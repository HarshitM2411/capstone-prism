import { afterEach, describe, expect, it } from 'vitest';
import { formatUsd, toSqlNumeric } from '../src/money.js';
import type { FakeOutcome } from '../src/providers/fake.js';
import { KEYS, buildTestApp, waitForLogs, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

const down: FakeOutcome = { type: 'error', kind: 'server_error', status: 503 };

/**
 * Expected costs, worked out by hand from `data/model_pricing.json` (USD per 1M tokens):
 *   tokens × price / 1,000,000, summed over input and output. Written as decimal strings so the
 *   test does not reuse the code under test.
 */
const CASES: {
  label: string;
  alias: 'fast' | 'smart';
  primaryDown: boolean;
  served: string;
  prompt: number;
  completion: number;
  expected: string;
}[] = [
  // 1000 × 0.15/1M = 0.00015 ; 500 × 0.60/1M = 0.0003
  {
    label: 'alpha-small',
    alias: 'fast',
    primaryDown: false,
    served: 'alpha/alpha-small',
    prompt: 1000,
    completion: 500,
    expected: '0.00045',
  },
  // 2000 × 3/1M = 0.006 ; 1000 × 15/1M = 0.015
  {
    label: 'alpha-large',
    alias: 'smart',
    primaryDown: false,
    served: 'alpha/alpha-large',
    prompt: 2000,
    completion: 1000,
    expected: '0.021',
  },
  // 12345 × 0.10/1M = 0.0012345 ; 6789 × 0.40/1M = 0.0027156
  {
    label: 'beta-small',
    alias: 'fast',
    primaryDown: true,
    served: 'beta/beta-small',
    prompt: 12345,
    completion: 6789,
    expected: '0.0039501',
  },
  // 100000 × 2.50/1M = 0.25 ; 50000 × 10/1M = 0.5
  {
    label: 'beta-large',
    alias: 'smart',
    primaryDown: true,
    served: 'beta/beta-large',
    prompt: 100000,
    completion: 50000,
    expected: '0.75',
  },
  // Smallest amounts: 1 × 0.15/1M = 0.00000015 ; 1 × 0.60/1M = 0.0000006
  {
    label: 'alpha-small, one token each way',
    alias: 'fast',
    primaryDown: false,
    served: 'alpha/alpha-small',
    prompt: 1,
    completion: 1,
    expected: '0.00000075',
  },
  // Output only, and input only
  {
    label: 'alpha-large, output only',
    alias: 'smart',
    primaryDown: false,
    served: 'alpha/alpha-large',
    prompt: 0,
    completion: 1,
    expected: '0.000015',
  },
  {
    label: 'beta-large, input only',
    alias: 'smart',
    primaryDown: true,
    served: 'beta/beta-large',
    prompt: 1,
    completion: 0,
    expected: '0.0000025',
  },
];

describe('cost per model and pricing tier (eval E5)', () => {
  it.each(CASES)(
    '$label: $prompt in / $completion out costs $expected',
    async ({ alias, primaryDown, served, prompt, completion, expected }) => {
      current = buildTestApp();
      if (primaryDown) current.providers.must('alpha').fallback = down;
      // The provider reports exact token counts, so the cost depends only on the price.
      const target = current.providers.must(primaryDown ? 'beta' : 'alpha');
      target.fallback = {
        type: 'ok',
        usage: { promptTokens: prompt, completionTokens: completion },
      };

      const res = await current.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.research}` },
        payload: JSON.stringify({ model: alias, messages: [{ role: 'user', content: 'Hello' }] }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['x-prism-provider']).toBe(served);
      expect(res.headers['x-prism-cost-usd']).toBe(expected);
      expect(res.json().usage).toMatchObject({
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
      });

      // What is logged and what is charged to the budget is the very same amount.
      await waitForLogs(current.logs, 1);
      const logged = current.logs.entries[0]!.costUnits!;
      expect(formatUsd(logged)).toBe(expected);
      expect(current.budget.spent.get(2)).toBe(logged);
    },
  );

  it('prints at most 8 decimals and never an exponent', async () => {
    current = buildTestApp();
    current.providers.must('alpha').fallback = {
      type: 'ok',
      usage: { promptTokens: 1, completionTokens: 0 },
    };
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.research}` },
      payload: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    // 1 × 0.15/1M = 0.00000015 USD.
    expect(res.headers['x-prism-cost-usd']).toBe('0.00000015');
    expect(res.headers['x-prism-cost-usd']).not.toMatch(/e/i);
  });

  it('charges a fallback the fallback model price, not the requested alias price', async () => {
    current = buildTestApp();
    current.providers.must('alpha').fallback = down;
    current.providers.must('beta').fallback = {
      type: 'ok',
      usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    };
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.research}` },
      payload: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    // beta-small: 0.10 + 0.40 per million tokens each way. alpha-small would be 0.75.
    expect(res.headers['x-prism-cost-usd']).toBe('0.5');
  });

  it('formats money as exact decimal text for the admin API', () => {
    expect(toSqlNumeric(45_000n)).toBe('0.00045000');
  });
});
