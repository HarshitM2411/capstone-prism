import { join } from 'node:path';
import {
  describeConfig,
  knownModelNames,
  loadGatewayConfig,
  readJsonFile,
  type GatewayConfig,
} from './config/gatewayConfig.js';
import type { Env } from './config/env.js';
import { seedTenants, type SeedResult } from './db/keys.js';
import { runMigrations, type MigrationResult } from './db/migrate.js';
import { verifyVectorExtension, waitForDatabase, type Pool } from './db/pool.js';
import { parseSeedFile, type SeedTenant } from './seed/seedFile.js';

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface LoadedConfig {
  config: GatewayConfig;
  tenants: SeedTenant[];
}

/** Loads and validates everything file-based. Throws `ConfigError` (fail fast) on any problem. */
export function loadAllConfig(env: Pick<Env, 'dataDir' | 'gatewayConfigFile'>): LoadedConfig {
  const config = loadGatewayConfig(env.dataDir, env.gatewayConfigFile);
  const seedJson = readJsonFile(join(env.dataDir, 'seed_keys.json'), 'seed_keys.json');
  const tenants = parseSeedFile(seedJson, { knownModelNames: knownModelNames(config) });
  return { config, tenants };
}

export interface DatabaseReady {
  migrations: MigrationResult;
  seed: SeedResult | null;
}

/** Waits for Postgres, applies migrations, checks pgvector, and (optionally) seeds tenants. */
export async function prepareDatabase(
  pool: Pool,
  tenants: SeedTenant[],
  options: { seed: boolean; log: Logger },
): Promise<DatabaseReady> {
  await waitForDatabase(pool, {
    onRetry: (err) => options.log.warn({ err: err.message }, 'waiting for postgres'),
  });
  const migrations = await runMigrations(pool);
  options.log.info(
    { applied: migrations.applied, alreadyApplied: migrations.alreadyApplied },
    'migrations complete',
  );
  await verifyVectorExtension(pool);
  const seed = options.seed ? await seedTenants(pool, tenants) : null;
  if (seed !== null) options.log.info(seed, 'tenant seed complete');
  return { migrations, seed };
}

export { describeConfig };
