import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { findKeyByRawKey, seedTenants } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from '../../src/db/pool.js';
import { createRequestLogWriter } from '../../src/db/requestLogs.js';
import { PgBudgetStore, reconcileStaleReservations } from '../../src/limits/budget.js';
import { RedisRateLimiter } from '../../src/limits/rpm.js';
import { fromSqlNumeric, formatUsd } from '../../src/money.js';
import type { RedisClient } from '../../src/redis.js';
import { checkRedis } from '../../src/redis.js';
import { loadAllConfig } from '../../src/startup.js';
import { FakeRegistry } from '../../src/providers/fake.js';
import { TEST_TIMEOUTS } from '../helpers/app.js';
import { DATA_DIR } from '../helpers/dataDir.js';
import { freshPool } from '../helpers/testDb.js';
import { deadRedis, freshRedis } from '../helpers/testRedis.js';

const loaded = loadAllConfig({
  dataDir: DATA_DIR,
  gatewayConfigFile: 'gateway_config.sample.json',
});

const SEARCH = 'prism-sk-search-1a2b3c';
const FREE = 'prism-sk-free-7g8h9i';
const DEMO = 'prism-sk-budget-demo-0j1k2l';

let pool: Pool;
let redis: RedisClient;
let app: FastifyInstance | undefined;

function appWith(limiterRedis: RedisClient = redis): FastifyInstance {
  app = buildApp({
    logLevel: 'silent',
    config: loaded.config,
    keys: { findByRawKey: (raw) => findKeyByRawKey(pool, raw) },
    requestLogs: createRequestLogWriter(pool),
    rateLimiter: new RedisRateLimiter(limiterRedis),
    budget: new PgBudgetStore(pool),
    providers: new FakeRegistry(['alpha', 'beta']),
    timeouts: TEST_TIMEOUTS,
    adminToken: 'test-admin-token-123',
    healthChecks: {
      postgres: async () => void (await pool.query('SELECT 1')),
      redis: () => checkRedis(limiterRedis),
    },
  });
  return app;
}

beforeEach(async () => {
  await pool?.end();
  redis?.disconnect();
  pool = await freshPool(20);
  redis = await freshRedis();
  await runMigrations(pool);
  await seedTenants(pool, loaded.tenants);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await pool?.end();
  redis?.disconnect();
});

function post(key: string, model = 'fast'): Promise<LightMyRequestResponse> {
  return app!.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: JSON.stringify({ model, messages: [{ role: 'user', content: 'What is a queue?' }] }),
  });
}

