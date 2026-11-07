# Prism

Prism is an OpenAI-compatible LLM gateway. Teams call one endpoint with a virtual API key. Prism
authenticates the key, enforces its model allowlist, rate limit and monthly budget, routes the request to
a provider (with retries and failover), optionally answers from a semantic cache, and records the exact
tokens and cost of every request. A small console shows usage, requests and cache behaviour.

- Gateway: Node 22, TypeScript, Fastify 5 (`apps/gateway`)
- Console: React + Vite, served by nginx (`apps/console`)
- State: Postgres with `pgvector` (keys, budgets, request log, cache), Redis (rate limit)
- Providers: two mock providers (`alpha`, `beta`) from `scripts/mock_provider.py`; any OpenAI-compatible
  service can replace them by configuration ([docs/real-provider.md](docs/real-provider.md))

Related documents: [architecture](docs/architecture.md), [implementation plan](docs/implementation-plan.md),
[verification report](docs/verification-report.md), [evaluation criteria](docs/eval.md),
[edge cases](docs/edgecase.md), [demo script](docs/demo-script.md).

## Quick start (Docker)

Requirements: Docker with Compose, about 4 GB of free disk for the images. No other setup is needed; every
setting has a default.

```bash
docker compose up -d --build
docker compose ps          # postgres, redis, alpha, beta, gateway, console should be healthy/running
curl http://localhost:8080/health
```

| Service | URL | Notes |
| --- | --- | --- |
| Gateway | http://localhost:8080 | `POST /v1/chat/completions`, `/admin/*`, `/health` |
| Console | http://localhost:3000 | sign in with the admin token (below) |
| `alpha` mock | http://localhost:9001 | models `alpha-small`, `alpha-large` |
| `beta` mock | http://localhost:9002 | models `beta-small`, `beta-large` |

The first start applies the database migrations and seeds the demo keys from `data/seed_keys.json`
(idempotent; set `SEED_ON_START=false` to skip). The embedding model (`Xenova/all-MiniLM-L6-v2`) is baked
into the gateway image, so nothing is downloaded at runtime.

Stop with `docker compose down` (add `-v` to also delete the database).

### Demo keys and admin token

| Team | Key | Budget / month | Rate limit | Models | Semantic cache |
| --- | --- | --- | --- | --- | --- |
| search | `prism-sk-search-1a2b3c` | $50 | 60 rpm | `fast` | on, threshold 0.92 |
| research | `prism-sk-research-4d5e6f` | $500 | 300 rpm | `fast`, `smart`, `auto` | off |
| free-tier | `prism-sk-free-7g8h9i` | $5 | 10 rpm | `fast` | on, threshold 0.85 |
| budget-demo | `prism-sk-budget-demo-0j1k2l` | $0.00001 | 60 rpm | `fast` | off |

Admin token for `/admin/*` and the console: `change-me-demo-admin-token` (header `x-admin-token`). These are
demo values; change `ADMIN_TOKEN` for anything else. Keys are stored only as hashes.

