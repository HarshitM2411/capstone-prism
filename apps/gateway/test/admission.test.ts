import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { KEYS, buildTestApp, waitForLogs, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function start(overrides: Parameters<typeof buildTestApp>[0] = {}): TestApp {
  current = buildTestApp(overrides);
  return current;
}

function post(
  t: TestApp,
  key: string | null,
  body: unknown = { model: 'fast', messages: [{ role: 'user', content: 'What is a queue?' }] },
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    payload: JSON.stringify(body),
  });
}

const chatFor = (model: string) => ({
  model,
  messages: [{ role: 'user', content: 'What is a queue?' }],
});

function expectContract(res: LightMyRequestResponse): void {
  expect(res.headers['x-prism-provider']).toBe('none');
  expect(res.headers['x-prism-cache']).toBe('miss');
  expect(res.headers['x-prism-fallback']).toBe('false');
  expect(res.headers['x-prism-cost-usd']).toBe('0');
}

describe('model allowlist (check 4)', () => {
  it.each([
    ['smart', KEYS.search],
    ['auto', KEYS.search],
    ['alpha-small', KEYS.search],
    ['beta-large', KEYS.research],
    ['alpha-large', KEYS.research],
  ])('forbids "%s" for a key that does not list it (403, logged)', async (model, key) => {
    const t = start();
    const res = await post(t, key, chatFor(model));

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      type: 'model_not_allowed',
      code: 'model_not_allowed',
    });
    expect(res.json().error.message).toContain(model);
    expectContract(res);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      status: 'rejected_allowlist',
      httpStatus: 403,
      errorCode: 'model_not_allowed',
      requestedModel: model,
    });
  });

  it('lets the same key use what it does list', async () => {
    const t = start();
    expect((await post(t, KEYS.research, chatFor('smart'))).statusCode).toBe(200);
    expect((await post(t, KEYS.research, chatFor('auto'))).statusCode).toBe(200);
  });

  it('forbids everything for a key with an empty allowlist (edge case 3.4)', async () => {
    const t = start();
    for (const model of ['fast', 'smart', 'auto']) {
      const res = await post(t, KEYS.locked, chatFor(model));
      expect(res.statusCode, model).toBe(403);
    }
  });

  it('is case-sensitive and exact, like model resolution', async () => {
    const t = start();
    // Not a known model at all: 404 comes first, never 403.
    expect((await post(t, KEYS.search, chatFor('FAST'))).statusCode).toBe(404);
  });

  it('answers 404 for an unknown model even when the key has an empty allowlist', async () => {
    const t = start();
    const res = await post(t, KEYS.locked, chatFor('no-such-model'));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('model_not_found');
  });

  it('does not consume rate limit or budget (no Redis or Postgres work)', async () => {
    const t = start();
    await post(t, KEYS.search, chatFor('smart'));
    expect(t.events).toEqual([]);
    expect(t.limiter.counts.size).toBe(0);
    expect(t.budget.reservations).toHaveLength(0);
  });
});

describe('requests per minute (check 5)', () => {
  it('admits up to the limit, then answers 429 with Retry-After and the envelope', async () => {
    const t = start();
    expect((await post(t, KEYS.slow)).statusCode).toBe(200);
    expect((await post(t, KEYS.slow)).statusCode).toBe(200);
    const res = await post(t, KEYS.slow);

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({
      type: 'rate_limit_exceeded',
      code: 'rate_limit_exceeded',
    });
    expect(res.headers['retry-after']).toBe('43'); // 42.5 s from the fake, rounded up
    expectContract(res);
  });

  it('logs the rejection and does not reach the budget (edge case 4.7)', async () => {
    const t = start();
    for (let i = 0; i < 3; i++) await post(t, KEYS.slow);
    await waitForLogs(t.logs, 3);

    expect(t.logs.entries.map((e) => e.status)).toEqual(['ok', 'ok', 'rejected_rate_limit']);
    expect(t.logs.entries[2]).toMatchObject({ httpStatus: 429, errorCode: 'rate_limit_exceeded' });
    expect(t.budget.reservations).toHaveLength(2); // the third request reserved nothing
  });

  it('counts each key separately', async () => {
    const t = start();
    for (let i = 0; i < 3; i++) await post(t, KEYS.slow);
    expect((await post(t, KEYS.search)).statusCode).toBe(200);
  });

  it('is not consulted for a request that fails earlier', async () => {
    const t = start();
    await post(t, null); // 401
    await post(t, KEYS.slow, { model: 'fast', messages: [] }); // 400
    await post(t, KEYS.slow, chatFor('nope')); // 404
    await post(t, KEYS.slow, chatFor('smart')); // 403
    expect(t.events).toEqual([]);
  });

  it('fails closed with 503 when the limiter cannot decide (edge case 4.4)', async () => {
    const t = start();
    t.limiter.failWith = new Error('Command timed out');
    const res = await post(t, KEYS.search);

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      type: 'service_unavailable',
      code: 'rate_limiter_unavailable',
    });
    expect(res.body).not.toContain('timed out');
    expectContract(res);
    expect(t.events).toEqual(['rate-limit']); // never proceeded to the budget
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'rejected_unavailable', httpStatus: 503 });
  });
});

