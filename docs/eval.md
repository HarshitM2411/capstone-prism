# Prism — Evaluation Plan

**Based on:** [`docs/architecture.md`](architecture.md), [`docs/implementation-plan.md`](implementation-plan.md), and the requirements in [`docs/context.md`](context.md) / `docs/PS1.pdf`.

This document defines **how we prove Prism works**: what we measure, how we measure it, what counts as a pass, and what evidence goes into the Verification Report. It is the "test plan — next doc" referenced in the architecture's traceability table, and it expands the exit criteria of each implementation phase into concrete, repeatable checks.

> **Principle:** a claim is only true if there is an automated check (or a captured artifact) that demonstrates it. Anything that cannot be automated (console, demo video) gets a manual checklist with explicit expected results.

---

## 1. Evaluation Map

Each assessment criterion from the problem statement maps to one or more evals, the phase that builds it, and the evidence produced.

| Assessment criterion | Eval(s) | Built in phase | Evidence |
|---|---|---|---|
| Functionality — OpenAI-compatible completions, streaming, keys/limits/budgets, failover, `auto`, cache, metering, console | E1–E11 | 2–10 | Smoke test output, test suite report |
| Accounting accurate under concurrency | E4 | 9 | Reconciliation report (`budget_usage` vs `request_logs`) |
| No over-admission under load | E3 | 3 | Load test report |
| Failover works when a provider is taken down | E7 | 4, 5 | Test log + demo video |
| Cache hits paraphrases without cross-tenant leakage | E8 | 8 | Test log (hit + isolation cases) |
| Routing beats a length-only baseline | E6 | 7 | Routing eval report |
| Code quality | E13 | 0–12 | Lint/type-check/test output |
| Documentation and demo | E12, §8 | 13 | README review, demo checklist |

---

## 2. Test Environment and Data

- **Stack under test:** Docker Compose (gateway, console, Postgres with `pgvector`, Redis) — the same one-command setup used for the demo.
- **Providers:** Mock Provider A and Mock Provider B are the default for every eval. They are deterministic (same input → same simulated behavior), so results are reproducible. The real provider is only exercised in E12.
- **Failure injection:** the Phase 4 health-toggle (`POST /debug/providers/:name/toggle`) and per-mock latency/failure/timeout config force failures on demand.
- **Seed data:** `seed_keys.json`, `model_pricing.json`, `gateway_config.sample.json` from the starter repo, with exact key values and alias names preserved.
- **Isolation:** each eval starts from a known state (fresh DB migration + seed, Redis flushed) so results do not depend on test order.
- **Time control:** RPM window and budget period logic should be testable with an injectable clock so minute-boundary behavior is not flaky.

---

## 3. Evals

Each eval lists **what it checks**, **method**, and **pass criteria**.

### E1 — API Contract and Smoke

- **Checks:** OpenAI-compatible request/response shape; `x-prism-*` header contract (`x-prism-provider`, `x-prism-cache`, `x-prism-fallback`, `x-prism-cost-usd`) present on every response path; `/health` returns 200.
- **Method:** schema-validate responses against the OpenAI chat-completion shape; run `scripts/smoke_test.py` unmodified.
- **Pass:** `scripts/smoke_test.py` passes as-is; all four headers present on hit, miss, fallback, and streamed responses.

### E2 — Rejection Codes (Auth, Allowlist, Rate Limit, Budget)

- **Checks:** each rejection path returns its own distinct, documented code in the OpenAI-style error envelope, and rejects before any provider is called.
- **Method:** one test per row below; assert HTTP status, `error.code`, and that no provider call or charge occurred.

| Scenario | Expected HTTP | Expected `error.code` |
|---|---|---|
| Missing or unknown key | 401 | `invalid_api_key` |
| Resolved model not in key's allowlist | 403 | `model_not_allowed` |
| RPM exceeded | 429 | `rate_limited` |
| Monthly budget would be exceeded | 402 | `budget_exceeded` |

- **Pass:** all four codes are produced individually and are distinct; a rejected request produces zero provider calls and zero cost.

