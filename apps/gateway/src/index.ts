import { buildApp } from './app.js';
import { ConfigError, loadEnv, type Env } from './config/env.js';
import { checkDatabase, createPool } from './db/pool.js';
import { describeConfig, loadAllConfig, prepareDatabase, type LoadedConfig } from './startup.js';

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
  const app = buildApp({
    logLevel: env.logLevel,
    healthChecks: { postgres: () => checkDatabase(pool) },
  });

  app.log.info(describeConfig(loaded.config), 'gateway configuration loaded');

  // 2. Storage: wait for Postgres, migrate, verify pgvector, seed tenants.
  try {
    await prepareDatabase(pool, loaded.tenants, { seed: env.seedOnStart, log: app.log });
  } catch (err) {
    app.log.error({ err }, 'database preparation failed');
    process.exit(1);
  }

  // Graceful shutdown: stop accepting new connections and let in-flight requests finish.
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
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
