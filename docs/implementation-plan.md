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

- [ ] Postgres schema/migrations for `virtual_keys`, `budget_usage` (with `reserved_usd`), `request_logs`, `cache_entries` (per architecture.md §5).
- [ ] Enable `pgvector` extension; `cache_entries.embedding` as a `vector` column; indexes on `request_logs (key_id, created_at)` and the cache lookup path.
- [ ] Startup config loader: reads `model_pricing.json` and `gateway_config.sample.json` (providers, aliases incl. `auto`, retry policy, degradation settings) into validated in-memory structures (alias → model → fallback chain, model → price, model → provider). **Fail fast** on a missing/malformed file, an alias target missing from the price table, or a fallback not served by a registered provider.
- [ ] Seed script: loads `seed_keys.json` into `virtual_keys` — `team`, hashed key, budget, RPM (and TPM when present), allowlist, **per-key cache `enabled`/`similarity_threshold`**, `status`, `created_at` — **preserving exact key values, team names and alias names** (spec requirement — demo/scripts depend on these). Idempotent: re-seeding changes nothing and creates no duplicates.
- [ ] Money handling decided and implemented once: integer-scaled arithmetic / `NUMERIC`, never floats (architecture.md §4.9).
- [ ] DB access layer (lightweight query module, no heavy ORM needed — e.g. `pg` + hand-written SQL, or Drizzle if we want type-safe queries) with a bounded connection pool.

**Exit criteria:** Fresh container start → migrations run → seed keys queryable from DB → config maps loaded and logged at startup. Re-running the seed is a no-op. Unit tests for the config loader (including the fail-fast cases) and the seed script.

---

## Phase 2 — HTTP Skeleton + Auth + Validation

**Goal:** `POST /v1/chat/completions` exists, authenticates, validates shape, and logs — but just echoes/stubs the response (no provider call yet).

