import type { GatewayConfig } from '../config/gatewayConfig.js';
import { OpenAICompatibleAdapter } from './openaiCompatible.js';
import type { ProviderAdapter, ProviderRegistry } from './types.js';

/**
 * One `OpenAICompatibleAdapter` per provider in the config. Pointing the gateway at another
 * OpenAI-compatible endpoint (Groq, Ollama, OpenAI itself) is a config change, not a code change.
 */
export function createProviderRegistry(config: GatewayConfig): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();
  for (const provider of config.providers.values()) {
    adapters.set(
      provider.name,
      new OpenAICompatibleAdapter({
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      }),
    );
  }
  return { get: (name) => adapters.get(name) };
}
