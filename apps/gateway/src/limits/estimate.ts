import type { GatewayConfig, ModelInfo } from '../config/gatewayConfig.js';
import type { ChatMessage, ChatRequest } from '../http/validate.js';
import type { ResolvedModel } from '../routing/resolve.js';

/** Output cap assumed when the client sets no `max_tokens`. */
export const DEFAULT_OUTPUT_CAP_TOKENS = 1024;

/** Extra tokens per message for role markers and separators. */
const PER_MESSAGE_OVERHEAD = 4;

const PICO_PER_UNIT = 10_000n;

/**
 * An upper bound on prompt tokens without running a tokenizer: no tokenizer produces more than one
 * token per two characters of English text (the mock providers count whitespace-separated words,
 * which is also below this bound). Over-estimating is safe: a reservation is capped at the budget
 * that remains and is replaced by the real cost at settlement.
 */
export function estimatePromptTokens(messages: readonly ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 2) + PER_MESSAGE_OVERHEAD * messages.length;
}

/**
 * The model used to price the reservation (edge case 5.16): the primary of an alias's chain, the
 * model itself for a concrete name, and — until Phase 7's classifier decides — the most expensive
 * tier for `auto`, so the estimate stays an upper bound.
 */
export function pricingModel(config: GatewayConfig, resolved: ResolvedModel): ModelInfo {
  let name: string;
  if (resolved.kind === 'model') name = resolved.name;
  else if (resolved.kind === 'alias') name = config.aliases.get(resolved.name)!.primary;
  else name = config.aliases.get(config.auto!.complex)!.primary;
  return config.models.get(name)!;
}

/** Estimated worst-case cost of a request in units of 1e-8 USD, rounded up. */
export function estimateCostUnits(
  config: GatewayConfig,
  resolved: ResolvedModel,
  chat: Pick<ChatRequest, 'messages' | 'maxTokens'>,
): bigint {
  const model = pricingModel(config, resolved);
  const promptTokens = BigInt(estimatePromptTokens(chat.messages));
  const outputTokens = BigInt(chat.maxTokens ?? DEFAULT_OUTPUT_CAP_TOKENS);
  const pico = promptTokens * model.inputPicoPerToken + outputTokens * model.outputPicoPerToken;
  return (pico + PICO_PER_UNIT - 1n) / PICO_PER_UNIT;
}
