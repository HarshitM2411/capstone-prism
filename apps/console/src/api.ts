/** Types of the gateway's admin API (`/admin/*`) and a tiny client for it. */

export interface Totals {
  requests: number;
  served: number;
  cache_hits: number;
  fallbacks: number;
  rejected: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: string;
}

export interface KeyUsage extends Totals {
  key_id: number;
  team: string;
  key_hint: string;
  status: string;
  budget: { period: string; monthly_usd: string; spent_usd: string; reserved_usd: string };
}

export interface UsageResponse {
  window: { from: string | null; to: string | null };
  totals: Totals;
  keys: KeyUsage[];
  unattributed_requests: number;
}

export interface LogEntry {
  request_id: string;
  created_at: string;
  key_id: number | null;
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

export interface LogsResponse {
  data: LogEntry[];
  limit: number;
  next_cursor: string | null;
}

export interface CacheKeyView {
  key_id: number;
  team: string;
  key_hint: string;
  cache_enabled: boolean;
  similarity_threshold: number | null;
  hits: number;
  misses: number;
  hit_rate: number;
  entries: number;
  stored_hit_count: number;
}

export interface CacheStatsResponse {
  definition: string;
  enabled: boolean;
  overall: {
    hits: number;
    misses: number;
    hit_rate: number;
    entries: number;
    stored_hit_count: number;
  };
  keys: CacheKeyView[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** GET `/admin/...` with the admin token. The console never talks to anything else. */
export async function adminGet<T>(
  path: string,
  token: string,
  params: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(name, String(value));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  let response: Response;
  try {
    response = await fetch(`${path}${suffix}`, { headers: { 'x-admin-token': token }, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the gateway.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* keep the generic message */
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

/** `0.00001455` -> `$0.00001455`; exact text from the API is shown as is, never rounded. */
export function usd(value: string): string {
  return `$${value}`;
}

export function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Share of the monthly budget that is spent, capped for display. */
export function budgetShare(spent: string, monthly: string): number {
  const total = Number(monthly);
  if (!(total > 0)) return 0;
  return Math.min(1, Number(spent) / total);
}
