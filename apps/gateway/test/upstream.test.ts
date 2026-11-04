import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { computeCostUnits, formatUsd } from '../src/money.js';
import type { ProviderErrorKind } from '../src/providers/errors.js';
import type { FakeOutcome } from '../src/providers/fake.js';
import { KEYS, buildTestApp, config, waitForLogs, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

/** Every provider in the chain gives the same outcome on every call. */
function failEverywhere(t: TestApp, outcome: FakeOutcome): void {
  for (const adapter of t.providers.adapters.values()) adapter.fallback = outcome;
}

function start(): TestApp {
  current = buildTestApp();
  return current;
}

function post(
  t: TestApp,
  body: Record<string, unknown> = {},
  key: string = KEYS.search,
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: JSON.stringify({
      model: 'fast',
      messages: [{ role: 'user', content: 'What is a message queue?' }],
      ...body,
    }),
  });
}

describe('the provider call (Phase 4 pass-through)', () => {
  it('serves `fast` from alpha-small and `smart` from alpha-large', async () => {
    const t = start();
    const fast = await post(t);
    const smart = await post(t, { model: 'smart' }, KEYS.research);

    expect(fast.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(smart.headers['x-prism-provider']).toBe('alpha/alpha-large');
    expect(t.providers.must('alpha').calls.map((c) => c.request.model)).toEqual([
      'alpha-small',
      'alpha-large',
    ]);
    expect(t.providers.must('beta').calls).toHaveLength(0); // the fallback is not touched
    expect(fast.headers['x-prism-fallback']).toBe('false');
    expect(fast.headers['x-prism-cache']).toBe('miss');
  });

  it('forwards the messages and sampling parameters unchanged, with the provider model id', async () => {
    const t = start();
    const messages = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'What is a message queue?' },
    ];
    await post(t, { messages, temperature: 0.3, max_tokens: 80, stop: ['\n'], seed: 7 });

    const sent = t.providers.must('alpha').calls[0]!.request;
    expect(sent.model).toBe('alpha-small'); // never the alias the client used
    expect(sent.messages).toEqual(messages);
    expect(sent.params).toEqual({ temperature: 0.3, max_tokens: 80, stop: ['\n'], seed: 7 });
  });

  it('bills the provider-reported usage, not anything the client or the gateway counted', async () => {
    const t = start();
    t.providers.must('alpha').script.push({
      type: 'ok',
      content: 'Four words right here',
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });
    const res = await post(t);

    expect(res.json().usage).toEqual({
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    const units = computeCostUnits(1_000_000, 1_000_000, config.models.get('alpha-small')!);
    expect(units).toBe(75_000_000n); // 0.15 + 0.60 USD
    expect(res.headers['x-prism-cost-usd']).toBe(formatUsd(units));
    expect(t.budget.spent.get(1)).toBe(units);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      resolvedProvider: 'alpha',
      resolvedModel: 'alpha-small',
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      costUnits: units,
      status: 'ok',
    });
  });

  it('returns the provider’s text as an OpenAI chat completion, under the requested model name', async () => {
    const t = start();
    t.providers.must('alpha').script.push({
      type: 'ok',
      content: 'Answer from alpha.',
      usage: { promptTokens: 5, completionTokens: 3 },
    });
    const body = (await post(t)).json();

    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'fast',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Answer from alpha.' },
          finish_reason: 'stop',
        },
      ],
    });
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.created).toBeTypeOf('number');
  });

  it('counts one request as one rate-limit hit and settles exactly once', async () => {
    const t = start();
    await post(t);
    expect(t.limiter.counts.get(1)).toBe(1);
    expect(t.budget.settled).toHaveLength(1);
  });

  it('streaming requests reach the provider too (their path is covered in streaming.test.ts)', async () => {
    const t = start();
    const res = await post(t, { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(t.providers.must('alpha').calls).toHaveLength(1);
  });
});