async function statuses(): Promise<Record<string, number>> {
  await app?.close(); // waits for background log writes
  app = undefined;
  const { rows } = await pool.query<{ status: string; n: string }>(
    'SELECT status, COUNT(*) AS n FROM request_logs GROUP BY status',
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

describe('requests per minute, end to end (the load-test scenario, edge cases 4.1, E3)', () => {
  it('admits exactly rpm_limit of 30 requests sent 10 at a time, repeated', async () => {
    for (let run = 0; run < 5; run++) {
      await redis.flushdb();
      await pool.query('TRUNCATE request_logs');
      appWith();
      const codes: number[] = [];
      for (let wave = 0; wave < 3; wave++) {
        const res = await Promise.all(Array.from({ length: 10 }, () => post(FREE)));
        codes.push(...res.map((r) => r.statusCode));
      }
      expect(
        codes.filter((c) => c === 200),
        `run ${run}`,
      ).toHaveLength(10);
      expect(codes.filter((c) => c === 429)).toHaveLength(20);
      expect(await statuses()).toEqual({ ok: 10, rejected_rate_limit: 20 });
    }
  });

  it('sends a usable Retry-After and the 429 envelope', async () => {
    appWith();
    await Promise.all(Array.from({ length: 10 }, () => post(FREE)));
    const res = await post(FREE);
    expect(res.statusCode).toBe(429);
    const retry = Number(res.headers['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(res.json().error.type).toBe('rate_limit_exceeded');
  });

  it('does not charge or reserve anything for a rate-limited request', async () => {
    appWith();
    await Promise.all(Array.from({ length: 10 }, () => post(FREE)));
    const before = await pool.query('SELECT spent_usd, reserved_usd FROM budget_usage');
    await Promise.all(Array.from({ length: 5 }, () => post(FREE)));
    const after = await pool.query('SELECT spent_usd, reserved_usd FROM budget_usage');
    expect(after.rows).toEqual(before.rows);
  });

  it('limits each key on its own', async () => {
    appWith();
    await Promise.all(Array.from({ length: 12 }, () => post(FREE)));
    expect((await post(SEARCH)).statusCode).toBe(200);
  });
});

describe('monthly budget, end to end (the budget-demo scenario)', () => {
  it('serves the first request, then answers 402 for every later one, and logs each', async () => {
    appWith();
    const first = await post(DEMO);
    expect(first.statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      const res = await post(DEMO);
      expect(res.statusCode).toBe(402);
      expect(res.json().error).toMatchObject({ type: 'budget_exceeded', code: 'budget_exceeded' });
      expect(res.headers['x-prism-cost-usd']).toBe('0');
    }
    expect(await statuses()).toEqual({ ok: 1, rejected_budget: 3 });
  });

  it('admits exactly one of many simultaneous requests for the budget-demo key', async () => {
    for (let run = 0; run < 5; run++) {
      await pool.query('TRUNCATE request_logs');
      await pool.query('DELETE FROM budget_usage');
      await redis.flushdb();
      appWith();
      const res = await Promise.all(Array.from({ length: 12 }, () => post(DEMO)));
      expect(
        res.filter((r) => r.statusCode === 200),
        `run ${run}`,
      ).toHaveLength(1);
      expect(res.filter((r) => r.statusCode === 402)).toHaveLength(11);
      await app?.close();
      app = undefined;
    }
  });

  it('reconciles: the cost headers, request_logs and budget_usage all agree (E4, edge case 5.5)', async () => {
    appWith();
    const res = await Promise.all(Array.from({ length: 40 }, () => post(SEARCH)));
    expect(res.every((r) => r.statusCode === 200)).toBe(true);

    const headerUnits = res.reduce(
      (sum, r) => sum + BigInt(Math.round(Number(r.headers['x-prism-cost-usd']) * 1e8)),
      0n,
    );
    await app?.close();
    app = undefined;
    const search = (await findKeyByRawKey(pool, SEARCH))!;

    const logged = await pool.query<{ total: string; n: string }>(
      'SELECT SUM(cost_usd) AS total, COUNT(*) AS n FROM request_logs WHERE key_id = $1',
      [search.id],
    );
    const budget = await pool.query<{ spent_usd: string; reserved_usd: string }>(
      'SELECT spent_usd, reserved_usd FROM budget_usage WHERE key_id = $1',
      [search.id],
    );
    expect(Number(logged.rows[0]!.n)).toBe(40);
    const loggedUnits = fromSqlNumeric(logged.rows[0]!.total);
    expect(fromSqlNumeric(budget.rows[0]!.spent_usd)).toBe(loggedUnits);
    expect(headerUnits).toBe(loggedUnits);
    expect(fromSqlNumeric(budget.rows[0]!.reserved_usd)).toBe(0n);
    expect((await pool.query('SELECT 1 FROM budget_reservations')).rowCount).toBe(0);
    expect(formatUsd(loggedUnits)).toMatch(/^0\.\d+$/);
  });

  it('keeps a stale hold from blocking the key once the reconciler has run', async () => {
    appWith();
    const search = (await findKeyByRawKey(pool, SEARCH))!;
    await post(SEARCH);
    // Simulate a crashed request: a hold that nothing will ever settle.
    await pool.query(
      `INSERT INTO budget_reservations (request_id, key_id, period, amount_usd, created_at)
       SELECT gen_random_uuid(), key_id, period, 4.5, now() - interval '10 minutes'
         FROM budget_usage WHERE key_id = $1`,
      [search.id],
    );
    await pool.query('UPDATE budget_usage SET reserved_usd = 4.5 WHERE key_id = $1', [search.id]);

    expect(await reconcileStaleReservations(pool, 120_000)).toBe(1);
    const { rows } = await pool.query('SELECT reserved_usd FROM budget_usage WHERE key_id = $1', [
      search.id,
    ]);
    expect(fromSqlNumeric(rows[0].reserved_usd)).toBe(0n);
    expect((await post(SEARCH)).statusCode).toBe(200);
  });
});

describe('allowlist, end to end', () => {
  it('answers 403 for smart with a fast-only key and records it', async () => {
    appWith();
    const res = await post(SEARCH, 'smart');
    expect(res.statusCode).toBe(403);
    expect(await statuses()).toEqual({ rejected_allowlist: 1 });
    expect((await pool.query('SELECT 1 FROM budget_usage')).rowCount).toBe(0);
    expect(await redis.dbsize()).toBe(0); // no rate-limit slot used either
  });
});

describe('when Redis is unavailable (edge case 4.4)', () => {
  it('rejects data-plane requests with 503 rate_limiter_unavailable, fast, without touching the budget', async () => {
    const dead = deadRedis();
    try {
      appWith(dead);
      const started = Date.now();
      const res = await post(SEARCH);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('rate_limiter_unavailable');
      expect(Date.now() - started).toBeLessThan(2000);
      expect((await pool.query('SELECT 1 FROM budget_usage')).rowCount).toBe(0);
      expect(await statuses()).toEqual({ rejected_unavailable: 1 });
    } finally {
      dead.disconnect();
    }
  });

  it('reports redis as down in /health while Postgres stays up', async () => {
    const dead = deadRedis();
    try {
      appWith(dead);
      const res = await app!.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json().dependencies).toEqual({ postgres: 'up', redis: 'down' });
    } finally {
      dead.disconnect();
    }
  });

  it('reports both dependencies as up when healthy', async () => {
    appWith();
    const res = await app!.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies).toEqual({ postgres: 'up', redis: 'up' });
  });
});
