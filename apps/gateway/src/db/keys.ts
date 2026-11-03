import { createHash } from 'node:crypto';
import { fromSqlNumeric, toSqlNumeric } from '../money.js';
import type { SeedTenant } from '../seed/seedFile.js';
import type { Pool } from './pool.js';

/** Virtual keys are looked up by this hash; the raw key is never stored. */
export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/** Last four characters, for the console to tell keys apart without revealing them. */
export function keyHint(rawKey: string): string {
  return `…${rawKey.slice(-4)}`;
}

export type KeyStatus = 'active' | 'disabled';

export interface VirtualKey {
  id: number;
  team: string;
  status: KeyStatus;
  keyHint: string;
  /** Monthly budget in units of 1e-8 USD. */
  monthlyBudgetUnits: bigint;
  rpmLimit: number;
  tpmLimit: number | null;
  allowedModels: string[];
  cacheEnabled: boolean;
  cacheThreshold: number | null;
  createdAt: Date;
}

interface VirtualKeyRow {
  id: string;
  team: string;
  status: KeyStatus;
  key_hint: string;
  monthly_budget_usd: string;
  rpm_limit: number;
  tpm_limit: number | null;
  allowed_models: string[];
  cache_enabled: boolean;
  cache_threshold: string | null;
  created_at: Date;
}

const KEY_COLUMNS = `id, team, status, key_hint, monthly_budget_usd, rpm_limit, tpm_limit,
  allowed_models, cache_enabled, cache_threshold, created_at`;

function mapKey(row: VirtualKeyRow): VirtualKey {
  return {
    id: Number(row.id),
    team: row.team,
    status: row.status,
    keyHint: row.key_hint,
    monthlyBudgetUnits: fromSqlNumeric(row.monthly_budget_usd),
    rpmLimit: row.rpm_limit,
    tpmLimit: row.tpm_limit,
    allowedModels: row.allowed_models,
    cacheEnabled: row.cache_enabled,
    cacheThreshold: row.cache_threshold === null ? null : Number(row.cache_threshold),
    createdAt: row.created_at,
  };
}

/** Auth lookup: resolves a raw key (hashed here) to its tenant, or `null` if unknown. */
export async function findKeyByRawKey(pool: Pool, rawKey: string): Promise<VirtualKey | null> {
  const { rows } = await pool.query<VirtualKeyRow>(
    `SELECT ${KEY_COLUMNS} FROM virtual_keys WHERE key_hash = $1`,
    [hashKey(rawKey)],
  );
  return rows[0] ? mapKey(rows[0]) : null;
}

export async function listKeys(pool: Pool): Promise<VirtualKey[]> {
  const { rows } = await pool.query<VirtualKeyRow>(
    `SELECT ${KEY_COLUMNS} FROM virtual_keys ORDER BY id`,
  );
  return rows.map(mapKey);
}

export interface SeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Idempotently loads tenants. A tenant is identified by its `team`: re-running the seed with the
 * same data changes nothing (not even `updated_at`); changed policy values are updated in place.
 * `status` is never touched by the seed, so a key disabled in the database stays disabled.
 * Tenants absent from the seed file are left alone.
 */
export async function seedTenants(pool: Pool, tenants: SeedTenant[]): Promise<SeedResult> {
  const result: SeedResult = { inserted: 0, updated: 0, unchanged: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const tenant of tenants) {
      const rawKey = tenant.virtualKey.reveal();
      const { rows } = await client.query<{ inserted: boolean }>(
        `INSERT INTO virtual_keys
           (key_hash, key_hint, team, monthly_budget_usd, rpm_limit, tpm_limit,
            allowed_models, cache_enabled, cache_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (team) DO UPDATE SET
           key_hash = EXCLUDED.key_hash,
           key_hint = EXCLUDED.key_hint,
           monthly_budget_usd = EXCLUDED.monthly_budget_usd,
           rpm_limit = EXCLUDED.rpm_limit,
           tpm_limit = EXCLUDED.tpm_limit,
           allowed_models = EXCLUDED.allowed_models,
           cache_enabled = EXCLUDED.cache_enabled,
           cache_threshold = EXCLUDED.cache_threshold,
           updated_at = now()
         WHERE (virtual_keys.key_hash, virtual_keys.monthly_budget_usd, virtual_keys.rpm_limit,
                virtual_keys.tpm_limit, virtual_keys.allowed_models, virtual_keys.cache_enabled,
                virtual_keys.cache_threshold)
           IS DISTINCT FROM
               (EXCLUDED.key_hash, EXCLUDED.monthly_budget_usd, EXCLUDED.rpm_limit,
                EXCLUDED.tpm_limit, EXCLUDED.allowed_models, EXCLUDED.cache_enabled,
                EXCLUDED.cache_threshold)
         RETURNING (xmax = 0) AS inserted`,
        [
          hashKey(rawKey),
          keyHint(rawKey),
          tenant.team,
          toSqlNumeric(tenant.monthlyBudgetUnits),
          tenant.rpmLimit,
          tenant.tpmLimit,
          tenant.allowedModels,
          tenant.cacheEnabled,
          tenant.cacheThreshold,
        ],
      );
      const row = rows[0];
      if (row === undefined) result.unchanged += 1;
      else if (row.inserted) result.inserted += 1;
      else result.updated += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if ((err as { code?: string }).code === '23505') {
      throw new Error(
        'Seeding failed: a virtual key value is already used by a different team. ' +
          'Each tenant needs a unique key.',
        { cause: err },
      );
    }
    throw err;
  } finally {
    client.release();
  }
  return result;
}