describe('when the provider fails (edge cases 8.1, 8.5, 8.8, 8.13, 8.17)', () => {
  const kinds: [ProviderErrorKind, number | undefined][] = [
    ['timeout', undefined],
    ['connection', undefined],
    ['server_error', 503],
    ['rate_limited', 429],
    ['malformed', 200],
    ['auth', 401],
    ['bad_request', 404],
  ];

  it.each(kinds)('a "%s" failure becomes a clean 502, billed nothing', async (kind, status) => {
    const t = start();
    const outcome: FakeOutcome =
      status === undefined ? { type: 'error', kind } : { type: 'error', kind, status };
    failEverywhere(t, outcome);

    const res = await post(t);

    expect(res.statusCode).toBe(502);
    expect(Object.keys(res.json())).toEqual(['error']);
    expect(res.json().error).toMatchObject({ type: 'upstream_error', code: 'upstream_error' });
    // Generic: nothing about the provider, its status, or why.
    expect(res.json().error.message).not.toMatch(/alpha|beta|503|429|401|404|provider "/);
    expect(res.headers['x-prism-provider']).toBe('none');
    expect(res.headers['x-prism-cost-usd']).toBe('0');
    expect(res.headers['x-prism-fallback']).toBe('false');

    // Nothing was billed and the hold is gone.
    await t.app.close();
    expect(t.budget.spent.get(1) ?? 0n).toBe(0n);
    expect(t.budget.reserved.get(1)).toBe(0n);
    expect(t.budget.holds.size).toBe(0);
    expect(t.budget.released).toHaveLength(1);
    expect(t.budget.settled).toHaveLength(0);
  });

  it('logs the failure with the provider and model that were tried, at zero cost', async () => {
    const t = start();
    failEverywhere(t, { type: 'error', kind: 'server_error', status: 500 });
    await post(t);

    await waitForLogs(t.logs, 1);
    // The last model tried is recorded: with every provider failing, that is the fallback.
    expect(t.logs.entries[0]).toMatchObject({
      status: 'upstream_error',
      httpStatus: 502,
      errorCode: 'upstream_error',
      requestedModel: 'fast',
      resolvedModel: 'beta-small',
      resolvedProvider: 'beta',
      fallback: true,
      retries: 4,
    });
    expect(t.logs.entries[0]?.costUnits ?? 0n).toBe(0n);
  });

  it('never exposes the provider’s credentials or error text', async () => {
    const t = start();
    t.providers.must('alpha').script.push({ type: 'error', kind: 'auth', status: 401 });
    const res = await post(t);
    for (const secret of ['mock-key-alpha', 'mock-key-beta', 'Bearer']) {
      expect(res.body).not.toContain(secret);
      expect(JSON.stringify(res.headers)).not.toContain(secret);
    }
    await waitForLogs(t.logs, 1);
    expect(
      JSON.stringify(t.logs.entries, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain('mock-key-alpha');
  });

  it('answers a provider that never responds within the timeout, never hangs (edge case 8.1)', async () => {
    const t = start();
    failEverywhere(t, { type: 'hang' });
    const started = Date.now();
    const res = await post(t);

    expect(res.statusCode).toBe(502);
    // Bounded by the request deadline (1.5 s in tests) however many attempts that allows.
    expect(Date.now() - started).toBeLessThan(2200);
  });

  it('answers a slow provider (latency beyond the first-byte limit) within the limit, not after it', async () => {
    const t = start();
    failEverywhere(t, { type: 'ok', latencyMs: 3000 });
    const started = Date.now();
    const res = await post(t);
    expect(res.statusCode).toBe(502);
    expect(Date.now() - started).toBeLessThan(2200);
  });

  it('still serves the next request once the providers are back (no lingering state)', async () => {
    const t = start();
    failEverywhere(t, { type: 'error', kind: 'server_error', status: 500 });
    expect((await post(t)).statusCode).toBe(502);
    failEverywhere(t, { type: 'ok' });
    expect((await post(t)).statusCode).toBe(200);
  });

  it('does not let unrelated requests wait for a hanging provider (edge case 8.20)', async () => {
    const t = start();
    const alpha = t.providers.must('alpha');
    alpha.script.push({ type: 'hang' });
    const slow = post(t);
    // Wait until the hanging call has consumed the scripted outcome.
    while (alpha.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    const started = Date.now();
    const quick = await post(t, {}, KEYS.research);
    expect(quick.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(200);
    // The hung attempt times out and is retried, which succeeds.
    expect((await slow).statusCode).toBe(200);
  });

  it('turns an unexpected adapter exception into a generic 503 and releases the hold', async () => {
    const t = start();
    const alpha = t.providers.must('alpha');
    alpha.chatCompletion = () =>
      Promise.reject(new Error('TypeError: x is undefined at /app/secret/path'));
    const res = await post(t);

    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('secret/path');
    await t.app.close();
    expect(t.budget.holds.size).toBe(0);
    expect(t.budget.spent.get(1) ?? 0n).toBe(0n);
  });

  it('answers 503 and releases the hold if no adapter is registered for the provider', async () => {
    const t = start();
    // Simulates a config/registry mismatch that startup validation should make impossible.
    (t.providers.adapters as Map<string, unknown>).delete('alpha');
    const res = await post(t);

    expect(res.statusCode).toBe(503);
    await t.app.close();
    expect(t.budget.holds.size).toBe(0);
  });
});