## Try it

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer prism-sk-search-1a2b3c" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"What is the capital of France?"}]}' -i
```

PowerShell users should use `curl.exe` and put the JSON body in a file (`-d "@body.json"`) to avoid quoting
problems.

Every response (including errors) carries:

| Header | Meaning |
| --- | --- |
| `x-prism-provider` | `provider/model` that answered (for example `alpha/alpha-small`); `none` for a cache hit or a rejected request |
| `x-prism-cache` | `hit` or `miss` (`miss` also when the key has the cache switched off) |
| `x-prism-fallback` | `true` if a fallback provider answered after the primary failed |
| `x-prism-cost-usd` | cost of this request as decimal text (non-streaming only; `0` for a cache hit) |

Add `"stream": true` for server-sent events. Prism asks the provider for usage on streams and bills the
reported usage; if a provider sends none, usage is estimated from the delivered text and flagged in the log.

## API overview

### Data plane: `POST /v1/chat/completions`

OpenAI request and response shapes. `model` is a concrete model (`alpha-small`) or an alias: `fast`, `smart`,
`auto`. `auto` classifies the prompt (simple or complex) and picks `fast` or `smart`; the reason is logged
(`route_reason`). Errors use the OpenAI envelope `{"error": {"message", "type", "code"}}`.

Checks run in this order, so the first failure decides the response:

| Order | Check | Status | Code |
| --- | --- | --- | --- |
| 1 | Missing or unknown key | 401 | `invalid_api_key` |
| 2 | Malformed body | 400 | `invalid_request` and similar |
| 3 | Unknown model | 404 | `model_not_found` |
| 4 | Model not in the key's allowlist | 403 | |
| 5 | Requests per minute (Redis sliding window) | 429 | `rate_limit_exceeded` |
| 6 | Monthly budget (atomic reserve) | 402 | `budget_exceeded` |
| 7 | Semantic cache lookup | 200 on a hit | |
| 8 | Provider call with retries, then failover | 200, or 502 | `upstream_error` |

If Redis cannot answer in time the rate limiter fails closed with `503`.

### Admin plane (`x-admin-token` header)

| Route | Purpose |
| --- | --- |
| `GET /admin/ping` | token check (used by the console sign-in) |
| `GET /admin/usage?key=&from=&to=` | requests, tokens, cost and budget per key; `key` is a team name, key id or raw key |
| `GET /admin/logs?key=&status=&from=&to=&limit=&cursor=` | request log, newest first, keyset pagination (`next_cursor`); `limit` default 50, max 200 |
| `GET /admin/cache/stats` | per-key and overall hits, misses, hit rate and entries |

`from` and `to` accept a date (`2026-11-06`, the whole UTC day, inclusive) or a timestamp with a zone (`to` is
exclusive). Neither route ever returns raw keys, key hashes, provider secrets or prompt text. Cost is an exact
8-decimal string.

## Configuration

### Environment variables (gateway)

All have defaults in `docker-compose.yml`; copy `.env.example` to `.env` to override.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | compose Postgres | required, `postgres://...` |
| `REDIS_URL` | compose Redis | required, `redis://...` |
| `ADMIN_TOKEN` | `change-me-demo-admin-token` | required, at least 8 characters |
| `PORT`, `HOST`, `LOG_LEVEL` | `8080`, `0.0.0.0`, `info` | server |
| `GATEWAY_CONFIG_FILE` | `gateway_config.docker.json` (compose) | providers, aliases, retry policy; file in `DATA_DIR` |
| `DATA_DIR` | `/data` (compose), `<repo>/data` otherwise | config, pricing, seed keys |
| `SEED_ON_START` | `true` | load `seed_keys.json` at startup |
| `PROVIDER_FIRST_BYTE_TIMEOUT_MS` | `2000` | time for a provider to start answering |
| `PROVIDER_IDLE_TIMEOUT_MS` | `10000` | longest silence inside a stream |
| `REQUEST_DEADLINE_MS` | `10000` (compose) | cap on one request including all retries and failovers |
| `STREAM_MAX_DURATION_MS` | `120000` | longest single stream |
| `REDIS_TIMEOUT_MS` | `500` | per Redis command; past it the request gets 503 |
| `EMBEDDING_MODEL`, `EMBEDDING_TIMEOUT_MS` | MiniLM, `1500` | local embeddings for routing and cache |
| `CACHE_TTL_SECONDS` | `86400` | how long a cached answer is served (`0` = never expires) |
| `DB_POOL_MAX`, `DB_CONNECT_TIMEOUT_MS` | `10`, `5000` | Postgres pool |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `GROQ_API_KEY` | empty, `https://api.openai.com/v1`, empty | only for real providers, see below |

Invalid values stop the gateway at startup with a message naming the variable. Secrets are never logged.

### Providers, aliases and prices

- `data/gateway_config.docker.json` (Docker) and `data/gateway_config.sample.json` (providers on `localhost`)
  define providers (`name`, `base_url`, `api_key`, optional `models`), aliases with a primary and ordered
  fallbacks, the retry policy and the `auto` mapping.
- `data/model_pricing.json` holds the price per 1M tokens for every model; a model without a price is a
  startup error, so cost is never silently zero.
- A provider `api_key` or `base_url` may be written `"env:NAME"`, read from the environment at startup.
- To use a real provider, follow [docs/real-provider.md](docs/real-provider.md). It is a configuration change,
  not a code change.

### Seeding keys

Edit `data/seed_keys.json` (team, `virtual_key`, budget, rate limit, allowlist, cache settings) and restart the
gateway, or run `pnpm --filter @prism/gateway db:seed` against a reachable database. Seeding is idempotent.

## Running the tests

Python 3 is needed for the starter scripts; they use only the standard library.

