import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { VirtualKey } from '../src/db/keys.js';
import type { KeyStore } from '../src/http/auth.js';
import { fakeReply, type FakeOutcome } from '../src/providers/fake.js';
import { KEYS, TENANTS, buildTestApp, waitForLogs, type TestApp } from './helpers/app.js';
import { MemoryCache, StubEmbedder, waitForEntries } from './helpers/memoryCache.js';

/** Keys of the cache tests: the cache is on (0.92) unless a test says otherwise. */
const SEARCH = KEYS.search; // id 1, cache on, 0.92, allowlist: fast
const OTHER = 'prism-sk-other-3t3t3t'; // id 11, cache on, 0.92 (another tenant)
const LOOSE = 'prism-sk-loose-4l4l4l'; // id 12, cache on, 0.85
const BOTH = 'prism-sk-both-5b5b5b'; // id 13, cache on, 0.92, fast + smart + auto
const NO_CACHE = KEYS.research; // id 2, cache OFF

const base = TENANTS[SEARCH]!;
const tenants: Record<string, VirtualKey> = {
  [SEARCH]: { ...base, cacheEnabled: true, cacheThreshold: 0.92 },
  [OTHER]: { ...base, id: 11, team: 'other', cacheEnabled: true, cacheThreshold: 0.92 },
  [LOOSE]: { ...base, id: 12, team: 'loose', cacheEnabled: true, cacheThreshold: 0.85 },
  [BOTH]: {
    ...base,
    id: 13,
    team: 'both',
    allowedModels: ['fast', 'smart', 'auto'],
    cacheEnabled: true,
    cacheThreshold: 0.92,
  },
  [NO_CACHE]: { ...TENANTS[NO_CACHE]!, cacheEnabled: false, cacheThreshold: null },
};
const keys: KeyStore = { findByRawKey: async (raw) => tenants[raw] ?? null };

interface Setup extends TestApp {
  cache: MemoryCache;
  embedder: StubEmbedder;
}

let current: TestApp | undefined;

afterEach(async () => {
  current?.app.server.closeAllConnections();
  await current?.app.close();
  current = undefined;
});

function start(overrides: Parameters<typeof buildTestApp>[0] = {}): Setup {
  const cache = new MemoryCache();
  const embedder = new StubEmbedder();
  const t = buildTestApp({ keys, cache, embedder, ...overrides });
  current = t;
  return Object.assign(t, { cache, embedder });
}

const A1 = 'How do I reset my password on the dashboard?';
const A2 = 'What are the steps to reset my dashboard password?';
const A3 = 'How do I reset my two-factor authentication on the dashboard?';
const UNRELATED = 'What is the boiling point of nitrogen?';

/** Vectors with chosen cosine similarities to A1 = [1, 0, 0]. */
function calibrated(embedder: StubEmbedder): void {
  embedder
    .set(A1, [1, 0, 0])
    .set(A2, [0.97, Math.sqrt(1 - 0.97 ** 2), 0])
    .set(A3, [0.74, Math.sqrt(1 - 0.74 ** 2), 0])
    .set(UNRELATED, [0, 0, 1]);
}

