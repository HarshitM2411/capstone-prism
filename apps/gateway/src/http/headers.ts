import type { FastifyReply } from 'fastify';
import { formatUsd } from '../money.js';

/** The `x-prism-*` response header contract (the starter's smoke and load tests read these). */
export const PRISM_HEADERS = {
  provider: 'x-prism-provider',
  cache: 'x-prism-cache',
  fallback: 'x-prism-fallback',
  costUsd: 'x-prism-cost-usd',
} as const;

export interface PrismHeaderValues {
  /** Provider that served the request; `none` when no provider was called. */
  provider: string;
  cache: 'hit' | 'miss';
  /** Whether a fallback model/provider (not the primary) served the request. */
  fallback: boolean;
  /** Cost in units of 1e-8 USD. `null` means "not known" (streams) and the header is omitted. */
  costUnits: bigint | null;
}

/** What every response carries unless a later stage overrides it. */
export const DEFAULT_PRISM_HEADERS: PrismHeaderValues = {
  provider: 'none',
  cache: 'miss',
  fallback: false,
  costUnits: 0n,
};

/**
 * The one place that writes the `x-prism-*` headers with real values. Stages call this when they
 * know more than the defaults (provider, cache hit, cost, fallback).
 */
export function setPrismHeaders(
  reply: FastifyReply,
  values: Partial<PrismHeaderValues> = {},
): void {
  const merged = { ...DEFAULT_PRISM_HEADERS, ...values };
  reply.header(PRISM_HEADERS.provider, merged.provider);
  reply.header(PRISM_HEADERS.cache, merged.cache);
  reply.header(PRISM_HEADERS.fallback, merged.fallback ? 'true' : 'false');
  if (merged.costUnits === null) {
    reply.removeHeader(PRISM_HEADERS.costUsd);
  } else {
    reply.header(PRISM_HEADERS.costUsd, formatUsd(merged.costUnits));
  }
}

function isEventStream(reply: FastifyReply): boolean {
  const type = reply.getHeader('content-type');
  return typeof type === 'string' && type.includes('text/event-stream');
}

/**
 * Safety net run in `onSend`: adds any contract header that no earlier stage set, without
 * overwriting real values. Rejections and framework errors therefore carry the full contract too
 * (E1). Streams never get `x-prism-cost-usd` (the cost is not known up front).
 */
export function fillMissingPrismHeaders(reply: FastifyReply): void {
  if (!reply.hasHeader(PRISM_HEADERS.provider)) {
    reply.header(PRISM_HEADERS.provider, DEFAULT_PRISM_HEADERS.provider);
  }
  if (!reply.hasHeader(PRISM_HEADERS.cache)) {
    reply.header(PRISM_HEADERS.cache, DEFAULT_PRISM_HEADERS.cache);
  }
  if (!reply.hasHeader(PRISM_HEADERS.fallback)) reply.header(PRISM_HEADERS.fallback, 'false');
  if (!isEventStream(reply) && !reply.hasHeader(PRISM_HEADERS.costUsd)) {
    reply.header(PRISM_HEADERS.costUsd, '0');
  }
}
