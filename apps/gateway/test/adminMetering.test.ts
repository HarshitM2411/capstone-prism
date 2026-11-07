import { afterEach, describe, expect, it } from 'vitest';
import type {
  KeyRef,
  KeyUsage,
  LogPage,
  LogQuery,
  MeteringStore,
  UsageQuery,
  UsageReport,
} from '../src/metering/store.js';
import { MAX_LOG_LIMIT } from '../src/routes/adminMetering.js';
import { ADMIN_TOKEN, buildTestApp, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function usageRow(overrides: Partial<KeyUsage> = {}): KeyUsage {
  return {
    keyId: 1,
    team: 'search',
    keyHint: '…2b3c',
    status: 'active',
    requests: 0,
    served: 0,
    cacheHits: 0,
    fallbacks: 0,
    rejected: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUnits: 0n,
    budget: { period: '2026-11', monthlyUnits: 5_000_000_000n, spentUnits: 0n, reservedUnits: 0n },
    ...overrides,
  };
}

class StubMetering implements MeteringStore {
  keys: KeyRef[] = [{ id: 1, team: 'search' }];
  report: UsageReport = { keys: [usageRow()], unattributedRequests: 0 };
  page: LogPage = { rows: [], nextCursor: null };
  usageQueries: UsageQuery[] = [];
  logQueries: LogQuery[] = [];
  lookups: string[] = [];
  failWith: Error | null = null;

  async findKey(reference: string): Promise<KeyRef | null> {
    this.lookups.push(reference);
    if (this.failWith !== null) throw this.failWith;
    return this.keys.find((k) => k.team === reference || String(k.id) === reference) ?? null;
  }
  async usage(query: UsageQuery): Promise<UsageReport> {
    this.usageQueries.push(query);
    if (this.failWith !== null) throw this.failWith;
    return this.report;
  }
  async logs(query: LogQuery): Promise<LogPage> {
    this.logQueries.push(query);
    if (this.failWith !== null) throw this.failWith;
    return this.page;
  }
}

const NOW = new Date('2026-11-06T10:00:00Z');

function start(metering: MeteringStore | undefined): TestApp {
  current = buildTestApp({ metering, now: () => NOW });
  return current;
}

function get(t: TestApp, url: string, token: string | null = ADMIN_TOKEN) {
  return t.app.inject({
    method: 'GET',
    url,
    headers: token === null ? {} : { 'x-admin-token': token },
  });
}

describe('admin metering routes: access', () => {
  it.each(['/admin/usage', '/admin/logs'])('%s needs the admin token', async (url) => {
    const t = start(new StubMetering());
    expect((await get(t, url, null)).statusCode).toBe(401);
    expect((await get(t, url, 'wrong')).statusCode).toBe(401);
    expect((await get(t, url)).statusCode).toBe(200);
  });

  it('a virtual key is not an admin token', async () => {
    const t = start(new StubMetering());
    const res = await get(t, '/admin/usage', 'prism-sk-search-1a2b3c');
    expect(res.statusCode).toBe(401);
  });

  it.each(['/admin/usage', '/admin/logs'])(
    '%s answers 503 when metering is not configured',
    async (url) => {
      const t = start(undefined);
      const res = await get(t, url);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('service_unavailable');
    },
  );

  it.each(['/admin/usage', '/admin/logs'])(
    '%s answers 503 (no details) when the database fails',
    async (url) => {
      const store = new StubMetering();
      store.failWith = new Error('connection to 10.0.0.5:5432 refused');
      const t = start(store);
      const res = await get(t, url);
      expect(res.statusCode).toBe(503);
      expect(JSON.stringify(res.json())).not.toContain('10.0.0.5');
    },
  );
});

describe('GET /admin/usage', () => {
  it('a key with no traffic returns zeros, not an error or NaN (edge case 10.10)', async () => {
    const t = start(new StubMetering());
    const res = await get(t, '/admin/usage?key=search');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      team: 'search',
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache_hits: 0,
      cost_usd: '0.00000000',
    });
    expect(body.totals).toMatchObject({ requests: 0, cost_usd: '0.00000000' });
    expect(res.payload).not.toMatch(/NaN|Infinity/);
  });

  it('reports tokens, cost and cache hits, with money as exact text', async () => {
    const store = new StubMetering();
    store.report = {
      keys: [
        usageRow({
          requests: 10,
          served: 8,
          cacheHits: 3,
          fallbacks: 1,
          rejected: 1,
          errors: 1,
          promptTokens: 1200,
          completionTokens: 800,
          costUnits: 123_456_789n,
          budget: {
            period: '2026-11',
            monthlyUnits: 5_000_000_000n,
            spentUnits: 123_456_789n,
            reservedUnits: 0n,
          },
        }),
        usageRow({ keyId: 2, team: 'research', requests: 2, costUnits: 1n, promptTokens: 5 }),
      ],
      unattributedRequests: 4,
    };
    const t = start(store);
    const body = (await get(t, '/admin/usage')).json();

    expect(body.keys[0]).toMatchObject({
      requests: 10,
      served: 8,
      cache_hits: 3,
      fallbacks: 1,
      rejected: 1,
      errors: 1,
      prompt_tokens: 1200,
      completion_tokens: 800,
      total_tokens: 2000,
      cost_usd: '1.23456789',
      budget: { period: '2026-11', monthly_usd: '50.00000000', spent_usd: '1.23456789' },
    });
    // The totals are the exact sum of the keys.
    expect(body.totals).toMatchObject({
      requests: 12,
      prompt_tokens: 1205,
      cost_usd: '1.23456790',
    });
    expect(body.unattributed_requests).toBe(4);
    expect(body.key).toBeNull();
  });

  it('passes no filter when there is no key or window (every key, all time)', async () => {
    const store = new StubMetering();
    const t = start(store);
    const body = (await get(t, '/admin/usage')).json();
    expect(store.usageQueries[0]).toEqual({ keyId: null, from: null, to: null, now: NOW });
    expect(store.lookups).toHaveLength(0);
    expect(body.window).toEqual({ from: null, to: null });
  });

  it('resolves the key by team name or id', async () => {
    const store = new StubMetering();
    const t = start(store);
    for (const ref of ['search', '1']) {
      const res = await get(t, `/admin/usage?key=${ref}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().key).toEqual({ key_id: 1, team: 'search' });
    }
    expect(store.usageQueries.every((q) => q.keyId === 1)).toBe(true);
  });

  it('an unknown key is a clear 404 that does not echo what was sent (edge case 10.11)', async () => {
    const t = start(new StubMetering());
    const res = await get(t, '/admin/usage?key=prism-sk-secret-abcdef');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ type: 'not_found_error', code: 'key_not_found' });
    expect(res.payload).not.toContain('prism-sk-secret-abcdef');
  });

  it('a date-only window covers whole UTC days: `to` includes its day', async () => {
    const store = new StubMetering();
    const t = start(store);
    const res = await get(t, '/admin/usage?from=2026-11-01&to=2026-11-30');
    expect(res.statusCode).toBe(200);
    expect(store.usageQueries[0]!.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(store.usageQueries[0]!.to?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(res.json().window).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-12-01T00:00:00.000Z',
    });
  });

  it('a full timestamp window is taken as given (offsets honoured)', async () => {
    const store = new StubMetering();
    const t = start(store);
    await get(
      t,
      `/admin/usage?from=${encodeURIComponent('2026-11-06T10:00:00+02:00')}&to=2026-11-06T12:00:00Z`,
    );
    expect(store.usageQueries[0]!.from?.toISOString()).toBe('2026-11-06T08:00:00.000Z');
    expect(store.usageQueries[0]!.to?.toISOString()).toBe('2026-11-06T12:00:00.000Z');
  });

  it.each([
    ['from=yesterday', /"from"/],
    ['to=2026-13-01', /"to"/],
    ['from=2026-02-30', /"from"/],
    ['from=2026-11-06T10:00:00', /"from"/], // no time zone
    ['from=2026-11-10&to=2026-11-01', /earlier/],
    ['from=2026-11-06T10:00:00Z&to=2026-11-06T10:00:00Z', /earlier/],
    ['key=a&key=b', /"key"/],
    [`key=${'x'.repeat(201)}`, /too long/],
  ])('rejects %s with 400', async (query, message) => {
    const store = new StubMetering();
    const t = start(store);
    const res = await get(t, `/admin/usage?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(message);
    expect(res.json().error.code).toBe('invalid_query');
    expect(store.usageQueries).toHaveLength(0);
  });
});

describe('GET /admin/logs', () => {
  it('defaults to 50 rows, newest first, with no filters', async () => {
    const store = new StubMetering();
    const t = start(store);
    const res = await get(t, '/admin/logs');
    expect(res.statusCode).toBe(200);
    expect(store.logQueries[0]).toEqual({
      keyId: null,
      status: null,
      from: null,
      to: null,
      limit: 50,
      before: null,
    });
    expect(res.json()).toMatchObject({ data: [], limit: 50, next_cursor: null });
  });

  it('caps the limit instead of failing, and rejects nonsense', async () => {
    const store = new StubMetering();
    const t = start(store);
    expect((await get(t, '/admin/logs?limit=100000')).json().limit).toBe(MAX_LOG_LIMIT);
    expect(store.logQueries[0]!.limit).toBe(MAX_LOG_LIMIT);
    for (const bad of ['0', '-5', 'abc', '1.5', '1e3']) {
      const res = await get(t, `/admin/logs?limit=${bad}`);
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('filters by key, status and window', async () => {
    const store = new StubMetering();
    const t = start(store);
    await get(t, '/admin/logs?key=search&status=rejected_budget&from=2026-11-01&limit=5');
    expect(store.logQueries[0]).toMatchObject({
      keyId: 1,
      status: 'rejected_budget',
      limit: 5,
    });
    expect(store.logQueries[0]!.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('rejects an unknown status, listing the valid ones', async () => {
    const t = start(new StubMetering());
    const res = await get(t, '/admin/logs?status=bogus');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('cache_hit');
  });

  it('answers 404 for an unknown key', async () => {
    const t = start(new StubMetering());
    expect((await get(t, '/admin/logs?key=nobody')).statusCode).toBe(404);
  });

  it('accepts only a cursor that this endpoint produced', async () => {
    const store = new StubMetering();
    const t = start(store);
    const good = '2026-11-06T10:00:00.123456Z_0d6b1c8e-5f0a-4c53-9b34-1c2d3e4f5a6b';
    expect((await get(t, `/admin/logs?cursor=${good}`)).statusCode).toBe(200);
    expect(store.logQueries[0]!.before).toEqual({
      createdAt: '2026-11-06T10:00:00.123456Z',
      requestId: '0d6b1c8e-5f0a-4c53-9b34-1c2d3e4f5a6b',
    });
    for (const bad of [
      'abc',
      "2026-11-06T10:00:00Z_'; DROP TABLE request_logs;--",
      good.slice(0, -1),
    ]) {
      const res = await get(t, `/admin/logs?cursor=${encodeURIComponent(bad)}`);
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('shapes rows without any secret, and returns the next cursor', async () => {
    const store = new StubMetering();
    store.page = {
      rows: [
        {
          requestId: '0d6b1c8e-5f0a-4c53-9b34-1c2d3e4f5a6b',
          createdAt: '2026-11-06T10:00:00.123456Z',
          keyId: 1,
          team: 'search',
          keyHint: '…2b3c',
          requestedModel: 'auto',
          resolvedModel: 'alpha-small',
          resolvedProvider: 'alpha',
          status: 'ok',
          httpStatus: 200,
          errorCode: null,
          promptTokens: 10,
          completionTokens: 20,
          costUnits: 1_500n,
          cache: 'miss',
          fallback: false,
          retries: 1,
          routeReason: 'simple: short factual question',
          usageEstimated: false,
          latencyMs: 42,
          timeToFirstTokenMs: 7,
        },
      ],
      nextCursor: {
        createdAt: '2026-11-06T10:00:00.123456Z',
        requestId: '0d6b1c8e-5f0a-4c53-9b34-1c2d3e4f5a6b',
      },
    };
    const t = start(store);
    const res = await get(t, '/admin/logs?limit=1');
    const body = res.json();
    expect(body.data[0]).toEqual({
      request_id: '0d6b1c8e-5f0a-4c53-9b34-1c2d3e4f5a6b',
      created_at: '2026-11-06T10:00:00.123456Z',
      key_id: 1,
      team: 'search',
      key_hint: '…2b3c',
      requested_model: 'auto',
      resolved_model: 'alpha-small',
      resolved_provider: 'alpha',
      status: 'ok',
      http_status: 200,
      error_code: null,
      prompt_tokens: 10,
      completion_tokens: 20,
      cost_usd: '0.00001500',
      cache: 'miss',
      fallback: false,
      retries: 1,
      route_reason: 'simple: short factual question',
      usage_estimated: false,
      latency_ms: 42,
      time_to_first_token_ms: 7,
    });
    expect(body.next_cursor).toBe(
      '2026-11-06T10:00:00.123456Z_0d6b1c8e-5f0a-4c53-9b34-1c2d3e4f5a6b',
    );
    expect(res.payload).not.toMatch(/key_hash|api_key|mock-key|prism-sk/);
  });
});
