import { fromSqlNumeric, toSqlNumeric } from '../money.js';
import { insertRequestLog, type RequestLogEntry } from '../db/requestLogs.js';
import type { Pool } from '../db/pool.js';

/** A hold on part of a key's monthly budget while a request is in flight. */
export interface Reservation {
  requestId: string;
  keyId: number;
  /** Calendar month (UTC), `YYYY-MM`, fixed when the request is admitted (edge case 5.11). */
  period: string;
  /** Units of 1e-8 USD held for this request. */
  reservedUnits: bigint;
}

export interface ReserveInput {
  requestId: string;
  keyId: number;
  /** The key's monthly budget in units of 1e-8 USD. */
  budgetUnits: bigint;
  /** Estimated worst-case cost in units of 1e-8 USD. */
  estimateUnits: bigint;
  now?: Date;
}

/**
 * Admission control for money (architecture §4.3): reserve → settle.
 *
 *  - `reserve` admits a request only while budget remains, and holds `LEAST(estimate, remaining)`;
 *  - `settle` replaces the hold with the actual cost, together with the request's log row;
 *  - `release` gives the hold back (failed request, cache hit).
 */
export interface BudgetStore {
  /** Resolves `null` when no budget remains (→ `402`). Throws if the store cannot be reached. */
  reserve(input: ReserveInput): Promise<Reservation | null>;
  /** Charges `actualUnits`, releases the hold and writes `log`, in one transaction. */
  settle(reservation: Reservation, actualUnits: bigint, log: RequestLogEntry): Promise<void>;
  /** Releases the hold without charging anything. */
  release(reservation: Reservation): Promise<void>;
}

/** `YYYY-MM` in UTC. */
export function budgetPeriod(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${now.getUTCFullYear()}-${month}`;
}

export class PgBudgetStore implements BudgetStore {
  constructor(private readonly pool: Pool) {}

  async reserve(input: ReserveInput): Promise<Reservation | null> {
    const period = budgetPeriod(input.now ?? new Date());

    // The first request of a month creates that month's row. Concurrent first requests cannot
    // both insert (primary key) and neither skips the check below (edge case 5.10).
    await this.pool.query(
      'INSERT INTO budget_usage (key_id, period) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [input.keyId, period],
    );

    // One statement: lock the row, admit only while `spent + reserved < budget`, hold
    // LEAST(estimate, remaining), and record the hold. Concurrent requests for the same key queue
    // on the row lock and re-check the condition against the updated row (READ COMMITTED), so
    // no two requests can both be admitted against the same remaining budget.
    const { rows } = await this.pool.query<{ amount_usd: string }>(
      `WITH candidate AS (
         SELECT key_id, period,
                LEAST($3::numeric, $4::numeric - spent_usd - reserved_usd) AS amount
           FROM budget_usage
          WHERE key_id = $1 AND period = $2
            AND spent_usd + reserved_usd < $4::numeric
            FOR UPDATE
       ),
       held AS (
         UPDATE budget_usage b
            SET reserved_usd = b.reserved_usd + c.amount
           FROM candidate c
          WHERE b.key_id = c.key_id AND b.period = c.period
         RETURNING c.amount AS amount
       )
       INSERT INTO budget_reservations (request_id, key_id, period, amount_usd)
       SELECT $5::uuid, $1, $2, amount FROM held
       RETURNING amount_usd`,
      [
        input.keyId,
        period,
        toSqlNumeric(input.estimateUnits),
        toSqlNumeric(input.budgetUnits),
        input.requestId,
      ],
    );

    const row = rows[0];
    if (row === undefined) return null;
    return {
      requestId: input.requestId,
      keyId: input.keyId,
      period,
      reservedUnits: fromSqlNumeric(row.amount_usd),
    };
  }

  async settle(reservation: Reservation, actualUnits: bigint, log: RequestLogEntry): Promise<void> {
    await this.finish(reservation, actualUnits, log);
  }

  async release(reservation: Reservation): Promise<void> {
    await this.finish(reservation, 0n, null);
  }

  private async finish(
    reservation: Reservation,
    actualUnits: bigint,
    log: RequestLogEntry | null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Deleting the hold is what releases it: if it is already gone (settled before, or cleared
      // by the reconciler) nothing is released a second time, but the actual cost is still charged.
      const { rows } = await client.query<{ amount_usd: string }>(
        'DELETE FROM budget_reservations WHERE request_id = $1 RETURNING amount_usd',
        [reservation.requestId],
      );
      const held = rows[0] === undefined ? 0n : fromSqlNumeric(rows[0].amount_usd);
      await client.query(
        `UPDATE budget_usage
            SET spent_usd = spent_usd + $3::numeric,
                reserved_usd = GREATEST(reserved_usd - $4::numeric, 0)
          WHERE key_id = $1 AND period = $2`,
        [reservation.keyId, reservation.period, toSqlNumeric(actualUnits), toSqlNumeric(held)],
      );
      if (log !== null) await insertRequestLog(client, log);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Releases holds older than `olderThanMs` — reservations whose request never settled, for example
 * because the gateway crashed mid-request (edge case 5.7). Returns how many were cleared.
 */
export async function reconcileStaleReservations(pool: Pool, olderThanMs: number): Promise<number> {
  const { rows } = await pool.query<{ cleared: string }>(
    `WITH stale AS (
       DELETE FROM budget_reservations
        WHERE created_at < now() - ($1::bigint * interval '1 millisecond')
       RETURNING key_id, period, amount_usd
     ),
     totals AS (
       SELECT key_id, period, SUM(amount_usd) AS amount FROM stale GROUP BY key_id, period
     ),
     released AS (
       UPDATE budget_usage b
          SET reserved_usd = GREATEST(b.reserved_usd - t.amount, 0)
         FROM totals t
        WHERE b.key_id = t.key_id AND b.period = t.period
       RETURNING 1
     )
     SELECT COUNT(*)::text AS cleared FROM stale`,
    [Math.max(0, Math.round(olderThanMs))],
  );
  return Number(rows[0]?.cleared ?? 0);
}
