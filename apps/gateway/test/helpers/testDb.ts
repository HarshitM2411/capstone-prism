import pg from 'pg';
import { createPool, type Pool } from '../../src/db/pool.js';

/**
 * Integration tests run against the Postgres from `docker compose up -d postgres`, in a
 * dedicated `prism_test` database so the demo data is never touched.
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://prism:prism@localhost:5432/postgres';
const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'prism_test';

export function testDatabaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function ensureTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      'Integration tests need Postgres. Start it with `docker compose up -d postgres` ' +
        `(or set TEST_DATABASE_ADMIN_URL). Original error: ${(err as Error).message}`,
      { cause: err },
    );
  }
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      TEST_DB,
    ]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE ${TEST_DB}`);
    }
  } finally {
    await admin.end();
  }
}

/** A pool on a completely empty `public` schema (extensions included). */
export async function freshPool(max = 5): Promise<Pool> {
  await ensureTestDatabase();
  const pool = createPool({
    connectionString: testDatabaseUrl(),
    max,
    connectionTimeoutMs: 5000,
  });
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  return pool;
}
