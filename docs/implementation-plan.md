# Prism — Implementation Plan

**Based on:** [`docs/architecture.md`](architecture.md) (decisions locked: Postgres + Redis, mocks-first with a real provider swapped in later, local `transformers.js` embeddings, Docker Compose for local/demo).

This plan breaks the build into phases. Each phase has a goal, concrete tasks, and **exit criteria** — a phase isn't "done" until its exit criteria are met, not just when the code is written. Phases are ordered by dependency: each one builds on a working, testable previous phase. Nothing here gets pushed to git without your review (per our working agreement).

> **Revision note:** this version incorporates the "should fix" gaps found in the plan-vs-architecture review: provider health/circuit tracking (Phase 5), concurrent accounting-accuracy testing (Phase 9), retry/failover billing semantics (Phase 5), a full-pipeline integration checkpoint (Phase 9), and a demoable mechanism for live provider failover (Phase 4).

---

## Phase Overview

| # | Phase | Depends on |
|---|---|---|
| 0 | Project scaffolding & infra | — |
| 1 | Data layer: schema, migrations, seed loading | 0 |
| 2 | HTTP skeleton + auth | 1 |
| 3 | Rate limits & budgets | 2 |
| 4 | Provider adapter layer (mocks) | 0 |
| 5 | Routing, retries, failover | 3, 4 |
| 6 | Streaming pass-through | 5 |
| 7 | Smart routing (`auto`) + eval | 5 |
| 8 | Semantic cache | 4 |
| 9 | Metering, logs, usage API + pipeline integration check | 5, 6, 8 |
| 10 | Ops console (React) | 9 |
| 11 | Verification: smoke/load/eval reports | 1–9 |
| 12 | Real provider swap-in | 4, 11 |
| 13 | Docs, demo, deliverables packaging | all |

---

## Phase 0 — Project Scaffolding & Infra

**Goal:** An empty but running system — containers up, nothing functional yet, but the skeleton is right.

- [ ] Pull `prism-capstone` starter repo content (`model_pricing.json`, `seed_keys.json`, `gateway_config.sample.json`, `scripts/smoke_test.py`, `scripts/load_test.py`) — **requires your approval before the actual clone/pull.**
- [ ] Initialize monorepo (pnpm workspaces): `apps/gateway`, `apps/console`, `packages/shared-types`, `data/`, `scripts/`, `docs/`.
- [ ] TypeScript config, ESLint/Prettier, base `package.json` scripts (`dev`, `build`, `test`, `lint`) for gateway and console.
- [ ] `docker-compose.yml`: Postgres (with `pgvector` extension enabled), Redis, gateway, console.
- [ ] Gateway boots on Fastify with a `/health` endpoint only.
- [ ] Console boots (React + Vite) showing a placeholder page.

**Exit criteria:** `docker compose up` brings up Postgres, Redis, gateway (`/health` → 200), and console (loads in browser) with one command.

---

## Phase 1 — Data Layer: Schema, Migrations, Seed Loading

**Goal:** Durable storage exists and is populated with the provided seed data.

- [ ] Postgres schema/migrations for `virtual_keys`, `budget_usage`, `request_logs`, `cache_entries` (per architecture.md §5).
- [ ] Enable `pgvector` extension; `cache_entries.embedding` as `vector` column.
- [ ] Startup config loader: reads `model_pricing.json` and `gateway_config.sample.json` into in-memory maps (alias → model → fallback chain, model → price).
- [ ] Seed script: loads `seed_keys.json` into `virtual_keys`, **preserving exact key values and alias names** (spec requirement — demo/scripts depend on these).
- [ ] DB access layer (lightweight query module, no heavy ORM needed — e.g. `pg` + hand-written SQL, or Drizzle if we want type-safe queries).

**Exit criteria:** Fresh container start → migrations run → seed keys queryable from DB → config maps loaded and logged at startup. Unit tests for the config loader and seed script.

---

## Phase 2 — HTTP Skeleton + Auth

**Goal:** `POST /v1/chat/completions` exists, validates shape, and authenticates — but just echoes/stubs the response (no provider call yet).

- [ ] Fastify route + JSON schema validation for the OpenAI-compatible request body.
- [ ] Auth middleware: resolve virtual key → `{ tenantId, allowedModels, rpmLimit, monthlyBudgetUsd }`; reject unknown key with `401 invalid_api_key`.
- [ ] Shared `error.code` envelope format used by every rejection path from here on.
- [ ] `x-prism-*` response headers wired as empty/default values (filled in by later phases).

**Exit criteria:** Valid key + valid body → 200 stub response with header contract present. Invalid/missing key → `401 invalid_api_key`. Tests for both paths.

---

## Phase 3 — Rate Limits & Budgets

**Goal:** All four rejection types work correctly, including under concurrency.

- [ ] Model allowlist check → `403 model_not_allowed`.
- [ ] Redis RPM counter (`INCR`+`EXPIRE` per key per minute bucket) → `429 rate_limited`.
- [ ] Postgres atomic budget check/update (conditional `UPDATE ... WHERE spent_usd + $cost <= budget`) → `402 budget_exceeded`.
- [ ] Concurrency test: fire N parallel requests against a key near its RPM/budget limit — confirm **no over-admission** (exactly the right number pass, rest rejected).

