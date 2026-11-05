import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { PgCacheStore, toVectorLiteral, type CachedResponse } from '../../src/cache/store.js';
import { findKeyByRawKey, seedTenants } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import { type Pool } from '../../src/db/pool.js';
import { createRequestLogWriter } from '../../src/db/requestLogs.js';
import { PgBudgetStore } from '../../src/limits/budget.js';
import { RedisRateLimiter } from '../../src/limits/rpm.js';
import { FakeRegistry } from '../../src/providers/fake.js';
import type { RedisClient } from '../../src/redis.js';
import { loadAllConfig } from '../../src/startup.js';
import { TEST_TIMEOUTS } from '../helpers/app.js';
import { DATA_DIR } from '../helpers/dataDir.js';
import { StubEmbedder } from '../helpers/memoryCache.js';
import { freshPool } from '../helpers/testDb.js';
import { freshRedis } from '../helpers/testRedis.js';

const loaded = loadAllConfig({
  dataDir: DATA_DIR,
  gatewayConfigFile: 'gateway_config.sample.json',
});
const DIMS = 384;

let pool: Pool;
let redis: RedisClient;
let store: PgCacheStore;
let app: FastifyInstance | undefined;
let searchId: number;
let freeId: number;

/** A unit vector in 384 dimensions with the given leading components. */
function vec(...lead: number[]): number[] {
  const v = [...lead, ...new Array<number>(DIMS - lead.length).fill(0)];
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** A vector whose cosine similarity to `vec(1)` is `s`. */
const at = (s: number): number[] => vec(s, Math.sqrt(1 - s * s));

const answer = (content: string): CachedResponse => ({
  content,
  finishReason: 'stop',
  promptTokens: 5,
  completionTokens: 3,
  provider: 'alpha',
  model: 'alpha-small',
});

beforeEach(async () => {
  await pool?.end();
  redis?.disconnect();
  pool = await freshPool();
  redis = await freshRedis();
  await runMigrations(pool);
  await seedTenants(pool, loaded.tenants);
  store = new PgCacheStore(pool, 60_000);
  searchId = (await findKeyByRawKey(pool, 'prism-sk-search-1a2b3c'))!.id;
  freeId = (await findKeyByRawKey(pool, 'prism-sk-free-7g8h9i'))!.id;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await pool?.end();
  redis?.disconnect();
});

const entry = (overrides: Partial<Parameters<PgCacheStore['write']>[0]> = {}) => ({
  keyId: searchId,
  alias: 'fast',
  contextHash: 'ctx',
  promptText: 'How do I reset my password?',
  embedding: vec(1),
  response: answer('Use the reset link.'),
  ...overrides,
});

const query = (overrides: Partial<Parameters<PgCacheStore['lookup']>[0]> = {}) => ({
  keyId: searchId,
  alias: 'fast',
  contextHash: 'ctx',
  embedding: vec(1),
  threshold: 0.92,
  ...overrides,
});

describe('PgCacheStore against Postgres + pgvector', () => {
  it('formats vectors for pgvector and rejects non-finite numbers', () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe('[0.5,-1,0]');
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow();
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow();
  });

  it('returns a stored answer for the same scope and a similar enough vector', async () => {
    await store.write(entry());
    const hit = await store.lookup(query({ embedding: at(0.97) }));
    expect(hit?.response).toEqual(answer('Use the reset link.'));
    expect(hit!.similarity).toBeGreaterThan(0.96);
    expect(hit!.similarity).toBeLessThan(0.98);
  });

  it('misses below the threshold and hits at it (the threshold is the caller’s)', async () => {
    await store.write(entry());
    expect(await store.lookup(query({ embedding: at(0.9) }))).toBeNull();
    expect(await store.lookup(query({ embedding: at(0.9), threshold: 0.85 }))).not.toBeNull();
  });

  it('never returns another tenant’s entry, however similar (edge cases 7.1, 7.2)', async () => {
    await store.write(entry({ keyId: searchId }));
    expect(await store.lookup(query({ keyId: freeId }))).toBeNull();
    await store.write(entry({ keyId: freeId, response: answer('Free tier answer.') }));
    expect((await store.lookup(query({ keyId: freeId })))?.response.content).toBe(
      'Free tier answer.',
    );
    expect((await store.lookup(query({ keyId: searchId })))?.response.content).toBe(
      'Use the reset link.',
    );
  });

  it('keeps tiers and contexts apart', async () => {
    await store.write(entry());
    expect(await store.lookup(query({ alias: 'smart' }))).toBeNull();
    expect(await store.lookup(query({ contextHash: 'other' }))).toBeNull();
    expect(await store.lookup(query())).not.toBeNull();
  });

  it('returns the closest of several entries in the scope', async () => {
    await store.write(entry({ promptText: 'far', embedding: at(0.93), response: answer('far') }));
    await store.write(entry({ promptText: 'near', embedding: at(0.99), response: answer('near') }));
    await store.write(entry({ promptText: 'mid', embedding: at(0.95), response: answer('mid') }));
    expect((await store.lookup(query()))?.response.content).toBe('near');
  });

  it('counts hits', async () => {
    await store.write(entry());
    await store.lookup(query());
    await store.lookup(query());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { rows } = await pool.query<{ hit_count: number }>('SELECT hit_count FROM cache_entries');
    expect(rows[0]!.hit_count).toBe(2);
  });

  it('stores an identical prompt in a scope only once (concurrent writers)', async () => {
    await Promise.all([store.write(entry()), store.write(entry()), store.write(entry())]);
    const { rows } = await pool.query('SELECT 1 FROM cache_entries');
    expect(rows.length).toBeLessThanOrEqual(3);
    await store.write(entry());
    const { rows: after } = await pool.query('SELECT 1 FROM cache_entries');
    expect(after).toHaveLength(rows.length);
    // The same text for another tenant is its own entry.
    await store.write(entry({ keyId: freeId }));
    const { rows: both } = await pool.query('SELECT key_id FROM cache_entries');
    expect(new Set(both.map((r: { key_id: string }) => r.key_id)).size).toBe(2);
  });

  it('does not store an empty or oversized answer', async () => {
    await store.write(entry({ response: answer('') }));
    await store.write(entry({ response: answer('x'.repeat(300_000)) }));
    const { rows } = await pool.query('SELECT 1 FROM cache_entries');
    expect(rows).toHaveLength(0);
  });

  it('serves entries until they expire, and removes expired ones', async () => {
    await store.write(entry());
    const { rows } = await pool.query<{ expires_at: Date | null }>(
      'SELECT expires_at FROM cache_entries',
    );
    expect(rows[0]!.expires_at).not.toBeNull();

    await pool.query("UPDATE cache_entries SET expires_at = now() - interval '1 second'");
    expect(await store.lookup(query())).toBeNull();
    // An expired entry does not block storing a fresh one for the same prompt.
    await store.write(entry({ response: answer('Fresh.') }));
    expect((await store.lookup(query()))?.response.content).toBe('Fresh.');

    expect(await store.deleteExpired()).toBe(1);
    const { rows: left } = await pool.query('SELECT 1 FROM cache_entries');
    expect(left).toHaveLength(1);
  });

  it('keeps entries for ever when the TTL is zero', async () => {
    const forever = new PgCacheStore(pool, 0);
    await forever.write(entry());
    const { rows } = await pool.query<{ expires_at: Date | null }>(
      'SELECT expires_at FROM cache_entries',
    );
    expect(rows[0]!.expires_at).toBeNull();
    expect(await forever.deleteExpired()).toBe(0);
  });

  it('rejects a vector of the wrong size instead of storing it', async () => {
    await expect(store.write(entry({ embedding: [1, 0, 0] }))).rejects.toThrow();
  });

  it('removes a tenant’s entries with the tenant', async () => {
    await store.write(entry());
    await pool.query('DELETE FROM virtual_keys WHERE id = $1', [searchId]);
    const { rows } = await pool.query('SELECT 1 FROM cache_entries');
    expect(rows).toHaveLength(0);
  });
});

