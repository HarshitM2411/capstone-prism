import { randomUUID } from 'node:crypto';
import type { RedisClient } from '../redis.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** When rejected: how long until the oldest request leaves the window (a `Retry-After` hint). */
  retryAfterMs: number;
}

/** Decides whether one more request from `keyId` fits under `limit` requests per minute. */
export interface RateLimiter {
  /** Rejects (throws) when the limiter cannot decide, so the caller can fail closed. */
  check(keyId: number, limit: number): Promise<RateLimitDecision>;
}

export const RPM_WINDOW_MS = 60_000;

/**
 * Sliding-window log in a Redis sorted set, one atomic script per request (architecture §4.3):
 *
 *  - time comes from Redis (`TIME`), so gateway instances never disagree about "now";
 *  - entries older than the window are dropped, and the request is admitted (and recorded) only
 *    if fewer than `limit` remain — so at most `limit` requests exist in any 60-second span;
 *  - a rejected request is NOT recorded, so a client that keeps hammering never extends its own
 *    lockout;
 *  - the TTL is set in the same script as the write, so a window key can never exist without one.
 *
 * KEYS[1] window key · ARGV[1] limit · ARGV[2] window ms · ARGV[3] unique member id
 * Returns { allowed (1|0), retryAfterMs }.
 */
export const SLIDING_WINDOW_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])

if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return { 1, 0 }
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if #oldest == 0 then
  return { 0, window }
end
local retry = tonumber(oldest[2]) + window - now
if retry < 1 then retry = 1 end
return { 0, retry }
`;

export function windowKey(keyId: number): string {
  return `rpm:${keyId}`;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisClient,
    private readonly windowMs = RPM_WINDOW_MS,
  ) {}

  async check(keyId: number, limit: number): Promise<RateLimitDecision> {
    // A limit of 0 means "no requests" (edge case 2.8); the script handles it without a write.
    const reply = (await this.redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      windowKey(keyId),
      String(limit),
      String(this.windowMs),
      randomUUID(),
    )) as [number, number];
    return { allowed: reply[0] === 1, retryAfterMs: reply[1] };
  }
}
