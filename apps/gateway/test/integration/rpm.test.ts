import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisRateLimiter, windowKey } from '../../src/limits/rpm.js';
import type { RedisClient } from '../../src/redis.js';
import { deadRedis, freshRedis } from '../helpers/testRedis.js';

let redis: RedisClient;

beforeEach(async () => {
  redis?.disconnect();
  redis = await freshRedis();
});

afterAll(() => {
  redis?.disconnect();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function admitted(limiter: RedisRateLimiter, keyId: number, limit: number, n: number) {
  const decisions = await Promise.all(Array.from({ length: n }, () => limiter.check(keyId, limit)));
  return decisions.filter((d) => d.allowed).length;
}

describe('RedisRateLimiter (against real Redis)', () => {
  it('admits exactly `limit` requests, then rejects', async () => {
    const limiter = new RedisRateLimiter(redis);
    const results = [];
    for (let i = 0; i < 12; i++) results.push((await limiter.check(1, 10)).allowed);
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results.slice(10)).toEqual([false, false]);
  });

  it('never over-admits under concurrency: exactly N of N+M parallel requests (edge case 4.1)', async () => {
    const limiter = new RedisRateLimiter(redis);
    // Repeat, because a race would only show up some of the time (E3 asks for repeated runs).
    for (let run = 0; run < 20; run++) {
      expect(await admitted(limiter, 100 + run, 10, 60), `run ${run}`).toBe(10);
    }
  });

  it('shares one window across several gateway instances (separate clients)', async () => {
    const other = await freshRedis();
    try {
      const a = new RedisRateLimiter(redis);
      const b = new RedisRateLimiter(other);
      const decisions = await Promise.all(
        Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).check(7, 10)),
      );
      expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
    } finally {
      other.disconnect();
    }
  });

  it('keeps a separate window per key', async () => {
    const limiter = new RedisRateLimiter(redis);
    expect(await admitted(limiter, 1, 3, 10)).toBe(3);
    expect(await admitted(limiter, 2, 3, 10)).toBe(3);
    expect(await admitted(limiter, 3, 5, 10)).toBe(5);
  });

  it('rejects everything when the limit is 0, without writing anything (edge case 2.8)', async () => {
    const limiter = new RedisRateLimiter(redis);
    const decision = await limiter.check(9, 0);
    expect(decision.allowed).toBe(false);
    expect(await redis.exists(windowKey(9))).toBe(0);
  });

  it('does not record rejected requests, so hammering never extends the lockout (edge case 4.8)', async () => {
    const limiter = new RedisRateLimiter(redis);
    expect(await admitted(limiter, 1, 5, 50)).toBe(5);
    expect(await redis.zcard(windowKey(1))).toBe(5);
  });

  it('always sets a TTL on the window key (edge case 4.5)', async () => {
    const limiter = new RedisRateLimiter(redis);
    for (let i = 0; i < 6; i++) {
      await limiter.check(1, 100);
      const ttl = await redis.pttl(windowKey(1));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    }
  });

  it('expires the key on its own once the window has passed', async () => {
    const limiter = new RedisRateLimiter(redis, 300);
    await limiter.check(1, 5);
    await sleep(450);
    expect(await redis.exists(windowKey(1))).toBe(0);
  });

  it('reports a Retry-After that is positive and no longer than the window', async () => {
    const limiter = new RedisRateLimiter(redis);
    await admitted(limiter, 1, 2, 2);
    const rejected = await limiter.check(1, 2);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(rejected.retryAfterMs).toBeGreaterThan(55_000); // the oldest request was just made
  });

  it('is a sliding window, not a fixed one: no burst across a window boundary (edge case 4.2)', async () => {
    const limiter = new RedisRateLimiter(redis, 1000);
    expect(await admitted(limiter, 1, 5, 5)).toBe(5);

    // Half a window later the first five still count; a fixed-window counter would have reset
    // at the boundary and let ten requests through within one second.
    await sleep(500);
    expect(await admitted(limiter, 1, 5, 5)).toBe(0);

    // Once the first five leave the window, requests are admitted again.
    await sleep(650);
    expect(await admitted(limiter, 1, 5, 5)).toBe(5);
  });

  it('never admits more than `limit` in any window, over a long burst of traffic', async () => {
    const windowMs = 400;
    const limit = 8;
    const limiter = new RedisRateLimiter(redis, windowMs);
    const admittedAt: number[] = [];
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const decision = await limiter.check(1, limit);
      if (decision.allowed) admittedAt.push(Date.now());
      await sleep(5);
    }
    expect(admittedAt.length).toBeGreaterThan(limit); // the window did slide
    // Allow a few ms of skew between the client clock and Redis's.
    for (let i = 0; i + limit < admittedAt.length; i++) {
      expect(admittedAt[i + limit]! - admittedAt[i]!).toBeGreaterThanOrEqual(windowMs - 25);
    }
  });

  it('starts from zero after Redis loses its data (a restart)', async () => {
    const limiter = new RedisRateLimiter(redis);
    expect(await admitted(limiter, 1, 3, 5)).toBe(3);
    await redis.flushdb();
    expect(await admitted(limiter, 1, 3, 5)).toBe(3);
  });

  it('fails closed: throws, quickly, when Redis cannot be reached (edge case 4.4)', async () => {
    const dead = deadRedis();
    try {
      const limiter = new RedisRateLimiter(dead);
      const started = Date.now();
      await expect(limiter.check(1, 10)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      dead.disconnect();
    }
  });

  it('a failing client does not affect a healthy one', async () => {
    const dead = deadRedis();
    try {
      await expect(new RedisRateLimiter(dead).check(1, 10)).rejects.toThrow();
    } finally {
      dead.disconnect();
    }
    expect((await new RedisRateLimiter(redis).check(1, 10)).allowed).toBe(true);
  });
});
