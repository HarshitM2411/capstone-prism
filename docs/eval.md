# Prism — Evaluation Plan

**Based on:** [`docs/architecture.md`](architecture.md), [`docs/implementation-plan.md`](implementation-plan.md), and the starter pack's evaluation guide (`EVALUATION_GUIDE`, `IMPLEMENTATION_GUIDE`, `scripts/`, `data/` from the [`prism-capstone`](https://github.com/airtribe-projects/prism-capstone) repo). Requirements are in [`docs/context.md`](context.md) / `docs/PS1.pdf`. Edge cases are in [`docs/edgecase.md`](edgecase.md).

This document defines **how we prove Prism works**: what we measure, how we measure it, what counts as a pass, and what evidence goes into the Verification Report. Prism is infrastructure, so it is verified by behavior under contract checks, concurrency, and injected failures — not by judging model output.

> **Principle:** a claim is only true if there is an automated check (or a captured artifact) that demonstrates it. Anything that cannot be automated (console, failure drill, demo video) gets a manual checklist with explicit expected results.

The starter pack defines four verification parts: the **smoke test**, the **load test**, a **routing eval** we build, and a **manual failure drill**. Those map to E1, E3/E4, E6 and E14 below; the other evals cover the rest of the graded behavior.

---

## 1. Evaluation Map

Each assessment criterion maps to one or more evals, the phase that builds it, and the evidence produced. The weights are the problem statement's.

| Assessment criterion | Eval(s) | Built in phase | Evidence |
|---|---|---|---|
| Must Have workflow (60%) — data loading, OpenAI-compatible completions over 2 providers with the header contract, streaming, keys/limits/budgets, failover, `auto`, cache, metering, usage, console | E1–E11 | 2–10 | Smoke test output, test suite report |
| Accounting accurate under concurrency (25% group) | E4 | 9 | Reconciliation report (`budget_usage`, `request_logs`, usage API, load test totals) |
| Zero over-admission under load | E3 | 3 | Load test report |
| Failover works when a provider is killed live | E7, E14 | 5 | Test log, failure drill, demo video |
| Cache hits paraphrases without cross-tenant leakage | E8 | 8 | Test log (hit, isolation and negative cases) |
| `auto` router beats a length-only baseline | E6 | 7 | Routing eval report |
| Streams terminate cleanly on upstream failure | E5 | 6 | Test log |
| Engineering quality, documentation, demo (15%) | E12, E13, §7 | 0–13 | Lint/type-check/test output, README review, demo checklist |

---

## 2. Test Environment and Data

- **Stack under test:** Docker Compose (gateway on `8080`, console, Postgres with `pgvector`, Redis, and the mock providers) — the same one-command setup used for the demo.
- **Providers:** the starter's `scripts/mock_provider.py`, run as `alpha` (port 9001) and `beta` (port 9002), serving `alpha-small`, `alpha-large`, `beta-small`, `beta-large`. Replies are deterministic per prompt; streaming is paced at about 20 ms per token; both streaming and non-streaming responses include `usage`. The real provider is only exercised in E12.
- **Failure injection:** the mocks' own `POST /admin/config` (`{"mode": "down"}`, `{"mode": "rate_limited"}`, `{"fail_rate": 0.3}`, `{"latency_ms": 3000}`, `{"mode": "ok"}` to restore). The gateway has no debug toggle.
- **In-process fake adapter:** automated unit and integration tests use it for speed and determinism where a real mock process is unnecessary.
- **Seed data:** `data/seed_keys.json`, `data/model_pricing.json`, `data/gateway_config.sample.json`, with exact key values, team names and alias names preserved.
- **Test inputs:** `data/sample_requests.jsonl` (basic, stream, smart, cache pairs A and B, near-miss `req_cache_a3`, `req_long`, negative cases `req_not_allowed`/`req_unknown_model`/`req_malformed`, `req_multiturn`, `req_no_cache`) and `data/routing_eval.jsonl` (20 labeled prompts).
- **Keys used:**

