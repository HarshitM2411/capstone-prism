# Swapping in a real provider

Prism talks to every provider through one `OpenAICompatibleAdapter` (`apps/gateway/src/providers/openaiCompatible.ts`).
The mock providers in Docker are reached through exactly that adapter (`base_url` plus a key), so using a real
OpenAI-compatible service is a configuration change, not a code change. Nothing in routing, retries, failover,
streaming, metering or the cache knows which provider it is talking to.

## Steps (OpenAI shown; Groq, Together or a local Ollama only differ in `base_url`, key and model names)

1. **Prices.** Append the model to `data/model_pricing.json` with the current price from the provider's
   pricing page (USD per 1M tokens), for example:

   ```json
   "gpt-4o-mini": { "input_per_1m": 0.15, "output_per_1m": 0.60 }
   ```

   The figures above are an example; check the page before relying on cost numbers.

2. **Config.** Copy `data/gateway_config.real.example.json` to `data/gateway_config.real.json`. It registers the
   provider with an explicit `models` list (the name-prefix rule used for the mocks does not apply to
   `gpt-...`) and puts it first in the `fast` chain with the mocks as fallbacks. For a local Ollama use
   `"base_url": "http://host.docker.internal:11434/v1"` and any non-empty key.

3. **Key from the environment only.** The provider's `api_key` is written as `"env:OPENAI_API_KEY"`. The gateway
   reads that variable at startup and refuses to start, naming the variable, if it is missing. Put the key in
   your shell or in an untracked `.env`, never in a tracked file:

   ```
   OPENAI_API_KEY=sk-... GATEWAY_CONFIG_FILE=gateway_config.real.json docker compose up -d gateway
   ```

4. **Check.** Run the same checks as for the mocks: the smoke test (`scripts/smoke_test.py ... --model fast`),
   a streaming request, a failover (point `base_url` at a closed port or use a wrong key to see the `502`/failover
   behaviour), and compare `/admin/usage` with the sum of `x-prism-cost-usd` headers.

## What is and is not covered without a key

- Covered by automated tests with no network: the adapter against local OpenAI-compatible servers (success,
  streaming with `stream_options.include_usage`, 4xx/5xx/429, timeouts, malformed bodies), and the config loader
  (`env:` keys, explicit model lists, a real provider in a fallback chain).
- Needs a real key and spend, and has **not** been run: a live call to a real provider.
