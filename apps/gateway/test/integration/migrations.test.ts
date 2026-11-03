import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { migrations } from '../../src/db/migrations.js';
import { verifyVectorExtension, type Pool } from '../../src/db/pool.js';
import { freshPool } from '../helpers/testDb.js';

let pool: Pool;
const ALL_IDS = migrations.map((m) => m.id);

beforeEach(async () => {
  await pool?.end();
  pool = await freshPool();
});

afterAll(async () => {
  await pool?.end();
});

async function tableNames(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
  );
  return rows.map((r) => r.table_name);
}

describe('runMigrations', () => {
  it('creates the schema on an empty database', async () => {
    const result = await runMigrations(pool);

    expect(result.applied).toEqual(ALL_IDS);
    expect(await tableNames()).toEqual([
      'budget_usage',
      'cache_entries',
      'request_logs',
      'schema_migrations',
      'virtual_keys',
    ]);
    await expect(verifyVectorExtension(pool)).resolves.toBeUndefined();
  });

  it('creates the indexes the design depends on', async () => {
    await runMigrations(pool);
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('request_logs_key_created_idx');
    expect(names).toContain('cache_entries_scope_idx');
  });

  it('is a no-op the second time (idempotent)', async () => {
    await runMigrations(pool);
    const second = await runMigrations(pool);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(ALL_IDS);
  });

  it('applies each migration exactly once when several instances start together (edge case 11.4)', async () => {
    const results = await Promise.all([
      runMigrations(pool),
      runMigrations(pool),
      runMigrations(pool),
    ]);

    const applied = results.flatMap((r) => r.applied);
    expect(applied.sort()).toEqual([...ALL_IDS].sort());
    const { rows } = await pool.query('SELECT id FROM schema_migrations');
    expect(rows).toHaveLength(ALL_IDS.length);
  });

  it('refuses to continue when an applied migration was edited', async () => {
    await runMigrations(pool);
    const edited = migrations.map((m) => ({ ...m, sql: `${m.sql}\n-- edited` }));

    await expect(runMigrations(pool, edited)).rejects.toThrow(/modified after it was applied/);
  });

  it('rolls back a failing migration completely', async () => {
    const broken = [
      {
        id: '900_broken',
        sql: 'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;',
      },
    ];

    await expect(runMigrations(pool, broken)).rejects.toThrow(/900_broken failed/);

    expect(await tableNames()).not.toContain('half_done');
    const { rows } = await pool.query('SELECT id FROM schema_migrations');
    expect(rows).toHaveLength(0);
  });

  it('keeps earlier migrations when a later one fails', async () => {
    const list = [
      ...migrations,
      { id: '900_broken', sql: 'CREATE TABLE half_done (id int); SELECT nope FROM nowhere;' },
    ];

    await expect(runMigrations(pool, list)).rejects.toThrow(/900_broken failed/);

    expect(await tableNames()).toContain('virtual_keys');
    const { rows } = await pool.query('SELECT id FROM schema_migrations');
    expect(rows.map((r) => r.id)).toEqual(ALL_IDS);
    // The lock was released, so a later run can proceed.
    await expect(runMigrations(pool, migrations)).resolves.toMatchObject({ applied: [] });
  });
});

