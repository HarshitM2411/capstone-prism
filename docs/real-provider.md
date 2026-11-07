# Swapping in a real provider

Prism talks to every provider through one `OpenAICompatibleAdapter` (`apps/gateway/src/providers/openaiCompatible.ts`).
The mock providers in Docker are reached through exactly that adapter (`base_url` plus a key), so using a real
OpenAI-compatible service is a configuration change. Nothing in routing, retries, failover, streaming, metering or
the cache knows which provider it is talking to.

This was run live against OpenRouter (an OpenAI-compatible service) with `openai/gpt-4o-mini`; the results are in
[`verification/real_provider.txt`](verification/real_provider.txt). OpenAI itself, Groq, Together or a local Ollama
differ only in `base_url`, key and model names.

## Steps

1. **Prices.** Append the model to `data/model_pricing.json` with the current price from the provider's pricing page
   (USD per 1M tokens). The model name is whatever the provider expects in the request, for example:

   ```json
   "openai/gpt-4o-mini": { "input_per_1m": 0.15, "output_per_1m": 0.60 }
   ```

   Check the price on the provider's page before relying on cost numbers. A priced model that no provider serves is
   ignored, so the default mock setup is unaffected.

2. **Config.** Copy `data/gateway_config.real.example.json` to `data/gateway_config.real.json` (git-ignored). It
   registers the provider with an explicit `models` list and puts it first in the `fast` chain, with the mocks as
   fallbacks. Change the model name there if you use another one.

3. **Key and URL from the environment only.** In the config both `base_url` and `api_key` are written as `env:NAME`
   (`env:OPENAI_BASE_URL`, `env:OPENAI_API_KEY`). The gateway reads them at startup and refuses to start, naming the
   variable (never its value), if one is missing or the URL is not http(s). Put them in your untracked `.env`:

   ```
   OPENAI_API_KEY=...
   OPENAI_BASE_URL=https://openrouter.ai/api/v1   # or https://api.openai.com/v1
   ```

   `.env` is git-ignored. Then start with the real config:

   ```
   GATEWAY_CONFIG_FILE=gateway_config.real.json docker compose up -d --build gateway
   ```

   (PowerShell: `$env:GATEWAY_CONFIG_FILE="gateway_config.real.json"` first.) Remove the variable and run
   `docker compose up -d gateway` to go back to the mocks.

4. **Check.** Run the same checks as for the mocks: `scripts/smoke_test.py ... --model fast`, a streaming request,
   `scripts/load_test.py`, and compare `/admin/usage` with the client-side sums.

## What was and was not exercised live

- Live: non-streaming and streaming requests, the smoke test (17 passed), the load test with usage reconciled to the
  cent, exact cost from the provider-reported usage.
- Not live: failover away from the real provider, because a real provider cannot be made to fail on demand. That path is
  provider-agnostic and was exercised with the mocks.
- A response header shows the provider as `provider/model`, so an OpenRouter model name makes it read
  `openai/openai/gpt-4o-mini` (provider `openai` is the name in the config, the model is `openai/gpt-4o-mini`).
