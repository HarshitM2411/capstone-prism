# Prism — Implementation Plan

**Based on:** [`docs/architecture.md`](architecture.md) (decisions locked: Postgres + Redis, mocks-first with an optional real provider swapped in later, local `transformers.js` embeddings, Docker Compose for local/demo) and the starter pack (`data/`, `scripts/`, and the [`prism-capstone`](https://github.com/airtribe-projects/prism-capstone) contract docs).

This plan breaks the build into phases. Each phase has a goal, concrete tasks, and **exit criteria** — a phase isn't "done" until its exit criteria are met, not just when the code is written. Phases are ordered by dependency: each one builds on a working, testable previous phase. Nothing here gets pushed to git without your review (per our working agreement). The matching verification for each phase is in [`eval.md`](eval.md); the edge cases each phase must handle are in [`edgecase.md`](edgecase.md).

> **Revision note:** this version aligns the plan with the starter pack and the decisions confirmed after reading it: the starter's `mock_provider.py` is the mock provider (failure injection happens on the mocks' own `/admin/config`, so no gateway-side health toggle is built); the admin API uses `/admin/*` routes behind an admin token; rate limiting uses a Redis **sliding window** (a fixed window can fail the provided load test at a minute boundary); the budget uses an atomic **reserve → settle** pattern; rejections are logged; per-key cache settings and `auto` routing reasons are first-class; provider health tracking is Good To Have. It also keeps the earlier additions: retry/failover billing semantics, concurrent accounting-accuracy testing, and a full-pipeline integration checkpoint.

---

## Prerequisites

| Item | Status |
|---|---|
| Node.js 22, Python 3.12 | Installed |
| `pnpm` | Installed (12.16.1, via `npm i -g pnpm` — `corepack enable` failed with `EPERM`) |
| Docker Desktop (with Compose) | Installed and running |
| Starter files (`data/`, `scripts/`) | Copied into the workspace (not yet committed) |

---

## Phase Overview

| # | Phase | Depends on |
|---|---|---|
| 0 | Project scaffolding & infra | — |
| 1 | Data layer: schema, migrations, seed loading | 0 |
| 2 | HTTP skeleton + auth + validation + error envelope | 1 |
| 3 | Rate limits & budgets | 2 |
| 4 | Provider adapter layer + core pass-through | 0, 2 |
| 5 | Routing, retries, failover | 3, 4 |
| 6 | Streaming pass-through | 5 |
| 7 | Smart routing (`auto`) + eval (embedding signal needs the Phase 8 embedding service — build structural features first, or build the embedding service first) | 5, 8 |
| 8 | Semantic cache | 4 |
| 9 | Metering, logs, admin/usage API + pipeline integration check | 5, 6, 8 |
| 10 | Ops console (React) | 9 |
| 11 | Verification: smoke/load/eval reports + failure drill | 1–9 |
| 12 | Real provider swap-in | 4, 11 |
| 13 | Docs, demo, deliverables packaging | all |

---

## Phase 0 — Project Scaffolding & Infra

**Goal:** An empty but running system — containers up, nothing functional yet, but the skeleton is right.

- [x] Pull the `prism-capstone` starter content (`data/*`, `scripts/*`) into the workspace — approved and done; not yet committed.
- [x] Run `python scripts/validate_pack.py` to confirm the seed and eval data are consistent.
- [x] Initialize monorepo (pnpm workspaces): `apps/gateway`, `apps/console`, `packages/shared-types`, `data/`, `scripts/`, `docs/`.
- [x] TypeScript config, ESLint/Prettier, base `package.json` scripts (`dev`, `build`, `test`, `lint`) for gateway and console.
- [x] `.env.example` (admin token, DB/Redis URLs, upstream timeouts) and a documented config loading story.
- [x] `docker-compose.yml`: Postgres (with `pgvector` extension enabled), Redis, **mock providers `alpha` (port 9001) and `beta` (port 9002)** running the starter's `scripts/mock_provider.py`, gateway (port 8080), console. Services wait for healthy dependencies.
- [x] Gateway boots on Fastify with a `/health` endpoint only.
- [x] Console boots (React + Vite) showing a placeholder page.

**Status: complete.** Notes: TypeScript is pinned to 6.x (`typescript-eslint` does not support 7.0 yet); pnpm 12 requires build scripts to be approved, so `esbuild` is allowed in `pnpm-workspace.yaml`; the gateway's `/health` is a liveness check only — dependency checks (Postgres in Phase 1, Redis in Phase 3) are added with their clients.

**Exit criteria:** `docker compose up` brings up Postgres, Redis, both mock providers (each answering a direct curl), gateway (`/health` → 200), and console (loads in browser) with one command.

---

## Phase 1 — Data Layer: Schema, Migrations, Seed Loading

**Goal:** Durable storage exists and is populated with the provided seed data.

- [x] Postgres schema/migrations for `virtual_keys`, `budget_usage` (with `reserved_usd`), `request_logs`, `cache_entries` (per architecture.md §5).
- [x] Enable `pgvector` extension; `cache_entries.embedding` as a `vector` column; indexes on `request_logs (key_id, created_at)` and the cache lookup path.
- [x] Startup config loader: reads `model_pricing.json` and `gateway_config.sample.json` (providers, aliases incl. `auto`, retry policy, degradation settings) into validated in-memory structures (alias → model → fallback chain, model → price, model → provider). **Fail fast** on a missing/malformed file, an alias target missing from the price table, or a fallback not served by a registered provider.
- [x] Seed script: loads `seed_keys.json` into `virtual_keys` — `team`, hashed key, budget, RPM (and TPM when present), allowlist, **per-key cache `enabled`/`similarity_threshold`**, `status`, `created_at` — **preserving exact key values, team names and alias names** (spec requirement — demo/scripts depend on these). Idempotent: re-seeding changes nothing and creates no duplicates.
- [x] Money handling decided and implemented once: integer-scaled arithmetic / `NUMERIC`, never floats (architecture.md §4.9).
- [x] DB access layer (lightweight query module, no heavy ORM needed — e.g. `pg` + hand-written SQL, or Drizzle if we want type-safe queries) with a bounded connection pool.

**Exit criteria:** Fresh container start → migrations run → seed keys queryable from DB → config maps loaded and logged at startup. Re-running the seed is a no-op. Unit tests for the config loader (including the fail-fast cases) and the seed script.

**Status: complete.** Notes: the seed upserts by `team` and never touches status, so a key disabled in the database stays disabled; the Docker config is data/gateway_config.docker.json (same as the sample, with the provider hostnames `alpha` and `beta`) because localhost is not reachable from the gateway container; the gateway's /health now reports Postgres (200 ok, or 503 degraded).

---

## Phase 2 — HTTP Skeleton + Auth + Validation

**Goal:** `POST /v1/chat/completions` exists, authenticates, validates shape, and logs — but just echoes/stubs the response (no provider call yet).

- [x] Fastify route + JSON schema validation for the OpenAI-compatible request body (empty `messages` → `400`, per the starter's `req_malformed`), with a body-size limit.
- [x] Auth middleware: resolve the virtual key by hash → `{ keyId, team, allowedModels, rpmLimit, monthlyBudgetUsd, cache config }`; reject missing/unknown/malformed/disabled keys with `401` (`authentication_error` / `invalid_api_key`). Auth runs first, validation second.
- [x] Unknown model or alias → `404` (`not_found_error` / `model_not_found`).
- [x] Shared error envelope `{ error: { message, type, code } }` used by every rejection path from here on (architecture.md §6).
- [x] `x-prism-*` response headers (`x-prism-provider`, `x-prism-cache`, `x-prism-fallback`, `x-prism-cost-usd`) wired through **one** helper with default values, so every code path emits them from day one.
- [x] Minimal request-log write on **every** path, including rejections (unknown key → null key), with the `status` enum. Completeness is verified in Phase 9.
- [x] Admin plane skeleton: `x-admin-token` check (`ADMIN_TOKEN` env), used by the `/admin/*` routes added later.

**Exit criteria:** Valid key + valid body → 200 stub response with the full header contract present. Invalid/missing key → `401`; empty `messages` → `400`; unknown model → `404`; each with the standard error body and each logged. Tests for all of these paths.

**Status: complete.** Notes: validation is hand-written (not a JSON schema) so every problem is reported in one message and the response always uses our envelope; authentication runs in the route's `onRequest` hook, before the body is parsed, so a bad key plus a bad body is always `401`. Beyond the plan: framework parse errors map to `400 invalid_json`, `413 request_too_large` and `415 unsupported_media_type` (all logged as `rejected_validation`); unsupported OpenAI parameters (`tools`, `n > 1`, `logprobs`, ...) are rejected instead of silently dropped (resolves P2); migration `002` adds an `internal_error` log status; `GET /admin/ping` is the only admin route until Phases 9-10. The `200` response is a stub (it also covers `stream: true` with a short SSE body) that Phase 4 and Phase 6 replace; allowlist, rate limit and budget checks arrive in Phase 3.

---

## Phase 3 — Rate Limits & Budgets

**Goal:** All four rejection types work correctly, including under concurrency, in the documented check order.

- [x] Model allowlist check (against the requested name; `auto` only for keys that list it) → `403 model_not_allowed`.
- [x] Redis RPM limiter: one atomic Lua script per request implementing a **sliding window** (sorted set `rpm:{keyId}`, time taken from Redis, admit only if under the limit, TTL always set) → `429 rate_limit_exceeded`. Rejected requests are not added to the window. Redis unreachable → fail closed with `503 service_unavailable` and a short timeout.
- [x] Postgres atomic budget **reserve → settle** (architecture.md §4.3): lazy period-row creation (`INSERT ... ON CONFLICT DO NOTHING`), admission only while budget remains, reservation of `LEAST(estimate, remaining)`, settlement to the actual cost, release on failure/cache hit → `402 budget_exceeded`. Cost estimate = prompt tokens + output cap priced from the resolved model.
- [x] Documented check order enforced exactly as in architecture.md §3.1; a rejected request never reaches later stages.
- [x] Concurrency tests: (a) fire N parallel requests at a key near its RPM limit; (b) fire parallel requests at a key whose budget fits only a few — confirm **no over-admission** (RPM exactly right; budget never exceeded by more than one request's cost, and the tiny-budget demo key admits exactly one request then rejects).
- [x] Reconfirm the sliding window against a burst that straddles a minute boundary (it must still admit at most the limit).

**Exit criteria:** Automated tests cover all 4 rejection codes individually, plus concurrency tests proving no race lets extra requests through. This is one of the explicitly graded criteria — do not skip the concurrency tests. Settlement is exercised with the Phase 2 stub's usage until real providers arrive in Phase 4.

**Status: complete.** Notes: the Redis limiter is `ioredis` with a per-command timeout (`REDIS_TIMEOUT_MS`, default 500 ms), no offline queue and no command retries, so a dead Redis fails the request fast with `503 rate_limiter_unavailable` and heals by itself when Redis returns; the window is a single Lua script on `rpm:{keyId}` using Redis `TIME`. Budget admission is one CTE statement (row lock → admit while `spent + reserved < budget` → hold `LEAST(estimate, remaining)`); migration `003_budget_reservations` adds one row per in-flight hold, which makes release idempotent and lets a reconciler (at startup and every 60 s, holds older than 120 s) clear holds orphaned by a crash (resolves P1). Settlement and the request's `request_logs` row are written in **one transaction**, so `spent_usd` always equals the sum of logged `cost_usd`; a duplicate settlement fails on the log primary key and charges nothing. If settlement fails the hold is released and the client gets `503` (revisit with real providers in Phases 4 and 9). The Phase 2 stub now reports real word-count usage and is priced from the resolved model, so budgets are genuinely spent: the `budget-demo` key admits its first request (about 0.0000188 USD, above its 0.00001 budget, which is the documented one-request overshoot) and rejects the rest. The concurrency tests run against real Redis (db 15) and Postgres (`prism_test`) and are repeated 5–20 times each. Verified live in Docker: `scripts/load_test.py` (30 requests, concurrency 10, limit 10) reports `Over-admission check OK`; stopping Redis returns `503`, and restarting it recovers without restarting the gateway.

---

## Phase 4 — Provider Adapter Layer + Core Pass-Through

**Goal:** The `ProviderAdapter` interface exists, one OpenAI-compatible adapter drives the mock providers, and a non-streaming request flows end to end through a single provider.

- [x] Define `ProviderAdapter` interface (architecture.md §4.6): `chatCompletion()`, `chatCompletionStream()`.
- [x] `OpenAICompatibleAdapter` against a `base_url` + `api_key` (works for the mocks now, real providers later by configuration only).
- [x] In-process **fake adapter** for deterministic, fast automated tests (configurable latency, failure/timeout injection, token-by-token streaming simulation, deterministic usage).
- [x] Timeouts at the adapter boundary for every call: connect/first-byte, per-chunk idle, plus an overall request deadline. Defaults must trip on a mock made slow with `latency_ms: 3000` (demo requirement) and be configurable.
- [x] Malformed upstream responses (invalid JSON, missing `usage`/`choices`) are handled and logged, never crash the gateway; provider error bodies are mapped to clean gateway errors and never forwarded raw. Provider keys never appear in responses or logs.
- [x] Core pass-through: `POST /v1/chat/completions` → resolve alias to its **primary** model → adapter → OpenAI-shaped response, cost computed from provider-reported usage × price table, header contract filled in (`x-prism-provider` like `alpha/alpha-small`, `x-prism-cache: miss`, `x-prism-fallback: false`, `x-prism-cost-usd`), request log written, budget settled.
- [x] Drive the real mocks by hand with curl (non-streaming) before relying on any assumption about their behavior.
- [x] Unit tests: the fake adapter and the adapter's error/timeout mapping behave deterministically so later failover/load tests are reproducible.

**Exit criteria:** A `fast` request returns a correct OpenAI-shaped response from `alpha-small` with correct headers, cost and log row; a simulated slow/dead provider (via the mock's `/admin/config` or the fake adapter) produces a timely error, never a hang.

**Status: complete.** Notes: `src/providers/` holds the `ProviderAdapter` interface, `OpenAICompatibleAdapter` (built on `fetch`; both `chatCompletion` and `chatCompletionStream` are implemented and tested, the stream is wired into the route in Phase 6), the `FakeAdapter`, and a registry built from the config. Every provider failure is a `ProviderError` with a kind (`timeout`, `connection`, `server_error`, `rate_limited`, `malformed`, `auth`, `bad_request`, `aborted`) and a built-in disposition (`retry`, `failover`, `fatal`, `abort`) that Phase 5's engine will act on; its message never contains the provider's body or key, and redirects are never followed. A response without valid `usage`, or reporting zero tokens in total, is `malformed` (never billed as free). Timeouts are environment settings: `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (default 2000, so a mock at `latency_ms: 3000` trips it), `PROVIDER_IDLE_TIMEOUT_MS` (10000) and `REQUEST_DEADLINE_MS` (15000, also the cap on all attempts once Phase 5 adds retries). Until then a failed call returns `502 upstream_error` (generic message, nothing billed, the hold released, the log row `upstream_error` with the provider and model tried). `x-prism-provider` is `provider/model` (for example `alpha/alpha-small`); the response `model` echoes the name the client sent. Streaming requests are still answered by the stub, and `auto` is priced and routed as `smart` until Phase 7's classifier. Verified live against the real mocks: `fast` served by `alpha-small`, `smart` by `alpha-large`, a 3000 ms mock gives `502` after 2.0 s, a `down` or `rate_limited` mock gives `502` immediately, and the next request after restoring the mock succeeds.

---

## Phase 5 — Routing, Retries, Failover

**Goal:** `fast`/`smart` aliases resolve correctly; failures trigger retry then failover; it's all recorded, counted, and billed correctly.

- [x] Alias → model → fallback chain resolution from `gateway_config.sample.json` (`fast`: `alpha-small` → `beta-small`; `smart`: `alpha-large` → `beta-large`).
- [x] Exponential backoff retry for transient errors (timeout, 5xx, connection reset) using the config's retry policy (3 attempts, 200 ms initial, ×2), with jitter.
- [x] Failover to the next model/provider in the chain on persistent failure, and **immediately on a provider `429`**; set `fallback` and log it.
- [x] Non-retryable provider 4xx → `502 upstream_error`, no retry, no failover; every provider failing → `502 upstream_error`, nothing billed.
- [x] **Retry/failover billing & rate-limit semantics** (decision + implementation): a single client request counts as **one** RPM hit regardless of how many internal retry/failover attempts it took; cost is billed only for the attempt that actually produced the response (failed attempts are not billed, even if a provider reports partial token usage before erroring); `retries` is recorded in the log.
- [x] `x-prism-provider` and `x-prism-fallback` headers populated correctly end-to-end.
- [x] Every request tries the primary first, so traffic returns to a restored primary immediately (Must Have behavior).
- [x] Test: use the mock's `/admin/config` (`{"mode": "down"}`) to take the primary down mid-test → confirm failover engages, is logged, and `x-prism-fallback: true`.
- [x] Test: a slow primary (`latency_ms: 3000`) → the timeout fires and the client is served by the fallback or gets a clean error; a flaky primary (`fail_rate: 0.3`) → retries absorb it.
- [x] Test: a request that retries once and fails over once still counts as exactly one RPM hit and is billed for exactly one (the successful) attempt's tokens.

**Exit criteria:** A request against `fast` or `smart` flows end-to-end to a mock provider and back with correct headers; a forced primary failure visibly fails over, recorded, counted, and billed exactly once; restoring the primary sends traffic back to it.

---

**Status: complete.** Notes: src/routing/chain.ts builds the chain (alias chain, a single concrete model, or the smart chain for `auto` until Phase 7) and src/routing/executor.ts runs it. Transient errors (timeout, connection, 5xx) retry on the same model with backoff `initial x mult^(n-1)` with +/-25% jitter, up to 3 tries per model; a provider 429 or a malformed reply fails over immediately; auth/bad-request errors end the request as `502` with no failover; a client abort stops everything. One overall deadline (`REQUEST_DEADLINE_MS`) caps all attempts; each attempt gets `min(first-byte timeout, time left)`, and a retry whose backoff would not fit is skipped. Every request starts at the primary. One request is one RPM hit; only the successful attempt is billed, at the serving model's price (the reservation estimate uses the primary); `retries` and `fallback` are logged, and on total failure the log records the last model tried and nothing is billed. `x-prism-provider` is now `provider/model`. Verified live against the mocks (down, 429, 3000 ms latency, `fail_rate 0.3`, both down, restore) and `spent_usd` reconciles with `request_logs`. Limitations until later phases: streaming is still stubbed (Phase 6) and `auto` routes as `smart` (Phase 7).

## Phase 6 — Streaming Pass-Through

**Goal:** `stream: true` works token-by-token, end to end, with correct usage capture and documented failure behavior.

- [x] SSE response wiring (`Content-Type: text/event-stream`): pipe each chunk from the adapter's async iterable to the client as it arrives, respecting backpressure.
- [x] Hold response headers until the first upstream chunk arrives so `x-prism-provider`/`x-prism-fallback` are accurate; a failure before the first chunk retries/fails over transparently.
- [x] Streaming headers: `x-prism-provider`, `x-prism-cache`, `x-prism-fallback` up front; `x-prism-cost-usd` is not required on streams — the final cost goes to the request log and usage API.
- [x] Correct `data: [DONE]` termination, exactly once.
- [x] Final usage chunk captured from the mock providers and used for cost/metering/budget settlement even though the body was streamed.
- [x] **Mid-stream failure behavior (documented):** after the first chunk, never switch provider or splice output; send an SSE `error` event, then `data: [DONE]`, close the stream, log `upstream_error`.
- [x] **Client disconnect:** abort the upstream call, release resources, log `client_disconnect`; bill delivered tokens as a flagged estimate (`usage_estimated`), or `0` if nothing was delivered.
- [x] Per-chunk idle timeout so a stalled provider cannot hold a connection forever.
- [x] Test: streamed response is NOT buffered — verify chunks arrive incrementally (the mocks pace ~20 ms per token) by timing between chunks in a test harness, not all at once at the end.
- [x] Tests: provider dies mid-stream; client disconnects mid-stream; failure before the first chunk fails over.

**Exit criteria:** A streaming request produces visibly incremental output and still logs correct token/cost data afterward; a mid-stream failure terminates cleanly with an error event and `[DONE]`.

---

**Status: complete.** Notes: `executeStreamWithFailover` (in `src/routing/executor.ts`) reuses the Phase 5 retry/failover loop but only up to the first chunk: the adapter stream is opened and its first step read inside the attempt, so a failure, hang or `429` before any byte is retried or failed over invisibly, and the headers are built from the model that actually answered. If nothing answers, the client gets the normal JSON `502` (never a half-open SSE body). `src/streaming/relay.ts` turns the upstream chunks into OpenAI `chat.completion.chunk` events through a pull-based `Readable` (backpressure is real: a client that stops reading stops the provider read, and nothing but counters is kept). It ends every stream with exactly one `data: [DONE]`; a failure after the first chunk becomes an `event: error` (generic message, no provider detail) followed by `[DONE]`, and never switches provider. `onEnd` runs exactly once however the stream ends (complete, provider failure, client gone, time cap) and settles the budget and writes the single log row in one transaction: provider-reported usage is billed as is; otherwise tokens are estimated from the delivered text (words, like the mocks) and the row is flagged `usage_estimated`, and nothing is billed if nothing was delivered. A client hang-up aborts the upstream call immediately and logs `client_disconnect` (499). New: `STREAM_MAX_DURATION_MS` (default 120000) caps one stream, since `REQUEST_DEADLINE_MS` only bounds the wait for the first chunk (the stale-reservation cutoff now sits above it); `request_logs` now stores `usage_estimated` and `time_to_first_token_ms`; `stream_options.include_usage` adds a final usage chunk; `x-accel-buffering: no` and `cache-control: no-cache, no-transform` keep proxies from buffering. Also fixed here (it affected non-streaming requests too): a client that disconnects never triggered Fastify's `onResponse`, so its log row was lost; the route now logs it from the connection `close`. Verified live against the mocks (progressive delivery, failover before the first chunk, immediate `429` failover, both providers down, client hang-up with an estimated bill, no leftover holds, `spent_usd` equals the sum of the logged costs). The mid-stream death and missing-usage cases are covered by the fake provider tests (the mocks cannot inject them). The Postgres `request_logs.cache` column is still always `miss` until Phase 8.

## Phase 7 — Smart Routing (`auto`) + Eval Harness

**Goal:** `model: "auto"` reliably beats a length-only baseline on `data/routing_eval.jsonl`.

- [x] Author our own development prompt set (including short-but-hard and long-but-trivial cases) for building and tuning the classifier. **The provided eval set is the answer key: `expected_tier` and its prompts are never used inside routing logic, exemplars, or tuning.**
- [x] Implement difficulty classifier: structural/keyword features + embedding-similarity-to-exemplars (architecture.md §4.4), with a bounded classification window for long prompts.
- [x] Wire `auto` into the router: tier → normal alias resolution (`route_by_difficulty`); record `route_reason` (chosen tier and why) in the request log for every `auto` request, including budget/allowlist rejections after classification.
- [x] Allowlist interaction: the chosen tier must be allowed for the key — downgrade to `fast` (logged in `route_reason`) if `smart` isn't allowed, else `403`.
- [x] Implement the length-only baseline for comparison.
- [x] **One-command routing eval** over all 20 cases in `routing_eval.jsonl`, classification only (no upstream call), printing `{ total, correct, accuracy, cases: [{ id, expected, actual, reason }] }` for the classifier and the baseline.
- [x] Tune until classifier accuracy is clearly above the baseline (about 60%) — target 80% or better, with the trap cases (`route_011/012/013/019/020` short-but-hard; `route_006/007/010` long-but-trivial) specifically handled. Report accuracy honestly and explain any misses.

**Exit criteria:** Eval report shows the classifier beating the baseline, especially on trap cases, with a reason per case. The report becomes part of the Phase 11 verification deliverable.

**Status: complete.** Notes: the classifier (`src/routing/classifier.ts`) adds two things up. (1) Weighted regex signals on a bounded window (`features.ts`): the opening sentence plus the final instruction (about 480 characters at most; prompts up to 450 characters are read whole, so a long system prompt, earlier turns or a huge log never dominate or slow it). Hard signals add (proof, reasoning, design, compare, estimate, diagnose, "why", expert topics, build-code, deep explanation, multi-part, numbered steps) and easy signals subtract (rewrite or translate, summarize, factoid, definition, yes/no, lookup, short writing, listing), with only a weak length term. (2) A local embedding term: similarity of the window to the mean of 20 simple and 20 complex reference prompts written for this project (`exemplars.ts`), using `Xenova/all-MiniLM-L6-v2` (q8, 384 dimensions) in a worker thread. If the model is not ready or fails, the classifier uses the structural signals alone and the reason says so; it never throws, and a thrown classifier error routes to `smart`. `auto` is resolved right after the rate limit and before the budget, then follows the normal alias path (chain, pricing, headers and logs show the resolved model, e.g. `alpha/alpha-large`, while the response body keeps `model: "auto"`). `request_logs.route_reason` (for example `smart: score 2.72 >= 1.00; +proof; embed +0.05`) is set before any later rejection, so a `402` or `403` after classification still carries it; it never contains prompt text. Allowlist: `auto` itself must be on the key's list (otherwise `403` with no classification); if the verdict is `smart` and only `fast` is allowed it downgrades to `fast` and the reason says "downgraded from smart"; otherwise `403`. New settings: `EMBEDDING_MODEL`, `EMBEDDING_CACHE_DIR`, `EMBEDDING_TIMEOUT_MS`. The Docker image is now Debian-based (`node:22-slim`; onnxruntime has no Alpine binaries) and bakes the model in at build time (`src/cli/fetchModel.ts`), so nothing is downloaded at runtime. **Not yet verified:** the rebuilt image. Its build compiled and the model-fetch step succeeded (384 dimensions), but the build then failed saving the image because the host disk was full; until it is rebuilt and run, Phases 7 and 8 were verified by running the gateway from source against the Compose Postgres and Redis and the real mock providers.

**Eval (one command: `pnpm routing:eval`, add `--set dev` for the development set, `--structural-only` to skip the model; JSON on stdout):**

| Set | Classifier | Length baseline (>150 characters = complex, fixed before tuning) |
|---|---|---|
| Provided `routing_eval.jsonl` (20 cases, measured once, never tuned on) | 20/20 (100%) | 9/20 (45%) |
| Own development set (`apps/gateway/eval/routing_dev.jsonl`, 80 cases) | 79/80 (98.8%) | 36/80 (45%) |
| Provided set, structural signals only (model unavailable) | 20/20 (100%) | 9/20 (45%) |

All trap cases are correct: the short-but-hard `route_011/012/013/019/020` (proof, estimate, diagnosis, design) go to `smart`, and the long-but-trivial `route_006/007/010` go to `fast`. The only development-set miss is `dev_s30` (a simple design-flavoured request scored as complex). **Honest caveat on independence:** the development set and the exemplars were written by us, but the provided eval prompts were visible while the signal patterns were drafted, so 100% on that set is not a clean held-out number; the development set is also close to the signal wording (it was authored alongside it). Both are measured sets, not a guarantee on unseen traffic: non-English and unusual prompts will degrade (documented limitation, edge case 6.6). The eval labels are read only by the scorer (`evaluate.ts`), never by the classifier, and a test checks that no exemplar equals an eval or development prompt.

---

## Phase 8 — Semantic Cache

**Goal:** Paraphrased prompts hit cache; tenants never see each other's cached responses; per-key settings are honored.

- [x] Local embedding generation via `transformers.js` (small sentence-embedding model) in a worker thread inside the gateway process, warmed at startup so the first request is not penalized.
- [x] Per-key cache configuration from the seed data: `enabled` and `similarity_threshold` (disabled keys skip lookup and writes entirely).
- [x] `pgvector` cosine-similarity query, always filtered by `key_id` **and** the resolved alias; context hash (system prompt, earlier turns, `temperature`/`max_tokens`/`top_p`) must match exactly; similarity runs on the last user message (architecture.md §4.5).
- [x] Cache write-through on a successful miss only (never errors, never aborted/partial streams, never time-sensitive prompts like `req_no_cache`); a cache hit short-circuits the provider call entirely and releases the budget reservation.
- [x] Streaming cache hit replays the stored response as an SSE stream (single content chunk + `data: [DONE]`) with `x-prism-cache: hit`; a streaming miss is cached only after the stream completes.
- [x] `x-prism-cache` header (`hit`/`miss`), `hit_count`, and hit-rate tracking behind `GET /admin/cache/stats` (overall and per key); the hit-rate denominator is defined once.
- [x] Embedding or cache-DB failure is treated as a miss and the request still succeeds.
- [x] **Threshold calibration** against the provided cases using the chosen embedding model: pair A (`req_cache_a1`/`a2`) and pair B (`req_cache_b1`/`b2`) hit; the near-miss `req_cache_a3` and unrelated prompts miss. Record the threshold, embedding model and observed behavior; if a seeded threshold must change, document it.
- [x] Tests: (a) a paraphrased prompt hits cache for the same key, (b) the *same* paraphrase under a *different* key does **not** hit cache (tenant isolation) — this is explicitly graded; (c) `req_cache_a3` misses; (d) a cache-disabled key (`research`, `budget-demo`) never hits; (e) multi-turn context mismatch misses.

**Exit criteria:** All tests in the last bullet pass reliably, not just on a lucky run, and `scripts/smoke_test.py`'s cache checks pass against the `search` key.

**Status: complete, with one documented calibration deviation (below).** Notes: `src/cache/scope.ts` defines the cache scope. Similarity runs on the last user message only (whitespace-normalised, cut at 1000 characters for both lookup and storage; a longer message is matched exactly only, because its full text goes into the context hash). Everything else that shapes an answer goes into a SHA-256 context hash that must match exactly: the system prompt and every other turn, `temperature`, `top_p`, `max_tokens`, `stop`, `seed` and the penalties. `src/cache/store.ts` (`PgCacheStore`) runs one pgvector query per lookup, `WHERE key_id = $1 AND alias = $2 AND context_hash = $3 AND not expired ORDER BY embedding <=> $vector LIMIT 1`, then compares the similarity with the key's own threshold, so tenant isolation is part of the query and the nearest entry of that tenant is ranked exactly (no approximate index, deliberately). The alias is the tier the request resolved to (for `auto`, the tier it chose). The cache runs after the budget reservation and before the provider call. A hit settles the reservation at zero in the same transaction as its log row (status `cache_hit`, `cache = hit`, cost 0, tokens 0, no provider or model recorded because none was called (edge case 10.8), `x-prism-cache: hit`, `x-prism-provider: none`) and never calls a provider; a streaming request gets the stored answer replayed as one content chunk, a closing chunk and `data: [DONE]` (no cost header, like any stream). Entries are written after a successful miss only: a non-streaming answer once settled, a stream only if it ran to its end (the relay collects the text up to 256 KB), never errors, partial or aborted streams, or time-sensitive prompts (documented keyword heuristic: current, currently, right now, today, tonight, latest, breaking, real-time, live, status of, weather, stock price, news, this week/month/year, and similar; a false positive only costs a provider call). A fallback-served answer is cached like any other, with the provider that produced it. An identical prompt in the same scope is stored once (concurrent identical requests may both call the provider; the second write is a no-op). Entries expire after `CACHE_TTL_SECONDS` (default one day, `0` = never); expired entries are removed every minute; there is no size cap (known limitation). The cache never fails a request: embedding failure, a model that is still loading (checked without waiting), a lookup error or a write error are all misses, logged. `GET /admin/cache/stats` (admin token) reports overall and per-key `hits`, `misses`, `hit_rate`, live `entries` and `stored_hit_count`; the single hit-rate definition is `cache hits / served requests (status ok or cache_hit) of keys with the cache enabled` (returned in the response as `definition`; keys with the cache off report zeros; no traffic gives `0`, never `NaN`).

**Threshold calibration (embedding model `Xenova/all-MiniLM-L6-v2`, the same model the router uses; cosine similarity):**

| Pair | Similarity | At 0.92 (`search`) | At 0.85 (`free-tier`) |
|---|---|---|---|
| `req_cache_a1` vs `a2` (paraphrase) | 0.953 | hit | hit |
| `req_cache_a1` vs `a3` (2FA vs password) | 0.741 | miss | miss |
| `req_cache_b1` vs `b2` (refund policy paraphrase) | 0.684 | **miss** | **miss** |
| `req_cache_a1` vs an unrelated prompt | about 0 | miss | miss |

**Deviation:** the plan said pair B should hit. With this model it does not at either seeded threshold, and no small 384-dimension model tried does better (`paraphrase-MiniLM-L6-v2` 0.649, `all-MiniLM-L12-v2` 0.712). Catching pair B would need a threshold below 0.68, which would also let the near-miss `a3` (0.741) hit and return a wrong answer; a miss only costs a provider call, so the seeded thresholds (0.92 and 0.85) are unchanged and pair B is documented as a known miss. The starter's smoke test treats each pair as soft and requires at least one to hit, which pair A does. Verified live against Postgres, Redis and the mock providers (the gateway run from source; the Docker image was not rebuilt, see the Phase 7 note): `scripts/smoke_test.py` against the `search` key gives 17 passed, 1 warning (pair B), 0 failed; the same paraphrase from another key misses; `research` (cache off) never hits; `req_no_cache` is never cached; a multi-turn conversation with a different earlier turn misses; a streaming repeat is replayed with `x-prism-cache: hit` and a single content chunk.

---

## Phase 9 — Metering, Request Logs, Admin/Usage API + Full Pipeline Integration Check

**Goal:** Every request produces a complete, queryable log row; usage is summarizable per key; accounting holds up under concurrency; and all stages built in Phases 2–8 are proven to work together, not just individually.

- [x] Cost computation from price table × provider-reported tokens using exact decimal math; the `x-prism-cost-usd` header prints up to 8 decimals so the sum of headers reconciles exactly with the usage API.
- [x] `request_logs` completeness on every code path (cache hit, cache miss, success, failure, fallback, stream, every rejection type) with all fields from architecture.md §5 (`request_id`, requested vs. resolved model/provider, `status`, tokens, cost, `cache`, `fallback`, `route_reason`, `retries`, `latency_ms`).
- [x] `GET /admin/usage?key=...&from=...&to=...`: requests, prompt/completion tokens, `cost_usd`, `cache_hits` for a key over a window (and every key when `key` is omitted, for the console). Unknown key → clear error; a key with no traffic returns zeros, never `NaN`.
- [x] `GET /admin/logs?key=...&limit=...`: recent entries, newest first, filterable by key, capped/paginated, never exposing provider secrets or raw keys.
- [x] `GET /admin/cache/stats` (from Phase 8) finalized and consistent with the logs.
- [x] Tests: cost computation correctness for each model/pricing tier; log completeness (all required fields present) for each code path.
- [x] **Concurrent accounting-accuracy test** (distinct from Phase 3's admission-control test): fire many concurrent *successful* requests against one key and confirm `budget_usage.spent_usd` reconciles exactly with the sum of `request_logs.cost_usd` and the usage API — no lost-update anomalies under concurrency.
- [x] **Full pipeline integration test**: exercise the complete request path end-to-end per architecture.md §3 in one combined scenario — an `auto`-routed request that misses cache, triggers a retry + failover, streams its response, and is then served again as a cache hit — asserting the `x-prism-*` headers and the resulting log rows are correct at every step, not just each stage in isolation.

**Exit criteria:** Querying the usage API after a mixed batch of requests (hits, misses, fallbacks, rejections) returns numbers that reconcile exactly with what actually happened, including under concurrent load; the full-pipeline integration test passes.

**Status: complete.** Notes: a cache hit now logs no provider or model and answers `x-prism-provider: none`, because none was called (edge case 10.8; Phase 8 had recorded the original producer). Cost uses the Phase 3 integer math (units of 1e-8 USD); `test/cost.test.ts` checks every model, both token directions and the smallest amounts against hand-computed decimals, and that a fallback is charged the fallback model's price. `src/metering/store.ts` (`PgMeteringStore`) is the read side. `GET /admin/usage` takes `key` (team name, key id or raw key; a raw key is hashed and never echoed, an unknown key is `404 key_not_found`), and `from`/`to` (a date means that whole UTC day, so `to=2026-11-30` includes the 30th; a full timestamp needs a zone and `to` is exclusive; `from` must be before `to`). It returns `keys[]` and `totals` (`requests`, `served`, `cache_hits`, `fallbacks`, `rejected`, `errors`, prompt/completion/total tokens, `cost_usd` as exact 8-decimal text) plus each key's current-month `budget` counters and `unattributed_requests` (rejected for a missing or unknown key; not in `totals`). A key with no traffic returns zeros. `GET /admin/logs` takes `key`, `status`, `from`, `to`, `limit` (default 50, capped at 200) and an opaque `cursor`; rows are newest first with keyset paging (no gaps or repeats) and expose only the log columns plus team and key hint, never a raw key, hash, provider secret or prompt text. `/admin/cache/stats` and `/admin/usage` count from the same rows and are tested to agree. Beyond the unit tests, `test/integration/metering.test.ts` runs against Postgres and Redis: one complete row per outcome (success, hit, stream, fallback, upstream failure and eight kinds of rejection), a mixed batch whose usage numbers equal the log sums, `budget_usage.spent_usd` and the sum of the cost headers exactly, 60 concurrent requests (12 streamed) on one key that reconcile the same way, and the full pipeline (`auto` to a miss, 2 retries, failover, stream, then two cache hits). Not logged by that test but covered elsewhere: `client_disconnect` and `internal_error` rows. **Verified live in Docker:** the rebuilt image (Phases 7 to 9, model baked in at `/models`) starts healthy and loads the embedding model; with the real mock providers a miss costs `0.00001455` (`alpha/alpha-small`), the same question is then `x-prism-provider: none, x-prism-cache: hit, cost 0`, a complex `auto` prompt goes to `alpha/alpha-large`, a stream has no cost header, `budget-demo` gets `402`, and `/admin/usage` plus the database show `budget_usage.spent_usd` equal to the summed `request_logs.cost_usd` for every key. Lesson from the build: if the host disk fills during `docker compose build`, the image can contain zero-byte `dist/*.js` files and the container then exits silently with code 0; check free space and rebuild.

---

## Phase 10 — Ops Console (React)

**Goal:** A minimal but functional dashboard — not polished, just correct ("vibe-coding fine" per spec).

- [ ] Usage-by-key view.
- [ ] Recent requests view (status, requested/resolved model, cache, fallback flag, route reason, cost, latency; rejections visible).
- [ ] Cache hit rate view.
- [ ] Console reads only from the admin API (`/admin/*`, demo admin token) — no direct DB access.

**Exit criteria:** Console visibly reflects real gateway activity when traffic is sent through it during a manual check, including a budget rejection, a rate-limit rejection and a fallback.

---

## Phase 11 — Verification: Smoke / Load / Eval Reports + Failure Drill

**Goal:** Produce the exact verification artifacts the spec requires.

- [ ] Pass `scripts/smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast` as-is (explain any WARN).
- [ ] Run `scripts/load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10`; capture the report — specifically confirming **zero over-admission** under concurrent load.
- [ ] Capture the usage-API numbers for the same key and window and show they reconcile with the load test's client-side totals (requests, tokens, sum of cost headers).
- [ ] Capture routing eval accuracy report with per-case results, the method, and an explanation of misses (from Phase 7).
- [ ] Capture the cache threshold, embedding choice, and behavior on pair A, pair B and `req_cache_a3` (from Phase 8).
- [ ] Run the manual failure drill: take `alpha` down, make it slow (`latency_ms: 3000`), make it flaky (`fail_rate: 0.3`), then restore it — record the outcomes.
- [ ] Capture a latency summary and the coarse measurement of gateway-added latency (timestamps around the upstream call), noting how it was measured.
- [ ] Assemble these, plus known limitations, into the **Verification Report** deliverable.

**Exit criteria:** All scripts pass; verification report drafted with real output, not placeholders.

---

## Phase 12 — Real Provider Swap-In

**Goal:** Prove the adapter abstraction holds — swap in one real OpenAI-compatible provider without touching core gateway logic, per your direction to start mocks-first and replace later.

- [ ] Register one real provider (for example OpenAI, Groq or a local Ollama) with the existing `OpenAICompatibleAdapter` — config only, no core code changes; append its models and current prices to `model_pricing.json`.
- [ ] Update the routing config to point an alias (or one fallback slot) at the real provider (config change only).
- [ ] Re-run the Phase 5/6/11 tests against the real provider to confirm identical behavior (streaming, failover, metering) through the same code paths. Real API keys and spend need your approval first, and keys come from the environment only.

**Exit criteria:** Switching between mock and real provider is a config change, not a code change — demonstrated by running the same test suite against both.

---

## Phase 13 — Docs, Demo, Deliverables Packaging

**Goal:** Everything the spec lists as a deliverable actually exists and is reviewable.

- [ ] README: setup instructions, environment variables, how to seed keys and configure providers, how to run the app and the mock providers, API overview (data plane and admin plane), how to run the smoke and load tests, architecture summary, routing/failover design, cache scoping, budget accounting, design decisions, known limitations.
- [ ] Confirm seeded demo keys + reproduction instructions (mock providers) are documented and correct.
- [ ] Verification report finalized (Phase 11 outputs).
- [ ] Explainer video script/checklist following the recommended demo flow: healthy gateway and both mocks; non-streaming request with `search` key showing headers; streaming; repeat prompt and paraphrase → `x-prism-cache: hit`; `auto` with the research key (`route_011` → `smart`, `route_006` → `fast`) plus the routing eval accuracy; burst past the free-tier limit; budget-demo key (first request consumes the budget, second rejected); live provider failover (`POST /admin/config {"mode": "down"}` on `alpha`) with `x-prism-fallback: true`; ops console; smoke and load test summaries — record once everything above is demo-ready.
- [ ] Final review pass before anything is pushed to the public GitHub repo — **requires your explicit approval**, per our working agreement.

**Exit criteria:** A fresh reviewer could clone the repo, follow the README, and reproduce every claim in the verification report and demo video.

---

## Good To Have / Stretch (only after the Must Have gateway works end to end)

- Provider health tracking and degradation-based routing (error rate and latency over a window, periodic probe of a skipped provider) plus `GET /admin/providers/health`.
- Tokens-per-minute limits (same Redis pattern, from `tokens_per_minute` in the seed data).
- Key management APIs; usage breakdowns by model/day; richer console charts.
- Response-quality escalation (retry on a stronger tier when `-small` refuses; the mocks support this with a `[refuse]` prompt) and guardrails middleware.
- Distributed budgets across multiple gateway instances, weighted routing, protocol translation for non-OpenAI providers.

---

## Testing Strategy Summary (cuts across phases)

The spec requires automated tests for: cost computation, rate limiting, cache decisions, allowlists, and routing behavior. These are built incrementally in their owning phase (9, 3, 8, 3, 5/7 respectively) rather than bolted on at the end — each phase's exit criteria already includes its tests passing. The full inventory and pass criteria are in [`eval.md`](eval.md).

---

## Next Step

Once Docker Desktop is installed, Phase 0 starts: scaffold the monorepo and `docker-compose.yml`, then bring everything up with one command. Committing the copied starter files, and any push, will wait for your explicit approval as agreed.
