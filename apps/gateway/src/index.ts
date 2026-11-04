import { buildApp } from './app.js';
import { ConfigError, loadEnv, type Env } from './config/env.js';
import { findKeyByRawKey } from './db/keys.js';
import { checkDatabase, createPool } from './db/pool.js';
import { createRequestLogWriter } from './db/requestLogs.js';
import { PgBudgetStore, reconcileStaleReservations } from './limits/budget.js';
import { RedisRateLimiter } from './limits/rpm.js';
import { createProviderRegistry } from './providers/registry.js';
import { checkRedis, createRedis } from './redis.js';
import { describeConfig, loadAllConfig, prepareDatabase, type LoadedConfig } from './startup.js';

/** A reservation can be older than this only if its request died with the process. */
const STALE_RESERVATION_MARGIN_MS = 30_000;
const MIN_STALE_RESERVATION_MS = 120_000;
const RECONCILE_INTERVAL_MS = 60_000;

function fatal(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  // 1. Everything file- or env-based is validated before any connection is opened.
  let env: Env;
  let loaded: LoadedConfig;
  try {
    env = loadEnv();
    loaded = loadAllConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) fatal(`Configuration error: ${err.message}`);
    throw err;
  }

  const pool = createPool({
    connectionString: env.databaseUrl,
    max: env.dbPoolMax,
    connectionTimeoutMs: env.dbConnectTimeoutMs,
    onError: (err) => app.log.error({ err: err.message }, 'idle postgres client error'),
  });
  // Redis may be down at boot: the gateway still starts, `/health` reports it, and requests fail
  // closed (503) until it is back, at which point the client reconnects by itself.
  const redis = createRedis({
    url: env.redisUrl,
    commandTimeoutMs: env.redisTimeoutMs,
    onError: (err) => app.log.warn({ err: err.message }, 'redis error'),
  });
  const app = buildApp({
    logLevel: env.logLevel,
    config: loaded.config,
    keys: { findByRawKey: (rawKey) => findKeyByRawKey(pool, rawKey) },
    requestLogs: createRequestLogWriter(pool),
    rateLimiter: new RedisRateLimiter(redis),
    budget: new PgBudgetStore(pool),
    providers: createProviderRegistry(loaded.config),
    timeouts: {
      firstByteMs: env.providerFirstByteTimeoutMs,
      idleMs: env.providerIdleTimeoutMs,
      deadlineMs: env.requestDeadlineMs,
    },
    streamMaxMs: env.streamMaxDurationMs,
    adminToken: env.adminToken.reveal(),
    healthChecks: {
      postgres: () => checkDatabase(pool),
      redis: () => checkRedis(redis),
    },
  });

  app.log.info(describeConfig(loaded.config), 'gateway configuration loaded');

  // 2. Storage: wait for Postgres, migrate, verify pgvector, seed tenants.
  try {
    await prepareDatabase(pool, loaded.tenants, { seed: env.seedOnStart, log: app.log });
  } catch (err) {
    app.log.error({ err }, 'database preparation failed');
    process.exit(1);
  }

  // 3. Release budget holds that were never settled (a crash mid-request), now and periodically.
  // A hold can legitimately live as long as the longest stream, so the cutoff sits above it.
  const staleAfterMs = Math.max(
    MIN_STALE_RESERVATION_MS,
    env.streamMaxDurationMs + STALE_RESERVATION_MARGIN_MS,
  );
  const reconcile = async (): Promise<void> => {
    try {
      const cleared = await reconcileStaleReservations(pool, staleAfterMs);
      if (cleared > 0) app.log.warn({ cleared }, 'released stale budget reservations');
    } catch (err) {
      app.log.error({ err }, 'budget reservation reconciliation failed');
    }
  };
  await reconcile();
  const reconciler = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  reconciler.unref();

  // Graceful shutdown: stop accepting new connections and let in-flight requests finish.
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(reconciler);
    try {
      await app.close();
      await pool.end();
      redis.disconnect();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();
