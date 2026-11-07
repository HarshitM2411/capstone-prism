# Prism — Verification Report

All numbers below come from real runs against the Docker Compose stack (gateway, console, Postgres with
`pgvector`, Redis, and the two starter mock providers `alpha` and `beta`) on 7 November 2026, unless
marked otherwise. Raw outputs are kept in [`docs/verification/`](verification/) so every claim can be
checked.

| What | How it was produced | Raw output |
| --- | --- | --- |
| Automated tests, lint, types, format | `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `vitest run` in `apps/gateway` | [`test_suite.txt`](verification/test_suite.txt) |
| Starter smoke test | `scripts/smoke_test.py` | [`smoke_test.txt`](verification/smoke_test.txt) |
| Starter load test | `scripts/load_test.py` | [`load_test.txt`](verification/load_test.txt), [`load_usage_api.json`](verification/load_usage_api.json) |
| Routing eval | `pnpm routing:eval --set both` | [`routing_eval.json`](verification/routing_eval.json), [`routing_eval_summary.txt`](verification/routing_eval_summary.txt) |
| Cache pairs | the starter's `sample_requests.jsonl` through the live gateway | [`cache_pairs.txt`](verification/cache_pairs.txt) |
| Failure drill | mock providers' `/admin/config` | [`failure_drill.txt`](verification/failure_drill.txt) |
| Gateway overhead | `scripts/measure_overhead.py` | [`latency_overhead.txt`](verification/latency_overhead.txt) |

## 1. Automated checks

- 39 test files, **823 tests, all passing** (unit, in-process HTTP, and integration tests against real
  Postgres and Redis). This includes the accounting checks described in §3.
- ESLint, `tsc` type-check for gateway, console and shared types, and Prettier: all clean.

## 2. Smoke test (`scripts/smoke_test.py`, unmodified)

```
python scripts/smoke_test.py --url http://localhost:8080 --key prism-sk-search-1a2b3c --model fast
  17 passed, 1 warnings, 0 failed
```

**The one WARN: pair B** (`req_cache_b1` "What is the refund policy for annual plans?" vs `req_cache_b2` "If I
bought an annual plan, can I get my money back?"). Its cosine similarity with the chosen embedding model is
about 0.68 to 0.77 (measured over 150 random smoke-test salts), while the near-miss that must _not_ hit
(`req_cache_a3`, the two-factor reset) scores about 0.74 against pair A's first prompt. No single threshold
can both accept pair B and reject `a3`, so the threshold favours correctness (a wrong cached answer is worse
than a provider call). Pair A hits every time (0.94 to 0.97). The smoke test treats each pair as soft and
requires one to hit, which is satisfied.

**Run the smoke test on a fresh cache.** The test prefixes every prompt with a random 8-hex-digit salt "to keep
this run out of any earlier cache", but a semantic cache barely notices such a prefix: `(14e846a6) What is a load
balancer?` and `(a766de99) What is a load balancer?` are near-duplicates, so a second run is served by the first
run's entries. We saw exactly this (a second run got hits on its "unrelated prompt" and a miss on pair A, because
earlier manual requests had stored near-duplicates). This is correct cache behaviour, not a bug, but it means
repeated runs should be preceded by `docker compose exec postgres psql -U prism -d prism -c "DELETE FROM cache_entries"`
(or by waiting for the TTL). The output above is from a clean cache.

## 3. Load test and accounting reconciliation

```
python scripts/load_test.py --url http://localhost:8080 --key prism-sk-free-7g8h9i --model fast \
  --requests 30 --concurrency 10 --rpm-limit 10

  accepted (200):      10
  rate limited (429):  20
  latency avg/p95 ms:  206 / 250
  accepted requests:   10      prompt tokens: 120      completion tokens: 261
  sum of cost headers: 0.000158 USD (10 of 10 had a numeric header)
  Over-admission check OK: 10 accepted <= limit 10.
