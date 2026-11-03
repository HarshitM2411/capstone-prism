# Prism — Edge Cases

**Based on:** [`docs/architecture.md`](architecture.md) and [`docs/implementation-plan.md`](implementation-plan.md). Requirements come from [`docs/context.md`](context.md) / `docs/PS1.pdf`. Verification of these cases is planned in [`docs/eval.md`](eval.md).

This document lists the edge cases each component must handle, the **expected behavior**, and the phase where it gets built and tested. Many of these are exactly where gateways fail under review — concurrency, streaming, failover, and tenant isolation — so they are worth deciding up front.

**How to read the "Expected behavior" column**

- Behavior stated in the architecture or plan is written as-is.
- Behavior marked **(proposed)** is not specified in the architecture; it is a recommended decision that needs your confirmation before coding. These are collected in [§12](#12-decisions-needed).

**Priority:** `P0` = explicitly graded or correctness-critical, `P1` = important robustness, `P2` = nice to have.

---

## 1. Request Validation (HTTP Layer — Phase 2)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 1.1 | Malformed JSON body | `400` with an OpenAI-style error envelope; no auth, rate, or budget side effects **(proposed)** | P1 |
| 1.2 | Missing `messages`, empty `messages` array, or missing `model` | `400` validation error from the Fastify schema, before anything else runs | P1 |
| 1.3 | Unknown `model` value (not `fast`, `smart`, `auto`, and not a configured model) | Clear error; must not fall through to a provider **(proposed: `400`/`404`-style code)** | P1 |
| 1.4 | `stream` is a non-boolean (e.g. `"true"`) | `400` validation error **(proposed)** | P2 |
| 1.5 | Extremely large prompt or body | Rejected by a body-size limit before embedding or provider calls **(proposed)** | P1 |
| 1.6 | Valid request but invalid/missing key | `401 invalid_api_key` — auth ordering vs. validation must be consistent **(proposed: validate shape first, as architecture §4.1 says)** | P1 |
| 1.7 | Unsupported OpenAI params (`tools`, `n > 1`, `logprobs`, etc.) | Either pass through where the adapter supports them or reject clearly; never silently drop **(proposed)** | P2 |
| 1.8 | Non-text content (image parts, empty strings, only-whitespace content) | Defined behavior; embedding and classifier must not crash on empty input **(proposed)** | P1 |

---

## 2. Authentication (Phase 2)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 2.1 | Missing `Authorization` header | `401 invalid_api_key` | P0 |
| 2.2 | Wrong scheme (`Basic` instead of `Bearer`), extra whitespace, empty bearer token | `401 invalid_api_key` | P1 |
| 2.3 | Key differs from a valid key by one character or case | `401`; lookup is by hash, so no partial matching | P1 |
| 2.4 | Very long or binary-garbage key | `401`, no crash, no unbounded work | P1 |
| 2.5 | Timing differences between "unknown key" and "known key, wrong state" | Compare hashes in constant time where practical **(proposed)** | P2 |
| 2.6 | Key value or hash appears in logs or error messages | Never. Logs store the key id, not the raw key | P0 |
| 2.7 | Seed keys reloaded (re-seeding on restart) | Idempotent; exact key values and alias names preserved; no duplicates | P0 |
| 2.8 | Key row exists but its policy fields are null/invalid (e.g. no allowlist, `rpm_limit = 0`) | Defined, safe default; `rpm_limit = 0` must not mean "unlimited" by accident **(proposed)** | P1 |

---

## 3. Model Allowlist (Phase 3)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 3.1 | Alias is allowed but the resolved model is not (or vice versa) | Check against the **resolved model** (architecture §6: "allowlist doesn't include resolved model") → `403 model_not_allowed` | P0 |
| 3.2 | `auto` resolves to `smart` but the key only allows `fast` | `403 model_not_allowed` after classification — or the classifier is constrained to allowed models. **Decision needed** | P0 |
| 3.3 | Fallback chain includes a model the key does not allow | Failover must skip non-allowed models rather than silently using one **(proposed)** | P0 |
| 3.4 | Empty allowlist | Treated as "allow nothing" or "allow all" — must be explicit and documented | P1 |
| 3.5 | Allowlist rejection must not consume RPM or budget | Allowlist is checked before any charge; rejection costs nothing | P1 |

---

## 4. Rate Limiting — RPM (Phase 3)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 4.1 | N+M parallel requests when only N slots remain | Exactly N admitted, M get `429`; atomic `INCR` guarantees no over-admission | P0 |
| 4.2 | Requests straddling a minute boundary | Fixed-window behavior is documented: a burst of up to 2× the limit across a boundary is a known property of fixed windows | P1 |
| 4.3 | `INCR` succeeds but `EXPIRE` fails or the process crashes between them | Counter would never expire. Use an atomic Lua script or set TTL only when the counter value is 1 and verify; ensure the key always gets a TTL **(proposed)** | P0 |
| 4.4 | Redis is unavailable or slow | Decide fail-open vs. fail-closed, with a timeout on the Redis call. Fail-closed is safer for cost; fail-open is safer for availability **(decision needed)** | P0 |
| 4.5 | Redis is flushed or restarted | Windows reset; accepted behavior per architecture ("losing it just resets rate windows") | P1 |
| 4.6 | Multiple gateway instances | Counters live in Redis, so the limit is shared across instances | P0 |
| 4.7 | Two different keys with identical traffic | Counters are independent per `keyId` | P1 |
| 4.8 | Retry or failover inside one client request | Counts as **one** RPM hit (plan Phase 5) | P0 |
| 4.9 | Client retries after receiving `429` | Each client retry is a new request and counts; no `Retry-After` is required by the spec, but returning it is helpful **(proposed)** | P2 |
| 4.10 | Cache-hit requests | Still count toward RPM (they are requests) — confirm intent **(proposed)** | P1 |
| 4.11 | Clock skew between gateway instances | Minute bucket derived from one source (Redis `TIME` or consistent app clock) **(proposed)** | P2 |

---

## 5. Budget Guard (Phase 3, Phase 9)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 5.1 | Parallel requests that together exceed the budget | Conditional `UPDATE` serializes on the row; exactly the affordable ones succeed; the rest get `402` | P0 |
| 5.2 | Cost is unknown before the call (completion tokens not yet known) | The conditional update needs a cost. Options: reserve an estimated max cost up front and settle afterward, or charge after the response. Over-admission risk depends on this choice **(decision needed)** | P0 |
| 5.3 | Reserved cost differs from actual cost | Reconcile: refund the difference, or record exact cost; `spent_usd` must equal the sum of `request_logs.cost_usd` | P0 |
| 5.4 | Request fails after budget was reserved | Reservation is released; failed attempts are not billed (plan Phase 5) | P0 |
| 5.5 | Streaming request whose final usage chunk never arrives (client disconnect, provider dies mid-stream) | Define billing: bill tokens actually streamed, bill the estimate, or bill nothing **(decision needed)** | P0 |
| 5.6 | No `budget_usage` row exists yet for this key and period (first request of the month) | Row is created atomically (`INSERT ... ON CONFLICT`); two concurrent first requests must not both insert or both skip the check | P0 |
| 5.7 | Month rollover at the boundary (e.g. 23:59:59 → 00:00:00) | Period computed once per request; request is charged to a single, consistent period; timezone is defined (UTC) **(proposed)** | P1 |
| 5.8 | Budget exactly equals the cost of the request | `spent + cost <= budget` allows it (≤, not <) | P0 |
| 5.9 | Cost is `0` (cache hit) when the key is already at its cap | Allowed or rejected? A cache hit costs nothing, but the architecture checks budget before cache. **Decision needed** | P1 |
| 5.10 | Floating-point drift in cost math | Use integer micro-dollars or `NUMERIC` in Postgres; never accumulate JS floats | P0 |
| 5.11 | Very small costs (sub-cent) rounding to zero | Keep full precision in storage; round only for display | P1 |
| 5.12 | `monthly_budget_usd` is `0` or negative | Every request gets `402`; no negative-math surprises | P1 |

---

## 6. Routing and the `auto` Classifier (Phases 5, 7)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 6.1 | Short-but-hard prompt (e.g. "Prove P≠NP") | Classified as hard → `smart` (spec trap) | P0 |
| 6.2 | Long-but-trivial prompt (e.g. "hello" repeated many times) | Classified as easy → `fast` (spec trap) | P0 |
| 6.3 | Empty or whitespace-only prompt | No crash; deterministic default (e.g. `fast`) **(proposed)** | P1 |
| 6.4 | Multi-turn conversation: difficulty depends on the last message vs. the whole history | Classifier input is defined (e.g. last user message plus structural features of the history) **(proposed)** | P1 |
| 6.5 | System prompt is long but the user message is trivial | System prompt should not dominate the length signal **(proposed)** | P1 |
| 6.6 | Non-English text, emoji, mixed scripts | No crash; embedding model handles it; accuracy may degrade — document as a known limitation | P2 |
| 6.7 | Code blocks or math symbols inside an otherwise easy question | Structural features raise difficulty without overriding other signals blindly | P1 |
| 6.8 | Prompt near the decision threshold | Deterministic: the same prompt always gets the same route | P0 |
| 6.9 | Embedding model failed to load or errors | Classifier falls back to structural features only; request is still served **(proposed)** | P1 |
| 6.10 | Classifier is slow on a long prompt | Truncate the input to the embedding model's max tokens; classification must not dominate latency **(proposed)** | P1 |
| 6.11 | Alias present in request but missing from `gateway_config.sample.json` | Config error surfaced at startup, not at request time **(proposed)** | P1 |
| 6.12 | Fallback chain is empty or has one entry | Valid; failover with nothing left returns a clean error | P1 |
| 6.13 | Fallback chain contains a cycle or duplicates | Validated at startup; each model is tried at most once per request | P1 |
| 6.14 | `auto` result must be reported | Log and headers show the resolved model, not just `auto` | P1 |

---

## 7. Semantic Cache (Phase 8)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 7.1 | Same paraphrase sent by two different keys | Second key must **miss**; every query filtered by `key_id` (explicitly graded) | P0 |
| 7.2 | Concurrent identical prompts from different tenants | No cross-tenant read or write interleaving; entries always written with the owner's `key_id` | P0 |
| 7.3 | Similar wording but a different meaning (e.g. "list the pros of X" vs. "list the cons of X") | Threshold tuning must avoid false hits; report the threshold and test negatives | P0 |
| 7.4 | Same question but different parameters (`temperature`, `max_tokens`, system prompt, model alias) | Cache key must account for anything that changes the answer, or this is a documented limitation **(decision needed)** | P0 |
| 7.5 | Same prompt, different alias (`fast` vs. `smart`) | Should a `fast` answer serve a `smart` request? **Decision needed**; recommended: scope by resolved model/alias **(proposed)** | P1 |
| 7.6 | Streaming request that would hit the cache | Cached response is replayed as an SSE stream (with `[DONE]`), not returned as plain JSON | P0 |
| 7.7 | Streaming miss: when to write the cache entry | Only after the stream completes successfully; a partial/aborted stream is never cached | P0 |
| 7.8 | Failed or errored provider response | Never cached | P0 |
| 7.9 | Fallback-served response | Cached like any other success, but the original provider/fallback info is recorded accurately | P1 |
| 7.10 | Embedding generation fails | Treat as a cache miss and continue to the provider; log it. Never fail the request because of the cache **(proposed)** | P0 |
| 7.11 | Two identical concurrent requests (cache stampede) | Both may miss and both call the provider; acceptable, but writes must not create corrupt duplicates **(proposed: dedupe or tolerate)** | P1 |
| 7.12 | Very long prompt exceeding the embedding model's input limit | Truncate consistently for both lookup and storage | P1 |
| 7.13 | Cache grows without bound | Define a TTL or size cap, or document it as a known limitation **(proposed)** | P2 |
| 7.14 | Stale cached answer | TTL or documented limitation; the spec does not require invalidation | P2 |
| 7.15 | Cache hit under a key whose budget is exhausted or whose allowlist excludes the model | Follows the pipeline order: auth, rate/budget, route, then cache. See 5.9 | P1 |
| 7.16 | pgvector index missing or the extension not enabled | Startup check fails loudly instead of failing on the first request | P1 |
| 7.17 | Hit-rate calculation | Denominator is defined (all requests vs. cache-eligible requests) and consistent between the API and the console | P1 |

---

## 8. Provider Adapter, Retry, and Failover (Phases 4, 5)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 8.1 | Provider never responds | Adapter-boundary timeout fires; the gateway never hangs | P0 |
| 8.2 | Timeout vs. total request budget | Per-attempt timeout times retries times the chain length could exceed what a client will wait; define an overall deadline **(proposed)** | P0 |
| 8.3 | Transient error (timeout, 5xx, connection reset) | Retry with exponential backoff up to a small max | P0 |
| 8.4 | Non-transient error (400/401/403 from provider, content policy) | No retry; decide whether to fail over or return the error to the client **(decision needed)** | P1 |
| 8.5 | Provider returns `429` | Treated as transient or as a trigger for failover (architecture's sequence diagram lists "rate-limited" as a failover trigger) | P1 |
| 8.6 | Backoff has no jitter | Synchronized retries can hammer a recovering provider; add jitter **(proposed)** | P2 |
| 8.7 | All providers in the chain fail | Clean error to the client (e.g. `502`/`503`-style, OpenAI-style envelope), logged, nothing billed | P0 |
| 8.8 | Primary is known-down (circuit state) | Skipped directly on subsequent requests until it recovers (plan Phase 5) | P0 |
| 8.9 | Circuit state: when does a down provider get retried? | Define a cool-down or half-open probe so recovery is detected; otherwise a provider is skipped forever **(proposed)** | P0 |
| 8.10 | Circuit state is per-instance in memory | Multiple gateway instances may disagree; acceptable for this scope, document as a limitation | P2 |
| 8.11 | Health-toggle flips mid-request | In-flight request completes or fails naturally; only new attempts see the new state | P1 |
| 8.12 | Health-toggle endpoint exposed in production | Must be gated (disabled outside demo/test or behind an admin credential) **(proposed)** | P0 |
| 8.13 | Both primary and fallback degraded (slow but not failing) | Timeouts bound the delay; failover on timeout, not only on hard errors | P1 |
| 8.14 | Provider reports usage but the response body is malformed | Treat as failure; do not bill | P1 |
| 8.15 | Retry succeeded after a partial streamed response was already sent | See 9.3; retries are only safe before the first byte is sent to the client | P0 |
| 8.16 | `x-prism-fallback` semantics when only a retry (same provider) succeeded | Not a failover; flag stays false | P1 |
| 8.17 | Mock provider non-determinism | Mocks must be deterministic so failover and load tests are reproducible | P1 |
| 8.18 | Provider credentials in errors | Provider error bodies must never leak keys or internal URLs to the client | P0 |
| 8.19 | Provider returns a model name different from what was requested | Log the resolved model that was priced, not the provider's echo **(proposed)** | P2 |

---

## 9. Streaming (Phase 6)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 9.1 | Client disconnects mid-stream | Abort the upstream request, stop reading, release resources; log a row with a defined status and partial tokens **(decision: see 5.5)** | P0 |
| 9.2 | Provider dies mid-stream | Send a terminal error event or close cleanly; cannot switch headers after sending; log failure | P0 |
| 9.3 | Failure before the first chunk | Safe to retry or fail over transparently, since nothing has been sent | P0 |
| 9.4 | Failure after the first chunk | Cannot fail over without duplicating or corrupting output; terminate with an error and log it **(proposed)** | P0 |
| 9.5 | Slow client (backpressure) | Respect backpressure; do not buffer the whole stream in memory | P0 |
| 9.6 | Missing final usage chunk | Metering still produces a row; fall back to an estimate or flag it as unknown (see 5.5) | P0 |
| 9.7 | `x-prism-*` headers on a stream | Headers are sent before the body, so values known only at the end (final cost) cannot be in headers. Decide how cost is reported for streams **(decision needed)** | P0 |
| 9.8 | Proxy or intermediary buffering SSE | Set `Cache-Control: no-cache` and disable buffering headers; test through the Docker network | P1 |
| 9.9 | `[DONE]` sent twice or not at all | Exactly once, always, on every success path including cache replay | P0 |
| 9.10 | Empty stream (provider returns no tokens) | Valid terminal sequence; log zero tokens | P1 |
| 9.11 | Idle connection / long gap between tokens | Per-chunk idle timeout so a stalled provider cannot hold the connection forever | P1 |
| 9.12 | Many concurrent streams | No per-stream memory growth; connection limits documented | P1 |
| 9.13 | Streaming a response that triggered a cache write | Cache write happens after completion and must not delay the final chunk to the client | P1 |

---

## 10. Metering and Request Logs (Phase 9)

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 10.1 | Every code path logs exactly one row | Hit, miss, success, failure, fallback, and each rejection (401/403/429/402) all produce one row | P0 |
| 10.2 | Rejected request before key is known (401) | There is no `key_id`; the log row needs a nullable key or a separate treatment **(decision needed)** | P0 |
| 10.3 | Log write fails (DB down or slow) | Must not corrupt the client response; decide whether logging is awaited or queued **(proposed)** | P0 |
| 10.4 | Log written but budget update failed, or the reverse | Both happen in one transaction so `budget_usage` always reconciles with `request_logs` | P0 |
| 10.5 | Unknown model in the price table | Fail loudly at startup validation, not with a `NaN` cost at request time | P0 |
| 10.6 | Provider reports `0` tokens or omits usage | Defined handling: cost `0` is suspicious; log a flag and fall back to an estimate **(proposed)** | P1 |
| 10.7 | Price per 1K vs. per 1M tokens | Units are explicit in the code and the price table loader | P0 |
| 10.8 | Cache hit logging | `cache = hit`, cost `$0`, latency measured from request start | P1 |
| 10.9 | Latency definition | Defined once (total time vs. time to first token for streams) and used consistently | P1 |
| 10.10 | Usage API for a key with no traffic | Returns zeros, not an error or `NaN` (division by zero in hit rate) | P0 |
| 10.11 | Usage API for an unknown key | `404`-style error, not an empty success that hides typos **(proposed)** | P1 |
| 10.12 | Usage API authorization | A tenant can only read its own usage unless an admin credential is used; the console needs a defined access model **(decision needed)** | P0 |
| 10.13 | Large `request_logs` table | `GET /v1/requests` is paginated or capped; index on `created_at` and `key_id` | P1 |
| 10.14 | Concurrent writes to the same key's usage | No lost updates; usage totals reconcile exactly (plan Phase 9) | P0 |
| 10.15 | Timestamps and timezones | Stored in UTC; the console formats for display | P2 |

---

## 11. Concurrency, Persistence, and Infrastructure

| # | Edge case | Expected behavior | Priority |
|---|---|---|---|
| 11.1 | Postgres unavailable at startup | Gateway waits or retries; `/health` reflects dependency state **(proposed)** | P1 |
| 11.2 | Postgres unavailable mid-request | Clean `5xx` error; no half-applied state | P0 |
| 11.3 | Postgres connection pool exhausted under load | Bounded pool with queue timeout; fails fast rather than hanging | P0 |
| 11.4 | Migrations run twice or concurrently (multiple instances) | Idempotent; guarded by a migration lock | P1 |
| 11.5 | `pgvector` extension missing | Startup fails with a clear message | P1 |
| 11.6 | Redis and Postgres disagree (e.g. RPM passed but budget failed) | The RPM hit is already counted; acceptable — a rejected request still counts as a request. Document it | P1 |
| 11.7 | Order of checks | Auth → allowlist → RPM → budget as architecture §3 describes; a request rejected early never touches later stages | P1 |
| 11.8 | Graceful shutdown with in-flight streams | Stop accepting new requests, let streams finish within a deadline, flush logs | P1 |
| 11.9 | Gateway restart mid-request | In-flight reservation (see 5.2) must not leak budget permanently | P0 |
| 11.10 | Config file missing or malformed at startup | Fail fast with a clear error; do not start half-configured | P0 |
| 11.11 | Secrets handling | Provider credentials only from environment; never logged, never in responses, never committed | P0 |
| 11.12 | Docker Compose startup ordering | Gateway waits for healthy Postgres/Redis; seed runs after migrations | P1 |
| 11.13 | Load test at high concurrency | No file-descriptor, memory, or event-loop starvation; the embedding model must not block the event loop (run it off the main thread or batch it) **(proposed)** | P0 |
| 11.14 | Embedding model cold start | First request after boot is slow; warm the model at startup so the first user request is not penalized **(proposed)** | P1 |

---

## 12. Decisions Needed

These are the places where the architecture is silent and the answer changes the implementation. Recommended defaults are listed so you can confirm quickly.

| # | Decision | Related cases | Recommended default |
|---|---|---|---|
| D1 | How the budget is charged when the real cost is unknown at admission time | 5.2, 5.3, 5.4 | Reserve an estimated maximum cost atomically, then settle to the actual cost and refund the difference; release on failure |
| D2 | Billing for streams that end without a final usage chunk | 5.5, 9.6 | Bill tokens actually delivered if known, otherwise a flagged estimate; never bill zero silently |
| D3 | Redis failure behavior for RPM | 4.4 | Fail closed with a short timeout (protects cost); log loudly |
| D4 | Whether cache hits are subject to the budget check | 5.9, 7.15 | Cost is `$0`, so allow a hit even when the budget is exhausted — but only after auth, allowlist, and RPM pass |
| D5 | What the cache key covers | 7.4, 7.5 | Scope by key and resolved model; include a hash of non-default sampling parameters; document the rest |
| D6 | Allowlist vs. `auto` | 3.2, 3.3 | Classifier picks among the models the key is allowed to use; otherwise `403` |
| D7 | Retry or failover on non-transient provider errors | 8.4 | Do not retry; fail over only for 5xx, timeout, connection errors, and provider `429` |
| D8 | How to report cost on streaming responses (headers are sent first) | 9.7 | Put the final cost in the log and usage API; send the other three headers up front, and add the cost as an SSE trailer or comment only if it is cheap to do |
| D9 | Log row for unauthenticated requests | 10.2 | Log with a null `key_id` and the rejection reason |
| D10 | Access model for the usage API and console | 10.12 | Per-key read with the virtual key; an admin credential for the console |
| D11 | Overall request deadline across retries and failover | 8.2 | One total deadline per request, with per-attempt timeouts below it |
| D12 | Debug/health-toggle endpoint exposure | 8.12 | Enabled only when an environment flag is set, with a shared secret |

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
| 6. Routing and `auto` | 5, 7 | E6 |
| 7. Semantic cache | 8 | E8 |
| 8. Adapter, retry, failover | 4, 5 | E7, E12 |
| 9. Streaming | 6 | E5, E7 |
| 10. Metering and logs | 9 | E4, E9, E10 |
| 11. Concurrency and infrastructure | 0, 1, 3, 9 | E3, E4, E12, E13 |
