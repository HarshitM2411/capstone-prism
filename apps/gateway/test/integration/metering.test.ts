import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { PgCacheStore } from '../../src/cache/store.js';
import { findKeyByRawKey, seedTenants } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from '../../src/db/pool.js';
import { createRequestLogWriter } from '../../src/db/requestLogs.js';
import { PgBudgetStore } from '../../src/limits/budget.js';
import type { RateLimiter } from '../../src/limits/rpm.js';
import { RedisRateLimiter } from '../../src/limits/rpm.js';
import { PgMeteringStore } from '../../src/metering/store.js';
import { formatUsd, fromSqlNumeric, parseUsd, toSqlNumeric } from '../../src/money.js';
import { FakeRegistry, type FakeOutcome } from '../../src/providers/fake.js';
import type { RedisClient } from '../../src/redis.js';
import type { Classifier } from '../../src/routing/classifier.js';
import { loadAllConfig } from '../../src/startup.js';
import { ADMIN_TOKEN, TEST_TIMEOUTS } from '../helpers/app.js';
import { DATA_DIR } from '../helpers/dataDir.js';
import { StubEmbedder } from '../helpers/memoryCache.js';
import { freshPool } from '../helpers/testDb.js';
import { freshRedis } from '../helpers/testRedis.js';

const loaded = loadAllConfig({
  dataDir: DATA_DIR,
  gatewayConfigFile: 'gateway_config.sample.json',
});

const SEARCH = 'prism-sk-search-1a2b3c';
const RESEARCH = 'prism-sk-research-4d5e6f';
const FREE = 'prism-sk-free-7g8h9i';
const DEMO = 'prism-sk-budget-demo-0j1k2l';

const down: FakeOutcome = { type: 'error', kind: 'server_error', status: 503 };

let pool: Pool;
let redis: RedisClient;
let app: FastifyInstance | undefined;
let providers: FakeRegistry;
let limiterFailure: Error | null = null;
let tenantIds: Record<string, number>;

const classifier: Classifier = {
  async classify() {
    return {
      difficulty: 'simple',
      score: 0,
      threshold: 1,
      signals: [],
      embedDelta: null,
      reason: 'simple: test verdict',
    };
  },
};

function startApp(): FastifyInstance {
  providers = new FakeRegistry(['alpha', 'beta']);
  const redisLimiter = new RedisRateLimiter(redis);
  const limiter: RateLimiter = {
    async check(keyId, limit) {
      if (limiterFailure !== null) throw limiterFailure;
      return redisLimiter.check(keyId, limit);
    },
  };
  app = buildApp({
    logLevel: 'silent',
    config: loaded.config,
    keys: { findByRawKey: (raw) => findKeyByRawKey(pool, raw) },
    requestLogs: createRequestLogWriter(pool),
    rateLimiter: limiter,
    budget: new PgBudgetStore(pool),
    providers,
    classifier,
    cache: new PgCacheStore(pool, 60_000),
    embedder: new StubEmbedder(384),
    metering: new PgMeteringStore(pool),
    timeouts: TEST_TIMEOUTS,
    retry: { maxAttempts: 3, initialBackoffMs: 5, backoffMultiplier: 2 },
    adminToken: ADMIN_TOKEN,
  });
  return app;
}

beforeEach(async () => {
  await pool?.end();
  redis?.disconnect();
  pool = await freshPool(10);
  redis = await freshRedis();
  limiterFailure = null;
  await runMigrations(pool);
  await seedTenants(pool, loaded.tenants);
  // The research key may use `auto`; turn its cache on so the pipeline test can reach it.
  await pool.query(
    `UPDATE virtual_keys SET cache_enabled = TRUE, cache_threshold = 0.92 WHERE team = 'research'`,
  );
  tenantIds = {};
  for (const [name, key] of Object.entries({
    search: SEARCH,
    research: RESEARCH,
    free: FREE,
    demo: DEMO,
  })) {
    tenantIds[name] = (await findKeyByRawKey(pool, key))!.id;
  }
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await pool?.end();
  redis?.disconnect();
});

function ask(
  instance: FastifyInstance,
  key: string | null,
  payload: unknown,
): Promise<LightMyRequestResponse> {
  return instance.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
    payload: payload as object,
  });
}

const chat = (model: string, content: string, extra: object = {}) => ({
  model,
  messages: [{ role: 'user', content }],
  ...extra,
});