```

**Zero over-admission:** exactly 10 of 30 concurrent requests were admitted, 20 got `429`.

Usage API for the same key and window (`GET /admin/usage?key=free-tier&from=<burst start>`):

| | Client side (load test) | `/admin/usage` | Match |
| --- | --- | --- | --- |
| Requests | 10 accepted + 20 rate limited = 30 | `requests: 30` (`served: 10`, `rejected: 20`) | exact |
| Prompt tokens | 120 | 120 | exact |
| Completion tokens | 261 | 261 | exact |
| Cost | 0.000158 (script rounds to 6 places) | `0.00015780` | exact |

Cache hits are included on both sides: a hit reports the stored answer's usage to the client and logs the same
numbers at zero cost, so token totals add up to what clients saw while the cost only counts provider calls.

The same reconciliation is automated against Postgres and Redis (`apps/gateway/test/integration/metering.test.ts`):
a mixed batch of hits, misses, fallbacks, streams, upstream failures and rejections; 60 concurrent requests on
one key (12 of them streamed) where `budget_usage.spent_usd`, the sum of `request_logs.cost_usd`, the usage API
and the sum of the cost headers are equal to the last digit; and the full pipeline (`auto` → miss → retry →
failover → stream → cache hit). The test is repeated and stable.

## 4. Routing evaluation (`model: "auto"`)

**Method.** The classifier adds two parts: weighted regex signals on a bounded window of the prompt (opening
sentence plus final instruction) and the similarity to the mean of 20 simple and 20 complex reference prompts
using the local embedding model. It scores the difficulty and routes `simple` to `fast` and `complex` to
`smart`. It was tuned on our own 80-case development set, not on the provided file, which is used only to
measure. The baseline is a length-only rule (a prompt longer than 150 characters is complex).

| Set | Classifier | Length-only baseline |
| --- | --- | --- |
| Provided `data/routing_eval.jsonl` (20 cases) | **20 / 20 (100%)** | 9 / 20 (45%) |
| Our development set (80 cases, tuning) | 79 / 80 (98.8%) | 36 / 80 (45%) |

Per case on the provided set (`reason` is the logged `route_reason`: the score, the signals and the embedding
term):

| Case | Expected | Actual | Correct | Baseline | Baseline correct | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| route_001 | fast | fast | yes | fast | yes | score -2.54 < 1.00; -short-definition; embed -0.29 |
| route_002 | fast | fast | yes | fast | yes | score -3.33 < 1.00; -transform; embed -0.29 |
| route_003 | fast | fast | yes | fast | yes | score -3.26 < 1.00; -transform -short-writing; embed -0.12 |
| route_004 | fast | fast | yes | fast | yes | score -1.84 < 1.00; -meaning; embed -0.11 |
| route_005 | fast | fast | yes | fast | yes | score -3.31 < 1.00; -transform; embed -0.29 |
| route_006 | fast | fast | yes | smart | no | score -0.84 < 1.00; embed -0.19 |
| route_007 | fast | fast | yes | smart | no | score -0.58 < 1.00; embed -0.14; long prompt: final instruction judged |
| route_008 | fast | fast | yes | fast | yes | score -2.44 < 1.00; -transform; embed -0.16 |
| route_009 | fast | fast | yes | fast | yes | score -2.22 < 1.00; -yes-no; embed -0.24 |
| route_010 | fast | fast | yes | smart | no | score -2.57 < 1.00; -transform; embed -0.19 |
| route_011 | smart | smart | yes | fast | no | score 2.72 >= 1.00; +proof; embed +0.05 |
| route_012 | smart | smart | yes | fast | no | score 3.55 >= 1.00; +estimate +reasoning; embed +0.05 |
| route_013 | smart | smart | yes | fast | no | score 5.75 >= 1.00; +expert-topic +why +multi-part; embed +0.31 |
| route_014 | smart | smart | yes | fast | no | score 5.21 >= 1.00; +design +compare; embed +0.35 |
| route_015 | smart | smart | yes | fast | no | score 5.23 >= 1.00; +reasoning +compare +multi-part; embed +0.25 |
| route_016 | smart | smart | yes | fast | no | score 3.45 >= 1.00; +build-code +explain-deep +multi-part +expert-topic; embed -0.03 |
| route_017 | smart | smart | yes | smart | yes | score 4.07 >= 1.00; +expert-topic; embed +0.30 |
| route_018 | smart | smart | yes | fast | no | score 4.32 >= 1.00; +design +multi-part; embed +0.30 |
| route_019 | smart | smart | yes | smart | yes | score 5.32 >= 1.00; +diagnose +expert-topic +multi-part; embed +0.26 |
| route_020 | smart | smart | yes | fast | no | score 2.60 >= 1.00; +proof; embed +0.02 |

**Misses.** None on the provided set. The one development miss, `dev_s30` ("trap: long input, trivial lookup"),
is a long prompt containing design-flavoured words around a trivial lookup, scored `smart`; that is a known
weakness of keyword signals. The classifier never fails a request: if the model is not ready it routes on the structural signals alone and says so in the reason.

## 5. Semantic cache: threshold, embedding model and the sample pairs

- **Embedding model:** `Xenova/all-MiniLM-L6-v2`, 8-bit quantised, 384 dimensions, run locally in a worker
  thread and baked into the Docker image (no network at runtime, no cost).
- **Similarity:** cosine, on the last user message only; everything else that shapes an answer (earlier turns,
  system prompt, sampling parameters) must match exactly through a hash. Lookups are scoped by key and tier and
  always filter by tenant in SQL.
- **Thresholds:** per key from the seed data (`search` 0.92, `free-tier` 0.85; `research` and `budget-demo` off).

Live result with the starter's own prompts on a clean cache, `search` key (threshold 0.92):

```
req_cache_a1   miss   first ask
req_cache_a2   hit    paraphrase of a1                 (similarity about 0.95)
req_cache_a3   miss   similar words, different intent  (about 0.74, below 0.92)
req_cache_b1   miss   first ask
req_cache_b2   miss   paraphrase of b1                 (about 0.68: the documented deviation)
req_no_cache   miss   time-sensitive, never stored
req_cache_a1   hit    exact repeat
```

## 6. Failure drill (live, `research` key, alias `fast`, primary `alpha`, fallback `beta`)

| Step (mock `alpha` config) | Result |
| --- | --- |
| normal | `200`, `alpha/alpha-small`, `x-prism-fallback: false`, 17 to 38 ms |
| `{"mode":"down"}` | 3 of 3 `200`, `beta/beta-small`, `x-prism-fallback: true`, about 0.7 s (3 attempts on alpha with 200 ms and 400 ms backoff, then beta) |
| `{"latency_ms": 3000}` | 3 of 3 `200`, `beta/beta-small`, `x-prism-fallback: true`, about **6.6 s** each: the 2 s first-byte timeout is hit and retried three times before failing over |
| `{"fail_rate": 0.3}` | 52 of 52 requests `200` served by `alpha`; the 30% failures were absorbed by the retries (for example 7 of 40 in one run needed one retry) and were invisible to the client |
| restored (`fail_rate 0`, latency 0) | `200`, `alpha/alpha-small`, no fallback, 14 to 29 ms |

The `/admin/logs` rows show the retries and the fallback flag, and the console shows the same (Phase 10). A
caveat visible in the slow-provider row: because timeouts are retried like other transient errors, a provider
that is merely slow costs the client about three timeouts before the fallback answers; a health-based skip of
a degraded provider is a stretch item that is not built.

## 7. Latency and gateway overhead

- **Client-observed latency in the load test:** average 206 ms, p95 250 ms (10 concurrent clients; the mock
  providers answer in about a millisecond, so this is dominated by the burst's queueing).
- **Gateway-added latency**, `scripts/measure_overhead.py` (100 sequential requests, interleaved direct and
  through the gateway, same prompts, cache off, first 5 discarded):

  ```
  direct   mean 17.08 ms  median 18.97 ms  p95 21.09 ms
  gateway  mean 26.60 ms  median 27.18 ms  p95 31.09 ms
  gateway adds about 8 ms (median) / 9.5 ms (mean)
  ```

  That covers authentication (one indexed query), validation, the Redis rate-limit script, the budget
  reservation, the routing decision, the upstream hop, settlement and the log row in one transaction. It was
  measured as wall-clock time around two client calls from the same machine, so it includes the client's own
  overhead on both sides and is a coarse figure, not a profile.
## 8. Console

The console (Phase 10) was checked in a browser against the running stack after a free-tier burst, a
`budget-demo` request and a request while `alpha` was down: the rate-limit `429` rows, the budget `402` row,
cache hits and the fallback (with its two retries) all appear in "Recent requests", and "Usage by key" and
"Cache" show numbers matching the admin API.

## 9. Known limitations

- **No live check against a real provider yet** (Phase 12 needs an API key and spend that you approve).
- **Pair B** of the cache sample does not hit at a safe threshold (see §2).
- **Repeated smoke-test runs need a cleared cache** (see §2).
- **A slow provider costs about three timeouts before failover** (see §6); no health-based provider skipping.
- **The cache has no size cap**, only a TTL (`CACHE_TTL_SECONDS`, default one day).
- **Routing is heuristic.** Long prompts wrapped around a trivial question can be sent to `smart`
  (one development case); the classifier is tuned for English prompts.
- **`auto` and the allowlist:** a key allowed `auto` and only `fast` gets `smart` verdicts downgraded to `fast`.
- **Tokens-per-minute limits** from the seed data are stored but not enforced (a stretch item).
- **Stream cost** is only known at the end, so streaming responses have no `x-prism-cost-usd` header; it is in
  the logs and the usage API. A stream's usage is estimated from the delivered text when the provider sends none
  (flagged `usage_estimated`).
- **Single gateway instance** is assumed for budgets; they are consistent in Postgres, but nothing here has
  been run with several gateway replicas.
- **The admin token** is one shared demo secret.
