/**
 * Database CLI:  `db.ts migrate` | `db.ts seed` | `db.ts setup` (migrate, then seed).
 * Uses the same env vars and data files as the gateway.
 */
import { ConfigError, loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { loadAllConfig, prepareDatabase } from '../startup.js';

const COMMANDS = ['migrate', 'seed', 'setup'] as const;
type Command = (typeof COMMANDS)[number];

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (command === undefined || !COMMANDS.includes(command)) {
    console.error(`Usage: db <${COMMANDS.join('|')}>`);
    process.exit(2);
  }

  let env;
  let loaded;
  try {
    env = loadEnv(process.env, { requireAdminToken: false, requireRedis: false });
    loaded = loadAllConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const pool = createPool({
    connectionString: env.databaseUrl,
    max: 2,
    connectionTimeoutMs: env.dbConnectTimeoutMs,
  });
  const log = {
    info: (obj: object, msg: string) => console.log(msg, JSON.stringify(obj)),
    warn: (obj: object, msg: string) => console.warn(msg, JSON.stringify(obj)),
  };
  try {
    // `migrate` runs migrations only; `seed` and `setup` also seed (migrations are idempotent).
    await prepareDatabase(pool, loaded.tenants, { seed: command !== 'migrate', log });
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
