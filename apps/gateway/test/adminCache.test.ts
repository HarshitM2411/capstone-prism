import { afterEach, describe, expect, it } from 'vitest';
import { HIT_RATE_DEFINITION } from '../src/routes/admin.js';
import { ADMIN_TOKEN, buildTestApp, type TestApp } from './helpers/app.js';
import { MemoryCache } from './helpers/memoryCache.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function get(t: TestApp, token: string | null = ADMIN_TOKEN) {
  return t.app.inject({
    method: 'GET',
    url: '/admin/cache/stats',
    headers: token === null ? {} : { 'x-admin-token': token },
  });
}

describe('GET /admin/cache/stats', () => {
  it('needs the admin token', async () => {
    current = buildTestApp({ cache: new MemoryCache() });
    expect((await get(current, null)).statusCode).toBe(401);
    expect((await get(current, 'wrong')).statusCode).toBe(401);
  });

  it('reports overall and per-key hit rates with one stated definition', async () => {
    const cache = new MemoryCache();
    cache.statsResult = {
      keys: [
        {
          keyId: 1,
          team: 'search',
          keyHint: '…2b3c',
          cacheEnabled: true,
          threshold: 0.92,
          hits: 3,
          served: 10,
          entries: 7,
          storedHits: 3,
        },
        {
          keyId: 3,
          team: 'free-tier',
          keyHint: '…9i',
          cacheEnabled: true,
          threshold: 0.85,
          hits: 1,
          served: 2,
          entries: 1,
          storedHits: 1,
        },
        {
          // The cache is off: its requests are not cache-eligible and do not dilute the rate.
          keyId: 2,
          team: 'research',
          keyHint: '…5f',
          cacheEnabled: false,
          threshold: null,
          hits: 0,
          served: 50,
          entries: 0,
          storedHits: 0,
        },
      ],
    };
    current = buildTestApp({ cache });
    const res = await get(current);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.definition).toBe(HIT_RATE_DEFINITION);
    expect(body.overall).toEqual({
      hits: 4,
      misses: 8,
      hit_rate: 0.3333,
      entries: 8,
      stored_hit_count: 4,
    });
    const byTeam = Object.fromEntries(
      body.keys.map((k: { team: string }) => [k.team, k]),
    ) as Record<string, Record<string, unknown>>;
    expect(byTeam.search).toMatchObject({ hits: 3, misses: 7, hit_rate: 0.3, entries: 7 });
    expect(byTeam['free-tier']).toMatchObject({ hit_rate: 0.5, similarity_threshold: 0.85 });
    expect(byTeam.research).toMatchObject({
      cache_enabled: false,
      hits: 0,
      misses: 0,
      hit_rate: 0,
    });
  });

  it('returns zeros, never NaN, when nothing has happened', async () => {
    const cache = new MemoryCache();
    cache.statsResult = {
      keys: [
        {
          keyId: 1,
          team: 'search',
          keyHint: '…2b3c',
          cacheEnabled: true,
          threshold: 0.92,
          hits: 0,
          served: 0,
          entries: 0,
          storedHits: 0,
        },
      ],
    };
    current = buildTestApp({ cache });
    const body = (await get(current)).json();
    expect(body.overall.hit_rate).toBe(0);
    expect(body.keys[0].hit_rate).toBe(0);
    expect(JSON.stringify(body)).not.toContain('null,"hit_rate"');
  });

  it('says so when the cache is not configured', async () => {
    current = buildTestApp();
    const res = await get(current);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, keys: [] });
  });

  it('answers 503 in the standard envelope when the database fails', async () => {
    const cache = new MemoryCache();
    cache.failStats = new Error('connection refused');
    current = buildTestApp({ cache });
    const res = await get(current);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('service_unavailable');
    expect(res.body).not.toContain('connection refused');
  });
});
