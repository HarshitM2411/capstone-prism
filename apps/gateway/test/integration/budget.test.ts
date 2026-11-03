import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { findKeyByRawKey, seedTenants } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from '../../src/db/pool.js';
import type { RequestLogEntry } from '../../src/db/requestLogs.js';
import {
  PgBudgetStore,
  budgetPeriod,
  reconcileStaleReservations,
  type Reservation,
} from '../../src/limits/budget.js';
import { fromSqlNumeric } from '../../src/money.js';
import { loadAllConfig } from '../../src/startup.js';
import { DATA_DIR } from '../helpers/dataDir.js';
import { freshPool } from '../helpers/testDb.js';

const loaded = loadAllConfig({
  dataDir: DATA_DIR,
  gatewayConfigFile: 'gateway_config.sample.json',
});

let pool: Pool;
let store: PgBudgetStore;
let keyId: number;

beforeEach(async () => {
  await pool?.end();
  pool = await freshPool(20);
  await runMigrations(pool);
  await seedTenants(pool, loaded.tenants);
  keyId = (await findKeyByRawKey(pool, 'prism-sk-search-1a2b3c'))!.id;
  store = new PgBudgetStore(pool);
});

afterAll(async () => {
  await pool?.end();
});

interface UsageRow {
  spent: bigint;
  reserved: bigint;
}

