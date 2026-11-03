import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/providers/errors.js';
import {
  FakeAdapter,
  FakeRegistry,
  countWords,
  fakeReply,
  fakeUsage,
} from '../src/providers/fake.js';
import type { CallOptions, UpstreamRequest } from '../src/providers/types.js';

const request: UpstreamRequest = {
  model: 'alpha-small',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'What is a message queue?' },
  ],
  params: {},
};

const options = (
  overrides: Partial<CallOptions['timeouts']> = {},
  signal?: AbortSignal,
): CallOptions => ({
  timeouts: { firstByteMs: 200, idleMs: 200, deadlineMs: 1000, ...overrides },
  ...(signal === undefined ? {} : { signal }),
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('FakeAdapter (deterministic stand-in for a provider)', () => {
  it('answers the same prompt with the same reply and usage, every time', async () => {
    const adapter = new FakeAdapter('alpha');
    const a = await adapter.chatCompletion(request, options());
    const b = await adapter.chatCompletion(request, options());

    expect(a.content).toBe(b.content);
    expect(a.content).toBe(fakeReply('alpha', request));
    expect(a.usage).toEqual(b.usage);
    expect(a.usage).toEqual(fakeUsage('alpha', request));
  });

  it('counts tokens as whitespace-separated words, like the starter mocks', () => {
    expect(countWords('one two  three\nfour')).toBe(4);
    expect(countWords('   ')).toBe(1);
    expect(fakeUsage('alpha', request).promptTokens).toBe(2 + 5);
  });

  it('names the provider and model in the reply, so tests can see who answered', () => {
    expect(fakeReply('alpha', request)).toContain('[alpha:alpha-small]');
    expect(fakeReply('beta', { ...request, model: 'beta-small' })).toContain('[beta:beta-small]');
  });

  it('records every call, including the request', async () => {
    const adapter = new FakeAdapter('alpha');
    await adapter.chatCompletion(request, options());
    await collect(adapter.chatCompletionStream(request, options()));
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]?.request).toBe(request);
  });

  describe('failure injection', () => {
    it('plays a script of outcomes in order, then falls back', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.script.push(
        { type: 'error', kind: 'server_error', status: 503 },
        { type: 'error', kind: 'rate_limited', status: 429, retryAfterMs: 5000 },
      );

      const first = await adapter.chatCompletion(request, options()).catch((e: unknown) => e);
      const second = await adapter.chatCompletion(request, options()).catch((e: unknown) => e);
      const third = await adapter.chatCompletion(request, options());

      expect(first).toMatchObject({ kind: 'server_error', status: 503, disposition: 'retry' });
      expect(second).toMatchObject({
        kind: 'rate_limited',
        retryAfterMs: 5000,
        disposition: 'failover',
      });
      expect((third as { content: string }).content).toContain('[alpha:');
    });

    it('can be flipped "down" and back by changing the fallback', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.fallback = { type: 'error', kind: 'server_error', status: 503 };
      await expect(adapter.chatCompletion(request, options())).rejects.toBeInstanceOf(
        ProviderError,
      );
      adapter.fallback = { type: 'ok' };
      await expect(adapter.chatCompletion(request, options())).resolves.toBeDefined();
    });

    it('overrides content and usage', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.script.push({
        type: 'ok',
        content: 'custom',
        usage: { promptTokens: 1000, completionTokens: 2000 },
      });
      const reply = await adapter.chatCompletion(request, options());
      expect(reply.content).toBe('custom');
      expect(reply.usage).toEqual({ promptTokens: 1000, completionTokens: 2000 });
    });

    it('never error messages with anything but the provider name and kind', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.script.push({ type: 'error', kind: 'auth', status: 401 });
      const err = (await adapter
        .chatCompletion(request, options())
        .catch((e: unknown) => e)) as ProviderError;
      expect(err.message).toBe('provider "alpha" failed (auth)');
    });
  });

  describe('latency and timeouts honour the same limits as a real adapter', () => {
    it('answers after the configured latency', async () => {
      const adapter = new FakeAdapter('alpha', { latencyMs: 60 });
      const started = Date.now();
      await adapter.chatCompletion(request, options());
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    });

    it('times out when the latency exceeds the first-byte limit', async () => {
      const adapter = new FakeAdapter('alpha', { latencyMs: 3000 });
      const started = Date.now();
      const err = (await adapter
        .chatCompletion(request, options({ firstByteMs: 80 }))
        .catch((e: unknown) => e)) as ProviderError;
      expect(err.kind).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('times out a hanging provider and can be aborted', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.fallback = { type: 'hang' };
      const timedOut = (await adapter
        .chatCompletion(request, options({ firstByteMs: 60 }))
        .catch((e: unknown) => e)) as ProviderError;
      expect(timedOut.kind).toBe('timeout');

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 40);
      const aborted = (await adapter
        .chatCompletion(request, options({}, controller.signal))
        .catch((e: unknown) => e)) as ProviderError;
      expect(aborted.kind).toBe('aborted');
    });
  });

  describe('streaming', () => {
    it('streams the reply token by token, then a final chunk with usage', async () => {
      const adapter = new FakeAdapter('alpha');
      const chunks = await collect(adapter.chatCompletionStream(request, options()));

      expect(chunks.map((c) => c.content).join('')).toBe(fakeReply('alpha', request));
      expect(chunks.length).toBeGreaterThan(5);
      expect(chunks.at(-1)).toEqual({
        content: '',
        finishReason: 'stop',
        usage: fakeUsage('alpha', request),
      });
      expect(chunks.slice(0, -1).every((c) => c.usage === null)).toBe(true);
    });

    it('paces tokens when asked to', async () => {
      const adapter = new FakeAdapter('alpha', { tokenDelayMs: 15 });
      const started = Date.now();
      const chunks = await collect(adapter.chatCompletionStream(request, options()));
      expect(Date.now() - started).toBeGreaterThanOrEqual(15 * (chunks.length - 2));
    });

    it('fails before the first chunk (a safe-to-retry failure)', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.script.push({ type: 'error', kind: 'server_error', status: 500 });
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const chunk of adapter.chatCompletionStream(request, options()))
            seen.push(chunk.content);
        })(),
      ).rejects.toMatchObject({ kind: 'server_error' });
      expect(seen).toEqual([]);
    });

    it('dies mid-stream after the requested number of chunks', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.script.push({ type: 'die_mid_stream', afterChunks: 3 });
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const chunk of adapter.chatCompletionStream(request, options()))
            seen.push(chunk.content);
        })(),
      ).rejects.toMatchObject({ kind: 'connection' });
      expect(seen).toHaveLength(3);
    });

    it('can omit the usage object (edge case 9.6)', async () => {
      const adapter = new FakeAdapter('alpha');
      adapter.script.push({ type: 'no_usage' });
      const chunks = await collect(adapter.chatCompletionStream(request, options()));
      expect(chunks.every((c) => c.usage === null)).toBe(true);
    });

    it('times out when tokens arrive slower than the idle limit', async () => {
      const adapter = new FakeAdapter('alpha', { tokenDelayMs: 500 });
      await expect(
        collect(adapter.chatCompletionStream(request, options({ idleMs: 50 }))),
      ).rejects.toMatchObject({
        kind: 'timeout',
      });
    });
  });
});

describe('FakeRegistry', () => {
  it('holds one independent fake per provider', () => {
    const registry = new FakeRegistry(['alpha', 'beta']);
    expect(registry.get('alpha')).not.toBe(registry.get('beta'));
    expect(registry.get('gamma')).toBeUndefined();
    expect(() => registry.must('gamma')).toThrow(/no fake provider/);
    expect(registry.must('beta').name).toBe('beta');
  });
});