| Key | Used for |
|---|---|
| `prism-sk-search-1a2b3c` | Smoke test, cache hit/miss, allowlist (`fast` only) |
| `prism-sk-research-4d5e6f` | `auto` routing demos (`fast`, `smart`, `auto` allowed; cache disabled) |
| `prism-sk-free-7g8h9i` | Load test and rate limiting (10 requests/minute) |
| `prism-sk-budget-demo-0j1k2l` | Budget rejection (tiny budget, cache disabled) |

- **Isolation:** each eval starts from a known state (fresh migration + seed, Redis flushed, mocks set to `ok`) so results do not depend on test order. Cache-sensitive tests salt their prompts (as the provided scripts do) so earlier runs cannot pollute them.
- **Time control:** the rate-limit window and budget period logic use an injectable clock in unit tests, so boundary behavior is not flaky.

---

## 3. Evals

Each eval lists **what it checks**, **method**, and **pass criteria**.

### E1 — API Contract and Smoke

- **Checks:** OpenAI-compatible request/response shape; the `x-prism-*` header contract on every response path; `GET /health` returns 200.
- **Method:** run `scripts/smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast` unmodified; additionally schema-validate responses against the OpenAI chat-completion shape.
- **Pass:**
  - Smoke test passes as-is: non-streaming 200 with `choices` and `usage`; `x-prism-provider`, `x-prism-cache`, `x-prism-cost-usd` present; a first salted request is a `miss`; SSE chunks end with `data: [DONE]` and `content-type: text/event-stream`; an invalid key gets 401/403; an unknown model gets a 4xx with an `error` body; an identical repeat is a `hit`; at least one paraphrase pair hits; an unrelated prompt is a `miss`.
  - `x-prism-provider`, `x-prism-cache` and `x-prism-fallback` are present on hit, miss, fallback and streamed responses; `x-prism-cost-usd` is present on non-streaming responses (and `0` on cache hits).
  - Any WARN (an individual paraphrase pair that misses) is explained in the report.

### E2 — Rejection Codes (Auth, Validation, Not Found, Allowlist, Rate Limit, Budget)

- **Checks:** each rejection path returns its own distinct, documented error in the OpenAI-style envelope, is logged, and rejects before any provider is called.
- **Method:** one test per row; assert HTTP status, `error.type`, `error.code`, that no provider call or charge occurred, and that a log row with the right `status` exists.

| Scenario | Expected HTTP | `error.type` | Log `status` |
|---|---|---|---|
| Missing, unknown, malformed or disabled key | 401 | `authentication_error` | `rejected_auth` |
| Empty `messages` (`req_malformed`) | 400 | `invalid_request_error` | `rejected_validation` |
| Unknown model (`req_unknown_model`) | 404 | `not_found_error` | `rejected_not_found` |
| `smart` on a `fast`-only key (`req_not_allowed`) | 403 | `model_not_allowed` | `rejected_allowlist` |
| RPM exceeded (`free-tier` key) | 429 | `rate_limit_exceeded` | `rejected_rate_limit` |
| Budget exhausted (`budget-demo` key, second request) | 402 | `budget_exceeded` | `rejected_budget` |

