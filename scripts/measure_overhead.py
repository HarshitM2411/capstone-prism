#!/usr/bin/env python3
"""Coarse measurement of the latency the gateway adds. Zero dependencies (Python 3.9+ stdlib).

Sends the same sequence of cache-busting requests (a) straight to a mock provider and (b) through
the gateway with a key that has the cache off, one at a time, and compares client-observed latency.
The difference is what the gateway adds for authentication, validation, rate limiting, budget
reservation, routing, the upstream hop, metering and the log write, plus its own response handling.

    python3 scripts/measure_overhead.py --gateway http://localhost:8080 \
        --key prism-sk-research-4d5e6f --provider http://localhost:9001 --provider-key mock-key-alpha \
        --model alpha-small --alias fast --requests 100

Limitations: wall-clock timings from one client on one machine; the first few requests are
discarded as warm-up; with a mock that answers in about a millisecond the numbers mostly show the
gateway's fixed cost, not what a slow real provider would add.
"""

import argparse
import json
import statistics
import time
import urllib.request
import uuid


def post(url, key, body):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    start = time.perf_counter()
    with urllib.request.urlopen(request, timeout=30) as response:
        response.read()
    return (time.perf_counter() - start) * 1000


def body(model, text):
    return {"model": model, "messages": [{"role": "user", "content": text}]}


def summarize(label, samples):
    ordered = sorted(samples)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    print(
        f"  {label:<10} n={len(samples)}  mean {statistics.mean(samples):6.2f} ms  "
        f"median {statistics.median(samples):6.2f} ms  p95 {p95:6.2f} ms"
    )
    return statistics.median(samples), statistics.mean(samples)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gateway", default="http://localhost:8080")
    parser.add_argument("--key", required=True, help="a virtual key with the cache disabled")
    parser.add_argument("--alias", default="fast")
    parser.add_argument("--provider", default="http://localhost:9001")
    parser.add_argument("--provider-key", default="mock-key-alpha")
    parser.add_argument("--model", default="alpha-small", help="the model the alias maps to")
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--warmup", type=int, default=5)
    args = parser.parse_args()

    salt = uuid.uuid4().hex[:8]
    direct, through = [], []
    # Interleaved, so drift in machine load hits both sides equally.
    for i in range(args.requests + args.warmup):
        text = f"({salt}) overhead probe number {i}: what is a message queue?"
        d = post(args.provider.rstrip("/") + "/v1/chat/completions", args.provider_key, body(args.model, text))
        g = post(args.gateway.rstrip("/") + "/v1/chat/completions", args.key, body(args.alias, text))
        if i >= args.warmup:
            direct.append(d)
            through.append(g)

    print("Client-observed latency, sequential requests:")
    d_median, d_mean = summarize("direct", direct)
    g_median, g_mean = summarize("gateway", through)
    print(f"  gateway adds about {g_median - d_median:.2f} ms (median) / {g_mean - d_mean:.2f} ms (mean)")


if __name__ == "__main__":
    main()
