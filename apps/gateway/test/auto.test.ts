import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { VirtualKey } from '../src/db/keys.js';
import type { KeyStore } from '../src/http/auth.js';
import type { Classification, Classifier } from '../src/routing/classifier.js';
import { KEYS, TENANTS, buildTestApp, waitForLogs, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function verdict(difficulty: 'simple' | 'complex', reason = 'test verdict'): Classification {
  return { difficulty, score: 0, threshold: 1, signals: [], embedDelta: null, reason };
}

function fixed(difficulty: 'simple' | 'complex'): Classifier & { calls: number } {
  const classifier = {
    calls: 0,
    async classify() {
      classifier.calls++;
      return verdict(difficulty);
    },
  };
  return classifier;
}

function start(overrides: Parameters<typeof buildTestApp>[0] = {}): TestApp {
  current = buildTestApp(overrides);
  return current;
}

function ask(
  t: TestApp,
  content: string,
  options: { key?: string; model?: string; stream?: boolean } = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${options.key ?? KEYS.research}` },
    payload: {
      model: options.model ?? 'auto',
      messages: [{ role: 'user', content }],
      ...(options.stream ? { stream: true } : {}),
    },
  });
}

/** A key that may use `auto` and the cheap tier only, and one that may use `auto` and `smart`. */
const CHEAP_ONLY = 'prism-sk-cheap-auto-1c1c1c';
const SMART_ONLY = 'prism-sk-smart-auto-2s2s2s';
const customKeys: KeyStore = {
  async findByRawKey(rawKey) {
    const extra: Record<string, VirtualKey> = {
      [CHEAP_ONLY]: { ...TENANTS[KEYS.research]!, id: 21, allowedModels: ['fast', 'auto'] },
      [SMART_ONLY]: { ...TENANTS[KEYS.research]!, id: 22, allowedModels: ['smart', 'auto'] },
    };
    return extra[rawKey] ?? TENANTS[rawKey] ?? null;
  },
};

describe('model "auto"', () => {
  it('serves a simple verdict with the fast tier and a complex one with the smart tier', async () => {
    const simple = start({ classifier: fixed('simple') });
    const fast = await ask(simple, 'hello');
    expect(fast.statusCode).toBe(200);
    expect(fast.headers['x-prism-provider']).toBe('alpha/alpha-small');
    await current!.app.close();

    const complex = start({ classifier: fixed('complex') });
    const smart = await ask(complex, 'hello');
    expect(smart.statusCode).toBe(200);
    expect(smart.headers['x-prism-provider']).toBe('alpha/alpha-large');
  });

  it('answers with the requested name in the body, but logs the resolved model', async () => {
    const t = start({ classifier: fixed('complex') });
    const res = await ask(t, 'hello');
    expect(res.json().model).toBe('auto');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      requestedModel: 'auto',
      resolvedModel: 'alpha-large',
      status: 'ok',
    });
  });

  it('records the route reason on a successful request (edge case 6.13)', async () => {
    const t = start({ classifier: fixed('simple') });
    await ask(t, 'hello');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]!.routeReason).toBe('fast: test verdict');
  });

  it('records the route reason on a streamed request', async () => {
    const t = start({ classifier: fixed('complex') });
    const res = await ask(t, 'hello', { stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-large');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]!.routeReason).toBe('smart: test verdict');
  });

  it('prices the reservation with the chosen tier, not the strongest one', async () => {
    const simple = start({ classifier: fixed('simple') });
    await ask(simple, 'hello');
    const cheap = simple.budget.reservations[0]!.reservedUnits;
    await current!.app.close();

    const complex = start({ classifier: fixed('complex') });
    await ask(complex, 'hello');
    expect(cheap).toBeLessThan(complex.budget.reservations[0]!.reservedUnits);
  });

  it('keeps the route reason on a budget rejection after classification (edge case 6.15)', async () => {
    // The demo key has no `auto` permission by default; give it one so the budget is what fails.
    const keys: KeyStore = {
      async findByRawKey(rawKey) {
        const key = TENANTS[rawKey];
        return rawKey === KEYS.demo && key ? { ...key, allowedModels: ['fast', 'auto'] } : null;
      },
    };
    const t = start({ classifier: fixed('simple'), keys });
    // The first request is admitted (the budget is not yet spent) and uses it up.
    expect((await ask(t, 'hello', { key: KEYS.demo })).statusCode).toBe(200);
    const res = await ask(t, 'hello', { key: KEYS.demo });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('budget_exceeded');
    await waitForLogs(t.logs, 2);
    expect(t.logs.entries[1]).toMatchObject({ status: 'rejected_budget', httpStatus: 402 });
    expect(t.logs.entries[1]!.routeReason).toBe('fast: test verdict');
  });

  describe('allowlist (edge cases 3.2, 3.3)', () => {
    it('refuses `auto` for a key that does not list it, without classifying', async () => {
      const classifier = fixed('simple');
      const t = start({ classifier });
      const res = await ask(t, 'hello', { key: KEYS.search });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('model_not_allowed');
      expect(classifier.calls).toBe(0);
    });

    it('downgrades a smart verdict to fast when the key may not use smart, and says so', async () => {
      const t = start({ classifier: fixed('complex'), keys: customKeys });
      const res = await ask(t, 'hello', { key: CHEAP_ONLY });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-prism-provider']).toBe('alpha/alpha-small');
      await waitForLogs(t.logs, 1);
      const reason = t.logs.entries[0]!.routeReason!;
      expect(reason).toContain('downgraded from smart');
      expect(reason.startsWith('fast:')).toBe(true);
    });

    it('refuses with 403 when the chosen tier is not allowed and cannot be downgraded', async () => {
      const t = start({ classifier: fixed('simple'), keys: customKeys });
      const res = await ask(t, 'hello', { key: SMART_ONLY });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('model_not_allowed');
      expect(t.events).not.toContain('budget-reserve');
      await waitForLogs(t.logs, 1);
      expect(t.logs.entries[0]).toMatchObject({ status: 'rejected_allowlist', httpStatus: 403 });
      expect(t.logs.entries[0]!.routeReason).toBe('fast: test verdict');
    });
  });

  it('classifies after the rate limit and before the budget', async () => {
    const t = start({ classifier: fixed('simple') });
    await ask(t, 'hello');
    expect(t.events.indexOf('rate-limit')).toBeLessThan(t.events.indexOf('budget-reserve'));
  });

  it('does not classify requests that name a tier or a model', async () => {
    const classifier = fixed('simple');
    const t = start({ classifier });
    expect((await ask(t, 'hello', { model: 'smart' })).statusCode).toBe(200);
    expect((await ask(t, 'hello', { model: 'fast' })).statusCode).toBe(200);
    expect(classifier.calls).toBe(0);
    await waitForLogs(t.logs, 2);
    expect(t.logs.entries.every((entry) => entry.routeReason === null)).toBe(true);
  });

  it('falls back to the smart tier if the classifier itself fails', async () => {
    const broken: Classifier = {
      async classify() {
        throw new Error('boom');
      },
    };
    const t = start({ classifier: broken });
    const res = await ask(t, 'hello');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-large');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]!.routeReason).toContain('classifier error');
  });

  it('works without embeddings by default (structural signals only)', async () => {
    const t = start();
    const hard = await ask(t, 'Prove that the square root of 2 is irrational.');
    expect(hard.headers['x-prism-provider']).toBe('alpha/alpha-large');
    const easy = await ask(t, 'Translate "good morning" into French.');
    expect(easy.headers['x-prism-provider']).toBe('alpha/alpha-small');
    await waitForLogs(t.logs, 2);
    expect(t.logs.entries[0]!.routeReason).toContain('structural only');
  });

  it('never puts prompt text in the route reason', async () => {
    const secret = 'zebra-umbrella-4471';
    const t = start();
    await ask(t, `Prove that ${secret} is irrational.`);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]!.routeReason).not.toContain(secret);
  });
});
