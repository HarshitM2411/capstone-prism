# Prism — LLM Gateway and Semantic Cache


**Source:** `docs/PS1.pdf` — AI-first Software Engineering Program, Case Study (Author: Airtribe)
**GitHub Repository (starter/reference):** https://github.com/airtribe-projects/prism-capstone


This document is a faithful, complete transcription and organization of the problem statement. It exists so the full context survives even as implementation details change.


---


## Background


Every AI product sits behind the same invisible layer: a **gateway** between the application and the model providers. It's the infrastructure layer every AI company now runs — one place that handles keys, budgets, failover, caching, and cost accounting, so teams don't each wire up providers their own way. Products like **LiteLLM**, **OpenRouter**, and **Portkey** exist because this is now core infrastructure, the way API gateways and load balancers were a decade ago.


**Prism** is an AI-first product where the gateway itself makes AI decisions in the hot path:
- It judges how hard each prompt is, to route it to the right model tier.
- It matches meaning — not strings — to serve repeated questions from cache.


There's no chatbot to build here. The challenge is **streaming, metering, reliability, and multi-tenancy done properly**, with machine judgment running inside the request path.


---


## Objective


Build a production-grade LLM gateway that can:


1. Route requests across multiple model providers through one unified, OpenAI-compatible API.
2. Judge prompt difficulty and route automatically — cheap models for simple prompts, strong models for hard ones — proven against a labeled eval set.
3. Fall back automatically when a provider goes down, rate-limits, or degrades.
4. Stream responses token by token, end to end, without buffering.
5. Meter usage per tenant — every request, every token, every dollar.
6. Enforce cost budgets and rate limits per team.
7. Answer repeated questions from a semantic cache instead of paying for the same tokens twice.
8. Keep a request log complete enough to debug any AI traffic issue.


---


## Key Features


### 1. Load the Provided Data
- Load the model price table, seed tenants, and gateway config:
 - `model_pricing.json`
 - `seed_keys.json`
 - `gateway_config.sample.json`
- **Preserve seed key values and alias names** — the demo flow and scripts reference them directly.


### 2. Unified Chat Completions API
- One OpenAI-compatible `POST /v1/chat/completions` endpoint in front of **at least 2 providers** (mocks count).
- Callers use a **model alias/name**; the gateway resolves it and **never exposes provider credentials**.
- Every response carries the **header contract**:
 - `x-prism-provider`
 - `x-prism-cache`
 - `x-prism-fallback`
 - `x-prism-cost-usd`


### 3. Streaming Pass-Through
- `"stream": true` flows tokens from provider → gateway → client **as they arrive**, no buffering.
- Stream terminates correctly (`data: [DONE]`); usage/cost still recorded even though the response was streamed.


### 4. Virtual Keys, Rate Limits & Budgets
- Authenticate every request with a **virtual key**.
- Enforce per-key:
 - Model allowlist
 - Requests-per-minute limit
 - Monthly cost budget
- **Distinct, documented error per rejection type**:
 - Invalid key
 - Model not allowed
 - Rate limited
 - Budget exhausted


### 5. Routing, Retries & Failover
- Resolve aliases (`fast`, `smart`) to a primary model with an **ordered fallback chain**.
- Retry transient errors with **exponential backoff**.
- Fail over to the next provider/model in the chain and **record that it happened**.


### 6. Smart Routing — the `auto` Alias
- `"model": "auto"` lets the gateway **classify prompt difficulty** and route to `fast` or `smart`.
- Must **beat a length-only baseline** — the eval set deliberately includes:
 - Short-but-hard prompts (traps for length-based heuristics)
 - Long-but-trivial prompts (traps for length-based heuristics)
- One-command **routing eval** reporting accuracy per case.


### 7. Semantic Response Cache
- Serve cached responses for **semantically similar** prompts (not just exact matches).
- Cache is **scoped per key** (tenant isolation — no cross-tenant leakage).
- Report hits via the header contract (`x-prism-cache`) and **track hit rates**.


### 8. Metering, Request Logs & Usage API
- Compute **cost per request** from the price table using **provider-reported token usage**.
- Log every request with:
 - Key
 - Model
 - Provider
 - Status
 - Tokens
 - Cost
 - Cache result
 - Fallback flag
 - Latency
- Expose a **usage summary API** over these logs.


### 9. Simple Ops Console & Verification
- A simple frontend ("vibe-coding fine" — doesn't need to be polished) showing:
 - Usage by key
 - Recent requests
 - Cache hit rate
- Must **pass** `scripts/smoke_test.py`.
- Must **run** `scripts/load_test.py` and the **routing eval**, and **report results**.


---


## Technical Requirements


- Expose core functionality as an **HTTP API**. The data plane must remain **OpenAI-compatible**.
- Use a **reliable persistent store** for virtual keys, usage records, request logs, and cache entries.
- **Usage accounting and rate limiting must work correctly under concurrent requests.**
- Every upstream provider call must have a **timeout** so the gateway does not hang when a provider is slow or dead.
- Keep provider integration behind an **adapter** so mock providers or real providers can be used **without changing the core system**.
- Provide **automated tests** for critical logic:
 - Cost computation
 - Rate limiting
 - Cache decisions
 - Allowlists
 - Routing behavior


---


## Assessment Criteria


### Functionality
Does the gateway load the provided data, serve OpenAI-compatible completions over two providers, stream responses correctly, enforce keys/rate limits/budgets, perform failover, route `auto` traffic, cache semantically, meter usage, and show platform activity through a simple console?


### Gateway Correctness Under Pressure
- Does usage accounting remain accurate during concurrent requests?
- Does the load test show **no over-admission**?
- Does provider failover work when a provider is taken down?
- Does the cache hit paraphrased prompts **without leaking responses across tenants**?


### Code Quality
Is the code clean, organized, maintainable, and easy to understand?


### Design and Structure
Is the gateway well-designed? Does it show a strong understanding of backend architecture, streaming, provider adapters, rate limiting, cost metering, retries, failover, and multi-tenant systems?


### Documentation and Demo
- Is the README clear?
- Are setup steps, APIs, design decisions, cache scoping, routing logic, failover behavior, and known limitations documented?
- Does the demo clearly show the full Prism workflow?


---


## Deliverables


1. **The final, functional product**: LLM gateway and simple ops console.
2. **README** covering:
  - Setup instructions
  - API documentation
  - Architecture
  - Routing/failover design
  - Cache scoping
  - Design decisions
3. **Public link** of the GitHub repository.
4. **Seeded demo keys** and instructions to reproduce the demo with mock providers.
5. **Verification report** including:
  - Smoke test output
  - Load test report
  - Routing eval accuracy
  - Over-admission results
  - Accounting totals
  - Latency summary
6. **Explainer video** demonstrating the project, including:
  - Streaming
  - Smart routing
  - Budget rejection
  - Rate limiting
  - Semantic cache hit on a paraphrased prompt
  - Live provider failover


---


## Resources


- GitHub Repository (starter/reference): https://github.com/airtribe-projects/prism-capstone


---


## Open Items / Not Yet Pulled Locally


- The reference repo (`prism-capstone`) containing `model_pricing.json`, `seed_keys.json`, `gateway_config.sample.json`, `scripts/smoke_test.py`, and `scripts/load_test.py` has **not yet been cloned** into this workspace. Needed before implementation can begin in earnest.


---


## Working Agreement


- All git operations (push/pull/clone/fetch) require **explicit approval** before execution — nothing is pushed or pulled automatically.