**Exit criteria:** Automated tests cover all 4 rejection codes individually, plus one concurrency test proving no race lets extra requests through. This is one of the explicitly graded criteria — do not skip the concurrency test.

---

## Phase 4 — Provider Adapter Layer (Mocks)

**Goal:** The `ProviderAdapter` interface exists, and two mock providers implement it realistically.

- [ ] Define `ProviderAdapter` interface (architecture.md §4.6): `chatCompletion()`, `chatCompletionStream()`.
- [ ] Mock Provider A, Mock Provider B: configurable latency, configurable failure/timeout injection, token-by-token streaming simulation, deterministic usage reporting.
- [ ] Per-call timeout wrapper at the adapter boundary (applies to every provider, mock or real).
- [ ] **Health-toggle mechanism for mock providers** — a debug/admin control (e.g. `POST /debug/providers/:name/toggle`) that forces a given mock provider down/degraded on demand. This is how failover gets triggered live, both in tests and on camera for the demo video (addresses: no concrete mechanism existed for demoing failover).
- [ ] Unit tests: mock providers behave deterministically (same input → same simulated behavior) so later failover/load tests are reproducible.

**Exit criteria:** Can call either mock provider directly (bypassing routing) and get a correct response, a correct stream, or a simulated failure/timeout on demand via config/flags or the health-toggle endpoint.

---

## Phase 5 — Routing, Retries, Failover

**Goal:** `fast`/`smart` aliases resolve correctly; failures trigger retry then failover; it's all recorded.

- [ ] Alias → model → fallback chain resolution from `gateway_config.sample.json`.
- [ ] Exponential backoff retry for transient errors.
- [ ] Failover to next model/provider in chain on persistent failure; set `fallback_used`.
- [ ] **Provider health/circuit tracking**: track recent failure counts per provider so a provider that's clearly down is skipped directly (not retried pointlessly) on subsequent requests until it recovers (architecture.md §4.7 — was missing from the original plan).
- [ ] **Retry/failover billing & rate-limit semantics** (decision + implementation): a single client request counts as **one** RPM hit regardless of how many internal retry/failover attempts it took; cost is billed only for the attempt that actually produced the response (failed attempts are not billed, even if a provider reports partial token usage before erroring).
- [ ] `x-prism-provider` and `x-prism-fallback` headers populated correctly end-to-end.
- [ ] Test: use the Phase 4 health-toggle to force the primary mock provider down mid-test → confirm failover engages and is logged.
- [ ] Test: a request that retries once and fails over once still counts as exactly one RPM hit and is billed for exactly one (the successful) attempt's tokens.

**Exit criteria:** A request against `fast` or `smart` flows end-to-end to a mock provider and back with correct headers; a forced primary failure visibly fails over, recorded, counted, and billed exactly once.

---

## Phase 6 — Streaming Pass-Through

**Goal:** `stream: true` works token-by-token, end to end, with correct usage capture.

- [ ] SSE response wiring: pipe each chunk from the adapter's async iterable to the client as it arrives.
- [ ] Correct `data: [DONE]` termination.
- [ ] Final usage chunk captured from mock providers and used for cost/metering even though the body was streamed.
- [ ] Test: streamed response is NOT buffered — verify chunks arrive incrementally (e.g. by timing between chunks in a test harness), not all at once at the end.

**Exit criteria:** A streaming request produces visibly incremental output and still logs correct token/cost data afterward.

---

## Phase 7 — Smart Routing (`auto`) + Eval Harness

**Goal:** `model: "auto"` reliably beats a length-only baseline on the labeled eval set.

- [ ] Build the labeled eval set (if not fully provided by starter repo) including short-but-hard and long-but-trivial trap cases.
- [ ] Implement difficulty classifier: structural/keyword features + embedding-distance-to-exemplars (architecture.md §4.4).
- [ ] Implement the length-only baseline for comparison.
- [ ] One-command eval script: reports accuracy per case for both classifier and baseline.
- [ ] Tune thresholds until classifier accuracy > baseline accuracy, with the trap cases specifically correct.

**Exit criteria:** Eval report shows classifier beating baseline, especially on trap cases. This report becomes part of the Phase 11 verification deliverable.

---

## Phase 8 — Semantic Cache

**Goal:** Paraphrased prompts hit cache; tenants never see each other's cached responses.

- [ ] Local embedding generation via `transformers.js` (small sentence-embedding model) inside the gateway process.
- [ ] `pgvector` cosine-similarity query, always filtered by `key_id`.
- [ ] Cache write-through on miss; cache hit short-circuits provider call entirely.
- [ ] `x-prism-cache` header (`hit`/`miss`) and hit-rate tracking.
- [ ] Tests: (a) a paraphrased prompt hits cache for the same key, (b) the *same* paraphrase under a *different* key does **not** hit cache (tenant isolation) — this is explicitly graded.

