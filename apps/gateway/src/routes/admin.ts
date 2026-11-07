import type { FastifyPluginAsync } from 'fastify';
import type { CacheKeyStats, CacheStore } from '../cache/store.js';
import { verifyAdminToken } from '../http/auth.js';
import { serviceUnavailable } from '../http/errors.js';
import type { MeteringStore } from '../metering/store.js';
import { registerMeteringRoutes } from './adminMetering.js';

export interface AdminRouteDeps {
  /** The expected token. Compared in constant time and never logged. */
  adminToken: string;
  /** Source of `/admin/cache/stats`; `null` when the cache is not configured. */
  cache?: CacheStore | null;
  /** Source of `/admin/usage` and `/admin/logs`; without it those routes answer 503. */
  metering?: MeteringStore | null;
  /** Clock for the budget period; tests fix it. */
  now?: () => Date;
}

/**
 * The one definition of the cache hit rate, used by `/admin/cache/stats` and by the console:
 * hits divided by the requests that were served (`ok` or `cache_hit`) for keys with the cache on.
 * Requests that failed or were rejected never reached the cache decision and are not counted; a
 * time-sensitive request is served by a provider and counts as a miss.
 */
export const HIT_RATE_DEFINITION =
  'cache hits / served requests (status ok or cache_hit) of keys with the cache enabled';

function rate(hits: number, served: number): number {
  return served === 0 ? 0 : Math.round((hits / served) * 10_000) / 10_000;
}

function keyView(key: CacheKeyStats) {
  // A key with the cache off never looks anything up, so it has no hit rate to report.
  const counted = key.cacheEnabled;
  return {
    key_id: key.keyId,
    team: key.team,
    key_hint: key.keyHint,
    cache_enabled: key.cacheEnabled,
    similarity_threshold: key.threshold,
    hits: counted ? key.hits : 0,
    misses: counted ? key.served - key.hits : 0,
    hit_rate: counted ? rate(key.hits, key.served) : 0,
    entries: key.entries,
    stored_hit_count: key.storedHits,
  };
}

/**
 * The admin plane (`/admin/*`). Every route registered in this plugin requires the
 * `x-admin-token` header; virtual keys are not accepted here (decision D10) and the admin token is
 * not accepted on the data plane.
 */
export const adminRoutes =
  (deps: AdminRouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', async (request) => {
      verifyAdminToken(deps.adminToken, request.headers['x-admin-token']);
    });

    // Lets the console check that a token works before it shows anything.
    app.get('/admin/ping', async () => ({ status: 'ok' }));

    registerMeteringRoutes(app, deps.metering ?? null, deps.now);

    app.get('/admin/cache/stats', async (request) => {
      if (deps.cache === undefined || deps.cache === null) {
        return {
          definition: HIT_RATE_DEFINITION,
          enabled: false,
          overall: { hits: 0, misses: 0, hit_rate: 0, entries: 0, stored_hit_count: 0 },
          keys: [],
        };
      }
      let stats;
      try {
        stats = await deps.cache.stats();
      } catch (err) {
        request.log.error({ err }, 'cache stats unavailable');
        throw serviceUnavailable('Cache statistics are temporarily unavailable.');
      }
      const keys = stats.keys.map(keyView);
      const hits = keys.reduce((sum, key) => sum + key.hits, 0);
      const misses = keys.reduce((sum, key) => sum + key.misses, 0);
      return {
        definition: HIT_RATE_DEFINITION,
        enabled: true,
        overall: {
          hits,
          misses,
          hit_rate: rate(hits, hits + misses),
          entries: keys.reduce((sum, key) => sum + key.entries, 0),
          stored_hit_count: keys.reduce((sum, key) => sum + key.stored_hit_count, 0),
        },
        keys,
      };
    });
  };
