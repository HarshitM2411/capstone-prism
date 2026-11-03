import type { LogStatus } from '../http/errors.js';
import type { Pool } from './pool.js';

/** One row per data-plane request, rejections included (architecture §4.9). */
export interface RequestLogEntry {
  requestId: string;
  /** `null` for unauthenticated requests: the submitted key is never stored. */
  keyId: number | null;
  requestedModel: string | null;
  status: LogStatus;
  httpStatus: number;
  errorCode: string | null;
  latencyMs: number;
}

export interface RequestLogWriter {
  write(entry: RequestLogEntry): Promise<void>;
}

const MAX_MODEL_LENGTH = 200;

export function createRequestLogWriter(pool: Pool): RequestLogWriter {
  return {
    async write(entry) {
      await pool.query(
        `INSERT INTO request_logs
           (request_id, key_id, requested_model, status, http_status, error_code, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.requestId,
          entry.keyId,
          // Postgres text cannot hold NUL bytes, and the value is client-controlled.
          entry.requestedModel === null
            ? null
            : entry.requestedModel.replaceAll('\u0000', '').slice(0, MAX_MODEL_LENGTH),
          entry.status,
          entry.httpStatus,
          entry.errorCode,
          Math.max(0, Math.round(entry.latencyMs)),
        ],
      );
    },
  };
}