- [ ] Fastify route + JSON schema validation for the OpenAI-compatible request body (empty `messages` → `400`, per the starter's `req_malformed`), with a body-size limit.
- [ ] Auth middleware: resolve the virtual key by hash → `{ keyId, team, allowedModels, rpmLimit, monthlyBudgetUsd, cache config }`; reject missing/unknown/malformed/disabled keys with `401` (`authentication_error` / `invalid_api_key`). Auth runs first, validation second.
- [ ] Unknown model or alias → `404` (`not_found_error` / `model_not_found`).
- [ ] Shared error envelope `{ error: { message, type, code } }` used by every rejection path from here on (architecture.md §6).
- [ ] `x-prism-*` response headers (`x-prism-provider`, `x-prism-cache`, `x-prism-fallback`, `x-prism-cost-usd`) wired through **one** helper with default values, so every code path emits them from day one.
- [ ] Minimal request-log write on **every** path, including rejections (unknown key → null key), with the `status` enum. Completeness is verified in Phase 9.
- [ ] Admin plane skeleton: `x-admin-token` check (`ADMIN_TOKEN` env), used by the `/admin/*` routes added later.

**Exit criteria:** Valid key + valid body → 200 stub response with the full header contract present. Invalid/missing key → `401`; empty `messages` → `400`; unknown model → `404`; each with the standard error body and each logged. Tests for all of these paths.

---

## Phase 3 — Rate Limits & Budgets

**Goal:** All four rejection types work correctly, including under concurrency, in the documented check order.

- [ ] Model allowlist check (against the requested name; `auto` only for keys that list it) → `403 model_not_allowed`.
- [ ] Redis RPM limiter: one atomic Lua script per request implementing a **sliding window** (sorted set `rpm:{keyId}`, time taken from Redis, admit only if under the limit, TTL always set) → `429 rate_limit_exceeded`. Rejected requests are not added to the window. Redis unreachable → fail closed with `503 service_unavailable` and a short timeout.
- [ ] Postgres atomic budget **reserve → settle** (architecture.md §4.3): lazy period-row creation (`INSERT ... ON CONFLICT DO NOTHING`), admission only while budget remains, reservation of `LEAST(estimate, remaining)`, settlement to the actual cost, release on failure/cache hit → `402 budget_exceeded`. Cost estimate = prompt tokens + output cap priced from the resolved model.
- [ ] Documented check order enforced exactly as in architecture.md §3.1; a rejected request never reaches later stages.
- [ ] Concurrency tests: (a) fire N parallel requests at a key near its RPM limit; (b) fire parallel requests at a key whose budget fits only a few — confirm **no over-admission** (RPM exactly right; budget never exceeded by more than one request's cost, and the tiny-budget demo key admits exactly one request then rejects).
- [ ] Reconfirm the sliding window against a burst that straddles a minute boundary (it must still admit at most the limit).

**Exit criteria:** Automated tests cover all 4 rejection codes individually, plus concurrency tests proving no race lets extra requests through. This is one of the explicitly graded criteria — do not skip the concurrency tests. Settlement is exercised with the Phase 2 stub's usage until real providers arrive in Phase 4.

---

## Phase 4 — Provider Adapter Layer + Core Pass-Through

**Goal:** The `ProviderAdapter` interface exists, one OpenAI-compatible adapter drives the mock providers, and a non-streaming request flows end to end through a single provider.

- [ ] Define `ProviderAdapter` interface (architecture.md §4.6): `chatCompletion()`, `chatCompletionStream()`.
- [ ] `OpenAICompatibleAdapter` against a `base_url` + `api_key` (works for the mocks now, real providers later by configuration only).
- [ ] In-process **fake adapter** for deterministic, fast automated tests (configurable latency, failure/timeout injection, token-by-token streaming simulation, deterministic usage).
- [ ] Timeouts at the adapter boundary for every call: connect/first-byte, per-chunk idle, plus an overall request deadline. Defaults must trip on a mock made slow with `latency_ms: 3000` (demo requirement) and be configurable.
- [ ] Malformed upstream responses (invalid JSON, missing `usage`/`choices`) are handled and logged, never crash the gateway; provider error bodies are mapped to clean gateway errors and never forwarded raw. Provider keys never appear in responses or logs.
- [ ] Core pass-through: `POST /v1/chat/completions` → resolve alias to its **primary** model → adapter → OpenAI-shaped response, cost computed from provider-reported usage × price table, header contract filled in (`x-prism-provider` like `alpha/alpha-small`, `x-prism-cache: miss`, `x-prism-fallback: false`, `x-prism-cost-usd`), request log written, budget settled.
- [ ] Drive the real mocks by hand with curl (non-streaming) before relying on any assumption about their behavior.
- [ ] Unit tests: the fake adapter and the adapter's error/timeout mapping behave deterministically so later failover/load tests are reproducible.

**Exit criteria:** A `fast` request returns a correct OpenAI-shaped response from `alpha-small` with correct headers, cost and log row; a simulated slow/dead provider (via the mock's `/admin/config` or the fake adapter) produces a timely error, never a hang.

---

## Phase 5 — Routing, Retries, Failover

**Goal:** `fast`/`smart` aliases resolve correctly; failures trigger retry then failover; it's all recorded, counted, and billed correctly.

- [ ] Alias → model → fallback chain resolution from `gateway_config.sample.json` (`fast`: `alpha-small` → `beta-small`; `smart`: `alpha-large` → `beta-large`).
- [ ] Exponential backoff retry for transient errors (timeout, 5xx, connection reset) using the config's retry policy (3 attempts, 200 ms initial, ×2), with jitter.
- [ ] Failover to the next model/provider in the chain on persistent failure, and **immediately on a provider `429`**; set `fallback` and log it.
- [ ] Non-retryable provider 4xx → `502 upstream_error`, no retry, no failover; every provider failing → `502 upstream_error`, nothing billed.
- [ ] **Retry/failover billing & rate-limit semantics** (decision + implementation): a single client request counts as **one** RPM hit regardless of how many internal retry/failover attempts it took; cost is billed only for the attempt that actually produced the response (failed attempts are not billed, even if a provider reports partial token usage before erroring); `retries` is recorded in the log.
- [ ] `x-prism-provider` and `x-prism-fallback` headers populated correctly end-to-end.
- [ ] Every request tries the primary first, so traffic returns to a restored primary immediately (Must Have behavior).
- [ ] Test: use the mock's `/admin/config` (`{"mode": "down"}`) to take the primary down mid-test → confirm failover engages, is logged, and `x-prism-fallback: true`.
- [ ] Test: a slow primary (`latency_ms: 3000`) → the timeout fires and the client is served by the fallback or gets a clean error; a flaky primary (`fail_rate: 0.3`) → retries absorb it.
- [ ] Test: a request that retries once and fails over once still counts as exactly one RPM hit and is billed for exactly one (the successful) attempt's tokens.

**Exit criteria:** A request against `fast` or `smart` flows end-to-end to a mock provider and back with correct headers; a forced primary failure visibly fails over, recorded, counted, and billed exactly once; restoring the primary sends traffic back to it.

---

## Phase 6 — Streaming Pass-Through

**Goal:** `stream: true` works token-by-token, end to end, with correct usage capture and documented failure behavior.

- [ ] SSE response wiring (`Content-Type: text/event-stream`): pipe each chunk from the adapter's async iterable to the client as it arrives, respecting backpressure.
- [ ] Hold response headers until the first upstream chunk arrives so `x-prism-provider`/`x-prism-fallback` are accurate; a failure before the first chunk retries/fails over transparently.
- [ ] Streaming headers: `x-prism-provider`, `x-prism-cache`, `x-prism-fallback` up front; `x-prism-cost-usd` is not required on streams — the final cost goes to the request log and usage API.
- [ ] Correct `data: [DONE]` termination, exactly once.
- [ ] Final usage chunk captured from the mock providers and used for cost/metering/budget settlement even though the body was streamed.
- [ ] **Mid-stream failure behavior (documented):** after the first chunk, never switch provider or splice output; send an SSE `error` event, then `data: [DONE]`, close the stream, log `upstream_error`.
- [ ] **Client disconnect:** abort the upstream call, release resources, log `client_disconnect`; bill delivered tokens as a flagged estimate (`usage_estimated`), or `0` if nothing was delivered.
- [ ] Per-chunk idle timeout so a stalled provider cannot hold a connection forever.
- [ ] Test: streamed response is NOT buffered — verify chunks arrive incrementally (the mocks pace ~20 ms per token) by timing between chunks in a test harness, not all at once at the end.
- [ ] Tests: provider dies mid-stream; client disconnects mid-stream; failure before the first chunk fails over.

**Exit criteria:** A streaming request produces visibly incremental output and still logs correct token/cost data afterward; a mid-stream failure terminates cleanly with an error event and `[DONE]`.

---

## Phase 7 — Smart Routing (`auto`) + Eval Harness

**Goal:** `model: "auto"` reliably beats a length-only baseline on `data/routing_eval.jsonl`.

- [ ] Author our own development prompt set (including short-but-hard and long-but-trivial cases) for building and tuning the classifier. **The provided eval set is the answer key: `expected_tier` and its prompts are never used inside routing logic, exemplars, or tuning.**
- [ ] Implement difficulty classifier: structural/keyword features + embedding-similarity-to-exemplars (architecture.md §4.4), with a bounded classification window for long prompts.
- [ ] Wire `auto` into the router: tier → normal alias resolution (`route_by_difficulty`); record `route_reason` (chosen tier and why) in the request log for every `auto` request, including budget/allowlist rejections after classification.
- [ ] Allowlist interaction: the chosen tier must be allowed for the key — downgrade to `fast` (logged in `route_reason`) if `smart` isn't allowed, else `403`.
- [ ] Implement the length-only baseline for comparison.
- [ ] **One-command routing eval** over all 20 cases in `routing_eval.jsonl`, classification only (no upstream call), printing `{ total, correct, accuracy, cases: [{ id, expected, actual, reason }] }` for the classifier and the baseline.
- [ ] Tune until classifier accuracy is clearly above the baseline (about 60%) — target 80% or better, with the trap cases (`route_011/012/013/019/020` short-but-hard; `route_006/007/010` long-but-trivial) specifically handled. Report accuracy honestly and explain any misses.

**Exit criteria:** Eval report shows the classifier beating the baseline, especially on trap cases, with a reason per case. The report becomes part of the Phase 11 verification deliverable.

---

## Phase 8 — Semantic Cache

**Goal:** Paraphrased prompts hit cache; tenants never see each other's cached responses; per-key settings are honored.

- [ ] Local embedding generation via `transformers.js` (small sentence-embedding model) in a worker thread inside the gateway process, warmed at startup so the first request is not penalized.
- [ ] Per-key cache configuration from the seed data: `enabled` and `similarity_threshold` (disabled keys skip lookup and writes entirely).
- [ ] `pgvector` cosine-similarity query, always filtered by `key_id` **and** the resolved alias; context hash (system prompt, earlier turns, `temperature`/`max_tokens`/`top_p`) must match exactly; similarity runs on the last user message (architecture.md §4.5).
- [ ] Cache write-through on a successful miss only (never errors, never aborted/partial streams, never time-sensitive prompts like `req_no_cache`); a cache hit short-circuits the provider call entirely and releases the budget reservation.
- [ ] Streaming cache hit replays the stored response as an SSE stream (single content chunk + `data: [DONE]`) with `x-prism-cache: hit`; a streaming miss is cached only after the stream completes.
- [ ] `x-prism-cache` header (`hit`/`miss`), `hit_count`, and hit-rate tracking behind `GET /admin/cache/stats` (overall and per key); the hit-rate denominator is defined once.
- [ ] Embedding or cache-DB failure is treated as a miss and the request still succeeds.
- [ ] **Threshold calibration** against the provided cases using the chosen embedding model: pair A (`req_cache_a1`/`a2`) and pair B (`req_cache_b1`/`b2`) hit; the near-miss `req_cache_a3` and unrelated prompts miss. Record the threshold, embedding model and observed behavior; if a seeded threshold must change, document it.
- [ ] Tests: (a) a paraphrased prompt hits cache for the same key, (b) the *same* paraphrase under a *different* key does **not** hit cache (tenant isolation) — this is explicitly graded; (c) `req_cache_a3` misses; (d) a cache-disabled key (`research`, `budget-demo`) never hits; (e) multi-turn context mismatch misses.

**Exit criteria:** All tests in the last bullet pass reliably, not just on a lucky run, and `scripts/smoke_test.py`'s cache checks pass against the `search` key.

---

## Phase 9 — Metering, Request Logs, Admin/Usage API + Full Pipeline Integration Check

**Goal:** Every request produces a complete, queryable log row; usage is summarizable per key; accounting holds up under concurrency; and all stages built in Phases 2–8 are proven to work together, not just individually.

- [ ] Cost computation from price table × provider-reported tokens using exact decimal math; the `x-prism-cost-usd` header prints up to 8 decimals so the sum of headers reconciles exactly with the usage API.
- [ ] `request_logs` completeness on every code path (cache hit, cache miss, success, failure, fallback, stream, every rejection type) with all fields from architecture.md §5 (`request_id`, requested vs. resolved model/provider, `status`, tokens, cost, `cache`, `fallback`, `route_reason`, `retries`, `latency_ms`).
- [ ] `GET /admin/usage?key=...&from=...&to=...`: requests, prompt/completion tokens, `cost_usd`, `cache_hits` for a key over a window (and every key when `key` is omitted, for the console). Unknown key → clear error; a key with no traffic returns zeros, never `NaN`.
- [ ] `GET /admin/logs?key=...&limit=...`: recent entries, newest first, filterable by key, capped/paginated, never exposing provider secrets or raw keys.
- [ ] `GET /admin/cache/stats` (from Phase 8) finalized and consistent with the logs.
- [ ] Tests: cost computation correctness for each model/pricing tier; log completeness (all required fields present) for each code path.
- [ ] **Concurrent accounting-accuracy test** (distinct from Phase 3's admission-control test): fire many concurrent *successful* requests against one key and confirm `budget_usage.spent_usd` reconciles exactly with the sum of `request_logs.cost_usd` and the usage API — no lost-update anomalies under concurrency.
- [ ] **Full pipeline integration test**: exercise the complete request path end-to-end per architecture.md §3 in one combined scenario — an `auto`-routed request that misses cache, triggers a retry + failover, streams its response, and is then served again as a cache hit — asserting the `x-prism-*` headers and the resulting log rows are correct at every step, not just each stage in isolation.

**Exit criteria:** Querying the usage API after a mixed batch of requests (hits, misses, fallbacks, rejections) returns numbers that reconcile exactly with what actually happened, including under concurrent load; the full-pipeline integration test passes.

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