### E3 — Concurrency: Admission Control (No Over-Admission)

- **Checks:** under parallel load near a limit, exactly the permitted number of requests are admitted — no race lets extras through.
- **Method:**
  1. *RPM:* key with `rpmLimit = N`; fire `M > N` parallel requests inside one minute bucket.
  2. *Budget:* key whose remaining budget fits exactly `K` requests of known cost; fire `M > K` parallel requests.
  3. Run `scripts/load_test.py` and read its over-admission result.
- **Pass:**
  - Exactly `N` requests admitted for RPM; the rest return `429`.
  - Exactly `K` requests admitted for budget; the rest return `402`.
  - Final `spent_usd` never exceeds the monthly budget.
  - Load test reports **zero over-admissions**.
  - Repeated runs (e.g. 20×) give the same result — not just a lucky pass.

### E4 — Concurrency: Accounting Accuracy

- **Checks:** concurrent *successful* requests produce no lost updates (a different failure mode from over-admission).
- **Method:** fire many concurrent successful requests against one key; afterwards compare `budget_usage.spent_usd`, the sum of `request_logs.cost_usd`, and the usage API total.
- **Pass:** all three values reconcile **exactly**; the row count in `request_logs` equals the number of requests sent (including rejected ones, per the one-row-per-request rule).

### E5 — Streaming Pass-Through

- **Checks:** tokens are forwarded as they arrive, the stream terminates correctly, and usage is still metered.
- **Method:** call with `stream: true` against a mock with fixed inter-token delay; timestamp each chunk on the client side.
- **Pass:**
  - Chunks arrive incrementally — the gap between first and last chunk is roughly the mock's total generation time, not near zero (i.e. not buffered).
  - Stream ends with `data: [DONE]`.
  - The log row has correct token counts and cost taken from the final usage chunk.

### E6 — Routing Eval (`auto` vs length-only baseline)

- **Checks:** the difficulty classifier uses signal beyond length and beats a length-only rule.
- **Method:** one-command eval script runs both the classifier and the length-only baseline over the labeled eval set and reports accuracy **per case** and overall.
- **Eval set must include:**
  - Short-but-hard prompts (e.g. "Prove P≠NP") — trap for length-only rules.
  - Long-but-trivial prompts (e.g. a long prompt that just repeats "hello") — the opposite trap.
  - Ordinary easy and hard prompts, including code, math, and multi-part questions.
- **Metrics reported:**
  - Overall accuracy: classifier vs baseline.
  - Accuracy on trap cases specifically.
  - Confusion counts (easy→smart, hard→fast).
