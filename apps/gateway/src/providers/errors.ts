/**
 * Why a provider call failed. The kind decides what the retry/failover engine (Phase 5) does:
 *
 *  - `timeout`, `connection`, `server_error`  → transient: retry, then fail over;
 *  - `rate_limited`, `malformed`              → not worth retrying here: fail over at once;
 *  - `auth`, `bad_request`                    → the request or our credentials are wrong: a
 *                                               failover would not help, answer `502`;
 *  - `aborted`                                → the client went away: stop everything.
 *
 * Messages are written by us and never contain the provider's response body, request body or
 * credentials, so an error can be logged or mapped to a client response as is.
 */
export type ProviderErrorKind =
  | 'timeout'
  | 'connection'
  | 'server_error'
  | 'rate_limited'
  | 'malformed'
  | 'auth'
  | 'bad_request'
  | 'aborted';

export type ErrorDisposition = 'retry' | 'failover' | 'fatal' | 'abort';

const DISPOSITIONS: Record<ProviderErrorKind, ErrorDisposition> = {
  timeout: 'retry',
  connection: 'retry',
  server_error: 'retry',
  rate_limited: 'failover',
  malformed: 'failover',
  auth: 'fatal',
  bad_request: 'fatal',
  aborted: 'abort',
};

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly provider: string,
    message: string,
    /** The provider's HTTP status, when it answered at all. */
    readonly status: number | null = null,
    /** From a `Retry-After` header on a 429, in milliseconds. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get disposition(): ErrorDisposition {
    return DISPOSITIONS[this.kind];
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}