```bash
# Smoke test (17 checks). Clear the cache first when re-running, see the note below.
docker compose exec postgres psql -U prism -d prism -c "TRUNCATE cache_entries"
python scripts/smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast

# Load test: burst past the free-tier limit (10 rpm), then compare with /admin/usage
python scripts/load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10
curl -H "x-admin-token: change-me-demo-admin-token" "http://localhost:8080/admin/usage?key=free-tier"

# Routing evaluation for model: auto
pnpm routing:eval --set both

# Gateway unit and integration tests (integration tests need Postgres and Redis from compose)
pnpm install
pnpm lint && pnpm typecheck && pnpm format:check
pnpm --filter @prism/gateway test
```

**Cache note.** The smoke test's salt does not isolate runs because the embeddings are salt-insensitive, so a
second run is served from the first run's cache. Truncate `cache_entries` between runs, as above.

Results of all of these, with raw output, are in [docs/verification-report.md](docs/verification-report.md).

## Local development without Docker for the gateway

```bash
corepack enable && pnpm install
docker compose up -d postgres redis alpha beta
pnpm --filter @prism/gateway model:fetch         # one-time embedding model download into .models/
# set DATABASE_URL=postgres://prism:prism@localhost:5432/prism, REDIS_URL=redis://localhost:6379,
# ADMIN_TOKEN=change-me-demo-admin-token (the sample config points providers at localhost)
pnpm dev:gateway
pnpm dev:console                                 # http://localhost:3000, proxies /admin to the gateway
```

## Architecture summary

```
client --> Gateway (Fastify)
            auth -> validate -> resolve model -> allowlist -> rate limit (Redis)
            -> classify `auto` -> budget reserve (Postgres) -> semantic cache (pgvector)
            -> provider adapter (retry, failover) -> settle cost, write request log
Console --> /admin/* (read-only usage, logs, cache stats)
```

Details and diagrams are in [docs/architecture.md](docs/architecture.md). The decisions that matter:

- **One adapter for every provider.** Providers speak the OpenAI protocol, so a provider is a `base_url`, a key
  and a model list. Mock and real providers take the same code path.
- **Routing and failover.** An alias has a primary and ordered fallbacks. Timeouts, connection errors and 5xx
  are retried on the same provider with exponential backoff; a 429 or a malformed answer fails over at once;
  when a provider is exhausted the next one is tried and `x-prism-fallback: true` is set. A rejected key or
  request (provider 401/400) is not retried and gives a 502. A stream can only fail over before its first
  chunk has reached the client; after that the provider is committed.
- **`auto` routing.** A local classifier combines structural signals and an embedding-similarity score against
  labelled examples against a fixed threshold (it falls back to structural signals alone if embeddings are slow). Accuracy on the dev and held-out
  sets is in the verification report.
- **Cache scoping.** The cache is per key (never shared between teams), per requested alias, and per
  request context (a hash of the request parts that change the answer). Lookup uses cosine similarity on
  384-dimension embeddings and honours each key's threshold and on/off switch. Hits cost $0,
  are logged with `resolved_provider = null`, and report the stored answer's token counts.
- **Budget accounting.** Money is an integer number of 1e-8 USD, never a float. A request reserves an estimate
  of its cost (capped at what is left) atomically before the provider call, so concurrent requests cannot
  overspend. The hold is settled to the exact cost afterwards; a failed request or a cache hit releases it, and
  holds left by a crash are cleared. The budget
  period is the UTC calendar month.
- **Rate limiting.** A Redis sliding window per key. It fails closed: no Redis, no requests.
- **Logging.** Exactly one request-log row per request, whatever the outcome (success, cache hit, each
  rejection, upstream error, client disconnect).

## Known limitations

- The real-provider path was run live once (OpenRouter, openai/gpt-4o-mini) but failover away from a real provider was only tested with the mocks.
- A slow (not failing) provider costs about three timeouts (about 6.6 s with the defaults) before failover;
  there is no health-based skipping of a degraded provider.
- The cache has a TTL but no size cap. Cache pair B of the starter sample does not hit at a safe threshold.
- `auto` routing is heuristic and tuned for English prompts.
- Tokens-per-minute limits are stored but not enforced.
- Streaming responses have no `x-prism-cost-usd` header (the cost is only known at the end); it is in the
  logs and the usage API.
- Budgets are consistent in Postgres but only tested with one gateway instance.
- One shared admin token; the console is read-only.

The full list, with measurements, is in section 9 of the verification report.