describe('monthly budget (check 7)', () => {
  it('admits the first request of the budget-demo key and rejects the next with 402', async () => {
    const t = start();
    const first = await post(t, KEYS.demo);
    expect(first.statusCode).toBe(200);
    // The first request cost more than the whole budget (1000 units) and was still served.
    expect(t.budget.spent.get(4)!).toBeGreaterThan(1000n);

    const second = await post(t, KEYS.demo);
    expect(second.statusCode).toBe(402);
    expect(second.json().error).toMatchObject({
      type: 'budget_exceeded',
      code: 'budget_exceeded',
    });
    expectContract(second);
    await waitForLogs(t.logs, 2);
    expect(t.logs.entries[1]).toMatchObject({
      status: 'rejected_budget',
      httpStatus: 402,
      errorCode: 'budget_exceeded',
      keyId: 4,
    });
  });

  it('charges nothing for the rejected request', async () => {
    const t = start();
    await post(t, KEYS.demo);
    const spentAfterFirst = t.budget.spent.get(4);
    await post(t, KEYS.demo);
    await post(t, KEYS.demo);
    expect(t.budget.spent.get(4)).toBe(spentAfterFirst);
    expect(t.budget.reserved.get(4)).toBe(0n);
  });

  it('runs after the rate limit and the allowlist (check order)', async () => {
    const t = start();
    await post(t, KEYS.search);
    expect(t.events).toEqual(['rate-limit', 'budget-reserve', 'budget-settle']);
  });

  it('still spends a rate-limit slot on a request the budget then rejects', async () => {
    const t = start();
    await post(t, KEYS.demo);
    await post(t, KEYS.demo);
    expect(t.limiter.counts.get(4)).toBe(2);
  });

  it('answers 503 when the budget store is unreachable, with nothing held', async () => {
    const t = start();
    t.budget.failReserveWith = new Error('connect ECONNREFUSED 10.1.2.3:5432');
    const res = await post(t, KEYS.search);

    expect(res.statusCode).toBe(503);
    expect(res.json().error.type).toBe('service_unavailable');
    expect(res.body).not.toContain('ECONNREFUSED');
    expectContract(res);
    expect(t.budget.reservations).toHaveLength(0);
  });

  it('releases the hold when settlement fails, and answers 503 (edge case 5.6)', async () => {
    const t = start();
    t.budget.failSettleWith = new Error('deadlock detected');
    const res = await post(t, KEYS.search);

    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('deadlock');
    await t.app.close(); // waits for the background release
    expect(t.budget.released).toEqual([t.budget.reservations[0]!.requestId]);
    expect(t.budget.reserved.get(1)).toBe(0n);
    expect(t.budget.spent.get(1) ?? 0n).toBe(0n);
  });

  it('settles the reserved hold to the real cost: nothing stays in flight', async () => {
    const t = start();
    await Promise.all(Array.from({ length: 20 }, () => post(t, KEYS.search)));
    expect(t.budget.reserved.get(1)).toBe(0n);
    expect(t.budget.holds.size).toBe(0);
    expect(t.budget.settled).toHaveLength(20);
  });
});
