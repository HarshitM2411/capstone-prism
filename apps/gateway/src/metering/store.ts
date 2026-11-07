import { hashKey } from '../db/keys.js';
import type { Pool } from '../db/pool.js';
import { fromSqlNumeric } from '../money.js';
import { budgetPeriod } from '../limits/budget.js';

/** A virtual key as the admin API names it (never includes the raw key or its hash). */
export interface KeyRef {
  id: number;
  team: string;
}

export interface UsageQuery {
  /** Restrict to one key; `null` for every key. */
  keyId: number | null;
  /** Inclusive lower bound on `created_at`; `null` for no lower bound. */
  from: Date | null;
  /** Exclusive upper bound on `created_at`; `null` for no upper bound. */
  to: Date | null;
  /** Decides which budget period is reported. */
  now: Date;
}

export interface KeyUsage {
  keyId: number;
  team: string;
  keyHint: string;
  status: string;
  /** Every logged request of the key in the window, rejections included. */
  requests: number;
  /** Requests answered with a completion (`ok` or `cache_hit`). */
  served: number;
  cacheHits: number;
  /** Requests in which a fallback model/provider was used. */
  fallbacks: number;
  /** Requests turned away before a provider was called (`rejected_*`). */
  rejected: number;
  /** Upstream failures, internal errors and client disconnects. */
  errors: number;
  promptTokens: number;
  completionTokens: number;
  /** Sum of `request_logs.cost_usd`, in units of 1e-8 USD. */
  costUnits: bigint;
  /** The current calendar-month budget counters of the key. */
  budget: {
    period: string;
    monthlyUnits: bigint;
    spentUnits: bigint;
    reservedUnits: bigint;
  };
}

export interface UsageReport {
  keys: KeyUsage[];
  /** Requests with no key (rejected for a missing or unknown key). Only counted when all keys are asked for. */
  unattributedRequests: number;
}

export interface LogQuery {
  keyId: number | null;
  status: string | null;
  from: Date | null;
  to: Date | null;
  /** Rows to return, already capped by the caller. */
  limit: number;
  /** Return only rows older than this position (the previous page's `nextCursor`). */
  before: LogCursor | null;
}

/** The position of a row in the newest-first order. `createdAt` keeps Postgres's microseconds. */
export interface LogCursor {
  createdAt: string;
  requestId: string;
}

export interface LogRow {
  requestId: string;
  createdAt: string;
  keyId: number | null;
  team: string | null;
  keyHint: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  resolvedProvider: string | null;
  status: string;
  httpStatus: number | null;
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  costUnits: bigint;
  cache: string;
  fallback: boolean;
  retries: number;
  routeReason: string | null;
  usageEstimated: boolean;
  latencyMs: number;
  timeToFirstTokenMs: number | null;
}

export interface LogPage {
  rows: LogRow[];
  /** Set when older rows exist. */
  nextCursor: LogCursor | null;
}

/** Read side of metering: the data behind `/admin/usage` and `/admin/logs`. */
export interface MeteringStore {
  /** Resolves a team name, numeric key id or raw key to a key; `null` if there is none. */
  findKey(reference: string): Promise<KeyRef | null>;
  usage(query: UsageQuery): Promise<UsageReport>;
  logs(query: LogQuery): Promise<LogPage>;
}

const CURSOR_TIMESTAMP = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface UsageRowSql {
  id: string;
  team: string;
  key_hint: string;
  status: string;
  monthly_budget_usd: string;
  requests: string | null;
  served: string | null;
  cache_hits: string | null;
  fallbacks: string | null;
  rejected: string | null;
  errors: string | null;
  prompt_tokens: string | null;
  completion_tokens: string | null;
  cost_usd: string | null;
  spent_usd: string | null;
  reserved_usd: string | null;
}

interface LogRowSql {
  request_id: string;
  created_at_text: string;
  key_id: string | null;
  team: string | null;
  key_hint: string | null;
  requested_model: string | null;
  resolved_model: string | null;
  resolved_provider: string | null;
  status: string;
  http_status: number | null;
  error_code: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: string;
  cache: string;
  fallback: boolean;
  retries: number;
  route_reason: string | null;
  usage_estimated: boolean;
  latency_ms: number;
  time_to_first_token_ms: number | null;
}

const count = (value: string | null): number => (value === null ? 0 : Number(value));

export class PgMeteringStore implements MeteringStore {
  constructor(private readonly pool: Pool) {}

  async findKey(reference: string): Promise<KeyRef | null> {
    // A raw key is accepted so an operator can paste the one they hold; it is hashed here and never
    // stored, logged or echoed. A team name wins over a numeric id of the same text.
    const { rows } = await this.pool.query<{ id: string; team: string }>(
      `SELECT id, team FROM virtual_keys
        WHERE team = $1 OR key_hash = $2 OR id::text = $1
        ORDER BY (team = $1) DESC, id
        LIMIT 1`,
      [reference, hashKey(reference)],
    );
    const row = rows[0];
    return row === undefined ? null : { id: Number(row.id), team: row.team };
  }

