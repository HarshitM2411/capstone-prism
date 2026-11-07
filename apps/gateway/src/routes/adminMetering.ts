import type { FastifyInstance, FastifyRequest } from 'fastify';
import { invalidRequest, PrismError, serviceUnavailable } from '../http/errors.js';
import { toSqlNumeric } from '../money.js';
import type { KeyRef, KeyUsage, LogCursor, LogRow, MeteringStore } from '../metering/store.js';

export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 200;
const MAX_KEY_REFERENCE_LENGTH = 200;

/** The statuses `/admin/logs?status=` accepts (the values of `request_logs.status`). */
export const LOG_STATUSES = [
  'ok',
  'cache_hit',
  'rejected_auth',
  'rejected_validation',
  'rejected_not_found',
  'rejected_allowlist',
  'rejected_rate_limit',
  'rejected_budget',
  'rejected_unavailable',
  'upstream_error',
  'client_disconnect',
  'internal_error',
] as const;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f-]{27})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function single(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw invalidRequest(`"${name}" must be given once, as plain text.`, 'invalid_query');
  }
  return value;
}

/**
 * A timestamp bound. A date alone (`2026-11-06`) means that UTC day: as `from` its start, as `to`
 * the end of that day, so `from=2026-11-01&to=2026-11-30` covers all of November 30. A full
 * timestamp must carry `Z` or an offset, and as `to` it is exclusive.
 */
function parseBound(name: 'from' | 'to', value: string | undefined): Date | null {
  if (value === undefined || value === '') return null;
  let date: Date;
  if (DATE_ONLY.test(value)) {
    date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) {
      return name === 'to' ? new Date(date.getTime() + DAY_MS) : date;
    }
  } else if (DATE_TIME.test(value)) {
    date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw invalidRequest(
    `"${name}" must be a date (YYYY-MM-DD) or an ISO 8601 timestamp with a time zone.`,
    'invalid_query',
  );
}

function parseWindow(request: FastifyRequest): { from: Date | null; to: Date | null } {
  const from = parseBound('from', single(request, 'from'));
  const to = parseBound('to', single(request, 'to'));
  if (from !== null && to !== null && from.getTime() >= to.getTime()) {
    throw invalidRequest('"from" must be earlier than "to".', 'invalid_query');
  }
  return { from, to };
}

async function resolveKey(store: MeteringStore, request: FastifyRequest): Promise<KeyRef | null> {
  const reference = single(request, 'key');
  if (reference === undefined || reference === '') return null;
  if (reference.length > MAX_KEY_REFERENCE_LENGTH) {
    throw invalidRequest('"key" is too long.', 'invalid_query');
  }
  const key = await guarded(request, () => store.findKey(reference));
  if (key === null) {
    // The submitted text is not echoed: it may be a raw key.
    throw new PrismError(
      404,
      'not_found_error',
      'key_not_found',
      'No virtual key matches the "key" parameter. Use the team name or the key id.',
      'rejected_not_found',
    );
  }
  return key;
}

async function guarded<T>(request: FastifyRequest, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    request.log.error({ err }, 'metering query failed');
    throw serviceUnavailable('Usage data is temporarily unavailable.');
  }
}

interface Totals {
  requests: number;
  served: number;
  cacheHits: number;
  fallbacks: number;
  rejected: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  costUnits: bigint;
}

function emptyTotals(): Totals {
  return {
    requests: 0,
    served: 0,
    cacheHits: 0,
    fallbacks: 0,
    rejected: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUnits: 0n,
  };
}

function addTotals(sum: Totals, row: Totals): Totals {
  return {
    requests: sum.requests + row.requests,
    served: sum.served + row.served,
    cacheHits: sum.cacheHits + row.cacheHits,
    fallbacks: sum.fallbacks + row.fallbacks,
    rejected: sum.rejected + row.rejected,
    errors: sum.errors + row.errors,
    promptTokens: sum.promptTokens + row.promptTokens,
    completionTokens: sum.completionTokens + row.completionTokens,
    costUnits: sum.costUnits + row.costUnits,
  };
}

function totalsView(totals: Totals) {
  return {
    requests: totals.requests,
    served: totals.served,
    cache_hits: totals.cacheHits,
    fallbacks: totals.fallbacks,
    rejected: totals.rejected,
    errors: totals.errors,
    prompt_tokens: totals.promptTokens,
    completion_tokens: totals.completionTokens,
    total_tokens: totals.promptTokens + totals.completionTokens,
    // Exact decimal text (8 places): money is never sent as a float.
    cost_usd: toSqlNumeric(totals.costUnits),
  };
}

