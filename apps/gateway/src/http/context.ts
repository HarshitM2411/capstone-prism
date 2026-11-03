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
  logStatus: LogStatus;
  errorCode: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present on data-plane routes. */
    prism: RequestContext | null;
  }
}
