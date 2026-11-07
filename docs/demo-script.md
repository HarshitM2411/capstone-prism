# Prism demo script and recording checklist

About 8 to 10 minutes. Every command below was run against the Docker stack while preparing the
[verification report](verification-report.md); the expected results are the ones recorded there.

## Before recording

- [ ] `docker compose up -d --build`, then `docker compose ps`: postgres, redis, alpha, beta, gateway, console up.
- [ ] Reset the demo state so the cache and budgets start clean (this deletes the request history):
      `docker compose down -v && docker compose up -d`
- [ ] Reset the mocks if you used them before: `POST http://localhost:9001/admin/config` and `:9002` with
      `{"mode":"normal","latency_ms":0,"fail_rate":0}`.
- [ ] Open the console at http://localhost:3000 (token `change-me-demo-admin-token`) in a second window.
- [ ] Put the request bodies in files (PowerShell quoting) or use a bash shell; examples use bash.
- [ ] Have `docs/verification-report.md` and the terminal output for the smoke and load tests ready.

Shell variables used below:

```bash
G=http://localhost:8080
A="x-admin-token: change-me-demo-admin-token"
```

## 1. Healthy system (about 30 s)

Say: gateway, Postgres, Redis and two mock providers, one `docker compose up`.

```bash
docker compose ps
curl $G/health
curl http://localhost:9001/health && curl http://localhost:9002/health
```

Expected: all up; the health responses are `ok`.

## 2. A normal request and its headers (about 1 min)

```bash
curl -i $G/v1/chat/completions -H "Authorization: Bearer prism-sk-search-1a2b3c" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"What is a message queue and when should I use one?"}]}'
```

Point at: `x-prism-provider: alpha/alpha-small`, `x-prism-cache: miss`, `x-prism-fallback: false`, `x-prism-cost-usd`
(a few millionths of a dollar), and the `usage` object the cost was computed from.

## 3. Streaming (about 30 s)

```bash
curl -N $G/v1/chat/completions -H "Authorization: Bearer prism-sk-search-1a2b3c" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","stream":true,"messages":[{"role":"user","content":"Explain how server-sent events work."}]}'
```

Expected: `data:` chunks, a final usage chunk, `data: [DONE]`. Say: the cost of a stream is only known at the end,
so it is in the log and the usage API rather than in a header.

## 4. Semantic cache (about 1 min)

Same `search` key, two different wordings of the same question, then a near-miss:

```bash
ask() { curl -s -o /dev/null -D - $G/v1/chat/completions -H "Authorization: Bearer prism-sk-search-1a2b3c" \
  -H "Content-Type: application/json" -d "{\"model\":\"fast\",\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" \
  | grep -i -E "x-prism-(cache|provider|cost)"; }
ask "How do I reset my password on the dashboard?"        # miss
ask "What are the steps to reset my dashboard password?"  # hit, provider none, cost 0
ask "How do I reset my dashboard layout?"                 # miss (similar words, different intent)
```

Say: the cache is per key and per alias; a hit is logged at $0 and never shares answers between teams. Mention the
known limitation: the starter's pair B does not hit at a safe threshold (report section 5).

## 5. `auto` routing (about 1 min)

With the `research` key (the only one allowed `auto`):

```bash
auto() { curl -s $G/v1/chat/completions -H "Authorization: Bearer prism-sk-research-4d5e6f" \
  -H "Content-Type: application/json" -d "{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}" -D - -o /dev/null \
  | grep -i -E "x-prism-provider"; }
auto "Prove that the square root of 2 is irrational."   # short but hard: smart tier (alpha-large)
```

For the long-but-trivial roster prompt `route_006` (see `data/routing_eval.jsonl`), the expected route is the `fast`
tier. Then show the accuracy: `pnpm routing:eval --set both` (dev 98.8 percent, held-out classifier set 100 percent,
against a 45 percent length-only baseline; see report section 4). The chosen tier and the reason are in the request
log (`/admin/logs`, `route_reason`).

## 6. Rate limit (about 1 min)

```bash
python scripts/load_test.py --url $G --key prism-sk-free-7g8h9i --model fast --requests 30 --concurrency 10 --rpm-limit 10
```

Expected: 10 accepted, 20 rejected with 429, and "Over-admission check OK". Then show that the usage API
agrees with the client-side sums printed by the script:

```bash
curl -s -H "$A" "$G/admin/usage?key=free-tier"
```

If the free-tier window was used already, wait a minute so the sliding window clears.

## 7. Budget (about 45 s)

```bash
# first request: admitted, uses up the tiny budget; second: 402 budget_exceeded
for i in 1 2; do curl -s -i $G/v1/chat/completions -H "Authorization: Bearer prism-sk-budget-demo-0j1k2l" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"hello"}]}' | head -n 1; done
```

Expected: `200`, then `402`. This works once per fresh database; after that the first call is already `402`, so\nreset with `docker compose down -v` before recording. Say: the budget is reserved atomically before the call, so concurrent requests cannot
overspend; the rejection is logged as `rejected_budget`.

## 8. Live failover (about 1.5 min)

Keep the console Requests tab visible.

```bash
curl -X POST http://localhost:9001/admin/config -H "Content-Type: application/json" -d '{"mode":"down"}'
curl -i $G/v1/chat/completions -H "Authorization: Bearer prism-sk-research-4d5e6f" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Name three prime numbers."}]}'
```

Expected: `200`, `x-prism-provider: beta/beta-small`, `x-prism-fallback: true`, in about 0.7 s (three attempts on `alpha` with
backoff, then `beta`). Restore: `curl -X POST http://localhost:9001/admin/config -d '{"mode":"normal"}'`.
Optionally show the slow case (`{"latency_ms":3000}`) and say honestly that it takes about 6.6 s because timeouts
are retried (known limitation).

## 9. Ops console (about 1 min)

- Usage tab: per-key requests, tokens, cost and budget used, updating every 5 s.
- Requests tab: filter by status (`rejected_rate_limit`, `cache_hit`, `upstream_error`), show the fallback request from step 8
  and "Load older".
- Cache tab: hits, misses and hit rate per key and the number of entries, matching step 4.

## 10. Tests and report (about 1 min)

```bash
python scripts/smoke_test.py --url $G --key prism-sk-search-1a2b3c --model fast   # clear cache_entries first
```

Expected: `17 passed, 1 warnings, 0 failed` (the warning is cache pair B). Show the summary tables in
`docs/verification-report.md`: automated tests, load and usage reconciliation, routing eval, failure drill,
gateway overhead, known limitations.

## Recording notes

- State the limitations out loud: no live real-provider run yet, slow-provider failover cost, pair B, the shared
  demo admin token, tokens-per-minute not enforced.
- Never show a real API key on screen. The demo keys above are fake.