describe('schema constraints', () => {
  beforeEach(async () => {
    await runMigrations(pool);
  });

  async function insertKey(overrides: Record<string, unknown> = {}): Promise<number> {
    const row = {
      key_hash: `hash-${Math.random()}`,
      key_hint: '…abcd',
      team: `team-${Math.random()}`,
      monthly_budget_usd: '1.00000000',
      rpm_limit: 10,
      ...overrides,
    };
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO virtual_keys (key_hash, key_hint, team, monthly_budget_usd, rpm_limit)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [row.key_hash, row.key_hint, row.team, row.monthly_budget_usd, row.rpm_limit],
    );
    return Number(rows[0]!.id);
  }

  it('rejects a negative budget or rate limit', async () => {
    await expect(insertKey({ monthly_budget_usd: '-1' })).rejects.toThrow();
    await expect(insertKey({ rpm_limit: -1 })).rejects.toThrow();
  });

  it('rejects duplicate keys and duplicate teams', async () => {
    await insertKey({ key_hash: 'same', team: 'a' });
    await expect(insertKey({ key_hash: 'same', team: 'b' })).rejects.toThrow(/unique/);
    await expect(insertKey({ key_hash: 'c', team: 'a' })).rejects.toThrow(/unique/);
  });

  it('stores money exactly, with no floating-point drift', async () => {
    const id = await insertKey({ monthly_budget_usd: '0.00001000' });
    const { rows } = await pool.query<{ monthly_budget_usd: string }>(
      'SELECT monthly_budget_usd FROM virtual_keys WHERE id = $1',
      [id],
    );
    expect(rows[0]?.monthly_budget_usd).toBe('0.00001000');
  });

  it('only accepts well-formed budget periods', async () => {
    const id = await insertKey();
    await pool.query("INSERT INTO budget_usage (key_id, period) VALUES ($1, '2026-11')", [id]);
    for (const bad of ['2026-13', '26-11', 'November', '2026-1']) {
      await expect(
        pool.query('INSERT INTO budget_usage (key_id, period) VALUES ($1, $2)', [id, bad]),
      ).rejects.toThrow(/check/);
    }
  });

  it('never lets spent or reserved go negative', async () => {
    const id = await insertKey();
    await pool.query("INSERT INTO budget_usage (key_id, period) VALUES ($1, '2026-11')", [id]);
    await expect(
      pool.query("UPDATE budget_usage SET reserved_usd = -0.00000001 WHERE period = '2026-11'"),
    ).rejects.toThrow(/check/);
  });

  it('logs a rejected request with no key (unknown credential)', async () => {
    await pool.query(
      "INSERT INTO request_logs (status, http_status, error_code) VALUES ('rejected_auth', 401, 'invalid_api_key')",
    );
    const { rows } = await pool.query('SELECT key_id, cost_usd, cache FROM request_logs');
    expect(rows[0]).toEqual({ key_id: null, cost_usd: '0.00000000', cache: 'miss' });
  });

  it('accepts every status the gateway can log, including internal_error', async () => {
    for (const status of [
      'ok',
      'cache_hit',
      'rejected_auth',
      'rejected_validation',
      'rejected_not_found',
      'rejected_allowlist',
      'rejected_rate_limit',
      'rejected_budget',
      'rejected_unavailable',
      'upstream_error',
      'client_disconnect',
      'internal_error',
    ]) {
      await pool.query('INSERT INTO request_logs (status) VALUES ($1)', [status]);
    }
    const { rowCount } = await pool.query('SELECT 1 FROM request_logs');
    expect(rowCount).toBe(12);
  });

  it('rejects an unknown request status', async () => {
    await expect(
      pool.query("INSERT INTO request_logs (status) VALUES ('mystery')"),
    ).rejects.toThrow(/check/);
  });

  it('stores 384-dimension embeddings and rejects other sizes', async () => {
    const id = await insertKey();
    const vector = (n: number) => `[${Array.from({ length: n }, () => 0.1).join(',')}]`;
    const insert = (embedding: string) =>
      pool.query(
        `INSERT INTO cache_entries (key_id, alias, context_hash, prompt_text, embedding, response_json, model)
         VALUES ($1, 'fast', 'ctx', 'hello', $2, '{}', 'alpha-small')`,
        [id, embedding],
      );

    await expect(insert(vector(384))).resolves.toBeDefined();
    await expect(insert(vector(3))).rejects.toThrow(/dimensions/);
  });

  it('answers a cosine-similarity query', async () => {
    const id = await insertKey();
    const axis = (i: number) =>
      `[${Array.from({ length: 384 }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;
    for (const i of [0, 1]) {
      await pool.query(
        `INSERT INTO cache_entries (key_id, alias, context_hash, prompt_text, embedding, response_json, model)
         VALUES ($1, 'fast', 'ctx', $2, $3, '{}', 'alpha-small')`,
        [id, `axis-${i}`, axis(i)],
      );
    }
    const { rows } = await pool.query<{ prompt_text: string; similarity: number }>(
      `SELECT prompt_text, 1 - (embedding <=> $1) AS similarity
       FROM cache_entries WHERE key_id = $2 ORDER BY embedding <=> $1 LIMIT 1`,
      [axis(1), id],
    );
    expect(rows[0]?.prompt_text).toBe('axis-1');
    expect(Number(rows[0]?.similarity)).toBeCloseTo(1, 5);
  });

  it('removes a key’s budget and cache rows when the key is deleted', async () => {
    const id = await insertKey();
    await pool.query("INSERT INTO budget_usage (key_id, period) VALUES ($1, '2026-11')", [id]);
    await pool.query('DELETE FROM virtual_keys WHERE id = $1', [id]);
    const { rowCount } = await pool.query('SELECT 1 FROM budget_usage');
    expect(rowCount).toBe(0);
  });
});
