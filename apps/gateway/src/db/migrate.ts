import { createHash } from 'node:crypto';
import { migrations as defaultMigrations, type Migration } from './migrations.js';
import type { Pool } from './pool.js';

/** Arbitrary constant: one advisory lock serializes concurrent migration runs (edge case 11.4). */
const MIGRATION_LOCK_KEY = 7_243_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Applies pending migrations in order, each inside its own transaction.
 * Safe to run repeatedly and from several gateway instances at once.
 */
export async function runMigrations(
  pool: Pool,
  migrations: Migration[] = defaultMigrations,
): Promise<MigrationResult> {
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id         TEXT PRIMARY KEY,
          checksum   TEXT        NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ id: string; checksum: string }>(
        'SELECT id, checksum FROM schema_migrations',
      );
      const applied = new Map(rows.map((row) => [row.id, row.checksum]));

      for (const migration of migrations) {
        const expected = checksum(migration.sql);
        const existing = applied.get(migration.id);
        if (existing !== undefined) {
          if (existing !== expected) {
            throw new Error(
              `Migration ${migration.id} was modified after it was applied. ` +
                'Add a new migration instead of editing an existing one.',
            );
          }
          result.alreadyApplied.push(migration.id);
          continue;
        }
        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
            migration.id,
            expected,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${migration.id} failed: ${(err as Error).message}`, {
            cause: err,
          });
        }
        result.applied.push(migration.id);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return result;
}
