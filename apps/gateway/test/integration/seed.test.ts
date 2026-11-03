import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { findKeyByRawKey, hashKey, listKeys, seedTenants } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from '../../src/db/pool.js';
import { Secret } from '../../src/secret.js';
import type { SeedTenant } from '../../src/seed/seedFile.js';
import { loadAllConfig } from '../../src/startup.js';
import { DATA_DIR } from '../helpers/dataDir.js';
import { freshPool } from '../helpers/testDb.js';

let pool: Pool;
let tenants: SeedTenant[];

beforeEach(async () => {
  await pool?.end();
  pool = await freshPool();
  await runMigrations(pool);
  tenants = loadAllConfig({
    dataDir: DATA_DIR,
    gatewayConfigFile: 'gateway_config.sample.json',
  }).tenants;
});

afterAll(async () => {
  await pool?.end();
});

const RAW_KEYS = [
  'prism-sk-search-1a2b3c',
  'prism-sk-research-4d5e6f',
  'prism-sk-free-7g8h9i',
  'prism-sk-budget-demo-0j1k2l',
];

describe('seedTenants', () => {
  it('inserts the four sample tenants', async () => {
    expect(await seedTenants(pool, tenants)).toEqual({ inserted: 4, updated: 0, unchanged: 0 });

    const keys = await listKeys(pool);
    expect(keys.map((k) => k.team)).toEqual(['search', 'research', 'free-tier', 'budget-demo']);
    expect(keys.every((k) => k.status === 'active')).toBe(true);
  });

  it('makes every seed key resolvable by its raw value', async () => {
    await seedTenants(pool, tenants);

    const search = await findKeyByRawKey(pool, 'prism-sk-search-1a2b3c');
    expect(search).toMatchObject({
      team: 'search',
      monthlyBudgetUnits: 5_000_000_000n,
      rpmLimit: 60,
      tpmLimit: 100000,
      allowedModels: ['fast'],
      cacheEnabled: true,
      cacheThreshold: 0.92,
    });
    const demo = await findKeyByRawKey(pool, 'prism-sk-budget-demo-0j1k2l');
    expect(demo).toMatchObject({
      team: 'budget-demo',
      monthlyBudgetUnits: 1000n,
      cacheEnabled: false,
    });
    for (const key of RAW_KEYS) {
      expect(await findKeyByRawKey(pool, key)).not.toBeNull();
    }
  });

  it('returns null for an unknown, empty or near-miss key', async () => {
    await seedTenants(pool, tenants);
    for (const key of ['', 'nope', 'prism-sk-search-1a2b3', 'PRISM-SK-SEARCH-1A2B3C']) {
      expect(await findKeyByRawKey(pool, key)).toBeNull();
    }
  });

  it('stores only a hash of the key, never the raw value (edge case 2.10)', async () => {
    await seedTenants(pool, tenants);
    const { rows } = await pool.query('SELECT * FROM virtual_keys');
    const dump = JSON.stringify(rows);
    for (const key of RAW_KEYS) expect(dump).not.toContain(key);
    expect(rows.map((r) => r.key_hash)).toContain(hashKey('prism-sk-search-1a2b3c'));
    expect(rows.find((r) => r.team === 'search')?.key_hint).toBe('…2b3c');
  });

  it('is a true no-op when re-run (exit criterion)', async () => {
    await seedTenants(pool, tenants);
    const before = await pool.query('SELECT id, updated_at FROM virtual_keys ORDER BY id');

    const second = await seedTenants(pool, tenants);
    const third = await seedTenants(pool, tenants);

    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 4 });
    expect(third).toEqual({ inserted: 0, updated: 0, unchanged: 4 });
    const after = await pool.query('SELECT id, updated_at FROM virtual_keys ORDER BY id');
    expect(after.rows).toEqual(before.rows); // same ids, same updated_at: nothing was touched
  });

  it('updates only the tenant whose policy changed', async () => {
    await seedTenants(pool, tenants);
    const changed = tenants.map((t) => (t.team === 'search' ? { ...t, rpmLimit: 999 } : t));

    expect(await seedTenants(pool, changed)).toEqual({ inserted: 0, updated: 1, unchanged: 3 });
    const search = await findKeyByRawKey(pool, 'prism-sk-search-1a2b3c');
    expect(search?.rpmLimit).toBe(999);
  });

  it('never re-enables a key that was disabled in the database', async () => {
    await seedTenants(pool, tenants);
    await pool.query("UPDATE virtual_keys SET status = 'disabled' WHERE team = 'free-tier'");

    await seedTenants(pool, tenants);
    const changed = tenants.map((t) => (t.team === 'free-tier' ? { ...t, rpmLimit: 11 } : t));
    await seedTenants(pool, changed);

    const free = await findKeyByRawKey(pool, 'prism-sk-free-7g8h9i');
    expect(free?.status).toBe('disabled');
    expect(free?.rpmLimit).toBe(11);
  });

  it('leaves tenants that are not in the seed file alone', async () => {
    await seedTenants(pool, tenants);
    await seedTenants(pool, tenants.slice(0, 1));
    expect(await listKeys(pool)).toHaveLength(4);
  });

  it('rotates a key in place: the old value stops working, no duplicate row', async () => {
    await seedTenants(pool, tenants);
    const rotated = tenants.map((t) =>
      t.team === 'search' ? { ...t, virtualKey: new Secret('prism-sk-search-NEW999') } : t,
    );

    expect(await seedTenants(pool, rotated)).toMatchObject({ updated: 1 });

    expect(await findKeyByRawKey(pool, 'prism-sk-search-1a2b3c')).toBeNull();
    expect(await findKeyByRawKey(pool, 'prism-sk-search-NEW999')).toMatchObject({ team: 'search' });
    expect(await listKeys(pool)).toHaveLength(4);
  });

  it('fails clearly and changes nothing when a key already belongs to another team', async () => {
    await seedTenants(pool, tenants.slice(0, 2));
    const clash: SeedTenant[] = [
      { ...tenants[0]!, rpmLimit: 1 }, // would be a valid update ...
      { ...tenants[2]!, virtualKey: tenants[1]!.virtualKey }, // ... but this reuses research's key
    ];

    await expect(seedTenants(pool, clash)).rejects.toThrow(/already used by a different team/);

    // The whole seed ran in one transaction, so the first update was rolled back too.
    const search = await findKeyByRawKey(pool, 'prism-sk-search-1a2b3c');
    expect(search?.rpmLimit).toBe(60);
    expect(await listKeys(pool)).toHaveLength(2);
  });

  it('stays correct when several gateways seed at the same time', async () => {
    const results = await Promise.all([
      seedTenants(pool, tenants),
      seedTenants(pool, tenants),
      seedTenants(pool, tenants),
    ]);

    expect(await listKeys(pool)).toHaveLength(4);
    expect(results.reduce((sum, r) => sum + r.inserted, 0)).toBe(4);
  });

  it('keeps a null tokens-per-minute and a null cache threshold as null', async () => {
    const research = tenants.find((t) => t.team === 'research')!;
    await seedTenants(pool, [{ ...research, tpmLimit: null }]);

    const key = await findKeyByRawKey(pool, 'prism-sk-research-4d5e6f');
    expect(key?.tpmLimit).toBeNull();
    expect(key?.cacheThreshold).toBeNull();
    // ... and re-seeding it is still a no-op (NULLs must not look like a change).
    expect(await seedTenants(pool, [{ ...research, tpmLimit: null }])).toMatchObject({
      unchanged: 1,
    });
  });
});
