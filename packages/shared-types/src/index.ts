/**
 * Types and constants shared by the gateway and the console.
 * Keep this package dependency-free.
 */

/** The `x-prism-*` response header contract (smoke test and load test depend on it). */
export const PRISM_HEADERS = {
  provider: 'x-prism-provider',
  cache: 'x-prism-cache',
  fallback: 'x-prism-fallback',
  costUsd: 'x-prism-cost-usd',
} as const;

/** OpenAI-style error envelope returned by every rejection path. */
export interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    code: string;
  };
}
