import type { AuthContext } from './auth.js';
import type { LogStatus } from './errors.js';

/**
 * Per-request state shared by the auth hook, the handler, the error handler and the request
 * logger. It is what ends up in the `request_logs` row.
 */
export interface RequestContext {
  /** Client-visible request id, also stored as `request_logs.request_id`. */
  requestId: string;
  /** Set as soon as the tenant is known (even if the key then turns out to be disabled). */
  keyId: number | null;
  /** The authenticated tenant policy; `null` until authentication succeeds. */
  auth: AuthContext | null;
  requestedModel: string | null;
  /** The concrete model that was priced or served, once known. */
  resolvedModel: string | null;
  /** The provider that was called, once a provider call was made. */
  resolvedProvider: string | null;
  /** A model other than the primary was tried or served. */
  fallback: boolean;
  /** Same-model retries made so far. */
  retries: number;
  logStatus: LogStatus;
  errorCode: string | null;
  /** The log row was already written (together with the budget settlement). */
  logged: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on data-plane routes. */
    prism: RequestContext | null;
  }
}
