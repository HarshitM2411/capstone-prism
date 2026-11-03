/**
 * The shared error model. Every rejection path throws a `PrismError`; one error handler turns it
 * into the OpenAI-style envelope `{ error: { message, type, code } }` (architecture §6) and
 * records the matching `request_logs.status`.
 */

/** Values allowed by the `request_logs.status` CHECK constraint. */
export type LogStatus =
  | 'ok'
  | 'cache_hit'
  | 'rejected_auth'
  | 'rejected_validation'
  | 'rejected_not_found'
  | 'rejected_allowlist'
  | 'rejected_rate_limit'
  | 'rejected_budget'
  | 'rejected_unavailable'
  | 'upstream_error'
  | 'client_disconnect'
  | 'internal_error';

export interface ErrorEnvelope {
  error: { message: string; type: string; code: string };
}

export class PrismError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly type: string,
    readonly code: string,
    message: string,
    readonly logStatus: LogStatus,
    /** Extra response headers, for example `Retry-After` on a 429. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'PrismError';
  }

  toEnvelope(): ErrorEnvelope {
    return { error: { message: this.message, type: this.type, code: this.code } };
  }
}

export function invalidApiKey(
  message = 'Invalid or missing API key. Send "Authorization: Bearer <key>".',
): PrismError {
  return new PrismError(401, 'authentication_error', 'invalid_api_key', message, 'rejected_auth');
}

export function invalidAdminToken(): PrismError {
  return new PrismError(
    401,
    'authentication_error',
    'invalid_admin_token',
    'Invalid or missing admin token. Send it in the "x-admin-token" header.',
    'rejected_auth',
  );
}

export function invalidRequest(
  message: string,
  code = 'invalid_request',
  httpStatus = 400,
): PrismError {
  return new PrismError(httpStatus, 'invalid_request_error', code, message, 'rejected_validation');
}

export function modelNotFound(model: string): PrismError {
  // The name is echoed back to the sender only after being length-limited by validation.
  return new PrismError(
    404,
    'not_found_error',
    'model_not_found',
    `The model "${model}" does not exist.`,
    'rejected_not_found',
  );
}

export function modelNotAllowed(model: string): PrismError {
  return new PrismError(
    403,
    'model_not_allowed',
    'model_not_allowed',
    `This API key is not allowed to use the model "${model}".`,
    'rejected_allowlist',
  );
}

export function rateLimitExceeded(retryAfterMs: number): PrismError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new PrismError(
    429,
    'rate_limit_exceeded',
    'rate_limit_exceeded',
    'Rate limit exceeded for this API key. Retry after the interval in the Retry-After header.',
    'rejected_rate_limit',
    { 'retry-after': String(seconds) },
  );
}

export function budgetExceeded(): PrismError {
  return new PrismError(
    402,
    'budget_exceeded',
    'budget_exceeded',
    'The monthly budget for this API key is exhausted.',
    'rejected_budget',
  );
}

export function rateLimiterUnavailable(): PrismError {
  return serviceUnavailable(
    'Rate limiting is temporarily unavailable, so the request was not accepted. Please retry shortly.',
    'rate_limiter_unavailable',
  );
}

export function serviceUnavailable(message: string, code = 'service_unavailable'): PrismError {
  return new PrismError(503, 'service_unavailable', code, message, 'rejected_unavailable');
}

/**
 * The provider could not produce a response. Deliberately generic: the provider's own message,
 * body and credentials never reach the client (edge case 8.17).
 */
export function upstreamError(): PrismError {
  return new PrismError(
    502,
    'upstream_error',
    'upstream_error',
    'The upstream model provider failed to produce a response. Please retry shortly.',
    'upstream_error',
  );
}

/** The client closed the connection before the response was ready. Nobody reads this response. */
export function clientClosed(): PrismError {
  return new PrismError(
    499,
    'invalid_request_error',
    'client_closed_request',
    'The client closed the connection before the response was ready.',
    'client_disconnect',
  );
}

export function internalError(): PrismError {
  return new PrismError(
    500,
    'internal_error',
    'internal_error',
    'Internal server error.',
    'internal_error',
  );
}

/** Messages for the framework's own request-parsing failures. Never echoes the request body. */
const PARSER_MESSAGES: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: 'request_too_large',
    message: 'Request body is too large.',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: 'unsupported_media_type',
    message: 'Content-Type must be application/json.',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    status: 400,
    code: 'invalid_request',
    message: 'Request body is empty; a JSON object is required.',
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: 'invalid_json',
    message: 'Request body is not valid JSON.',
  },
};

/** Maps anything thrown by a handler or by the framework to a `PrismError`. */
export function toPrismError(err: unknown): PrismError {
  if (err instanceof PrismError) return err;

  const candidate = err as { code?: unknown; statusCode?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : undefined;
  const statusCode = typeof candidate?.statusCode === 'number' ? candidate.statusCode : undefined;

  const parser = code === undefined ? undefined : PARSER_MESSAGES[code];
  if (parser !== undefined) {
    return invalidRequest(parser.message, parser.code, parser.status);
  }
  if (
    err instanceof SyntaxError ||
    (statusCode !== undefined && statusCode >= 400 && statusCode < 500)
  ) {
    // Any other client-side framework failure (bad content-length, aborted body, ...).
    return invalidRequest('The request could not be processed.');
  }
  return internalError();
}
