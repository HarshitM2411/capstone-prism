import { toSqlNumeric } from '../money.js';
import type { LogStatus } from '../http/errors.js';
import type { Pool } from './pool.js';

/** One row per data-plane request, rejections included (architecture §4.9). */
export interface RequestLogEntry {
  requestId: string;
  /** `null` for unauthenticated requests: the submitted key is never stored. */
  keyId: number | null;
  requestedModel: string | null;
  /** The concrete model that was priced or served; `null` when the request was rejected early. */
  resolvedModel?: string | null;
  /** The provider that was called (or last tried), once a provider call was made. */
  resolvedProvider?: string | null;
  /** A fallback model/provider (not the primary) served the request. */
  fallback?: boolean;
  /** Same-provider retries before the attempt that produced the outcome. */
  retries?: number;
  status: LogStatus;
  httpStatus: number;
  errorCode: string | null;
  promptTokens?: number;
  completionTokens?: number;
  /** Cost in units of 1e-8 USD (the same amount that is settled into `budget_usage`). */
  costUnits?: bigint;
  /** The token counts are our estimate (a stream that ended without the provider's usage). */
  usageEstimated?: boolean;
  /** For `auto` requests: the chosen tier and why (never contains prompt text). */
  routeReason?: string | null;
  latencyMs: number;
  /** Streams only: time until the first content reached the client. */
  timeToFirstTokenMs?: number | null;
}

export interface RequestLogWriter {
  write(entry: RequestLogEntry): Promise<void>;
}

/** Anything with `query`: the pool, or a client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const MAX_MODEL_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

/** Postgres text cannot hold NUL bytes, and these values are client-controlled. */
function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replaceAll('\u0000', '').slice(0, MAX_MODEL_LENGTH);
}

function cleanRouteReason(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replaceAll('\u0000', '').slice(0, MAX_REASON_LENGTH);
}

export async function insertRequestLog(db: Queryable, entry: RequestLogEntry): Promise<void> {
  await db.query(
    `INSERT INTO request_logs
       (request_id, key_id, requested_model, resolved_model, resolved_provider, fallback, retries,
        status, http_status, error_code, prompt_tokens, completion_tokens, cost_usd, latency_ms,
        usage_estimated, time_to_first_token_ms, route_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      entry.requestId,
      entry.keyId,
      cleanText(entry.requestedModel),
      cleanText(entry.resolvedModel),
      cleanText(entry.resolvedProvider),
      entry.fallback ?? false,
      entry.retries ?? 0,
      entry.status,
      entry.httpStatus,
      entry.errorCode,
      entry.promptTokens ?? 0,
      entry.completionTokens ?? 0,
      toSqlNumeric(entry.costUnits ?? 0n),
      Math.max(0, Math.round(entry.latencyMs)),
      entry.usageEstimated ?? false,
      entry.timeToFirstTokenMs === null || entry.timeToFirstTokenMs === undefined
        ? null
        : Math.max(0, Math.round(entry.timeToFirstTokenMs)),
      cleanRouteReason(entry.routeReason),
    ],
  );
}

export function createRequestLogWriter(pool: Pool): RequestLogWriter {
  return {
    async write(entry) {
      await insertRequestLog(pool, entry);
    },
  };
}
