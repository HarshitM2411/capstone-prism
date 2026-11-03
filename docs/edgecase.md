# Prism — Edge Cases

**Based on:** [`docs/architecture.md`](architecture.md) and [`docs/implementation-plan.md`](implementation-plan.md), aligned with the starter pack's contract (`API_CONTRACT`, `DATA_MODEL`, `EVALUATION_GUIDE`, `IMPLEMENTATION_GUIDE` in the [`prism-capstone`](https://github.com/airtribe-projects/prism-capstone) repo). Requirements come from [`docs/context.md`](context.md) / `docs/PS1.pdf`. Verification of these cases is planned in [`docs/eval.md`](eval.md).

This document lists the edge cases each component must handle, the **expected behavior**, and the phase where it gets built and tested. Many of these are exactly where gateways fail under review — concurrency, streaming, failover, and tenant isolation.

**How to read the "Expected behavior" column**

- Behavior is the **decided** behavior from the architecture or the starter contract, unless marked **(proposed)**.
- **(proposed)** means the architecture and starter pack don't specify it; it is a recommended default that is cheap to change. These are listed in [§12](#12-decisions).

**Priority:** `P0` = explicitly graded or correctness-critical, `P1` = important robustness, `P2` = nice to have.

**Error codes used below** (architecture §6): `401 authentication_error`, `400 invalid_request_error`, `404 not_found_error`, `403 model_not_allowed`, `429 rate_limit_exceeded`, `402 budget_exceeded`, `502 upstream_error`, `503 service_unavailable`.

---

## 1. Request Validation (Phase 2)