- **Pass:**
  - Classifier accuracy **>** baseline accuracy overall.
  - Every trap case is classified correctly (or, at minimum, trap-case accuracy is strictly higher than the baseline's).
  - Output is saved as an artifact for the Verification Report.
- **Guardrail:** thresholds are tuned on the labeled set; if the set is small, hold out some cases to detect overfitting before reporting.

### E7 — Retry, Failover, and Billing Semantics

- **Checks:** transient errors retry with backoff; persistent failures fail over; failover is recorded; billing and RPM semantics hold.
- **Method:** use the health-toggle and mock failure modes.

| Scenario | Expected result |
|---|---|
| Primary healthy | Served by primary; `x-prism-fallback` false |
| Primary forced down mid-test | Served by fallback; `x-prism-fallback` true; log row has `fallback_used = true` and the actual provider |
| One transient error, then success | Retried with backoff; served by primary; not marked as failover |
| Retry once **and** fail over once | Exactly **one** RPM hit; billed for exactly **one** attempt (the successful one) |
| Provider that is clearly down, repeated requests | Skipped directly after repeated failures (health/circuit state), not retried every time; recovers once healthy |
| Every provider in the chain fails | Clean error to the client, logged, nothing billed |

- **Pass:** every row behaves as stated; backoff timing is observable (increasing delays); no failed attempt is ever billed.

### E8 — Semantic Cache and Tenant Isolation

- **Checks:** paraphrases hit the cache; one tenant's cached responses are never served to another.
- **Method:**
  1. Key A sends prompt P (miss). Key A sends a paraphrase of P → expect hit.
  2. Key B sends the same paraphrase → expect miss (must not see Key A's entry).
  3. Unrelated prompt under Key A → expect miss.
  4. Concurrent cross-tenant traffic with identical prompts → no leakage.
- **Pass:**
  - Case 1 is a hit with `x-prism-cache: hit`, cost `$0`, and no provider call.
  - Case 2 is a miss for Key B — **this is explicitly graded**; zero leaks across all runs.
  - Case 3 is a miss.
  - Results are stable across repeated runs.
- **Also report:** the similarity threshold used (architecture suggests ~0.92) and the hit rate observed on the paraphrase set.

### E9 — Metering and Request Log Completeness

- **Checks:** cost = provider-reported tokens × price-table rate; every request writes one complete log row on every code path.
- **Method:**
  - Unit tests: cost computation for each model and pricing tier, including zero-token and cache-hit (`$0`) cases.
  - Integration: for each path (cache hit, miss, success, failure, fallback, each rejection type) assert exactly one `request_logs` row with all required fields: key, alias, resolved model, provider, status, prompt/completion tokens, cost, cache result, fallback flag, latency.
- **Pass:** costs match hand-computed values; no missing or null required fields; usage API totals (requests, cost, cache hit rate) match the rows.

### E10 — Full Pipeline Integration

- **Checks:** all stages work together, not just individually (architecture §3).
- **Method:** one combined scenario — an `auto`-routed request that misses the cache, triggers a retry + failover, streams its response, and is then served again as a cache hit.
- **Pass:** at every step the four `x-prism-*` headers and the resulting log rows are correct; the second request is a hit with `$0` cost; counters reconcile afterward.

### E11 — Ops Console (manual)

- **Checks:** the console reflects real activity and reads only from the API.
- **Method:** send mixed traffic (hits, misses, a fallback, a rejection), then open the console.
- **Pass:**
  - Usage-by-key, recent-requests, and cache-hit-rate views show numbers that match the usage API.
  - Network inspection confirms the frontend calls only the gateway API (no direct DB access).

### E12 — Provider Swap-In and Timeouts

- **Checks:** the adapter abstraction holds, and no provider can hang the gateway.
- **Method:**
  - Point one alias at a real provider via config only; re-run E1, E5, E7, E9 against it.
  - Configure a mock to never respond; call it.
- **Pass:**
  - The same suites pass against mock and real providers with **no core code changes**.
  - The hanging mock produces a timeout error or failover within the configured timeout — the gateway never hangs.

### E13 — Code Quality Gates

- **Checks:** the codebase is clean and maintainable.
- **Method:** run lint, format check, and TypeScript type-check for gateway, console, and shared types; run the full test suite in CI-style (clean checkout).
- **Pass:** zero lint/type errors; all tests green from a clean checkout; module layout matches architecture §7.

---

## 4. Automated Test Inventory

The spec requires automated tests for the following critical logic. Each is built in its owning phase.

| Area | What the tests cover | Phase |
|---|---|---|
| Cost computation | Per-model/tier pricing, token math, zero-cost cache hits | 9 |
| Rate limiting | RPM window, boundary behavior, per-key independence, concurrency | 3 |
| Allowlists | Allowed vs disallowed model per key; alias resolved before the check | 3 |
| Budget | Conditional-update atomicity, exact-boundary behavior, concurrency | 3 |
| Cache decisions | Similarity threshold, hit/miss, tenant filter on every query | 8 |
| Routing behavior | Alias resolution, fallback chain order, `auto` classification | 5, 7 |
| Retry / failover | Backoff, failover, health state, billing semantics | 5 |
| Mock providers | Determinism, latency, failure/timeout injection, usage reporting | 4 |
| Streaming | Incremental delivery, `[DONE]`, final usage capture | 6 |
| Config / seed loading | Exact key and alias preservation, in-memory maps | 1 |

---

## 5. Phase Gates

A phase is not done until its gate passes. This ties each phase's exit criteria to the evals above.

| Phase | Gate (must pass) | Evals |
|---|---|---|
| 0 — Scaffolding | `docker compose up` brings up all services; `/health` → 200 | E1 (health) |
| 1 — Data layer | Migrations run, seed keys queryable, config maps loaded; unit tests green | §4 config/seed |
| 2 — HTTP + auth | Valid key → 200 stub with header contract; invalid key → `401` | E1, E2 |
| 3 — Limits & budgets | All four rejection codes; concurrency test shows no over-admission | E2, E3 |
| 4 — Adapters | Mocks callable directly: response, stream, simulated failure/timeout | E12 (timeout), §4 mocks |
| 5 — Routing & failover | End-to-end through a mock; forced failure fails over, recorded, billed once | E7 |
| 6 — Streaming | Incremental output; correct usage logged | E5 |
| 7 — Smart routing | Classifier beats baseline, trap cases correct | E6 |
| 8 — Semantic cache | Paraphrase hit; cross-tenant miss, reliably | E8 |
| 9 — Metering & logs | Usage numbers reconcile exactly, including under concurrency; pipeline test passes | E4, E9, E10 |
| 10 — Console | Reflects real traffic on manual check | E11 |
| 11 — Verification | All scripts pass; report drafted with real output | All |
| 12 — Real provider | Same suite passes on mock and real via config only | E12 |
| 13 — Docs & demo | Fresh reviewer can reproduce every claim | §6, §7 |

---

## 6. Verification Report Template

The report in Phase 11 must contain real captured output (not placeholders) for each item the spec lists.

| Section | Source | Capture |
|---|---|---|
| Smoke test output | `scripts/smoke_test.py` | Full console output, pass/fail summary |
| Load test report | `scripts/load_test.py` | Request counts, status breakdown, errors |
| Routing eval accuracy | E6 script | Classifier vs baseline accuracy, per-case table, trap-case results |
| Over-admission results | E3 + load test | Admitted vs allowed counts per limit type |
| Accounting totals | E4 + usage API | `spent_usd`, sum of `cost_usd`, usage API total, and the reconciliation result |
| Latency summary | Load test / request logs | p50, p95, p99 for hit, miss, and fallback paths; streaming time-to-first-token |
| Cache results | E8 | Hit rate on paraphrases; isolation result |
| Failover results | E7 | Scenario table with observed outcomes |
| Environment | — | Commit hash, date, seed data version, mock vs real provider, machine/Docker details |

Each section should state the command used to produce it so a reviewer can re-run it.

---

## 7. Demo Checklist (Explainer Video)

Record once every eval above is green. Each beat has an expected on-screen result.

| # | Beat | Expected on screen |
|---|---|---|
| 1 | Streaming | Tokens appear incrementally; `[DONE]` at the end |
| 2 | Smart routing | A trivial prompt routes to `fast`; a hard prompt routes to `smart`; `auto` shown in the log |
| 3 | Budget rejection | Key at its cap receives `402 budget_exceeded` |
| 4 | Rate limiting | Burst past RPM receives `429 rate_limited` |
| 5 | Semantic cache hit | A paraphrased prompt returns `x-prism-cache: hit` at `$0` |
| 6 | Live provider failover | Primary toggled down via the health-toggle endpoint; the next request is served by the fallback with `x-prism-fallback` set |
| 7 | Console | Usage, recent requests, and cache hit rate reflect everything shown above |

---

## 8. Open Items

- **Thresholds are proposals.** The cache similarity threshold (~0.92), retry count, backoff curve, and timeout values should be fixed in config, then recorded in the report alongside the results.
- **Eval set provenance.** Confirm whether the starter repo ships the full labeled routing eval set; if not, we author it (Phase 7) and document its size and labeling method.
- **Latency targets.** The spec asks for a latency summary but not a target; we report measured numbers and note that mocks make absolute values synthetic.
- **Real-provider evals (E12)** need API keys and spend; run them minimally and only after your approval.
- **Git / network actions.** Pulling the starter repo and pushing the final repository both require your explicit approval, per the working agreement.
