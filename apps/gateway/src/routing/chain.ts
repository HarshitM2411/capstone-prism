import type { GatewayConfig, ModelInfo } from '../config/gatewayConfig.js';
import type { ResolvedModel } from './resolve.js';

/**
 * The models that may serve a request, in the order they are tried.
 *
 *  - a tier alias (`fast`, `smart`) is its primary followed by its fallbacks;
 *  - a concrete model name is that model alone: the caller chose it, so it is never swapped;
 *  - `auto` uses the `smart` chain until Phase 7's classifier picks the tier.
 *
 * Config validation guarantees every name in a chain is a priced model with a provider.
 */
export function modelChain(config: GatewayConfig, resolved: ResolvedModel): ModelInfo[] {
  let names: readonly string[];
  if (resolved.kind === 'model') names = [resolved.name];
  else if (resolved.kind === 'alias') names = config.aliases.get(resolved.name)!.chain;
  else names = config.aliases.get(config.auto!.complex)!.chain;
  return names.map((name) => config.models.get(name)!);
}
