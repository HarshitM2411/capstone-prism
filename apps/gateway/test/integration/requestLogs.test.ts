import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { findKeyByRawKey, seedTenants } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { createRequestLogWriter } from '../../src/db/requestLogs.js';
import { PgBudgetStore } from '../../src/limits/budget.js';
import { RedisRateLimiter } from '../../src/limits/rpm.js';
import type { RedisClient } from '../../src/redis.js';
import { loadAllConfig } from '../../src/startup.js';
import { DATA_DIR } from '../helpers/dataDir.js';
import { freshPool } from '../helpers/testDb.js';
import { freshRedis } from '../helpers/testRedis.js';

const loaded = loadAllConfig({
  dataDir: DATA_DIR,
  gatewayConfigFile: 'gateway_config.sample.json',
});

let pool: Pool;
let redis: RedisClient;
let app: FastifyInstance | undefined;

function appFor(target: Pool): FastifyInstance {
  app = buildApp({
    logLevel: 'silent',
    config: loaded.config,
    keys: { findByRawKey: (raw) => findKeyByRawKey(target, raw) },
    requestLogs: createRequestLogWriter(target),
    rateLimiter: new RedisRateLimiter(redis),
    budget: new PgBudgetStore(target),
    adminToken: 'test-admin-token-123',
  });
  return app;
}

beforeEach(async () => {
  await pool?.end();
  redis?.disconnect();
  pool = await freshPool();
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

const body = { model: 'fast', messages: [{ role: 'user', content: 'What is a message queue?' }] };

function post(instance: FastifyInstance, key: string | null, payload: unknown = body) {
  return instance.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    payload: JSON.stringify(payload),
  });
}

interface LogRow {
  request_id: string;
  key_id: string | null;
  requested_model: string | null;
  status: string;
  http_status: number;
  error_code: string | null;
  latency_ms: number;
  cost_usd: string;
  cache: string;
}

async function logs(): Promise<LogRow[]> {
  // `app.close()` waits for in-flight log writes, so the rows are complete afterwards.
  await app?.close();
  app = undefined;
  const { rows } = await pool.query<LogRow>(
    'SELECT * FROM request_logs ORDER BY created_at, request_id',
  );
  return rows;
}

