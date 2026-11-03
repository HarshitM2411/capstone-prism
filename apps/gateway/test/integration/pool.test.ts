import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDatabase,
  createPool,
  verifyVectorExtension,
  waitForDatabase,
  type Pool,
} from '../../src/db/pool.js';
import { freshPool, testDatabaseUrl } from '../helpers/testDb.js';

const pools: Pool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
});

function track(pool: Pool): Pool {
  pools.push(pool);
  return pool;
}

/** A pool pointing at a port nothing listens on. */
function deadPool(): Pool {
  return track(
    createPool({
      connectionString: 'postgres://prism:prism@127.0.0.1:1/prism',
      max: 2,
      connectionTimeoutMs: 300,
    }),
  );
}

describe('waitForDatabase', () => {
  it('returns immediately when Postgres is up', async () => {
    const pool = track(await freshPool());
    await expect(waitForDatabase(pool, { timeoutMs: 2000 })).resolves.toBeUndefined();
  });

  it('gives up with a clear error when Postgres never appears (edge case 11.1)', async () => {
    const retries: string[] = [];
    const started = Date.now();

    await expect(
      waitForDatabase(deadPool(), {
        timeoutMs: 1200,
        intervalMs: 200,
        onRetry: (err) => retries.push(err.message),
      }),
    ).rejects.toThrow(/did not become available within 1200 ms/);

    expect(retries.length).toBeGreaterThan(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('checkDatabase', () => {
  it('resolves while Postgres answers', async () => {
    const pool = track(await freshPool());
    await expect(checkDatabase(pool)).resolves.toBeUndefined();
  });

  it('rejects quickly when Postgres is unreachable', async () => {
    const started = Date.now();
    await expect(checkDatabase(deadPool(), 500)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('pool limits (edge case 11.3)', () => {
  it('fails fast instead of hanging when every connection is busy', async () => {
    await freshPool().then((p) => p.end()); // make sure the test database exists
    const pool = track(
      createPool({ connectionString: testDatabaseUrl(), max: 1, connectionTimeoutMs: 300 }),
    );
    const held = await pool.connect();
    const started = Date.now();

    await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout/i);

    expect(Date.now() - started).toBeLessThan(2000);
    held.release();
    await expect(pool.query('SELECT 1')).resolves.toBeDefined();
  });
});

describe('verifyVectorExtension', () => {
  it('rejects with an actionable message when pgvector is missing', async () => {
    const pool = track(await freshPool()); // empty schema: no extension yet
    await expect(verifyVectorExtension(pool)).rejects.toThrow(/pgvector/);
  });

  it('passes once the extension exists', async () => {
    const pool = track(await freshPool());
    await pool.query('CREATE EXTENSION vector');
    await expect(verifyVectorExtension(pool)).resolves.toBeUndefined();
  });
});