async function usage(id = keyId, period?: string): Promise<UsageRow | null> {
  const { rows } = await pool.query<{ spent_usd: string; reserved_usd: string }>(
    'SELECT spent_usd, reserved_usd FROM budget_usage WHERE key_id = $1 AND ($2::text IS NULL OR period = $2)',
    [id, period ?? null],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { spent: fromSqlNumeric(row.spent_usd), reserved: fromSqlNumeric(row.reserved_usd) };
}

async function holdCount(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM budget_reservations');
  return Number(rows[0]!.n);
}

function reserve(budgetUnits: bigint, estimateUnits: bigint, now?: Date, id = keyId) {
  return store.reserve({
    requestId: randomUUID(),
    keyId: id,
    budgetUnits,
    estimateUnits,
    ...(now === undefined ? {} : { now }),
  });
}

function logFor(reservation: Reservation, costUnits: bigint): RequestLogEntry {
  return {
    requestId: reservation.requestId,
    keyId: reservation.keyId,
    requestedModel: 'fast',
    resolvedModel: 'alpha-small',
    status: 'ok',
    httpStatus: 200,
    errorCode: null,
    promptTokens: 5,
    completionTokens: 17,
    costUnits,
    latencyMs: 3,
  };
}

async function loggedCost(id = keyId): Promise<bigint> {
  const { rows } = await pool.query<{ total: string }>(
    'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM request_logs WHERE key_id = $1',
    [id],
  );
  return fromSqlNumeric(rows[0]!.total);
}

describe('budgetPeriod', () => {
  it('is the UTC calendar month', () => {
    expect(budgetPeriod(new Date('2026-11-04T10:00:00Z'))).toBe('2026-11');
    expect(budgetPeriod(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(budgetPeriod(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12');
  });
});

describe('PgBudgetStore.reserve', () => {
  it('creates the month’s row lazily and holds the estimate', async () => {
    expect(await usage()).toBeNull();
    const r = await reserve(10_000n, 400n);

    expect(r).toMatchObject({ keyId, reservedUnits: 400n, period: budgetPeriod(new Date()) });
    expect(await usage()).toEqual({ spent: 0n, reserved: 400n });
    expect(await holdCount()).toBe(1);
  });

  it('holds only what remains when the estimate is larger than the remaining budget', async () => {
    const first = await reserve(1000n, 5000n);
    expect(first?.reservedUnits).toBe(1000n);
    expect(await usage()).toEqual({ spent: 0n, reserved: 1000n });
  });

  it('rejects once the budget is fully held or spent (strict: spent + reserved < budget)', async () => {
    expect(await reserve(1000n, 5000n)).not.toBeNull();
    expect(await reserve(1000n, 5000n)).toBeNull();
    expect(await holdCount()).toBe(1); // a rejection holds nothing
    expect(await usage()).toEqual({ spent: 0n, reserved: 1000n });
  });

  it('rejects everything when the budget is zero (edge case 5.2)', async () => {
    expect(await reserve(0n, 1n)).toBeNull();
    expect(await reserve(0n, 0n)).toBeNull();
    expect(await holdCount()).toBe(0);
  });

  it('admits at 1 unit below the budget and rejects at exactly the budget (edge case 5.3)', async () => {
    const a = await reserve(100n, 99n);
    await store.settle(a!, 99n, logFor(a!, 99n));
    expect(await reserve(100n, 50n)).not.toBeNull(); // 99 spent, 1 unit left → admitted

    await pool.query('DELETE FROM budget_reservations');
    await pool.query('UPDATE budget_usage SET spent_usd = 0.000001, reserved_usd = 0');
    expect(await reserve(100n, 50n)).toBeNull(); // spent == budget exactly
  });

  it('keeps each key’s budget separate', async () => {
    const other = (await findKeyByRawKey(pool, 'prism-sk-research-4d5e6f'))!.id;
    expect(await reserve(1000n, 5000n)).not.toBeNull();
    expect(await reserve(1000n, 5000n)).toBeNull();
    expect(await reserve(1000n, 5000n, undefined, other)).not.toBeNull();
  });

  it('creates the row exactly once when many first requests arrive together (edge case 5.10)', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => reserve(100_000n, 10n)));
    expect(results.every((r) => r !== null)).toBe(true);
    const { rows } = await pool.query('SELECT 1 FROM budget_usage WHERE key_id = $1', [keyId]);
    expect(rows).toHaveLength(1);
    expect(await usage()).toEqual({ spent: 0n, reserved: 300n });
  });

  it('never over-admits under concurrency, repeated (edge cases 5.1, 5.4)', async () => {
    // Budget 10 units, each request estimates 3: holds are 3, 3, 3, 1 → exactly 4 admitted.
    for (let run = 0; run < 10; run++) {
      await pool.query('DELETE FROM budget_usage');
      const results = await Promise.all(Array.from({ length: 25 }, () => reserve(10n, 3n)));
      const admitted = results.filter((r): r is Reservation => r !== null);
      expect(admitted, `run ${run}`).toHaveLength(4);
      expect(admitted.reduce((sum, r) => sum + r.reservedUnits, 0n)).toBe(10n);
      expect(await usage()).toEqual({ spent: 0n, reserved: 10n });
    }
  });

  it('bounds the overshoot to one request even when every admitted request overruns', async () => {
    const budget = 10n;
    const results = await Promise.all(Array.from({ length: 25 }, () => reserve(budget, 3n)));
    const admitted = results.filter((r): r is Reservation => r !== null);
    // Each request actually costs 3 units, including the one that was only held 1.
    for (const r of admitted) await store.settle(r, 3n, logFor(r, 3n));

    const row = (await usage())!;
    expect(row.spent).toBe(12n);
    expect(row.spent - budget).toBeLessThanOrEqual(3n); // at most one request's cost over
    expect(row.reserved).toBe(0n);
    expect(await reserve(budget, 3n)).toBeNull(); // and nothing more is admitted
  });

  it('starts a fresh budget in a new month and leaves the old row alone (edge case 5.11)', async () => {
    const dec = new Date('2026-12-31T23:59:59Z');
    const jan = new Date('2027-01-01T00:00:00Z');

    const old = await reserve(1000n, 5000n, dec);
    expect(old?.period).toBe('2026-12');
    expect(await reserve(1000n, 5000n, dec)).toBeNull(); // December is used up

    const fresh = await reserve(1000n, 5000n, jan);
    expect(fresh?.period).toBe('2027-01'); // January starts over
    expect(await usage(keyId, '2026-12')).toEqual({ spent: 0n, reserved: 1000n });
    expect(await usage(keyId, '2027-01')).toEqual({ spent: 0n, reserved: 1000n });

    // A request admitted in December and settled in January is still charged to December.
    await store.settle(old!, 700n, logFor(old!, 700n));
    expect(await usage(keyId, '2026-12')).toEqual({ spent: 700n, reserved: 0n });
    expect(await usage(keyId, '2027-01')).toEqual({ spent: 0n, reserved: 1000n });
  });
});

describe('PgBudgetStore.settle', () => {
  it('replaces the hold with the actual cost and writes the log row, atomically', async () => {
    const r = (await reserve(100_000n, 5000n))!;
    await store.settle(r, 1234n, logFor(r, 1234n));

    expect(await usage()).toEqual({ spent: 1234n, reserved: 0n });
    expect(await holdCount()).toBe(0);
    expect(await loggedCost()).toBe(1234n);
  });

  it('keeps spent equal to the sum of the logged costs over many requests (edge case 5.5)', async () => {
    const costs = [10n, 250n, 3n, 99n, 1n, 480n, 7n];
    const reservations = await Promise.all(costs.map(() => reserve(100_000n, 500n)));
    await Promise.all(
      reservations.map((r, i) => store.settle(r!, costs[i]!, logFor(r!, costs[i]!))),
    );

    const row = (await usage())!;
    expect(row.spent).toBe(costs.reduce((a, b) => a + b, 0n));
    expect(row.spent).toBe(await loggedCost());
    expect(row.reserved).toBe(0n);
  });

  it('can settle above the hold, which is how a request overshoots by its own cost', async () => {
    const r = (await reserve(100n, 5000n))!;
    expect(r.reservedUnits).toBe(100n);
    await store.settle(r, 400n, logFor(r, 400n));
    expect(await usage()).toEqual({ spent: 400n, reserved: 0n });
  });

  it('refuses to charge the same request twice, and leaves the totals unchanged', async () => {
    const r = (await reserve(100_000n, 500n))!;
    await store.settle(r, 300n, logFor(r, 300n));
    await expect(store.settle(r, 300n, logFor(r, 300n))).rejects.toThrow(/duplicate|unique/);

    expect(await usage()).toEqual({ spent: 300n, reserved: 0n });
    expect(await loggedCost()).toBe(300n);
  });

  it('rolls the whole settlement back when the log row cannot be written', async () => {
    const r = (await reserve(100_000n, 500n))!;
    const bad = { ...logFor(r, 300n), status: 'not-a-status' as RequestLogEntry['status'] };
    await expect(store.settle(r, 300n, bad)).rejects.toThrow();

    // Nothing was charged, and the hold is still there for a release or the reconciler.
    expect(await usage()).toEqual({ spent: 0n, reserved: 500n });
    expect(await holdCount()).toBe(1);
    await store.release(r);
    expect(await usage()).toEqual({ spent: 0n, reserved: 0n });
  });
});

describe('PgBudgetStore.release', () => {
  it('gives the hold back without charging anything', async () => {
    const r = (await reserve(100_000n, 500n))!;
    await store.release(r);
    expect(await usage()).toEqual({ spent: 0n, reserved: 0n });
    expect(await holdCount()).toBe(0);
  });

  it('is idempotent: releasing twice does not release anyone else’s hold (edge case 5.6)', async () => {
    const a = (await reserve(100_000n, 500n))!;
    const b = (await reserve(100_000n, 700n))!;
    await store.release(a);
    await store.release(a);
    expect(await usage()).toEqual({ spent: 0n, reserved: 700n });
    await store.release(b);
    expect(await usage()).toEqual({ spent: 0n, reserved: 0n });
  });

  it('frees budget for the next request', async () => {
    const r = (await reserve(1000n, 5000n))!;
    expect(await reserve(1000n, 5000n)).toBeNull();
    await store.release(r);
    expect(await reserve(1000n, 5000n)).not.toBeNull();
  });
});

describe('reconcileStaleReservations (edge case 5.7, proposal P1)', () => {
  async function age(requestId: string, ms: number): Promise<void> {
    await pool.query(
      `UPDATE budget_reservations SET created_at = now() - ($2::bigint * interval '1 millisecond')
        WHERE request_id = $1`,
      [requestId, ms],
    );
  }

  it('clears holds whose request never settled, and only those', async () => {
    const crashed = (await reserve(100_000n, 500n))!;
    const inFlight = (await reserve(100_000n, 700n))!;
    await age(crashed.requestId, 10 * 60_000);

    expect(await reconcileStaleReservations(pool, 120_000)).toBe(1);

    expect(await usage()).toEqual({ spent: 0n, reserved: 700n });
    const { rows } = await pool.query('SELECT request_id FROM budget_reservations');
    expect(rows).toEqual([{ request_id: inFlight.requestId }]);
  });

  it('does nothing when nothing is stale, and is safe to run repeatedly', async () => {
    await reserve(100_000n, 500n);
    expect(await reconcileStaleReservations(pool, 120_000)).toBe(0);
    expect(await reconcileStaleReservations(pool, 120_000)).toBe(0);
    expect(await usage()).toEqual({ spent: 0n, reserved: 500n });
  });

  it('un-blocks a key whose budget was pinned by lost holds', async () => {
    const lost = (await reserve(1000n, 5000n))!;
    expect(await reserve(1000n, 5000n)).toBeNull();
    await age(lost.requestId, 5 * 60_000);
    await reconcileStaleReservations(pool, 120_000);
    expect(await reserve(1000n, 5000n)).not.toBeNull();
  });

  it('adds up several stale holds of the same key and month', async () => {
    const holds = await Promise.all([reserve(100_000n, 100n), reserve(100_000n, 200n)]);
    for (const h of holds) await age(h!.requestId, 600_000);
    expect(await reconcileStaleReservations(pool, 120_000)).toBe(2);
    expect(await usage()).toEqual({ spent: 0n, reserved: 0n });
  });

  it('never drives reserved below zero if a late settlement races with the reconciler', async () => {
    const r = (await reserve(100_000n, 500n))!;
    await age(r.requestId, 600_000);
    await reconcileStaleReservations(pool, 120_000);
    // The request finally settles after its hold was cleared: it is still charged, once.
    await store.settle(r, 250n, logFor(r, 250n));
    expect(await usage()).toEqual({ spent: 250n, reserved: 0n });
  });
});