Validation runs **after** authentication (architecture §3.1).

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 1.1 | Malformed JSON body | `400 invalid_request_error`, logged; no Redis, Postgres reservation or provider side effects | P1 |
| 1.2 | Empty `messages` (the starter's `req_malformed`), missing `messages` or missing `model` | `400` from the schema validation, before routing | P0 |
| 1.3 | Unknown `model` (not an alias and not a configured model, e.g. `no-such-model-xyz`) | `404 not_found_error` / `model_not_found`; never falls through to a provider (the smoke test expects a 4xx with an `error` body) | P0 |
| 1.4 | `stream` is a non-boolean (e.g. `"true"`) | `400` validation error | P2 |
| 1.5 | Extremely large prompt or body | Rejected by a body-size limit (`400`/`413`) before embedding or provider calls | P1 |
| 1.6 | Valid body but invalid/missing key | `401` — authentication is checked first, so a bad key never reveals validation details | P0 |
| 1.7 | Unsupported OpenAI params (`tools`, `n > 1`, `logprobs`, etc.) | Passed through where the adapter supports them or rejected clearly; never silently dropped **(proposed)** | P2 |
| 1.8 | Non-text content, empty or whitespace-only message content | Defined behavior; the embedding model and classifier must not crash on empty input | P1 |
| 1.9 | Multi-turn request (`req_multiturn`) | Valid; the whole history counts toward prompt tokens; see the cache-key rules in §7 | P1 |
| 1.10 | Client sends a provider model name (e.g. `alpha-small`) | Allowed only if it is a configured model **and** on the key's allowlist; none of the seed keys list one, so they get `403 model_not_allowed` | P1 |

---

## 2. Authentication (Phase 2)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 2.1 | Missing `Authorization` header | `401 authentication_error` / `invalid_api_key`, logged with a null key | P0 |
| 2.2 | Wrong scheme (`Basic` instead of `Bearer`), extra whitespace, empty bearer token | `401` | P1 |
| 2.3 | Key differs from a valid key by one character or case | `401`; lookup is by hash, so no partial matching | P1 |
| 2.4 | Very long or binary-garbage key | `401`, no crash, no unbounded work | P1 |
| 2.5 | Key row has `status = disabled` | `401`, same response as unknown (no oracle for which keys exist) | P1 |
| 2.6 | Raw key value or hash appears in logs, console or error messages | Never. Logs store the key id; rejected unknown keys are logged with a null key (the submitted value is dropped) | P0 |
| 2.7 | Seed re-run (restart/redeploy) | Idempotent; exact key values and team names preserved; no duplicates | P0 |
| 2.8 | Key row with missing/invalid policy fields (no allowlist, `rpm_limit = 0`) | Safe default: an empty allowlist allows nothing, `rpm_limit = 0` rejects everything — never "unlimited" by accident | P1 |
| 2.9 | Admin routes without the `x-admin-token`, or with a wrong one | `401`; the data-plane virtual key is not accepted on admin routes | P0 |
| 2.10 | Admin token or provider keys visible in console, logs or responses | Never | P0 |

---

## 3. Model Allowlist (Phase 3)

The allowlist holds the names callers send (`fast`, `smart`, `auto`) and is checked against the **requested name**. A fallback chain belongs to its alias, so fallbacks never need a separate allowlist check.

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 3.1 | `search` or `free-tier` key requests `smart` (`req_not_allowed`) | `403 model_not_allowed` | P0 |
| 3.2 | `auto` classifies as `smart` but the key allows `fast` and `auto` only | Downgrade to `fast`, record the downgrade in `route_reason`; if neither tier is allowed → `403` | P0 |
| 3.3 | Key requests `auto` but `auto` is not on its allowlist | `403 model_not_allowed` (`search`, `free-tier` and `budget-demo` cannot use `auto`) | P0 |
| 3.4 | Empty allowlist | Allows nothing | P1 |
| 3.5 | Allowlist rejection must not consume RPM or budget | Allowlist is checked before the rate limiter and the budget; rejection costs nothing | P0 |
| 3.6 | Unknown model vs. disallowed model | Unknown → `404` (resolution comes first); known-but-disallowed → `403` | P1 |

---

## 4. Rate Limiting — RPM, Redis Sliding Window (Phase 3)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 4.1 | N+M parallel requests when only N slots remain | Exactly N admitted, M get `429`; one atomic Lua script decides each request | P0 |
| 4.2 | Burst that straddles a minute boundary | Sliding window: never more than the limit inside any 60-second span. A fixed window could admit 2× and fail the provided load test, which is why it is not used | P0 |
| 4.3 | Process crashes between "add to window" and "set TTL" | Not possible: both happen inside the same Lua script, so a window key always has a TTL | P0 |
| 4.4 | Redis is unavailable or slow | Short timeout, then **fail closed**: `503 service_unavailable` / `rate_limiter_unavailable`, logged. Protecting spend is preferred over availability | P0 |
| 4.5 | Redis is flushed or restarted | Windows reset; accepted behavior (Redis is not a system of record) | P1 |
| 4.6 | Multiple gateway instances | The window lives in Redis, so the limit is shared across instances | P0 |
| 4.7 | Two different keys with identical traffic | Windows are independent per `keyId` | P1 |
| 4.8 | Retry or failover inside one client request | Counts as **one** RPM hit — the limiter is called once per client request | P0 |
| 4.9 | Client keeps sending after getting `429` | Rejected requests are not added to the window, so the client can recover as soon as old entries expire; a `Retry-After` hint is returned | P1 |
| 4.10 | Cache-hit requests | Still count toward RPM (they are requests) | P1 |
| 4.11 | Clock skew between gateway instances | Not an issue: the Lua script uses Redis's own clock | P1 |
| 4.12 | Request rejected earlier (401/400/404/403) | Never reaches the limiter, so it does not consume the window | P1 |
| 4.13 | Load test: `free-tier` key, 30 requests, concurrency 10, limit 10 | At most 10 accepted (`accepted <= limit`), the rest `429` | P0 |

---

## 5. Budget Guard — Reserve → Settle (Phases 3 and 9)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 5.1 | Parallel requests that together exceed the budget | The conditional reservation serializes on the row; admission requires `spent + reserved < budget`; the rest get `402` | P0 |
| 5.2 | Final cost unknown at admission | Reserve `LEAST(estimate, remaining)`; settle to the actual cost afterward | P0 |
| 5.3 | `budget-demo` key (budget `0.00001`, smaller than one request's cost) | The first request is admitted (budget remains) and reserves the whole remaining budget; it settles above the ceiling; the next request gets `402 budget_exceeded`, and that rejection is logged | P0 |
| 5.4 | Two concurrent requests on a nearly empty budget | The first reserves everything that remains, so the second is rejected while the first is in flight; worst-case overshoot is one request's cost | P0 |
| 5.5 | Reserved amount differs from actual cost | Settlement adds the actual cost to `spent_usd` and releases the reservation; `spent_usd` always equals the sum of logged `cost_usd` | P0 |
| 5.6 | Request fails or is a cache hit after reserving | Reservation is released; nothing is charged | P0 |
| 5.7 | Reservation is never released (gateway crash mid-request) | A stale `reserved_usd` would block spending. Startup/periodic reconciliation clears reservations older than the request deadline **(proposed)** | P0 |
| 5.8 | Stream that ends without a final usage chunk (client disconnect, provider dies) | Bill tokens actually delivered, estimated from the streamed content and flagged `usage_estimated`; bill `0` if nothing was delivered | P0 |
| 5.9 | Cache hit when the key's budget is already exhausted | The budget gate runs before the cache, so the request is rejected `402`; the `budget-demo` key also has its cache disabled so a `$0` hit can never mask this rejection in the demo | P1 |
| 5.10 | First request of a month (no `budget_usage` row) | The row is created lazily with `INSERT ... ON CONFLICT DO NOTHING`; two concurrent first requests cannot both insert or both skip the check | P0 |
| 5.11 | Month rollover at the boundary | Period is computed once per request in UTC and used for both reserve and settle, so one request is charged to a single period | P1 |
| 5.12 | Budget exactly equals what is already spent | Not admitted (`spent + reserved < budget` is strict for admission) | P1 |
| 5.13 | Floating-point drift in cost math | Never use floats: integer-scaled arithmetic and `NUMERIC`; costs are exact multiples of `0.00000001` USD | P0 |
| 5.14 | Cost header precision vs. usage API | The header prints up to 8 decimals, so the sum of headers equals the API's `cost_usd` exactly (the load test compares these) | P0 |
| 5.15 | `monthly_budget_usd` is `0` or negative | Every request gets `402`; no negative-math surprises | P1 |
| 5.16 | Fallback model is pricier than the primary | Estimate is based on the primary; the settlement uses the actual model that served; documented as part of the overshoot bound | P1 |

---

## 6. Routing and the `auto` Classifier (Phases 5 and 7)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 6.1 | Short-but-hard prompts (`route_011/012/013/019/020`, e.g. "Prove that the square root of 2 is irrational.") | Classified complex → `smart` | P0 |
| 6.2 | Long-but-trivial prompts (`route_006/007/010`, roster lookup, log extraction) | Classified simple → `fast` | P0 |
| 6.3 | Empty or whitespace-only prompt | No crash; deterministic default (`fast`) with a logged reason | P1 |
| 6.4 | Multi-turn conversation | The classifier judges the last user message with structural features of the history; the input window is defined and bounded | P1 |
| 6.5 | Long system prompt with a trivial user message | The system prompt must not dominate the length signal | P1 |
| 6.6 | Non-English text, emoji, mixed scripts | No crash; accuracy may degrade — documented as a known limitation | P2 |
| 6.7 | Code blocks or math symbols in an otherwise easy question | Structural features raise difficulty without overriding the other signals blindly | P1 |
| 6.8 | Prompt near the decision threshold | Deterministic: the same prompt always gets the same route | P0 |
| 6.9 | Embedding model unavailable | Classifier falls back to structural features only; the request is still served | P1 |
| 6.10 | Very long prompt | Classification uses a bounded window of the prompt so it never dominates latency | P1 |
| 6.11 | Alias missing from, or inconsistent with, the config | Detected at startup (fail fast), not at request time | P0 |
| 6.12 | Fallback chain empty, a single entry, or containing duplicates | Validated at startup; each model is tried at most once per request; a chain with nothing left returns `502` | P1 |
| 6.13 | Every `auto` request | `route_reason` (chosen tier and why) is logged, and the log and headers show the resolved model rather than `auto` | P0 |
| 6.14 | Eval labels leaking into logic | `expected_tier` and the eval prompts are never used in exemplars, features or tuning; the eval is measurement only | P0 |
| 6.15 | Rejections after classification (budget `402`) | The log row still carries `route_reason` | P1 |

---

## 7. Semantic Cache (Phase 8)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 7.1 | Same paraphrase sent by two different keys | Second key must **miss**; every query is filtered by `key_id` (explicitly graded) | P0 |
| 7.2 | Concurrent identical prompts from different tenants | No cross-tenant read or write interleaving; entries are always written with the owner's `key_id` | P0 |
| 7.3 | Similar wording, different intent (`req_cache_a3`: 2FA reset vs. password reset) | Must miss; pair A (`a1`/`a2`) and pair B (`b1`/`b2`) must hit — thresholds are calibrated against all of them | P0 |
| 7.4 | Same last message but different earlier turns, system prompt, `temperature`, `max_tokens` or `top_p` | Miss: the context hash and sampling parameters must match exactly | P0 |
| 7.5 | Same prompt under a different alias/tier (`fast` vs. `smart`) | Miss: entries are scoped to the resolved alias | P1 |
| 7.6 | Key with cache disabled (`research`, `budget-demo`) | No lookup and no write; `x-prism-cache: miss` | P0 |
| 7.7 | Per-key thresholds (`search` 0.92, `free-tier` 0.85) | Each key uses its own threshold | P1 |
| 7.8 | Streaming request that would hit the cache | Replayed as an SSE stream (single content chunk, then `data: [DONE]`) with `x-prism-cache: hit` | P0 |
| 7.9 | Streaming miss: when to write the entry | Only after the stream completes successfully; partial/aborted streams are never cached | P0 |
| 7.10 | Error or failed provider response | Never cached | P0 |
| 7.11 | Time-sensitive prompt (`req_no_cache`: "current status of the payments service") | Never cached (documented keyword heuristic) | P1 |
| 7.12 | Fallback-served response | Cached like any other success; the original provider is recorded in the log | P1 |
| 7.13 | Embedding generation or cache DB fails | Treated as a miss; the request is still served; logged. The cache never fails a request | P0 |
| 7.14 | Two identical concurrent requests (stampede) | Both may miss and call the provider; acceptable, but writes must not create corrupt entries | P1 |
| 7.15 | Prompt longer than the embedding model's limit | Truncated consistently for both lookup and storage | P1 |
| 7.16 | Cache grows without bound | `expires_at` is available; eviction/TTL behavior is documented, or listed as a known limitation | P2 |
| 7.17 | `pgvector` extension or index missing | Startup check fails loudly instead of failing on the first request | P1 |
| 7.18 | Hit-rate calculation | One definition (hits ÷ cache-eligible requests, or hits ÷ all requests) used by both `/admin/cache/stats` and the console | P1 |
| 7.19 | Smoke test's first request with a salted prompt | Must be a `miss`; a false positive here means the threshold is too low | P0 |
| 7.20 | Embedding model cold start | Model is loaded and warmed at startup so the first request is not penalized | P1 |

---

## 8. Provider Adapter, Retry, and Failover (Phases 4 and 5)

Failure injection comes from the mocks' own `/admin/config` (`down`, `rate_limited`, `fail_rate`, `latency_ms`). The gateway has no debug toggle.

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 8.1 | Provider never responds / `latency_ms: 3000` | The per-call timeout fires; the gateway never hangs; the client gets a timely fallback response or a clean error | P0 |
| 8.2 | Retries × timeout × chain length exceeds what a client will wait | An overall request deadline caps the total time | P0 |
| 8.3 | Transient error (timeout, 5xx, connection reset) | Retry with exponential backoff (3 attempts, 200 ms, ×2, with jitter) | P0 |
| 8.4 | Provider `429` (`rate_limited` mode) | No retry; fail over immediately to the next provider in the chain | P0 |
| 8.5 | Non-transient provider 4xx (bad request, provider auth failure, unknown model at the provider) | No retry, no failover; mapped to `502 upstream_error` and logged | P1 |
| 8.6 | Provider `down` (every request `503`) | Retries exhausted, then failover; `x-prism-fallback: true`; logged as a fallback | P0 |
| 8.7 | Provider flaky (`fail_rate: 0.3`) | Retries absorb the failures; most requests succeed on the primary without a failover | P1 |
| 8.8 | All providers in the chain fail | `502 upstream_error` with the standard envelope, logged, nothing billed | P0 |
| 8.9 | Primary restored after being down | The next request goes to the primary again (every request tries the primary first) | P0 |
| 8.10 | Provider health tracking (Good To Have) | If built, a skipped provider is probed periodically so recovery is quick; per-instance state is a documented limitation | P2 |
| 8.11 | Mock flipped mid-request | In-flight requests complete or fail naturally; only new attempts see the new state | P1 |
| 8.12 | Mock admin ports exposed | The mocks are demo/test infrastructure; their `/admin/config` is for local use only and is not exposed beyond the Compose network except the demo ports | P1 |
| 8.13 | Provider reports usage but the body is malformed, or omits `usage`/`choices` | Treated as a failure; not billed; the gateway does not crash | P0 |
| 8.14 | Retry succeeded after a partial stream was already sent | Not allowed: retries and failover are only safe before the first byte reaches the client (§9) | P0 |
| 8.15 | `x-prism-fallback` when only a same-provider retry succeeded | Stays `false` — a retry is not a failover | P1 |
| 8.16 | Mock providers' determinism | The mocks' replies are deterministic per prompt, so failover and load tests are reproducible | P1 |
| 8.17 | Provider credentials in errors or logs | Never; provider error bodies are mapped to a gateway error, not forwarded raw | P0 |
| 8.18 | Provider returns a different model name than requested | Log and price the model the gateway resolved, not the provider's echo | P2 |
| 8.19 | One request counts as one RPM hit and one billed attempt | Even after a retry plus a failover; only the successful attempt is billed | P0 |
| 8.20 | Long upstream calls | Do not block unrelated requests (async I/O; embeddings in a worker thread) | P1 |

---

## 9. Streaming (Phase 6)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 9.1 | Client disconnects mid-stream | Abort the upstream call, release resources, log `client_disconnect`, bill delivered tokens as a flagged estimate | P0 |
| 9.2 | Provider dies mid-stream | Send a terminal SSE `error` event, then `data: [DONE]`, close the stream, log `upstream_error`; never switch provider or splice output | P0 |
| 9.3 | Failure before the first chunk | Safe to retry or fail over transparently — nothing has been sent, and headers were not sent yet | P0 |
| 9.4 | Failure after the first chunk | Never retried; see 9.2 | P0 |
| 9.5 | Slow client (backpressure) | Respect backpressure; never buffer the whole stream in memory | P0 |
| 9.6 | Final usage chunk missing | Metering still writes a row; tokens are estimated from delivered content and flagged `usage_estimated` | P0 |
| 9.7 | Headers on a stream | Headers are held until the first upstream chunk. `x-prism-provider`, `x-prism-cache` and `x-prism-fallback` are sent; `x-prism-cost-usd` is not required on streams — the final cost goes to the log and usage API | P0 |
| 9.8 | Proxy or intermediary buffering SSE | `Content-Type: text/event-stream`, `Cache-Control: no-cache`, buffering disabled; verified through the Docker network | P1 |
| 9.9 | `[DONE]` sent twice or not at all | Exactly once on every success path, including a cache replay and the error path | P0 |
| 9.10 | Empty stream (no tokens) | Valid terminal sequence; logs zero tokens | P1 |
| 9.11 | Long gap between tokens | A per-chunk idle timeout so a stalled provider cannot hold the connection forever | P1 |
| 9.12 | Many concurrent streams | No per-stream memory growth; connection limits documented | P1 |
| 9.13 | Cache write after a streamed miss | Happens after completion and must not delay the final chunk | P1 |
| 9.14 | Streaming honesty | Tokens arrive progressively (the mocks pace ~20 ms per token); an all-at-once arrival means buffering and is a failure | P0 |
| 9.15 | Streaming request rejected before streaming begins (401/403/429/402) | A normal JSON error response, not an SSE stream | P1 |

---

## 10. Metering, Request Logs, and Admin API (Phase 9)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 10.1 | Every code path logs exactly one row | Hit, miss, success, failure, fallback, stream, and each rejection (401/400/404/403/429/402/502/503) | P0 |
| 10.2 | Rejected before the key is known (401) | Row is written with a null `key_id`; the submitted value is not stored | P0 |
| 10.3 | Log write fails (DB down or slow) | Must not corrupt the client response; the failure is reported to stderr/metrics **(proposed)** | P0 |
| 10.4 | Budget settlement and the log row disagree | Both are written together so `budget_usage` always reconciles with `request_logs` | P0 |
| 10.5 | Model missing from the price table | Fails loudly at startup validation, never as a `NaN` cost at request time | P0 |
| 10.6 | Provider reports `0` tokens or omits usage | Treated as malformed; flagged rather than silently billed `0` | P1 |
| 10.7 | Price units | Prices are USD per **1M** tokens (`input_per_1m`, `output_per_1m`); the unit is explicit in the loader and the cost function | P0 |
| 10.8 | Cache-hit logging | `status = cache_hit`, `cache = hit`, cost `0`, resolved provider/model null | P1 |
| 10.9 | Latency definition | Total time as seen by the client; streams also record time to first token | P1 |
| 10.10 | `/admin/usage` for a key with no traffic | Returns zeros, not an error or `NaN` | P0 |
| 10.11 | `/admin/usage` for an unknown key | Clear error, not an empty success that hides typos | P1 |
| 10.12 | `/admin/usage` with no `key` | Returns every key's totals (needed by the console) | P1 |
| 10.13 | Usage window boundaries | `from` and `to` are inclusive on dates, in UTC; documented | P1 |
| 10.14 | Large `request_logs` table | `/admin/logs` is capped (`limit`), newest first; index on `(key_id, created_at)` | P1 |
| 10.15 | Concurrent writes for the same key | No lost updates; the usage API reconciles with the load test's client-side totals exactly | P0 |
| 10.16 | Timestamps and timezones | Stored in UTC; the console formats for display | P2 |
| 10.17 | Secrets in logs shown by the console | Never; no raw virtual keys, admin token or provider keys | P0 |
| 10.18 | Prompt/response body logging | Bodies are not logged (the minimal trace is metadata only); if that changes, retention and privacy are documented | P1 |

---

## 11. Concurrency, Persistence, and Infrastructure

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 11.1 | Postgres unavailable at startup | Gateway waits/retries; `/health` reflects dependency state | P1 |
| 11.2 | Postgres unavailable mid-request | Clean `5xx` error; no half-applied state | P0 |
| 11.3 | Connection pool exhausted under load | Bounded pool with a queue timeout; fails fast rather than hanging | P0 |
| 11.4 | Migrations run twice or concurrently (multiple instances) | Idempotent; guarded by a migration lock | P1 |
| 11.5 | `pgvector` extension missing | Startup fails with a clear message | P1 |
| 11.6 | Redis and Postgres disagree (RPM passed, budget failed) | The RPM hit is already counted — a rejected request still counts as a request; documented | P1 |
| 11.7 | Order of checks | Exactly as architecture §3.1; a request rejected early never touches later stages | P0 |
| 11.8 | Graceful shutdown with in-flight streams | Stop accepting new requests, let streams finish within a deadline, flush logs | P1 |
| 11.9 | Gateway restart mid-request | In-flight reservations must not leak budget permanently (see 5.7) | P0 |
| 11.10 | Config file missing or malformed at startup | Fail fast with a clear error; never start half-configured | P0 |
| 11.11 | Secrets handling | Provider credentials and the admin token come from the environment only; never logged, never in responses, never committed | P0 |
| 11.12 | Docker Compose startup ordering | Gateway waits for healthy Postgres, Redis and both mocks; the seed runs after migrations | P1 |
| 11.13 | Load test at high concurrency | No file-descriptor, memory or event-loop starvation; embeddings run off the main thread | P0 |
| 11.14 | Persistence | Keys, logs, usage and cache survive a gateway restart; only Redis windows reset | P0 |
| 11.15 | Single-instance assumptions | Provider health state (if built) is per instance; documented as a known limitation | P2 |

---

## 12. Decisions

### 12.1 Resolved

These were open earlier and are now decided, by the starter contract or by you.

| # | Decision | Resolution |
|---|---|---|
| D1 | How the budget is charged when the real cost is unknown at admission | Atomic reserve → settle; admit while budget remains; worst-case overshoot is one request's cost (architecture §4.3) |
| D2 | Billing for streams with no final usage chunk | Bill delivered tokens as a flagged estimate; bill `0` if nothing was delivered |
| D3 | Redis failure behavior for RPM | Fail closed with `503 service_unavailable` and a short timeout |
| D4 | Cache hit vs. exhausted budget | The budget gate runs before the cache, so the request is rejected; the demo key has its cache disabled |
| D5 | What the cache key covers | `key_id`, resolved alias, exact context hash and sampling parameters, similarity on the last user message |
| D6 | Allowlist vs. `auto` | The chosen tier must be allowed; downgrade to `fast` if needed, else `403` |
| D7 | Retry or failover on non-transient provider errors | Transient errors retry then fail over; provider `429` fails over immediately; other 4xx → `502`, no retry |
| D8 | Cost on streaming responses | Not sent as a header on streams (not required); final cost goes to the log and usage API |
| D9 | Log row for unauthenticated requests | Logged with a null key |
| D10 | Access model for the admin API and console | One demo admin token in `x-admin-token`; virtual keys do not work on admin routes |
| D11 | Overall request deadline | Per-attempt timeouts below one overall request deadline |
| D12 | Debug/health-toggle endpoint | Not built; failure injection uses the mocks' own `/admin/config` |
| D13 | Rate limiter algorithm | Redis sliding window via a Lua script (not a fixed window) |
| D14 | Cache on streaming hit | Replayed as an SSE stream: one content chunk plus `[DONE]` |
| D15 | Mid-stream failure | Error event, then `[DONE]`; never splice providers |
| D16 | Provider recovery | Primary tried first on every request; health tracking is Good To Have |

### 12.2 Still proposed

| # | Item | Related cases | Default |
|---|---|---|---|
| P1 | Reconciliation of stale reservations after a crash | 5.7, 11.9 | Clear reservations older than the request deadline at startup and periodically |
| P2 | Behavior on unsupported OpenAI parameters | 1.7 | Pass through where supported, otherwise reject clearly |
| P3 | Behavior when the request-log write fails | 10.3 | Do not fail the client response; emit an error metric |
| P4 | Time-sensitive prompt heuristic | 7.11 | A small keyword list (`current`, `now`, `today`, `latest`, `status`) |

---

## 13. Coverage Map

Where each edge-case group is verified, so nothing here is untested.

| Section | Built in phase | Verified by (see `eval.md`) |
|---|---|---|
| 1. Request validation | 2 | E1, E2 |
| 2. Authentication | 2 | E2 |
| 3. Allowlist | 3 | E2 |
| 4. Rate limiting | 3 | E2, E3 |
| 5. Budget guard | 3, 9 | E3, E4 |
| 6. Routing and `auto` | 5, 7 | E6, E7 |
| 7. Semantic cache | 8 | E8 |
| 8. Adapter, retry, failover | 4, 5 | E7, E12 |
| 9. Streaming | 6 | E5, E7 |
| 10. Metering, logs, admin API | 9 | E4, E9, E10 |
| 11. Concurrency and infrastructure | 0, 1, 3, 9 | E3, E4, E12, E13 |
