import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { computeCostUnits, formatUsd } from '../src/money.js';
import type { FakeOutcome } from '../src/providers/fake.js';
import { KEYS, buildTestApp, config, waitForLogs, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function start(): TestApp {
  current = buildTestApp();
  return current;
}

function post(
  t: TestApp,
  model = 'fast',
  key: string = KEYS.research,
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'What is a message queue?' }],
    }),
  });
}

const down: FakeOutcome = { type: 'error', kind: 'server_error', status: 503 };
const rateLimited: FakeOutcome = { type: 'error', kind: 'rate_limited', status: 429 };
const RESEARCH_ID = 2;

describe('retry and failover, end to end (eval E7)', () => {
  it('serves from the primary when it is healthy', async () => {
    const t = start();
    const res = await post(t);
    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(res.headers['x-prism-fallback']).toBe('false');
    expect(t.providers.must('beta').calls).toHaveLength(0);
  });

  it('primary down: retries, then fails over to beta, flagged and logged', async () => {
    const t = start();
    t.providers.must('alpha').fallback = down;
    const res = await post(t);

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('beta/beta-small');
    expect(res.headers['x-prism-fallback']).toBe('true');
    expect(res.json().choices[0].message.content).toContain('[beta:beta-small]');
    expect(res.json().model).toBe('fast'); // the client still sees the name it asked for
    expect(t.providers.must('alpha').calls).toHaveLength(3); // 1 try + 2 retries
    expect(t.providers.must('beta').calls).toHaveLength(1);

    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      status: 'ok',
      resolvedProvider: 'beta',
      resolvedModel: 'beta-small',
      fallback: true,
      retries: 2,
    });
  });

  it('provider 429: no retry, immediate failover', async () => {
    const t = start();
    t.providers.must('alpha').fallback = rateLimited;
    const res = await post(t);

    expect(res.headers['x-prism-provider']).toBe('beta/beta-small');
    expect(res.headers['x-prism-fallback']).toBe('true');
    expect(t.providers.must('alpha').calls).toHaveLength(1);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ fallback: true, retries: 0 });
  });

  it('one transient error, then success: retried, served by the primary, not a fallback', async () => {
    const t = start();
    t.providers.must('alpha').script.push(down);
    const res = await post(t);

    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(res.headers['x-prism-fallback']).toBe('false');
    expect(t.providers.must('alpha').calls).toHaveLength(2);
    expect(t.providers.must('beta').calls).toHaveLength(0);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ fallback: false, retries: 1 });
  });

  it('retry once and fail over once: exactly one RPM hit, one billed attempt (edge case 8.19)', async () => {
    const t = start();
    t.providers.must('alpha').script.push(down, rateLimited); // retried once, then rate limited
    const res = await post(t);

    expect(res.headers['x-prism-fallback']).toBe('true');
    expect(t.providers.must('alpha').calls).toHaveLength(2);
    expect(t.providers.must('beta').calls).toHaveLength(1);

    // One request = one rate-limit hit, however many provider calls it took.
    expect(t.limiter.counts.get(RESEARCH_ID)).toBe(1);
    expect(t.events.filter((e) => e === 'rate-limit')).toHaveLength(1);

    // Billed once, for the successful attempt's tokens, at that model's price.
    const usage = res.json().usage;
    const expected = computeCostUnits(
      usage.prompt_tokens,
      usage.completion_tokens,
      config.models.get('beta-small')!,
    );
    expect(res.headers['x-prism-cost-usd']).toBe(formatUsd(expected));
    expect(t.budget.settled).toHaveLength(1);
    expect(t.budget.spent.get(RESEARCH_ID)).toBe(expected);
    expect(t.budget.reserved.get(RESEARCH_ID)).toBe(0n);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ retries: 1, fallback: true, costUnits: expected });
  });

  it('bills the model that answered, not the primary the estimate was based on', async () => {
    const t = start();
    t.providers.must('alpha').fallback = rateLimited;
    t.providers.must('beta').script.push({
      type: 'ok',
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });
    const res = await post(t, 'smart');

    expect(res.headers['x-prism-provider']).toBe('beta/beta-large');
    const units = computeCostUnits(1_000_000, 1_000_000, config.models.get('beta-large')!);
    expect(res.headers['x-prism-cost-usd']).toBe(formatUsd(units));
    expect(t.budget.spent.get(RESEARCH_ID)).toBe(units);
  });

  it('a non-retryable provider error is a 502: no retry, no failover (edge case 8.5)', async () => {
    const t = start();
    t.providers.must('alpha').fallback = { type: 'error', kind: 'bad_request', status: 404 };
    const res = await post(t);

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({ type: 'upstream_error', code: 'upstream_error' });
    expect(t.providers.must('alpha').calls).toHaveLength(1);
    expect(t.providers.must('beta').calls).toHaveLength(0);
  });

  it('every provider failing: 502, nothing billed, logged (edge case 8.8)', async () => {
    const t = start();
    t.providers.must('alpha').fallback = down;
    t.providers.must('beta').fallback = down;
    const res = await post(t);

    expect(res.statusCode).toBe(502);
    expect(Object.keys(res.json())).toEqual(['error']);
    expect(res.headers['x-prism-provider']).toBe('none');
    expect(res.headers['x-prism-cost-usd']).toBe('0');
    await t.app.close();
    expect(t.budget.spent.get(RESEARCH_ID) ?? 0n).toBe(0n);
    expect(t.budget.reserved.get(RESEARCH_ID)).toBe(0n);
    expect(t.budget.settled).toHaveLength(0);
    expect(t.limiter.counts.get(RESEARCH_ID)).toBe(1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'upstream_error', httpStatus: 502 });
  });

  it('a flaky primary: retries absorb the failures, requests still succeed on the primary (8.7)', async () => {
    const t = start();
    const alpha = t.providers.must('alpha');
    // Every third provider call fails, deterministically, about the rate of fail_rate 0.3.
    for (let i = 0; i < 60; i++) alpha.script.push(i % 3 === 0 ? down : { type: 'ok' });

    // Sequential, so each request sees a predictable slice of the script.
    const results: LightMyRequestResponse[] = [];
    for (let i = 0; i < 20; i++) results.push(await post(t));

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.every((r) => r.headers['x-prism-fallback'] === 'false')).toBe(true);
    expect(t.providers.must('beta').calls).toHaveLength(0);
  });

  it('a slow primary: the timeout fires and the client is served by the fallback in time (8.1)', async () => {
    const t = start();
    t.providers.must('alpha').fallback = { type: 'ok', latencyMs: 3000 };
    const started = Date.now();
    const res = await post(t);

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('beta/beta-small');
    expect(res.headers['x-prism-fallback']).toBe('true');
    expect(Date.now() - started).toBeLessThan(1500); // inside the request deadline
  });

  it('traffic returns to the primary as soon as it is restored (edge case 8.9)', async () => {
    const t = start();
    const alpha = t.providers.must('alpha');
    alpha.fallback = down;
    expect((await post(t)).headers['x-prism-provider']).toBe('beta/beta-small');

    alpha.fallback = { type: 'ok' };
    const restored = await post(t);
    expect(restored.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(restored.headers['x-prism-fallback']).toBe('false');
  });

  it('uses the smart chain for `smart`', async () => {
    const t = start();
    t.providers.must('alpha').fallback = rateLimited;
    const res = await post(t, 'smart');
    expect(res.headers['x-prism-provider']).toBe('beta/beta-large');
    expect(res.headers['x-prism-fallback']).toBe('true');
  });

  it('keeps accounting exact under concurrent failovers: spent equals the logged cost', async () => {
    const t = start();
    t.providers.must('alpha').fallback = rateLimited;
    await Promise.all(Array.from({ length: 25 }, () => post(t)));
    await waitForLogs(t.logs, 25);

    const logged = t.logs.entries.reduce((sum, e) => sum + (e.costUnits ?? 0n), 0n);
    expect(t.budget.spent.get(RESEARCH_ID)).toBe(logged);
    expect(t.budget.reserved.get(RESEARCH_ID)).toBe(0n);
    expect(t.logs.entries.every((e) => e.fallback === true)).toBe(true);
    expect(t.limiter.counts.get(RESEARCH_ID)).toBe(25);
  });

  it('does not retry or fail over a request the client abandoned', async () => {
    const t = start();
    const alpha = t.providers.must('alpha');
    alpha.script.push({ type: 'error', kind: 'aborted' });
    const res = await post(t);
    expect(res.statusCode).toBe(499);
    expect(alpha.calls).toHaveLength(1);
    expect(t.providers.must('beta').calls).toHaveLength(0);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'client_disconnect' });
    await t.app.close();
    expect(t.budget.holds.size).toBe(0);
  });
});