function usageView(row: KeyUsage) {
  return {
    key_id: row.keyId,
    team: row.team,
    key_hint: row.keyHint,
    status: row.status,
    ...totalsView(row),
    budget: {
      period: row.budget.period,
      monthly_usd: toSqlNumeric(row.budget.monthlyUnits),
      spent_usd: toSqlNumeric(row.budget.spentUnits),
      reserved_usd: toSqlNumeric(row.budget.reservedUnits),
    },
  };
}

function logView(row: LogRow) {
  return {
    request_id: row.requestId,
    created_at: row.createdAt,
    key_id: row.keyId,
    team: row.team,
    key_hint: row.keyHint,
    requested_model: row.requestedModel,
    resolved_model: row.resolvedModel,
    resolved_provider: row.resolvedProvider,
    status: row.status,
    http_status: row.httpStatus,
    error_code: row.errorCode,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    cost_usd: toSqlNumeric(row.costUnits),
    cache: row.cache,
    fallback: row.fallback,
    retries: row.retries,
    route_reason: row.routeReason,
    usage_estimated: row.usageEstimated,
    latency_ms: row.latencyMs,
    time_to_first_token_ms: row.timeToFirstTokenMs,
  };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_LOG_LIMIT;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw invalidRequest('"limit" must be a whole number of at least 1.', 'invalid_query');
  }
  // Capped rather than rejected, so a console asking for "everything" still gets a page.
  return Math.min(Number(value), MAX_LOG_LIMIT);
}

function parseCursor(value: string | undefined): LogCursor | null {
  if (value === undefined || value === '') return null;
  const match = CURSOR.exec(value);
  if (match === null || !UUID.test(match[2]!)) {
    throw invalidRequest('"cursor" is not a value returned by this endpoint.', 'invalid_query');
  }
  return { createdAt: match[1]!, requestId: match[2]! };
}

function parseStatus(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  if (!(LOG_STATUSES as readonly string[]).includes(value)) {
    throw invalidRequest(`"status" must be one of: ${LOG_STATUSES.join(', ')}.`, 'invalid_query');
  }
  return value;
}

/**
 * `/admin/usage` and `/admin/logs`. Registered inside the admin plugin, so the admin-token hook
 * already applies. Neither route can return a raw key, a key hash, a provider secret or prompt
 * text: the store selects only the columns shown here.
 */
export function registerMeteringRoutes(
  app: FastifyInstance,
  metering: MeteringStore | null,
  now: () => Date = () => new Date(),
): void {
  const need = (): MeteringStore => {
    if (metering === null) throw serviceUnavailable('Usage data is not configured.');
    return metering;
  };

  app.get('/admin/usage', async (request) => {
    const store = need();
    const window = parseWindow(request);
    const key = await resolveKey(store, request);
    const report = await guarded(request, () =>
      store.usage({ keyId: key?.id ?? null, ...window, now: now() }),
    );

    const totals = report.keys.reduce<Totals>(addTotals, emptyTotals());
    return {
      window: {
        from: window.from?.toISOString() ?? null,
        to: window.to?.toISOString() ?? null,
      },
      // Tokens and cost come from the request log over the window; `budget` is the key's counter
      // for the current UTC month and equals the logged cost when the window covers that month.
      key: key === null ? null : { key_id: key.id, team: key.team },
      totals: totalsView(totals),
      keys: report.keys.map(usageView),
      // Requests that could not be tied to a key (a missing or unknown key). They are not in
      // `totals`, which sums the keys only.
      unattributed_requests: report.unattributedRequests,
    };
  });

  app.get('/admin/logs', async (request) => {
    const store = need();
    const window = parseWindow(request);
    const limit = parseLimit(single(request, 'limit'));
    const status = parseStatus(single(request, 'status'));
    const before = parseCursor(single(request, 'cursor'));
    const key = await resolveKey(store, request);

    const page = await guarded(request, () =>
      store.logs({ keyId: key?.id ?? null, status, ...window, limit, before }),
    );
    return {
      data: page.rows.map(logView),
      limit,
      // Pass this back as `cursor` for the next (older) page; `null` on the last page.
      next_cursor:
        page.nextCursor === null
          ? null
          : `${page.nextCursor.createdAt}_${page.nextCursor.requestId}`,
    };
  });
}
