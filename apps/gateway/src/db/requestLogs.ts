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
  status: LogStatus;
  httpStatus: number;
  errorCode: string | null;
  promptTokens?: number;
  completionTokens?: number;
  /** Cost in units of 1e-8 USD (the same amount that is settled into `budget_usage`). */
  costUnits?: bigint;
  latencyMs: number;
}

export interface RequestLogWriter {
  write(entry: RequestLogEntry): Promise<void>;
}

/** Anything with `query`: the pool, or a client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const MAX_MODEL_LENGTH = 200;

/** Postgres text cannot hold NUL bytes, and these values are client-controlled. */
function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replaceAll('\u0000', '').slice(0, MAX_MODEL_LENGTH);
}

export async function insertRequestLog(db: Queryable, entry: RequestLogEntry): Promise<void> {
  await db.query(
    `INSERT INTO request_logs
       (request_id, key_id, requested_model, resolved_model, status, http_status, error_code,
        prompt_tokens, completion_tokens, cost_usd, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.requestId,
      entry.keyId,
      cleanText(entry.requestedModel),
      cleanText(entry.resolvedModel),
      entry.status,
      entry.httpStatus,
      entry.errorCode,
      entry.promptTokens ?? 0,
      entry.completionTokens ?? 0,
      toSqlNumeric(entry.costUnits ?? 0n),
      Math.max(0, Math.round(entry.latencyMs)),
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