describe('semantic cache end to end against Postgres', () => {
  const A1 = 'How do I reset my password on the dashboard?';
  const A2 = 'What are the steps to reset my dashboard password?';
  const A3 = 'How do I reset my two-factor authentication on the dashboard?';

  function start(): { app: FastifyInstance; embedder: StubEmbedder } {
    const embedder = new StubEmbedder(DIMS);
    embedder.set(A1, vec(1)).set(A2, at(0.97)).set(A3, at(0.74));
    app = buildApp({
      logLevel: 'silent',
      config: loaded.config,
      keys: { findByRawKey: (raw) => findKeyByRawKey(pool, raw) },
      requestLogs: createRequestLogWriter(pool),
      rateLimiter: new RedisRateLimiter(redis),
      budget: new PgBudgetStore(pool),
      providers: new FakeRegistry(['alpha', 'beta']),
      timeouts: TEST_TIMEOUTS,
      cache: store,
      embedder,
      adminToken: 'test-admin-token-123',
    });
    return { app, embedder };
  }

  const ask = (instance: FastifyInstance, key: string, content: string) =>
    instance.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'fast', messages: [{ role: 'user', content }] },
    });

  async function entriesWritten(count: number): Promise<void> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const { rows } = await pool.query('SELECT 1 FROM cache_entries');
      if (rows.length >= count || Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('hits a paraphrase for the same key, never for another key, and misses the near-miss', async () => {
    const { app: instance } = start();
    expect((await ask(instance, 'prism-sk-search-1a2b3c', A1)).headers['x-prism-cache']).toBe(
      'miss',
    );
    await entriesWritten(1);

    expect((await ask(instance, 'prism-sk-search-1a2b3c', A2)).headers['x-prism-cache']).toBe(
      'hit',
    );
    expect((await ask(instance, 'prism-sk-search-1a2b3c', A3)).headers['x-prism-cache']).toBe(
      'miss',
    );
    // Tenant isolation: the free-tier key (threshold 0.85, cache on) must not see search's entry.
    expect((await ask(instance, 'prism-sk-free-7g8h9i', A2)).headers['x-prism-cache']).toBe('miss');
    // A key with the cache off never looks anything up.
    expect((await ask(instance, 'prism-sk-research-4d5e6f', A1)).headers['x-prism-cache']).toBe(
      'miss',
    );
  });

  it('logs hits, spends nothing on them and reports them in /admin/cache/stats', async () => {
    const { app: instance } = start();
    await ask(instance, 'prism-sk-search-1a2b3c', A1);
    await entriesWritten(1);
    await ask(instance, 'prism-sk-search-1a2b3c', A1);
    await ask(instance, 'prism-sk-search-1a2b3c', A2);

    const stats = await instance.inject({
      method: 'GET',
      url: '/admin/cache/stats',
      headers: { 'x-admin-token': 'test-admin-token-123' },
    });
    expect(stats.statusCode).toBe(200);
    const body = stats.json();
    const search = body.keys.find((k: { team: string }) => k.team === 'search');
    expect(search).toMatchObject({ entries: 1, stored_hit_count: 2, cache_enabled: true });
    expect(search.hits).toBe(2);
    expect(search.misses).toBe(1);
    expect(search.hit_rate).toBeCloseTo(0.6667, 3);
    const research = body.keys.find((k: { team: string }) => k.team === 'research');
    expect(research).toMatchObject({ cache_enabled: false, hits: 0, hit_rate: 0 });

    await instance.close();
    app = undefined;
    const { rows } = await pool.query<{ status: string; cache: string; cost_usd: string }>(
      'SELECT status, cache, cost_usd FROM request_logs ORDER BY created_at',
    );
    expect(rows.map((r) => [r.status, r.cache])).toEqual([
      ['ok', 'miss'],
      ['cache_hit', 'hit'],
      ['cache_hit', 'hit'],
    ]);
    expect(Number(rows[1]!.cost_usd)).toBe(0);
    const { rows: usage } = await pool.query<{ spent_usd: string; reserved_usd: string }>(
      'SELECT spent_usd, reserved_usd FROM budget_usage WHERE key_id = $1',
      [searchId],
    );
    expect(Number(usage[0]!.spent_usd)).toBe(Number(rows[0]!.cost_usd));
    expect(Number(usage[0]!.reserved_usd)).toBe(0);
  });

  it('serves requests normally when the cache table is unusable (edge case 7.13)', async () => {
    const { app: instance } = start();
    await pool.query('ALTER TABLE cache_entries RENAME TO cache_entries_gone');
    const res = await ask(instance, 'prism-sk-search-1a2b3c', A1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-cache']).toBe('miss');
    await pool.query('ALTER TABLE cache_entries_gone RENAME TO cache_entries');
  });
});