- **Pass:** every code is produced individually and is distinguishable from the body alone; a rejected request produces zero provider calls and zero cost; the rejection itself appears in the request log (a 401 with a null key). The order of checks matches architecture §3.1 (for example, an unknown model is `404` even when the key's allowlist would also reject it).
- **Budget-demo specifics:** the first request is admitted and consumes the tiny budget; the second is rejected with `budget_exceeded` — no setup needed.

### E3 — Concurrency: Admission Control (Zero Over-Admission)

- **Checks:** under parallel load near a limit, exactly the permitted number of requests are admitted — no race lets extras through.
- **Method:**
  1. *Provided load test:* `python scripts/load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10`.
  2. *RPM unit/integration test:* key with limit `N`; fire `M > N` parallel requests inside one window; repeat with a burst that straddles a minute boundary.
  3. *Budget test:* a key whose remaining budget fits only a few requests; fire many parallel requests.
- **Pass:**
  - The load test prints `Over-admission check OK` (`accepted <= limit`) and exits `0`.
  - Exactly `N` requests are admitted for RPM; the rest return `429`; a boundary-straddling burst never admits more than `N` within any 60-second span.
  - For the budget, `spent_usd` never exceeds the monthly budget by more than **one request's cost** (the documented overshoot bound), and once the ceiling is crossed every later request is `402`.
  - Repeated runs (for example 20×) give the same result — not just a lucky pass.

### E4 — Concurrency: Accounting Accuracy

- **Checks:** concurrent *successful* requests produce no lost updates (a different failure mode from over-admission), and client-side totals reconcile with the server.
- **Method:** fire many concurrent successful, cache-busting requests against one key (the load test's client-side totals are the independent source); afterwards compare:
  - the load test's printed `accepted requests`, `prompt tokens`, `completion tokens` and `sum of cost headers`;
  - `GET /admin/usage?key=...&from=...&to=...` (`requests`, `prompt_tokens`, `completion_tokens`, `cost_usd`);
  - the sum of `request_logs.cost_usd` and `budget_usage.spent_usd`.
- **Pass:** all values reconcile **exactly** (costs are exact multiples of `0.00000001` USD and the header prints up to 8 decimals, so there is no rounding gap); `reserved_usd` returns to `0` when no requests are in flight; the `request_logs` row count equals the number of requests sent, rejected ones included.

### E5 — Streaming Pass-Through

- **Checks:** tokens are forwarded as they arrive, the stream terminates correctly, usage is still metered, and failures end cleanly.
- **Method:** call with `stream: true` against the mocks (about 20 ms per token); timestamp each chunk on the client; additionally inject failures.
- **Pass:**
  - Chunks arrive incrementally — the gap between the first and last chunk is roughly the mock's generation time, not near zero (not buffered).
  - The stream ends with exactly one `data: [DONE]`, with `content-type: text/event-stream`.
  - Headers include `x-prism-provider`, `x-prism-cache`, `x-prism-fallback`; `x-prism-cost-usd` is not required.
  - The log row has correct token counts and cost taken from the final usage chunk, and the budget settles to that cost.
  - Provider dies mid-stream → the client receives an SSE `error` event followed by `data: [DONE]`; no provider switch or splice; logged `upstream_error`.
  - Failure before the first chunk → transparent failover with `x-prism-fallback: true`.
  - Client disconnect mid-stream → upstream aborted, logged `client_disconnect`, delivered tokens billed as a flagged estimate.
  - A streaming cache hit is replayed as an SSE stream ending in `[DONE]` with `x-prism-cache: hit`.

### E6 — Routing Eval (`auto` vs length-only baseline)

- **Checks:** the difficulty classifier uses signal beyond length and beats a length-only rule on `data/routing_eval.jsonl`.
- **Method:** the one-command routing eval sends every prompt through the `auto` classifier (classification only — no upstream call) and prints:

```json
{
  "total": 20,
  "correct": 17,
  "accuracy": 0.85,
  "cases": [
    { "id": "route_011", "expected": "smart", "actual": "smart", "reason": "proof request; judged complex" }
  ]
}
```

  It runs the classifier and the length-only baseline side by side and reports accuracy per case and overall.
- **Eval set traps (provided):**
  - Short-but-hard: `route_011`, `route_012`, `route_013`, `route_019`, `route_020`.
  - Long-but-trivial: `route_006`, `route_007`, `route_010`.
  - A length-only heuristic scores about 60% by design.
- **Rules:** `expected_tier` is the answer key and is never used inside routing logic, exemplars or tuning; exemplars and thresholds come from our own development prompts. The classifier logs its reason per case (and per live `auto` request in the request log).
- **Metrics reported:** overall accuracy (classifier vs. baseline); accuracy on the trap cases; the list of misses with an explanation; confusion counts (simple→`smart`, complex→`fast`); the classification method.
- **Pass:**
  - Classifier accuracy is clearly above the baseline; the target is **80% or better** (a documented method reaching 80%+ is a solid baseline).
  - Trap cases are handled; any trap miss is explained honestly in the report.
  - Live check: `route_011` ("Prove that the square root of 2 is irrational.") routes to `smart` and `route_006` (the on-call roster lookup) routes to `fast`, with the reason visible in the request log.
  - Output is saved as an artifact for the Verification Report.

### E7 — Retry, Failover, and Billing Semantics

- **Checks:** transient errors retry with backoff; persistent failures and provider `429`s fail over; failover is recorded; billing and RPM semantics hold; traffic returns to a restored primary.
- **Method:** set failure modes on the mocks' `/admin/config` (or use the fake adapter for timing-sensitive cases).

| Scenario | Expected result |
|---|---|
| Primary healthy | Served by primary; `x-prism-fallback: false` |
| Primary `{"mode": "down"}` | Retries then failover; served by `beta`; `x-prism-fallback: true`; log has `fallback = true`, the actual provider, and `retries` |
| Primary `{"mode": "rate_limited"}` (429) | No retry; immediate failover to `beta` |
| Primary `{"fail_rate": 0.3}` | Retries absorb the failures; requests still succeed |
| Primary `{"latency_ms": 3000}` | Per-call timeout fires; the client gets a fallback response or a clean error within the deadline, never a hang |
| One transient error, then success | Retried with backoff; served by primary; `x-prism-fallback` stays `false` |
| Retry once **and** fail over once | Exactly **one** RPM hit; billed for exactly **one** attempt (the successful one) |
| Non-retryable provider 4xx | `502 upstream_error`; no retry, no failover |
| Every provider in the chain fails | `502 upstream_error` with the standard envelope, logged, nothing billed |
| Primary restored (`{"mode": "ok"}`) | The next request is served by the primary again |

- **Pass:** every row behaves as stated; backoff delays are observable and increasing; no failed attempt is ever billed; restoring the primary immediately sends traffic back to it.
- **Optional (Good To Have):** if provider health tracking is built, a clearly-down provider is skipped on subsequent requests, probed periodically, and `GET /admin/providers/health` reports it.

### E8 — Semantic Cache and Tenant Isolation

- **Checks:** paraphrases hit the cache; one tenant's cached responses are never served to another; per-key settings are honored; bad entries are never cached.
- **Method (salt prompts to avoid pollution):**
  1. `search` key sends `req_cache_a1` (miss), then `req_cache_a2` (paraphrase) → expect hit; repeat with pair B (`req_cache_b1` then `req_cache_b2`).
  2. `search` key sends `req_cache_a3` (similar words, different intent) → expect miss.
  3. Same paraphrase under a different cache-enabled key (`free-tier`) → expect miss (must not see the `search` key's entry).
  4. An unrelated prompt → miss.
  5. Cache-disabled keys (`research`, `budget-demo`): repeat a prompt → always `miss`.
  6. `req_multiturn` repeated with a different earlier turn → miss; with identical context → hit.
  7. A provider error response and a time-sensitive prompt (`req_no_cache`) → never cached.
  8. Streaming: a repeated streamed prompt is replayed as an SSE hit; an aborted stream leaves no cache entry.
  9. Concurrent cross-tenant traffic with identical prompts → no leakage.
- **Pass:**
  - Pair A and pair B hit with `x-prism-cache: hit`, cost `0`, no provider call; at least one pair must hit (the smoke test's requirement) and both are expected to.
  - `req_cache_a3` misses; the unrelated prompt misses.
  - The cross-tenant case is a miss — **an automatic correctness failure if it ever hits**; zero leaks across all runs.
  - Results are stable across repeated runs.
- **Also report:** the embedding model, each key's threshold actually used (seed: `search` 0.92, `free-tier` 0.85), any threshold change made during calibration and why, the observed similarity for pairs A and B, `req_cache_a3` and an unrelated prompt, and the overall hit rate.

### E9 — Metering and Request Log Completeness

- **Checks:** cost = provider-reported tokens × price-table rate; every request writes one complete log row on every code path, including rejections.
- **Method:**
  - Unit tests: cost computation for each of `alpha-small`, `alpha-large`, `beta-small`, `beta-large` against hand-computed values (prices are USD per 1M tokens), including zero-token handling and cache-hit (`0`) cases; exact decimal arithmetic (no float drift).
  - Integration: for each path (cache hit, miss, success, fallback, stream, each rejection type, upstream failure) assert exactly one `request_logs` row with all required fields: `request_id`, key, `requested_model`, `resolved_provider`, `resolved_model` (null for rejections and cache hits), `status`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `cache`, `fallback`, `route_reason` (for `auto`), `retries`, `latency_ms`, `created_at`.
  - Admin API checks: `/admin/usage` for a key with traffic, with no traffic (zeros, not `NaN`), and unknown key (clear error); `/admin/logs` newest-first with `limit`; `/admin/cache/stats` hits, misses and hit rate.
- **Pass:** costs match hand-computed values; no missing or null required fields; usage API totals (requests, tokens, cost, cache hits) match the rows; `/admin/*` rejects calls without the admin token; provider keys, raw virtual keys and the admin token never appear in any log, response or console view.

### E10 — Full Pipeline Integration

- **Checks:** all stages work together, not just individually (architecture §3).
- **Method:** one combined scenario — an `auto`-routed request (research key) that misses the cache (cache enabled for the scenario), triggers a retry + failover, streams its response, and is then served again as a cache hit.
- **Pass:** at every step the `x-prism-*` headers and the resulting log rows are correct (`route_reason` present, `fallback`, `retries`, cost, cache result); the repeat is a hit with cost `0`; counters reconcile afterward.

### E11 — Ops Console (manual)

- **Checks:** the console reflects real activity and reads only from the admin API.
- **Method:** send mixed traffic (hits, misses, a fallback, a rate-limit rejection, a budget rejection), then open the console.
- **Pass:**
  - Usage-by-key, recent-requests (including rejections, route reasons and the fallback flag) and cache-hit-rate views show numbers that match `/admin/usage`, `/admin/logs` and `/admin/cache/stats`.
  - Network inspection confirms the frontend calls only the gateway's admin API with the demo token (no direct DB access), and no secret is visible.

### E12 — Provider Swap-In and Timeouts

- **Checks:** the adapter abstraction holds, and no provider can hang the gateway.
- **Method:**
  - Point one alias (or one fallback slot) at a real OpenAI-compatible provider via config only; re-run E1, E5, E7 and E9 against it.
  - Configure a mock with `{"latency_ms": 3000}` (or longer) and call it.
- **Pass:**
  - The same suites pass against mock and real providers with **no core code changes**.
  - The slow mock produces a fallback response or a clean error within the configured timeout and the overall deadline — the gateway never hangs.
  - Real API keys and spend need your approval first, and keys are read from the environment only.

### E13 — Code Quality and Automated Tests

- **Checks:** the codebase is clean and maintainable, and the required automated tests exist and pass.
- **Method:** run lint, format check, and TypeScript type-check for gateway, console and shared types; run the full test suite from a clean checkout.
- **Pass:** zero lint/type errors; all tests green from a clean checkout; module layout matches architecture §7; the required test areas (cost computation, rate limiter, cache decision, allowlist, routing) are present (see §4).

### E14 — Manual Failure Drill (recorded in the demo)

- **Checks:** live failure handling is visible and correct, as in the starter's drill.
- **Method:** with traffic flowing on the `fast` alias:
  1. `curl -X POST http://localhost:9001/admin/config -d '{"mode": "down"}'` → the next request is served by `beta` with `x-prism-fallback: true` and logged as a fallback.
  2. `{"mode": "ok", "latency_ms": 3000}` → the timeout fires; the client gets a timely response, never a hang.
  3. `{"latency_ms": 0, "fail_rate": 0.3}` → retries absorb it; requests still succeed.
  4. `{"mode": "ok", "fail_rate": 0}` → traffic returns to `alpha` immediately.
- **Pass:** each step shows the expected outcome in the response headers, the request log and the console.

---

## 4. Automated Test Inventory

The spec requires automated tests for the following critical logic. Each is built in its owning phase.

| Area | What the tests cover | Phase |
|---|---|---|
| Cost computation | Per-model pricing (per 1M tokens), exact decimal math, zero-cost cache hits, header precision | 9 |
| Rate limiting | Sliding-window correctness, minute-boundary behavior, per-key independence, concurrency, Redis-down fail-closed | 3 |
| Allowlists | Allowed vs disallowed per key; `auto` permission and tier downgrade; check precedes limiter and budget | 3 |
| Budget | Reserve/settle atomicity, lazy period row, exact-boundary behavior, tiny-budget key, overshoot bound, concurrency | 3 |
| Cache decisions | Per-key enabled/threshold, similarity threshold, context-hash scoping, never-cache rules, tenant filter on every query | 8 |
| Routing behavior | Alias resolution, fallback chain order, `auto` classification and `route_reason`, allowlist interaction | 5, 7 |
| Retry / failover | Backoff, provider `429` immediate failover, non-retryable 4xx, billing and RPM semantics | 5 |
| Provider adapter | Timeouts, malformed responses, error mapping, fake adapter determinism | 4 |
| Streaming | Incremental delivery, `[DONE]`, final usage capture, mid-stream failure, client disconnect | 6 |
| Config / seed loading | Exact key and alias preservation, fail-fast validation, idempotent seeding | 1 |
| Admin API | Token enforcement, usage reconciliation, log shape | 9 |

---

## 5. Phase Gates

A phase is not done until its gate passes. This ties each phase's exit criteria to the evals above.

| Phase | Gate (must pass) | Evals |
|---|---|---|
| 0 — Scaffolding | `docker compose up` brings up Postgres, Redis, both mocks, gateway, console; `/health` → 200 | E1 (health) |
| 1 — Data layer | Migrations run, seed keys queryable, config maps loaded and validated; re-seeding is a no-op; unit tests green | §4 config/seed |
| 2 — HTTP + auth | Valid key → 200 stub with header contract; `401`, `400`, `404` with the standard envelope; each logged | E1, E2 |
| 3 — Limits & budgets | All rejection codes; concurrency tests show no over-admission; tiny-budget key admits exactly one | E2, E3 |
| 4 — Adapters + pass-through | `fast` request served by `alpha-small` with correct headers, cost, log; slow/dead provider never hangs | E1, E9, E12 (timeout) |
| 5 — Routing & failover | Forced failure fails over, recorded, billed once; `429` fails over immediately; primary restored | E7 |
| 6 — Streaming | Incremental output; correct usage logged; clean mid-stream failure | E5 |
| 7 — Smart routing | Classifier beats baseline (target 80%+), trap cases handled, reasons logged | E6 |
| 8 — Semantic cache | Pairs A and B hit; `req_cache_a3` and cross-tenant miss, reliably; per-key config honored | E8, E1 (cache checks) |
| 9 — Metering & admin API | Usage numbers reconcile exactly, including under concurrency; pipeline test passes | E4, E9, E10 |
| 10 — Console | Reflects real traffic on manual check | E11 |
| 11 — Verification | Smoke, load, routing eval and failure drill all pass; report drafted with real output | E1, E3, E4, E6, E8, E14 |
| 12 — Real provider | Same suite passes on mock and real via config only | E12 |
| 13 — Docs & demo | A fresh reviewer can reproduce every claim | §6, §7 |

---

## 6. Verification Report Template

The report in Phase 11 must contain real captured output (not placeholders) for each item the spec and the starter's evaluation guide list.

| Section | Source | Capture |
|---|---|---|
| Smoke test output | `scripts/smoke_test.py` | Full console output, pass/fail summary; explain any WARN |
| Load test report | `scripts/load_test.py` | Burst summary: accepted, rate-limited, other outcomes, latency avg/p95 |
| Over-admission results | E3 + load test | `accepted <= limit` result; admitted vs allowed counts per limit type |
| Accounting totals | E4 + `/admin/usage` | Client-side totals from the load test next to the usage API numbers, and the reconciliation result |
| Routing eval accuracy | E6 script | Classifier vs baseline accuracy, per-case results, method, explanation of the misses |
| Cache results | E8 | Embedding model, thresholds used, behavior on pair A, pair B and `req_cache_a3`, hit rate, isolation result |
| Failover results | E7, E14 | Scenario table with observed outcomes |
| Latency summary | Load test / request logs | Client-observed average and p95; gateway-added latency and how it was measured (timestamps around the upstream call) |
| Known limitations | — | For example: per-instance provider health state, cache eviction, fixed embedding model |
| Environment | — | Commit hash, date, seed data version, mock vs real provider, machine/Docker details |

Each section should state the command used to produce it so a reviewer can re-run it.

---

## 7. Demo Checklist (Explainer Video)

Record once every eval above is green. The beats follow the starter's recommended demo flow; each has an expected on-screen result.

| # | Beat | Expected on screen |
|---|---|---|
| 1 | Healthy system | Both mocks and the gateway report healthy (`/health` → 200) |
| 2 | Non-streaming request, `search` key, `fast` alias | Headers show the serving provider, `x-prism-cache: miss`, and a cost |
| 3 | Streaming request | Tokens arrive one by one; `[DONE]` at the end |
| 4 | Repeat the prompt, then a paraphrase (`req_cache_a1`, `req_cache_a2`) | `x-prism-cache: hit` on both, cost `0` |
| 5 | `auto` with the research key: `route_011` and `route_006` | The proof lands on `smart`, the roster lookup on `fast`, with reasons in the log; routing eval accuracy shown |
| 6 | Burst past the `free-tier` limit | Clean `429 rate_limit_exceeded` rejections |
| 7 | Two requests with the `budget-demo` key | The first consumes the budget; the second is `402 budget_exceeded` |
| 8 | Live provider failover (`{"mode": "down"}` on `alpha`) | The same request is served by `beta` with `x-prism-fallback: true` |
| 9 | Ops console | Usage by key, recent requests (including both rejections and the fallback), cache hit rate |
| 10 | Smoke test and load test | Both summaries shown |

---

## 8. Open Items

- **Docker Desktop** is not installed yet; Phase 0 and every Compose-based eval depend on it.
- **Cache thresholds** are calibrated in Phase 8 against the chosen embedding model; the seeded values (0.92, 0.85) are used unless calibration shows they cannot satisfy pairs A and B and the near-miss together. Any change is documented in the report.
- **Routing accuracy target** is 80% or better; the exact result and the explanation of misses are reported as measured, not tuned to the labels.
- **Latency targets.** The spec asks for a latency summary, not a target; mocks make absolute values synthetic, and we say so.
- **Real-provider evals (E12)** need API keys and spend; run them minimally and only after your approval.
- **Git / network actions.** Committing the copied starter files and pushing the final repository require your explicit approval, per the working agreement.