function ask(
  t: TestApp,
  content: string,
  options: {
    key?: string;
    model?: string;
    stream?: boolean;
    system?: string;
    extra?: Record<string, unknown>;
    messages?: { role: string; content: string }[];
  } = {},
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${options.key ?? SEARCH}` },
    payload: {
      model: options.model ?? 'fast',
      messages: options.messages ?? [
        ...(options.system === undefined ? [] : [{ role: 'system', content: options.system }]),
        { role: 'user', content },
      ],
      ...(options.stream ? { stream: true } : {}),
      ...options.extra,
    },
  });
}

function providerCalls(t: TestApp): number {
  return [...t.providers.adapters.values()].reduce((sum, a) => sum + a.calls.length, 0);
}

describe('semantic cache: hits and misses', () => {
  it('serves an identical repeat from the cache without calling a provider', async () => {
    const t = start();
    const first = await ask(t, A1);
    expect(first.headers['x-prism-cache']).toBe('miss');
    await waitForEntries(t.cache, 1);

    const second = await ask(t, A1);
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-prism-cache']).toBe('hit');
    expect(second.headers['x-prism-cost-usd']).toBe('0');
    expect(second.json().choices[0].message.content).toBe(first.json().choices[0].message.content);
    expect(second.json().model).toBe('fast');
    expect(providerCalls(t)).toBe(1);
  });

  it('records the hit: status, zero cost, the stored usage, no provider, nothing held', async () => {
    const t = start();
    const miss = await ask(t, A1);
    await waitForEntries(t.cache, 1);
    const spentAfterMiss = t.budget.spent.get(1)!;

    await ask(t, A1);
    await waitForLogs(t.logs, 2);
    expect(t.logs.entries[1]).toMatchObject({
      status: 'cache_hit',
      httpStatus: 200,
      cache: 'hit',
      costUnits: 0n,
      // The usage the client is shown for the stored answer (nothing was billed for it).
      promptTokens: miss.json().usage.prompt_tokens,
      completionTokens: miss.json().usage.completion_tokens,
      resolvedProvider: null,
      resolvedModel: null,
    });
    expect(t.logs.entries[0]!.cache ?? 'miss').toBe('miss');
    expect(t.budget.spent.get(1)).toBe(spentAfterMiss);
    expect(t.budget.holds.size).toBe(0);
    expect(t.budget.reserved.get(1)).toBe(0n);
  });

  it('hits a paraphrase and misses a similar-looking prompt with another intent (edge case 7.3)', async () => {
    const t = start();
    calibrated(t.embedder);
    await ask(t, A1);
    await waitForEntries(t.cache, 1);

    expect((await ask(t, A2)).headers['x-prism-cache']).toBe('hit');
    expect((await ask(t, A3)).headers['x-prism-cache']).toBe('miss');
    expect((await ask(t, UNRELATED)).headers['x-prism-cache']).toBe('miss');
  });

  it('answers a hit as the stored answer, whatever the paraphrase says', async () => {
    const t = start();
    calibrated(t.embedder);
    const first = await ask(t, A1);
    await waitForEntries(t.cache, 1);
    const hit = await ask(t, A2);
    expect(hit.json().choices[0].message.content).toBe(first.json().choices[0].message.content);
    expect(hit.json().choices[0].message.content).toBe(
      fakeReply('alpha', {
        model: 'alpha-small',
        messages: [{ role: 'user', content: A1 }],
        params: {},
      }),
    );
  });

  it('uses each key’s own threshold (edge case 7.7)', async () => {
    const t = start();
    // 0.88 similar: above the 0.85 key's threshold, below the 0.92 key's.
    t.embedder.set(A1, [1, 0, 0]).set(A2, [0.88, Math.sqrt(1 - 0.88 ** 2), 0]);
    for (const key of [SEARCH, LOOSE]) {
      await ask(t, A1, { key });
      await waitForEntries(t.cache, key === SEARCH ? 1 : 2);
    }
    expect((await ask(t, A2, { key: SEARCH })).headers['x-prism-cache']).toBe('miss');
    expect((await ask(t, A2, { key: LOOSE })).headers['x-prism-cache']).toBe('hit');
  });
});

describe('semantic cache: tenant isolation (edge cases 7.1, 7.2)', () => {
  it('does not serve one key’s cached answer to another key, even for the same paraphrase', async () => {
    const t = start();
    calibrated(t.embedder);
    await ask(t, A1, { key: SEARCH });
    await waitForEntries(t.cache, 1);
    expect((await ask(t, A1, { key: SEARCH })).headers['x-prism-cache']).toBe('hit');

    const callsBefore = providerCalls(t);
    const other = await ask(t, A2, { key: OTHER });
    expect(other.headers['x-prism-cache']).toBe('miss');
    expect(providerCalls(t)).toBe(callsBefore + 1);
    // The lookup was scoped to the asking tenant, in the query itself.
    expect(t.cache.lookups.at(-1)!.keyId).toBe(11);
  });

  it('stores every entry under its owner’s key id', async () => {
    const t = start();
    await Promise.all([ask(t, A1, { key: SEARCH }), ask(t, A1, { key: OTHER })]);
    await waitForEntries(t.cache, 2);
    expect(t.cache.entries.map((e) => e.keyId).sort()).toEqual([1, 11]);
  });
});

describe('semantic cache: scope (edge cases 7.4, 7.5)', () => {
  it('misses when the system prompt differs', async () => {
    const t = start();
    await ask(t, A1, { system: 'Be brief.' });
    await waitForEntries(t.cache, 1);
    expect((await ask(t, A1, { system: 'Be brief.' })).headers['x-prism-cache']).toBe('hit');
    expect((await ask(t, A1, { system: 'Be verbose.' })).headers['x-prism-cache']).toBe('miss');
    expect((await ask(t, A1)).headers['x-prism-cache']).toBe('miss');
  });

  it('misses when an earlier turn differs, though the last message is identical', async () => {
    const t = start();
    const turns = (first: string) => [
      { role: 'user', content: first },
      { role: 'assistant', content: 'An answer.' },
      { role: 'user', content: 'What happens when the pool is exhausted?' },
    ];
    await ask(t, '', { messages: turns('What is connection pooling?') });
    await waitForEntries(t.cache, 1);
    const same = await ask(t, '', { messages: turns('What is connection pooling?') });
    const different = await ask(t, '', { messages: turns('What is a thread pool?') });
    expect(same.headers['x-prism-cache']).toBe('hit');
    expect(different.headers['x-prism-cache']).toBe('miss');
  });

  it.each([
    ['temperature', { temperature: 0.9 }],
    ['top_p', { top_p: 0.4 }],
    ['max_tokens', { max_tokens: 30 }],
  ])('misses when %s differs', async (_name, extra) => {
    const t = start();
    await ask(t, A1);
    await waitForEntries(t.cache, 1);
    expect((await ask(t, A1, { extra })).headers['x-prism-cache']).toBe('miss');
  });

  it('keeps tiers apart: a fast answer never serves a smart request', async () => {
    const t = start();
    await ask(t, A1, { key: BOTH, model: 'fast' });
    await waitForEntries(t.cache, 1);
    expect((await ask(t, A1, { key: BOTH, model: 'smart' })).headers['x-prism-cache']).toBe('miss');
    expect((await ask(t, A1, { key: BOTH, model: 'fast' })).headers['x-prism-cache']).toBe('hit');
    await waitForEntries(t.cache, 2);
    expect(t.cache.entries.map((e) => e.alias).sort()).toEqual(['fast', 'smart']);
  });

  it('scopes `auto` by the tier it chose', async () => {
    const t = start();
    await ask(t, A1, { key: BOTH, model: 'auto' });
    await waitForEntries(t.cache, 1);
    expect(t.cache.entries[0]!.alias).toBe('fast');
    expect((await ask(t, A1, { key: BOTH, model: 'fast' })).headers['x-prism-cache']).toBe('hit');
  });
});

describe('semantic cache: when it is off or must not be used', () => {
  it('does nothing for a key with the cache disabled (edge case 7.6)', async () => {
    const t = start();
    await ask(t, A1, { key: NO_CACHE });
    const second = await ask(t, A1, { key: NO_CACHE });
    expect(second.headers['x-prism-cache']).toBe('miss');
    expect(t.embedder.embedCalls).toEqual([]);
    expect(t.cache.lookups).toEqual([]);
    expect(t.cache.entries).toEqual([]);
    expect(providerCalls(t)).toBe(2);
  });

  it('never caches or looks up a time-sensitive prompt (edge case 7.11)', async () => {
    const t = start();
    const prompt = 'What is the current status of the payments service?';
    await ask(t, prompt);
    const second = await ask(t, prompt);
    expect(second.headers['x-prism-cache']).toBe('miss');
    expect(t.cache.entries).toEqual([]);
    expect(t.embedder.embedCalls).toEqual([]);
  });

  it('does not cache an error response (edge case 7.10)', async () => {
    const t = start();
    const down: FakeOutcome = { type: 'error', kind: 'server_error', status: 503 };
    for (const adapter of t.providers.adapters.values()) adapter.fallback = down;
    const failed = await ask(t, A1);
    expect(failed.statusCode).toBe(502);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.cache.entries).toEqual([]);
    for (const adapter of t.providers.adapters.values()) adapter.fallback = { type: 'ok' };
    expect((await ask(t, A1)).headers['x-prism-cache']).toBe('miss');
  });

  it('caches an answer served by a fallback, recording the provider that produced it (edge case 7.12)', async () => {
    const t = start();
    t.providers.must('alpha').fallback = { type: 'error', kind: 'server_error', status: 503 };
    const first = await ask(t, A1);
    expect(first.headers['x-prism-fallback']).toBe('true');
    await waitForEntries(t.cache, 1);
    expect(t.cache.entries[0]!.response.provider).toBe('beta');

    const hit = await ask(t, A1);
    expect(hit.headers['x-prism-cache']).toBe('hit');
    // No provider served the hit; the entry itself remembers who produced the answer.
    expect(hit.headers['x-prism-provider']).toBe('none');
  });

  it('skips the cache while the embedding model is still loading (edge case 7.20)', async () => {
    const t = start();
    t.embedder.ready_ = false;
    const res = await ask(t, A1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-cache']).toBe('miss');
    expect(t.embedder.embedCalls).toEqual([]);
    expect(t.cache.entries).toEqual([]);
  });
});

describe('semantic cache never fails a request (edge case 7.13)', () => {
  it('serves the request when embedding fails', async () => {
    const t = start();
    t.embedder.failWith = new Error('model crashed');
    const res = await ask(t, A1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-cache']).toBe('miss');
    expect(t.cache.entries).toEqual([]);
  });

  it('serves the request when the cache lookup fails, and still stores the answer', async () => {
    const t = start();
    t.cache.failLookup = new Error('database down');
    const res = await ask(t, A1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-cache']).toBe('miss');
    await waitForEntries(t.cache, 1);
    expect(t.cache.entries).toHaveLength(1);
  });

  it('serves the request when the cache write fails', async () => {
    const t = start();
    t.cache.failWrite = new Error('database down');
    const res = await ask(t, A1);
    expect(res.statusCode).toBe(200);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'ok' });
  });
});

describe('semantic cache and streaming (edge cases 7.8, 7.9)', () => {
  function sse(res: LightMyRequestResponse): { payloads: string[]; text: string } {
    const payloads = res.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    const text = payloads
      .filter((p) => p !== '[DONE]')
      .map((p) => JSON.parse(p).choices[0]?.delta?.content ?? '')
      .join('');
    return { payloads, text };
  }

  it('caches a completed stream and replays it as one chunk plus [DONE]', async () => {
    const t = start();
    const miss = await ask(t, A1, { stream: true });
    expect(miss.headers['x-prism-cache']).toBe('miss');
    await waitForEntries(t.cache, 1);
    const streamed = sse(miss).text;
    expect(t.cache.entries[0]!.response.content).toBe(streamed);

    const hit = await ask(t, A1, { stream: true });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers['x-prism-cache']).toBe('hit');
    expect(hit.headers['content-type']).toMatch(/text\/event-stream/);
    const replay = sse(hit);
    expect(replay.text).toBe(streamed);
    expect(replay.payloads.at(-1)).toBe('[DONE]');
    const contentChunks = replay.payloads
      .filter((p) => p !== '[DONE]')
      .filter((p) => (JSON.parse(p).choices[0]?.delta?.content ?? '') !== '');
    expect(contentChunks).toHaveLength(1);
    expect(providerCalls(t)).toBe(1);
  });

  it('serves a stream-cached answer to a non-streaming request, and the reverse', async () => {
    const t = start();
    const streamed = await ask(t, A1, { stream: true });
    await waitForEntries(t.cache, 1);
    const plain = await ask(t, A1);
    expect(plain.headers['x-prism-cache']).toBe('hit');
    expect(plain.json().choices[0].message.content).toBe(sse(streamed).text);
  });

  it('does not cache a stream that died midway', async () => {
    const t = start();
    t.providers.must('alpha').script.push({ type: 'die_mid_stream', afterChunks: 2 });
    const res = await ask(t, A1, { stream: true });
    expect(res.body).toContain('event: error');
    await waitForLogs(t.logs, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.cache.entries).toEqual([]);
  });
});