**Exit criteria:** Both tests in the last bullet pass reliably, not just on a lucky run.

---

## Phase 9 — Metering, Request Logs, Usage API + Full Pipeline Integration Check

**Goal:** Every request produces a complete, queryable log row; usage is summarizable per key; accounting holds up under concurrency; and all stages built in Phases 2–8 are proven to work together, not just individually.

- [ ] Cost computation from price table × provider-reported tokens.
- [ ] `request_logs` write on every code path (cache hit, cache miss, success, failure, fallback).
- [ ] `GET /v1/usage/:key` (or equivalent) summary endpoint: totals, cost, cache hit rate.
- [ ] **`GET /v1/requests`** (separate, explicit endpoint per architecture.md §4.1) returning the recent request log for the console's "recent requests" view — not folded into the usage-summary endpoint.
- [ ] Tests: cost computation correctness for each model/pricing tier; log completeness (all required fields present) for each code path.
- [ ] **Concurrent accounting-accuracy test** (distinct from Phase 3's admission-control test): fire many concurrent *successful* requests against one key and confirm `budget_usage.spent_usd` reconciles exactly with the sum of `request_logs.cost_usd` — no lost-update anomalies under concurrency. This directly covers the assessment criterion "does usage accounting remain accurate during concurrent requests," which is a different failure mode than over-admission.
- [ ] **Full pipeline integration test**: exercise the complete request path end-to-end per architecture.md §3 in one combined scenario — an `auto`-routed request that misses cache, triggers a retry + failover, streams its response, and is then served again as a cache hit — asserting all four `x-prism-*` headers and the resulting log rows are correct at every step, not just each stage in isolation.

**Exit criteria:** Querying the usage API after a mixed batch of requests (hits, misses, fallbacks, rejections) returns numbers that reconcile exactly with what actually happened, including under concurrent load; the full-pipeline integration test passes.

---

## Phase 10 — Ops Console (React)

**Goal:** A minimal but functional dashboard — not polished, just correct ("vibe-coding fine" per spec).

- [ ] Usage-by-key view.
- [ ] Recent requests view.
- [ ] Cache hit rate view.
- [ ] Console reads only from the Usage API (no direct DB access).

**Exit criteria:** Console visibly reflects real gateway activity when traffic is sent through it during a manual check.

---

## Phase 11 — Verification: Smoke / Load / Eval Reports

**Goal:** Produce the exact verification artifacts the spec requires.

- [ ] Pass `scripts/smoke_test.py` as-is.
- [ ] Run `scripts/load_test.py`; capture report — specifically confirming **no over-admission** under concurrent load.
- [ ] Capture routing eval accuracy report (from Phase 7).
- [ ] Capture accounting totals (usage API output matches load test's actual traffic).
- [ ] Capture latency summary.
- [ ] Assemble these into the **Verification Report** deliverable.

**Exit criteria:** All scripts pass; verification report drafted with real output, not placeholders.

---

## Phase 12 — Real Provider Swap-In

**Goal:** Prove the adapter abstraction holds — swap in one real provider without touching core gateway logic, per your direction to start mocks-first and replace later.

- [ ] Implement one real `ProviderAdapter` (e.g. OpenAI) alongside the existing mocks — same interface, no core code changes.
- [ ] Update `gateway_config.sample.json`-equivalent routing config to point an alias at the real provider (config change only).
- [ ] Re-run Phase 5/6/11 tests against the real provider to confirm identical behavior (streaming, failover, metering) through the same code paths.

**Exit criteria:** Switching between mock and real provider is a config change, not a code change — demonstrated by running the same test suite against both.

---

## Phase 13 — Docs, Demo, Deliverables Packaging

**Goal:** Everything the spec lists as a deliverable actually exists and is reviewable.

- [ ] README: setup instructions, API docs, architecture summary, routing/failover design, cache scoping, design decisions, known limitations.
- [ ] Confirm seeded demo keys + reproduction instructions (mock providers) are documented and correct.
- [ ] Verification report finalized (Phase 11 outputs).
- [ ] Explainer video script/checklist: streaming, smart routing, budget rejection, rate limiting, semantic cache hit on paraphrase, live provider failover (triggered via the Phase 4 health-toggle endpoint) — record once everything above is demo-ready.
- [ ] Final review pass before anything is pushed to the public GitHub repo — **requires your explicit approval**, per our working agreement.

**Exit criteria:** A fresh reviewer could clone the repo, follow the README, and reproduce every claim in the verification report and demo video.

---

## Testing Strategy Summary (cuts across phases)

Per architecture.md's technical requirements, automated tests are required for: cost computation, rate limiting, cache decisions, allowlists, and routing behavior. These are built incrementally in their owning phase (3, 4/5, 8, 3, 5/7 respectively) rather than bolted on at the end — each phase's exit criteria already includes its tests passing.

---

## Next Step

Once you approve this plan, Phase 0 starts with pulling the starter repo's seed files — I'll ask for explicit approval before that `git clone`/pull, as agreed.