describe('end to end against Postgres: auth → validation → resolution → log', () => {
  it('authenticates every seed key from the database and returns the stub response', async () => {
    const instance = appFor(pool);
    for (const key of [
      'prism-sk-search-1a2b3c',
      'prism-sk-research-4d5e6f',
      'prism-sk-free-7g8h9i',
      'prism-sk-budget-demo-0j1k2l',
    ]) {
      const res = await post(instance, key);
      expect(res.statusCode, key).toBe(200);
      expect(res.headers['x-prism-provider']).toBe('none');
    }
    expect(await logs()).toHaveLength(4);
  });

  it('writes one correct row for each kind of outcome', async () => {
    const instance = appFor(pool);
    const ok = await post(instance, 'prism-sk-search-1a2b3c');
    const unauth = await post(instance, null);
    const unknownKey = await post(instance, 'prism-sk-not-a-real-key');
    const invalid = await post(instance, 'prism-sk-search-1a2b3c', { model: 'fast', messages: [] });
    const notFound = await post(instance, 'prism-sk-search-1a2b3c', {
      ...body,
      model: 'no-such-model-xyz',
    });

    const search = (await findKeyByRawKey(pool, 'prism-sk-search-1a2b3c'))!;
    const rows = await logs();
    expect(rows).toHaveLength(5);

    const byId = new Map(rows.map((r) => [r.request_id, r]));
    expect(byId.get(ok.headers['x-request-id'] as string)).toMatchObject({
      key_id: String(search.id),
      requested_model: 'fast',
      status: 'ok',
      http_status: 200,
      error_code: null,
      cache: 'miss',
    });
    expect(Number(byId.get(ok.headers['x-request-id'] as string)?.cost_usd)).toBeGreaterThan(0);
    expect(byId.get(unauth.headers['x-request-id'] as string)).toMatchObject({
      key_id: null,
      requested_model: null,
      status: 'rejected_auth',
      http_status: 401,
      error_code: 'invalid_api_key',
    });
    expect(byId.get(unknownKey.headers['x-request-id'] as string)).toMatchObject({
      key_id: null,
      status: 'rejected_auth',
    });
    expect(byId.get(invalid.headers['x-request-id'] as string)).toMatchObject({
      key_id: String(search.id),
      requested_model: 'fast',
      status: 'rejected_validation',
      http_status: 400,
      error_code: 'invalid_request',
    });
    expect(byId.get(notFound.headers['x-request-id'] as string)).toMatchObject({
      key_id: String(search.id),
      requested_model: 'no-such-model-xyz',
      status: 'rejected_not_found',
      http_status: 404,
      error_code: 'model_not_found',
    });
    expect(rows.every((r) => Number.isInteger(r.latency_ms) && r.latency_ms >= 0)).toBe(true);
  });

  it('attributes a disabled key’s rejection to its key id but answers like an unknown key', async () => {
    await pool.query("UPDATE virtual_keys SET status = 'disabled' WHERE team = 'free-tier'");
    const instance = appFor(pool);

    const disabled = await post(instance, 'prism-sk-free-7g8h9i');
    const unknown = await post(instance, 'prism-sk-unknown');
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toEqual(unknown.json());

    const free = (await findKeyByRawKey(pool, 'prism-sk-free-7g8h9i'))!;
    const rows = await logs();
    const disabledRow = rows.find((r) => r.request_id === disabled.headers['x-request-id']);
    expect(disabledRow?.key_id).toBe(String(free.id));
    expect(disabledRow?.status).toBe('rejected_auth');
  });

  it('never stores a raw key, an admin token or prompt text in the log', async () => {
    const instance = appFor(pool);
    await post(instance, 'prism-sk-typo-key-should-not-be-stored');
    await post(instance, 'prism-sk-search-1a2b3c', {
      model: 'fast',
      messages: [{ role: 'user', content: 'a-very-private-prompt' }],
      temperature: 99,
    });

    const dump = JSON.stringify(await logs());
    for (const secret of [
      'prism-sk-typo-key-should-not-be-stored',
      'prism-sk-search-1a2b3c',
      'a-very-private-prompt',
      'test-admin-token-123',
    ]) {
      expect(dump).not.toContain(secret);
    }
  });

  it('copes with a model name that Postgres text cannot store literally', async () => {
    const instance = appFor(pool);
    const res = await post(instance, 'prism-sk-search-1a2b3c', {
      ...body,
      model: 'bad\u0000model',
    });
    expect(res.statusCode).toBe(404);
    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requested_model).toBe('badmodel');
  });

  it('keeps serving requests when the database goes away (503, no crash)', async () => {
    const dead = createPool({
      connectionString: 'postgres://prism:prism@127.0.0.1:1/prism',
      max: 2,
      connectionTimeoutMs: 300,
    });
    const instance = appFor(dead);

    const res = await post(instance, 'prism-sk-search-1a2b3c');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe('service_unavailable');
    expect(res.headers['x-prism-provider']).toBe('none');
    // The log write for this request fails too; that must not crash or hang shutdown.
    await app?.close();
    app = undefined;
    await dead.end();
  });

  it('returns the admin ping only with the token', async () => {
    const instance = appFor(pool);
    const ok = await instance.inject({
      method: 'GET',
      url: '/admin/ping',
      headers: { 'x-admin-token': 'test-admin-token-123' },
    });
    const denied = await instance.inject({ method: 'GET', url: '/admin/ping' });
    expect(ok.statusCode).toBe(200);
    expect(denied.statusCode).toBe(401);
    expect(await logs()).toHaveLength(0);
  });
});