  async usage(query: UsageQuery): Promise<UsageReport> {
    const { rows } = await this.pool.query<UsageRowSql>(
      `SELECT k.id, k.team, k.key_hint, k.status, k.monthly_budget_usd,
              l.requests, l.served, l.cache_hits, l.fallbacks, l.rejected, l.errors,
              l.prompt_tokens, l.completion_tokens, l.cost_usd,
              b.spent_usd, b.reserved_usd
         FROM virtual_keys k
         LEFT JOIN (
           SELECT key_id,
                  COUNT(*) AS requests,
                  COUNT(*) FILTER (WHERE status IN ('ok', 'cache_hit')) AS served,
                  COUNT(*) FILTER (WHERE status = 'cache_hit') AS cache_hits,
                  COUNT(*) FILTER (WHERE fallback) AS fallbacks,
                  COUNT(*) FILTER (WHERE status LIKE 'rejected\\_%') AS rejected,
                  COUNT(*) FILTER (
                    WHERE status IN ('upstream_error', 'internal_error', 'client_disconnect')
                  ) AS errors,
                  SUM(prompt_tokens) AS prompt_tokens,
                  SUM(completion_tokens) AS completion_tokens,
                  SUM(cost_usd) AS cost_usd
             FROM request_logs
            WHERE key_id IS NOT NULL
              AND ($1::timestamptz IS NULL OR created_at >= $1)
              AND ($2::timestamptz IS NULL OR created_at < $2)
            GROUP BY key_id
         ) l ON l.key_id = k.id
         LEFT JOIN budget_usage b ON b.key_id = k.id AND b.period = $3
        WHERE ($4::bigint IS NULL OR k.id = $4)
        ORDER BY k.id`,
      [query.from, query.to, budgetPeriod(query.now), query.keyId],
    );

    let unattributed = 0;
    if (query.keyId === null) {
      const result = await this.pool.query<{ requests: string }>(
        `SELECT COUNT(*) AS requests FROM request_logs
          WHERE key_id IS NULL
            AND ($1::timestamptz IS NULL OR created_at >= $1)
            AND ($2::timestamptz IS NULL OR created_at < $2)`,
        [query.from, query.to],
      );
      unattributed = count(result.rows[0]?.requests ?? null);
    }

    const period = budgetPeriod(query.now);
    return {
      keys: rows.map((row) => ({
        keyId: Number(row.id),
        team: row.team,
        keyHint: row.key_hint,
        status: row.status,
        requests: count(row.requests),
        served: count(row.served),
        cacheHits: count(row.cache_hits),
        fallbacks: count(row.fallbacks),
        rejected: count(row.rejected),
        errors: count(row.errors),
        promptTokens: count(row.prompt_tokens),
        completionTokens: count(row.completion_tokens),
        costUnits: row.cost_usd === null ? 0n : fromSqlNumeric(row.cost_usd),
        budget: {
          period,
          monthlyUnits: fromSqlNumeric(row.monthly_budget_usd),
          spentUnits: row.spent_usd === null ? 0n : fromSqlNumeric(row.spent_usd),
          reservedUnits: row.reserved_usd === null ? 0n : fromSqlNumeric(row.reserved_usd),
        },
      })),
      unattributedRequests: unattributed,
    };
  }

  async logs(query: LogQuery): Promise<LogPage> {
    // `created_at` is compared at full precision against the cursor text Postgres produced, with
    // the row id as the tie-break, so paging neither skips nor repeats rows.
    const { rows } = await this.pool.query<LogRowSql>(
      `SELECT l.request_id, ${CURSOR_TIMESTAMP.replaceAll('created_at', 'l.created_at')} AS created_at_text,
              l.key_id, k.team, k.key_hint,
              l.requested_model, l.resolved_model, l.resolved_provider,
              l.status, l.http_status, l.error_code,
              l.prompt_tokens, l.completion_tokens, l.cost_usd, l.cache, l.fallback, l.retries,
              l.route_reason, l.usage_estimated, l.latency_ms, l.time_to_first_token_ms
         FROM request_logs l
         LEFT JOIN virtual_keys k ON k.id = l.key_id
        WHERE ($1::bigint IS NULL OR l.key_id = $1)
          AND ($2::text IS NULL OR l.status = $2)
          AND ($3::timestamptz IS NULL OR l.created_at >= $3)
          AND ($4::timestamptz IS NULL OR l.created_at < $4)
          AND ($5::timestamptz IS NULL OR (l.created_at, l.request_id) < ($5::timestamptz, $6::uuid))
        ORDER BY l.created_at DESC, l.request_id DESC
        LIMIT $7`,
      [
        query.keyId,
        query.status,
        query.from,
        query.to,
        query.before?.createdAt ?? null,
        query.before?.requestId ?? null,
        query.limit + 1,
      ],
    );

    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((row) => ({
        requestId: row.request_id,
        createdAt: row.created_at_text,
        keyId: row.key_id === null ? null : Number(row.key_id),
        team: row.team,
        keyHint: row.key_hint,
        requestedModel: row.requested_model,
        resolvedModel: row.resolved_model,
        resolvedProvider: row.resolved_provider,
        status: row.status,
        httpStatus: row.http_status,
        errorCode: row.error_code,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        costUnits: fromSqlNumeric(row.cost_usd),
        cache: row.cache,
        fallback: row.fallback,
        retries: row.retries,
        routeReason: row.route_reason,
        usageEstimated: row.usage_estimated,
        latencyMs: row.latency_ms,
        timeToFirstTokenMs: row.time_to_first_token_ms,
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? { createdAt: last.created_at_text, requestId: last.request_id }
          : null,
    };
  }
}