function admin(instance: FastifyInstance, url: string) {
  return instance.inject({ method: 'GET', url, headers: { 'x-admin-token': ADMIN_TOKEN } });
}

interface Row {
  request_id: string;
  key_id: string | null;
  requested_model: string | null;
  resolved_provider: string | null;
  resolved_model: string | null;
  status: string;
  http_status: number | null;
  error_code: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: string;
  cache: string;
  fallback: boolean;
  route_reason: string | null;
  retries: number;
  latency_ms: number;
  usage_estimated: boolean;
  time_to_first_token_ms: number | null;
  created_at: Date;
}

async function rows(): Promise<Row[]> {
  const { rows: result } = await pool.query<Row>(
    'SELECT * FROM request_logs ORDER BY created_at, request_id',
  );
  return result;
}

/** Logs are written just after the response, so wait until `count` rows exist. */
async function waitForRows(count: number): Promise<Row[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const current = await rows();
    if (current.length >= count || Date.now() > deadline) {
      expect(current).toHaveLength(count);
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForCacheEntries(count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { rows: found } = await pool.query('SELECT 1 FROM cache_entries');
    if (found.length >= count || Date.now() > deadline) {
      expect(found.length).toBeGreaterThanOrEqual(count);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function rowOf(all: Row[], res: LightMyRequestResponse): Row {
  const row = all.find((r) => r.request_id === res.headers['x-request-id']);
  if (row === undefined) throw new Error(`no log row for request ${res.headers['x-request-id']}`);
  return row;
}

const units = (row: Row): bigint => fromSqlNumeric(row.cost_usd);

describe('request_logs completeness on every code path (eval E5)', () => {
  it('writes one complete, correct row for each kind of outcome', async () => {
    const instance = startApp();
    const unlimited = await pool.query(
      `UPDATE virtual_keys SET rpm_limit = 1 WHERE team = 'free-tier'`,
    );
    expect(unlimited.rowCount).toBe(1);

    const results: Record<string, LightMyRequestResponse> = {};

    // Success paths.
    results.ok = await ask(
      instance,
      RESEARCH,
      chat('smart', 'Explain consensus protocols in depth'),
    );
    results.miss = await ask(instance, SEARCH, chat('fast', 'How do I reset my password?'));
    await waitForCacheEntries(1);
    results.hit = await ask(instance, SEARCH, chat('fast', 'How do I reset my password?'));
    results.stream = await ask(
      instance,
      RESEARCH,
      chat('fast', 'Stream me a short answer', { stream: true }),
    );

    // Fallback served the request.
    providers.must('alpha').fallback = down;
    results.fallback = await ask(instance, RESEARCH, chat('fast', 'Answer through the fallback'));
    // Both providers down.
    providers.must('beta').fallback = down;
    results.upstream = await ask(instance, RESEARCH, chat('fast', 'Nobody can answer this'));
    providers.must('alpha').fallback = { type: 'ok' };
    providers.must('beta').fallback = { type: 'ok' };

    // Rejections, one per check in the pipeline.
    results.noKey = await ask(instance, null, chat('fast', 'hello'));
    results.badKey = await ask(instance, 'prism-sk-not-a-real-key', chat('fast', 'hello'));
    results.invalid = await ask(instance, SEARCH, { model: 'fast', messages: [] });
    results.notFound = await ask(instance, SEARCH, chat('no-such-model', 'hello'));
    results.allowlist = await ask(instance, SEARCH, chat('smart', 'hello'));
    await ask(instance, FREE, chat('fast', 'first request uses the only slot'));
    results.rateLimit = await ask(instance, FREE, chat('fast', 'second request is over the limit'));
    await ask(instance, DEMO, chat('fast', 'the first request is admitted'));
    results.budget = await ask(instance, DEMO, chat('fast', 'the second is over budget'));
    limiterFailure = new Error('redis is down');
    results.unavailable = await ask(instance, RESEARCH, chat('fast', 'limiter unavailable'));
    limiterFailure = null;

    const all = await waitForRows(Object.keys(results).length + 2);

    // Every response maps to exactly one row, and the row agrees with the response.
    const ids = new Set(all.map((r) => r.request_id));
    expect(ids.size).toBe(all.length);
    for (const [name, res] of Object.entries(results)) {
      const row = rowOf(all, res);
      expect(row.http_status, name).toBe(res.statusCode);
      expect(row.latency_ms, name).toBeGreaterThanOrEqual(0);
      expect(row.created_at, name).toBeInstanceOf(Date);
      expect(row.retries, name).toBeGreaterThanOrEqual(0);
      if (res.statusCode >= 400) {
        expect(row.error_code, name).toBe(res.json().error.code);
        expect(units(row), `${name} cost`).toBe(row.status === 'upstream_error' ? units(row) : 0n);
      } else {
        expect(row.error_code, name).toBeNull();
      }
    }

    const search = BigInt(tenantIds.search!);
    const keyOf = (row: Row) => (row.key_id === null ? null : BigInt(row.key_id));

    // Served by a provider.
    expect(rowOf(all, results.ok!)).toMatchObject({
      status: 'ok',
      requested_model: 'smart',
      resolved_provider: 'alpha',
      resolved_model: 'alpha-large',
      cache: 'miss',
      fallback: false,
      route_reason: null,
    });
    expect(rowOf(all, results.ok!).prompt_tokens).toBeGreaterThan(0);
    expect(rowOf(all, results.ok!).completion_tokens).toBeGreaterThan(0);
    expect(units(rowOf(all, results.ok!))).toBeGreaterThan(0n);
    expect(keyOf(rowOf(all, results.ok!))).toBe(BigInt(tenantIds.research!));

    expect(rowOf(all, results.miss!)).toMatchObject({ status: 'ok', cache: 'miss' });
    expect(keyOf(rowOf(all, results.miss!))).toBe(search);

    // A hit: free, no provider recorded, still attributed to the key.
    const hit = rowOf(all, results.hit!);
    expect(hit).toMatchObject({
      status: 'cache_hit',
      cache: 'hit',
      requested_model: 'fast',
      resolved_provider: null,
      resolved_model: null,
      prompt_tokens: rowOf(all, results.miss!).prompt_tokens,
      completion_tokens: rowOf(all, results.miss!).completion_tokens,
      fallback: false,
      retries: 0,
    });
    expect(units(hit)).toBe(0n);
    expect(results.hit!.headers['x-prism-provider']).toBe('none');
    expect(results.hit!.headers['x-prism-cost-usd']).toBe('0');

    // A stream: ok, with a time to first token.
    const stream = rowOf(all, results.stream!);
    expect(stream).toMatchObject({ status: 'ok', cache: 'miss', resolved_provider: 'alpha' });
    expect(stream.time_to_first_token_ms).not.toBeNull();
    expect(units(stream)).toBeGreaterThan(0n);

    // A fallback.
    expect(rowOf(all, results.fallback!)).toMatchObject({
      status: 'ok',
      fallback: true,
      retries: 2,
      resolved_provider: 'beta',
      resolved_model: 'beta-small',
    });

    // Everything failed upstream.
    expect(rowOf(all, results.upstream!)).toMatchObject({
      status: 'upstream_error',
      http_status: 502,
      requested_model: 'fast',
      prompt_tokens: 0,
      completion_tokens: 0,
    });
    expect(units(rowOf(all, results.upstream!))).toBe(0n);

    // Rejections: no provider was called, nothing was charged.
    const rejections: [string, string, string | null, boolean][] = [
      ['noKey', 'rejected_auth', null, false],
      ['badKey', 'rejected_auth', null, false],
      ['invalid', 'rejected_validation', 'fast', true],
      ['notFound', 'rejected_not_found', 'no-such-model', true],
      ['allowlist', 'rejected_allowlist', 'smart', true],
      ['rateLimit', 'rejected_rate_limit', 'fast', true],
      ['budget', 'rejected_budget', 'fast', true],
      ['unavailable', 'rejected_unavailable', 'fast', true],
    ];
    for (const [name, status, model, hasKey] of rejections) {
      const row = rowOf(all, results[name]!);
      expect(row.status, name).toBe(status);
      expect(row.resolved_provider, name).toBeNull();
      // Only the budget check has priced a model by then; every other rejection came earlier.
      expect(row.resolved_model, name).toBe(name === 'budget' ? 'alpha-small' : null);
      expect(row.cache, name).toBe('miss');
      expect(units(row), name).toBe(0n);
      expect(row.prompt_tokens + row.completion_tokens, name).toBe(0);
      expect(row.key_id === null, `${name} key`).toBe(!hasKey);
      if (name !== 'noKey' && name !== 'badKey') expect(row.requested_model, name).toBe(model);
    }
    // The submitted key is never stored.
    const { rows: leaked } = await pool.query(
      `SELECT 1 FROM request_logs WHERE to_jsonb(request_logs)::text LIKE '%prism-sk-%'`,
    );
    expect(leaked).toHaveLength(0);
  });

  it('records the route reason of an auto request, served or answered from the cache', async () => {
    const instance = startApp();
    const first = await ask(instance, RESEARCH, chat('auto', 'What is a message queue?'));
    await waitForCacheEntries(1);
    const second = await ask(instance, RESEARCH, chat('auto', 'What is a message queue?'));
    const all = await waitForRows(2);
    expect(rowOf(all, first)).toMatchObject({
      requested_model: 'auto',
      route_reason: 'fast: simple: test verdict',
      status: 'ok',
    });
    expect(rowOf(all, second)).toMatchObject({
      requested_model: 'auto',
      route_reason: 'fast: simple: test verdict',
      status: 'cache_hit',
    });
  });
});

describe('GET /admin/usage and /admin/logs against Postgres', () => {
  it('a key with no traffic reports zeros; an unknown key is a 404; all keys when none is named', async () => {
    const instance = startApp();
    const empty = (await admin(instance, '/admin/usage?key=search')).json();
    expect(empty.keys).toHaveLength(1);
    expect(empty.keys[0]).toMatchObject({
      team: 'search',
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_hits: 0,
      cost_usd: '0.00000000',
    });
    expect(empty.keys[0].budget.spent_usd).toBe('0.00000000');
    expect(empty.keys[0].budget.monthly_usd).toBe('50.00000000');

    expect((await admin(instance, '/admin/usage?key=nobody')).statusCode).toBe(404);
    expect((await admin(instance, '/admin/logs?key=nobody')).statusCode).toBe(404);

    const everyone = (await admin(instance, '/admin/usage')).json();
    expect(everyone.keys.map((k: { team: string }) => k.team)).toEqual([
      'search',
      'research',
      'free-tier',
      'budget-demo',
    ]);
  });

  it('finds a key by team, by id, and by the raw key without ever returning it', async () => {
    const instance = startApp();
    await ask(instance, SEARCH, chat('fast', 'hello there'));
    await waitForRows(1);
    for (const ref of ['search', String(tenantIds.search), SEARCH]) {
      const res = await admin(instance, `/admin/usage?key=${encodeURIComponent(ref)}`);
      expect(res.statusCode, ref).toBe(200);
      expect(res.json().keys[0]).toMatchObject({ team: 'search', requests: 1 });
      expect(res.payload).not.toContain(SEARCH);
    }
  });

  it('respects the time window: from is inclusive, to is exclusive', async () => {
    const instance = startApp();
    await ask(instance, SEARCH, chat('fast', 'one'));
    await ask(instance, SEARCH, chat('fast', 'two'));
    const all = await waitForRows(2);
    const [first, second] = all as [Row, Row];
    const stamp = async (row: Row) =>
      (
        await pool.query<{ t: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
             FROM request_logs WHERE request_id = $1`,
          [row.request_id],
        )
      ).rows[0]!.t;
    // Millisecond precision is all a client can send; make the rows distinguishable.
    await pool.query(
      `UPDATE request_logs SET created_at = '2026-11-01T10:00:00Z' WHERE request_id = $1`,
      [first.request_id],
    );
    await pool.query(
      `UPDATE request_logs SET created_at = '2026-11-02T10:00:00Z' WHERE request_id = $1`,
      [second.request_id],
    );
    expect(await stamp(first)).toBe('2026-11-01T10:00:00.000000Z');

    const requests = async (query: string) =>
      (await admin(instance, `/admin/usage?key=search&${query}`)).json().keys[0].requests;
    expect(await requests('from=2026-11-01&to=2026-11-01')).toBe(1); // that whole day
    expect(await requests('from=2026-11-02')).toBe(1);
    expect(await requests('from=2026-11-01&to=2026-11-02')).toBe(2); // a date as `to` includes its day
    expect(await requests('from=2026-11-01&to=2026-11-03')).toBe(2);
    expect(await requests('to=2026-10-31')).toBe(0);
    expect(await requests('from=2026-11-01T10:00:00Z&to=2026-11-02T10:00:00Z')).toBe(1); // half-open
  });

  it('lists logs newest first, filters them, and pages without gaps or repeats', async () => {
    const instance = startApp();
    for (let i = 0; i < 7; i++)
      await ask(instance, SEARCH, chat('fast', `question number ${i} about queues`));
    await ask(instance, RESEARCH, chat('smart', 'a question for another team'));
    await ask(instance, SEARCH, chat('smart', 'not allowed'));
    await waitForRows(9);

    const page1 = (await admin(instance, '/admin/logs?limit=4')).json();
    expect(page1.data).toHaveLength(4);
    expect(page1.next_cursor).not.toBeNull();
    // Newest first.
    const times = page1.data.map((r: { created_at: string }) => r.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(page1.data[0]).toMatchObject({ status: 'rejected_allowlist', team: 'search' });

    const page2 = (
      await admin(instance, `/admin/logs?limit=4&cursor=${encodeURIComponent(page1.next_cursor)}`)
    ).json();
    const page3 = (
      await admin(instance, `/admin/logs?limit=4&cursor=${encodeURIComponent(page2.next_cursor)}`)
    ).json();
    const ids = [...page1.data, ...page2.data, ...page3.data].map(
      (r: { request_id: string }) => r.request_id,
    );
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
    expect(page3.next_cursor).toBeNull();
    const everything = (await rows()).map((r) => r.request_id).reverse();
    expect(ids).toEqual(everything);

    const onlySearch = (await admin(instance, '/admin/logs?key=search&limit=200')).json();
    expect(onlySearch.data).toHaveLength(8);
    const rejected = (await admin(instance, '/admin/logs?status=rejected_allowlist')).json();
    expect(rejected.data).toHaveLength(1);
    const capped = (await admin(instance, '/admin/logs?limit=100000')).json();
    expect(capped.limit).toBe(200);
  });

  it('never exposes a raw key, a key hash or a provider secret', async () => {
    const instance = startApp();
    await ask(instance, SEARCH, chat('fast', 'hello'));
    await ask(instance, null, chat('fast', 'hello'));
    await waitForRows(2);
    const text =
      (await admin(instance, '/admin/logs')).payload +
      (await admin(instance, '/admin/usage')).payload;
    const { rows: hashes } = await pool.query<{ key_hash: string }>(
      'SELECT key_hash FROM virtual_keys',
    );
    for (const key of [SEARCH, RESEARCH, FREE, DEMO, 'mock-key-alpha', 'mock-key-beta']) {
      expect(text).not.toContain(key);
    }
    for (const { key_hash: hash } of hashes) expect(text).not.toContain(hash);
  });
});

describe('accounting reconciles exactly (eval E4, exit criterion of phase 9)', () => {
  /** Sums the log table without going through the code under test (BigInt, not SQL SUM). */
  function logTotals(all: Row[], keyId: number) {
    const mine = all.filter((r) => r.key_id !== null && Number(r.key_id) === keyId);
    return {
      requests: mine.length,
      prompt: mine.reduce((s, r) => s + r.prompt_tokens, 0),
      completion: mine.reduce((s, r) => s + r.completion_tokens, 0),
      hits: mine.filter((r) => r.status === 'cache_hit').length,
      cost: mine.reduce((s, r) => s + units(r), 0n),
    };
  }

  async function spent(keyId: number): Promise<bigint> {
    const { rows: found } = await pool.query<{ spent_usd: string; reserved_usd: string }>(
      'SELECT spent_usd, reserved_usd FROM budget_usage WHERE key_id = $1',
      [keyId],
    );
    if (found.length === 0) return 0n;
    expect(fromSqlNumeric(found[0]!.reserved_usd), 'no reservation left over').toBe(0n);
    return fromSqlNumeric(found[0]!.spent_usd);
  }

  it('a mixed batch (hits, misses, fallbacks, rejections) matches the usage API, the budget and the headers', async () => {
    const instance = startApp();
    const headerCost = new Map<number, bigint>();
    const note = (keyId: number | undefined, res: LightMyRequestResponse) => {
      const header = res.headers['x-prism-cost-usd'];
      if (typeof header === 'string') {
        headerCost.set(keyId!, (headerCost.get(keyId!) ?? 0n) + parseUsd(header));
      }
    };

    // search: misses and hits (the same questions asked again).
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4; i++) {
        note(
          tenantIds.search,
          await ask(instance, SEARCH, chat('fast', `Search question ${i} about indexing`)),
        );
        if (round === 0) await waitForCacheEntries(i + 1);
      }
    }
    // research: successes, a failover, a stream, and an upstream failure.
    for (let i = 0; i < 3; i++) {
      note(
        tenantIds.research,
        await ask(instance, RESEARCH, chat('smart', `Research question ${i} about topology`)),
      );
    }
    providers.must('alpha').fallback = down;
    note(tenantIds.research, await ask(instance, RESEARCH, chat('fast', 'Fail over please')));
    providers.must('beta').fallback = down;
    note(tenantIds.research, await ask(instance, RESEARCH, chat('fast', 'Everything is down')));
    providers.must('alpha').fallback = { type: 'ok' };
    providers.must('beta').fallback = { type: 'ok' };
    note(
      tenantIds.research,
      await ask(instance, RESEARCH, chat('fast', 'A streamed one', { stream: true })),
    );
    // rejections
    await ask(instance, SEARCH, chat('smart', 'not allowed'));
    await ask(instance, null, chat('fast', 'anonymous'));
    await ask(instance, DEMO, chat('fast', 'admitted once'));
    await ask(instance, DEMO, chat('fast', 'then over budget'));
    await ask(instance, SEARCH, { model: 'fast' });

    const all = await waitForRows(4 + 4 + 3 + 1 + 1 + 1 + 5);
    const usage = (await admin(instance, '/admin/usage')).json();

    let apiRequests = 0;
    let apiCost = 0n;
    for (const key of usage.keys as { key_id: number; [k: string]: unknown }[]) {
      const expected = logTotals(all, key.key_id);
      expect(key.requests, `${key.team} requests`).toBe(expected.requests);
      expect(key.prompt_tokens, `${key.team} prompt`).toBe(expected.prompt);
      expect(key.completion_tokens, `${key.team} completion`).toBe(expected.completion);
      expect(key.cache_hits, `${key.team} hits`).toBe(expected.hits);
      expect(key.cost_usd, `${key.team} cost`).toBe(toSqlNumeric(expected.cost));
      // The budget counter is the same number, to the last 1e-8.
      expect(await spent(key.key_id), `${key.team} budget`).toBe(expected.cost);
      expect((key.budget as { spent_usd: string }).spent_usd).toBe(toSqlNumeric(expected.cost));
      // The headers the client saw add up as well (streams have no cost header).
      if (headerCost.has(key.key_id)) {
        const streamed = all
          .filter((r) => Number(r.key_id) === key.key_id && r.http_status === 200)
          .filter((r) => r.time_to_first_token_ms !== null)
          .reduce((s, r) => s + units(r), 0n);
        expect(headerCost.get(key.key_id)! + streamed, `${key.team} headers`).toBe(expected.cost);
      }
      apiRequests += key.requests as number;
      apiCost += expected.cost;
    }
    expect(usage.totals.requests).toBe(apiRequests);
    expect(usage.totals.cost_usd).toBe(toSqlNumeric(apiCost));
    expect(usage.unattributed_requests).toBe(all.filter((r) => r.key_id === null).length);
    expect(apiRequests + usage.unattributed_requests).toBe(all.length);

    // The batch contained every kind of outcome we claim to reconcile.
    const kinds = new Set(all.map((r) => r.status));
    for (const kind of [
      'ok',
      'cache_hit',
      'upstream_error',
      'rejected_allowlist',
      'rejected_auth',
      'rejected_budget',
      'rejected_validation',
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(all.some((r) => r.fallback)).toBe(true);

    // The cache statistics tell the same story as the usage API.
    const stats = (await admin(instance, '/admin/cache/stats')).json();
    const searchUsage = usage.keys.find((k: { team: string }) => k.team === 'search');
    const searchStats = stats.keys.find((k: { team: string }) => k.team === 'search');
    expect(searchStats.hits).toBe(searchUsage.cache_hits);
    expect(searchStats.hits).toBe(4);
    expect(searchStats.misses).toBe(searchUsage.served - searchUsage.cache_hits);
    expect(stats.overall.hits).toBe(
      usage.keys.reduce(
        (s: number, k: { cache_hits: number; team: string }) =>
          s + (k.team === 'search' ? k.cache_hits : 0),
        0,
      ),
    );

    expect(formatUsd(apiCost)).not.toBe('0');
  });

  it('matches what a client adds up from its own responses, cache hits included (the load test’s check)', async () => {
    const instance = startApp();
    const responses: LightMyRequestResponse[] = [];
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 3; i++) {
        responses.push(
          await ask(instance, SEARCH, chat('fast', `Client side question ${i} on queues`)),
        );
        if (round === 0) await waitForCacheEntries(i + 1);
      }
    }
    expect(responses.filter((r) => r.headers['x-prism-cache'] === 'hit')).toHaveLength(3);

    const prompt = responses.reduce((s, r) => s + (r.json().usage.prompt_tokens as number), 0);
    const completion = responses.reduce(
      (s, r) => s + (r.json().usage.completion_tokens as number),
      0,
    );
    const cost = responses.reduce(
      (s, r) => s + parseUsd(r.headers['x-prism-cost-usd'] as string),
      0n,
    );

    await waitForRows(6);
    const usage = (await admin(instance, '/admin/usage?key=search')).json().keys[0];
    expect(usage.requests).toBe(6);
    expect(usage.cache_hits).toBe(3);
    expect(usage.prompt_tokens).toBe(prompt);
    expect(usage.completion_tokens).toBe(completion);
    expect(usage.cost_usd).toBe(toSqlNumeric(cost));
  });

  it('stays exact under many concurrent requests on one key', async () => {
    const instance = startApp();
    const N = 60;
    const STREAMS = 12;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ask(
          instance,
          RESEARCH,
          // Different lengths give every request a different token count and cost.
          chat(
            i % 2 === 0 ? 'fast' : 'smart',
            `concurrent request ${i} ${'padding '.repeat(i % 9)}`,
            i < STREAMS ? { stream: true } : {},
          ),
        ),
      ),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);

    const all = await waitForRows(N);
    const keyId = tenantIds.research!;
    const logged = all.reduce((s, r) => s + units(r), 0n);
    expect(logged).toBeGreaterThan(0n);

    // Costs differ between requests, so a lost update could not cancel out.
    expect(new Set(all.map((r) => r.cost_usd)).size).toBeGreaterThan(5);

    // 1. the budget counter, 2. the sum of the logs, 3. the usage API, 4. the headers.
    expect(await spent(keyId)).toBe(logged);
    const usage = (await admin(instance, '/admin/usage?key=research')).json();
    expect(usage.keys[0].requests).toBe(N);
    expect(usage.keys[0].cost_usd).toBe(toSqlNumeric(logged));
    expect(usage.keys[0].budget.spent_usd).toBe(toSqlNumeric(logged));
    expect(usage.keys[0].budget.reserved_usd).toBe('0.00000000');

    const fromHeaders = responses
      .filter((r) => typeof r.headers['x-prism-cost-usd'] === 'string')
      .reduce((s, r) => s + parseUsd(r.headers['x-prism-cost-usd'] as string), 0n);
    const streamed = all
      .filter((r) => r.time_to_first_token_ms !== null)
      .reduce((s, r) => s + units(r), 0n);
    expect(responses.filter((r) => r.headers['x-prism-cost-usd'] === undefined)).toHaveLength(
      STREAMS,
    );
    expect(fromHeaders + streamed).toBe(logged);

    const tokens = all.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
    expect(usage.keys[0].total_tokens).toBe(tokens);
  });
});

describe('full pipeline: auto → miss → retry + failover → stream → cache hit (exit criterion of phase 9)', () => {
  it('shows the right headers, rows, usage and cache statistics at each step', async () => {
    const instance = startApp();
    providers.must('alpha').fallback = down;
    const question = 'What is a message queue?';

    // Step 1: `auto` is classified, the cache misses, alpha fails 3 times, beta streams the answer.
    const first = await ask(instance, RESEARCH, chat('auto', question, { stream: true }));
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/event-stream');
    expect(first.headers).toMatchObject({
      'x-prism-provider': 'beta/beta-small',
      'x-prism-cache': 'miss',
      'x-prism-fallback': 'true',
    });
    expect(first.headers['x-prism-cost-usd']).toBeUndefined(); // a stream's cost is only known at the end
    expect(first.body).toContain('[beta:beta-small]');
    expect(first.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(providers.must('alpha').calls).toHaveLength(3);
    expect(providers.must('beta').calls).toHaveLength(1);

    const afterFirst = await waitForRows(1);
    const missRow = afterFirst[0]!;
    expect(missRow).toMatchObject({
      key_id: String(tenantIds.research),
      requested_model: 'auto',
      resolved_provider: 'beta',
      resolved_model: 'beta-small',
      status: 'ok',
      http_status: 200,
      cache: 'miss',
      fallback: true,
      retries: 2,
      route_reason: 'fast: simple: test verdict',
      usage_estimated: false,
    });
    expect(missRow.time_to_first_token_ms).not.toBeNull();
    const charged = units(missRow);
    expect(charged).toBeGreaterThan(0n);
    expect(
      await pool
        .query('SELECT spent_usd FROM budget_usage WHERE key_id = $1', [tenantIds.research])
        .then((r) => fromSqlNumeric(r.rows[0].spent_usd)),
    ).toBe(charged);

    // The completed stream was stored for the `fast` tier, ready for the next ask.
    await waitForCacheEntries(1);
    const { rows: entries } = await pool.query<{ alias: string; model: string }>(
      'SELECT alias, model FROM cache_entries',
    );
    expect(entries).toEqual([{ alias: 'fast', model: 'beta-small' }]);

    // Step 2: the same question again is answered from the cache; no provider is called.
    const callsBefore = [providers.must('alpha').calls.length, providers.must('beta').calls.length];
    const second = await ask(instance, RESEARCH, chat('auto', question));
    expect(second.statusCode).toBe(200);
    expect(second.headers).toMatchObject({
      'x-prism-provider': 'none',
      'x-prism-cache': 'hit',
      'x-prism-fallback': 'false',
      'x-prism-cost-usd': '0',
    });
    expect(second.json().choices[0].message.content).toContain('[beta:beta-small]');
    expect([providers.must('alpha').calls.length, providers.must('beta').calls.length]).toEqual(
      callsBefore,
    );

    // Step 3: the same again as a stream is replayed from the cache too.
    const third = await ask(instance, RESEARCH, chat('auto', question, { stream: true }));
    expect(third.headers).toMatchObject({ 'x-prism-cache': 'hit', 'x-prism-provider': 'none' });
    expect(third.body).toContain('[beta:beta-small]');
    expect(third.body.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const all = await waitForRows(3);
    const hitRows = all.filter((r) => r.status === 'cache_hit');
    expect(hitRows).toHaveLength(2);
    for (const row of hitRows) {
      expect(row).toMatchObject({
        requested_model: 'auto',
        resolved_provider: null,
        resolved_model: null,
        cache: 'hit',
        route_reason: 'fast: simple: test verdict',
        // A hit reports the stored answer's usage (what clients see) at zero cost.
        prompt_tokens: missRow.prompt_tokens,
        completion_tokens: missRow.completion_tokens,
      });
      expect(units(row)).toBe(0n);
    }

    // The money did not move on a hit.
    expect(
      await pool
        .query('SELECT spent_usd, reserved_usd FROM budget_usage WHERE key_id = $1', [
          tenantIds.research,
        ])
        .then((r) => r.rows[0]),
    ).toEqual({
      spent_usd: toSqlNumeric(charged),
      reserved_usd: '0.00000000',
    });

    // The admin APIs agree with each other and with the rows.
    const usage = (await admin(instance, '/admin/usage?key=research')).json();
    expect(usage.keys[0]).toMatchObject({
      requests: 3,
      served: 3,
      cache_hits: 2,
      fallbacks: 1,
      cost_usd: toSqlNumeric(charged),
      prompt_tokens: missRow.prompt_tokens * 3,
      completion_tokens: missRow.completion_tokens * 3,
    });
    const logs = (await admin(instance, '/admin/logs?key=research')).json();
    expect(logs.data.map((r: { status: string }) => r.status)).toEqual([
      'cache_hit',
      'cache_hit',
      'ok',
    ]);
    expect(logs.data[2]).toMatchObject({
      resolved_model: 'beta-small',
      fallback: true,
      retries: 2,
    });
    const stats = (await admin(instance, '/admin/cache/stats')).json();
    const research = stats.keys.find((k: { team: string }) => k.team === 'research');
    expect(research).toMatchObject({ hits: 2, misses: 1, entries: 1 });
    expect(research.hit_rate).toBeCloseTo(2 / 3, 3);
  });
});
