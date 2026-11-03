import type { GatewayConfig } from '../config/gatewayConfig.js';

/** What a requested model name means. Allowlist, tier selection and fallbacks use this later. */
export type ResolvedModel =
  | { kind: 'alias'; name: string }
  | { kind: 'auto'; name: 'auto' }
  | { kind: 'model'; name: string };

/**
 * Step 3 of the check order: is this a name the gateway knows? Tier aliases (`fast`, `smart`),
 * `auto`, and configured model names are valid; anything else is `null` (→ 404). Matching is
 * exact and case-sensitive so a typo can never fall through to a provider.
 */
export function resolveModel(config: GatewayConfig, requested: string): ResolvedModel | null {
  if (config.aliases.has(requested)) return { kind: 'alias', name: requested };
  if (requested === 'auto' && config.auto !== null) return { kind: 'auto', name: 'auto' };
  if (config.models.has(requested)) return { kind: 'model', name: requested };
  return null;
}
