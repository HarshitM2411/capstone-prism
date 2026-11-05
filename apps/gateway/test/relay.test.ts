import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/providers/errors.js';
import type { UpstreamChunk } from '../src/providers/types.js';
import type { OpenedStream } from '../src/routing/executor.js';
import {
  WordCounter,
  createSseBody,
  resolveStreamUsage,
  type RelayOptions,
  type StreamSummary,
} from '../src/streaming/relay.js';

const text = (content: string, finishReason: string | null = null): UpstreamChunk => ({
  content,
  finishReason,
  usage: null,
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

interface Harness {
  opened: OpenedStream;
  /** How many chunks the source has been asked for. */
  pulled: () => number;
  aborted: () => number;
  /** Lets a source that is stuck waiting finish with an abort error. */
  hang: () => void;
}

/**
 * A source stream built from `chunks`. After them it either ends, fails with `error`, or (with
 * `stall`) waits until it is aborted, like a provider that stopped talking.
 */
async function source(
  chunks: UpstreamChunk[],
  options: { error?: ProviderError; stall?: boolean } = {},
): Promise<Harness> {
  let pulled = 0;
  let aborted = 0;
  let release: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => (release = resolve));

  async function* generate(): AsyncGenerator<UpstreamChunk> {
    for (const chunk of chunks) {
      pulled++;
      yield chunk;
    }
    if (options.stall === true) {
      await stalled;
      throw new ProviderError('aborted', 'alpha', 'the call was aborted by the caller');
    }
    if (options.error !== undefined) throw options.error;
  }

  const iterator = generate();
  const first = await iterator.next();
  return {
    opened: {
      first,
      iterator,
      abort: () => {
        aborted++;
        release?.();
      },
    },
    pulled: () => pulled,
    aborted: () => aborted,
    hang: () => release?.(),
  };
}

function relay(harness: Harness, overrides: Partial<RelayOptions> = {}) {
  const res = new FakeResponse();
  const ends: StreamSummary[] = [];
  const sse = createSseBody({
    opened: harness.opened,
    res: res as unknown as RelayOptions['res'],
    id: 'chatcmpl-1',
    created: 1,
    model: 'fast',
    includeUsage: false,
    promptTokensEstimate: 5,
    maxDurationMs: 5000,
    elapsedMs: () => 7,
    onEnd: async (summary) => {
      ends.push(summary);
    },
    ...overrides,
  });
  return { ...sse, res, ends };
}

async function readAll(body: Readable): Promise<string> {
  let out = '';
  for await (const part of body) out += (part as Buffer).toString('utf8');
  return out;
}

/** The `data:` payloads of an SSE body, in order. */
function dataLines(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6));
}

describe('WordCounter', () => {
  it('counts words across chunk boundaries', () => {
    const counter = new WordCounter();
    for (const part of ['Hel', 'lo wor', 'ld ', ' and', ' more\n']) counter.add(part);
    expect(counter.count).toBe(4);
  });

  it('counts nothing for empty or whitespace-only text', () => {
    const counter = new WordCounter();
    counter.add('');
    counter.add('  \n ');
    expect(counter.count).toBe(0);
  });
});

describe('resolveStreamUsage (edge cases 5.8, 9.6)', () => {
  it('prefers the provider-reported usage', () => {
    expect(
      resolveStreamUsage(
        { usage: { promptTokens: 9, completionTokens: 4 }, deliveredTokens: 100 },
        5,
      ),
    ).toEqual({ usage: { promptTokens: 9, completionTokens: 4 }, estimated: false });
  });

  it('estimates from the delivered text when the provider never reported usage', () => {
    expect(resolveStreamUsage({ usage: null, deliveredTokens: 12 }, 5)).toEqual({
      usage: { promptTokens: 5, completionTokens: 12 },
      estimated: true,
    });
  });

  it('bills nothing when nothing was delivered', () => {
    expect(resolveStreamUsage({ usage: null, deliveredTokens: 0 }, 5)).toEqual({
      usage: { promptTokens: 0, completionTokens: 0 },
      estimated: true,
    });
  });

  it('does not trust a usage object that reports zero tokens', () => {
    expect(
      resolveStreamUsage({ usage: { promptTokens: 0, completionTokens: 0 }, deliveredTokens: 3 }, 5)
        .estimated,
    ).toBe(true);
  });
});

describe('the SSE relay', () => {
  it('relays chunks as OpenAI deltas, ends with one [DONE], and reports what it delivered', async () => {
    const harness = await source([
      text('Hello '),
      text('brave '),
      text('world', null),
      { content: '', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 3 } },
    ]);
    const { body, done, ends } = relay(harness);
    const out = await readAll(body);
    await done;

    const lines = dataLines(out);
    expect(lines.filter((l) => l === '[DONE]')).toHaveLength(1);
    expect(lines.at(-1)).toBe('[DONE]');
    const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'Hello ' });
    expect(chunks[1].choices[0].delta).toEqual({ content: 'brave ' });
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
    expect(chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === 'fast')).toBe(
      true,
    );
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('Hello brave world');

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      end: 'complete',
      usage: { promptTokens: 3, completionTokens: 3 },
      deliveredTokens: 3,
      timeToFirstTokenMs: 7,
      failure: null,
    });
  });

  it('adds a final usage chunk only when the client asked for it', async () => {
    const withUsage = async (includeUsage: boolean): Promise<string[]> => {
      const harness = await source([
        text('Hi '),
        { content: '', finishReason: 'stop', usage: { promptTokens: 2, completionTokens: 1 } },
      ]);
      const { body } = relay(harness, { includeUsage });
      return dataLines(await readAll(body));
    };
    const yes = await withUsage(true);
    const usageChunk = JSON.parse(yes.at(-2)!);
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
    const no = await withUsage(false);
    expect(no.some((l) => l !== '[DONE]' && 'usage' in JSON.parse(l))).toBe(false);
  });

  it('ends an empty stream with a valid terminal sequence and zero tokens (edge case 9.10)', async () => {
    const harness = await source([]);
    const { body, ends, done } = relay(harness);
    const lines = dataLines(await readAll(body));
    await done;
    expect(lines.at(-1)).toBe('[DONE]');
    expect(JSON.parse(lines[0]!).choices[0].finish_reason).toBe('stop');
    expect(ends[0]).toMatchObject({ end: 'complete', deliveredTokens: 0, usage: null });
  });

  it('adds a stop chunk when the provider never sent a finish reason', async () => {
    const harness = await source([text('only text')]);
    const { body } = relay(harness);
    const lines = dataLines(await readAll(body));
    const last = JSON.parse(lines.at(-2)!);
    expect(last.choices[0].finish_reason).toBe('stop');
  });

  it('a provider failure after the first chunk is an error event, then [DONE] (edge case 9.2)', async () => {
    const failure = new ProviderError('connection', 'alpha', 'closed the stream early');
    const harness = await source([text('one '), text('two ')], { error: failure });
    const { body, done, ends } = relay(harness);
    const out = await readAll(body);
    await done;

    expect(out).toContain('event: error\n');
    const errorAt = out.indexOf('event: error');
    expect(out.indexOf('data: [DONE]')).toBeGreaterThan(errorAt);
    expect(dataLines(out).filter((l) => l === '[DONE]')).toHaveLength(1);
    expect(out).not.toContain('closed the stream early'); // the provider's detail never leaks
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ end: 'upstream_failed', deliveredTokens: 2, usage: null });
    expect(ends[0]!.failure?.kind).toBe('connection');
  });

  it('reports a client that went away, and stops the provider (edge case 9.1)', async () => {
    const harness = await source([text('one '), text('two '), text('three ')], { stall: true });
    const { body, done, ends, res } = relay(harness);

    const reader = body[Symbol.asyncIterator]();
    await reader.next(); // the client reads a little...
    res.emit('close'); // ...then its connection drops
    body.destroy();
    await done;

    expect(harness.aborted()).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.end).toBe('client_disconnect');
    expect(ends[0]!.deliveredTokens).toBeGreaterThan(0);
  });

  it('settles a stream that was destroyed before it was ever read', async () => {
    const harness = await source([text('one '), text('two ')]);
    const { body, done, ends } = relay(harness);
    body.destroy();
    await done;
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ end: 'client_disconnect', deliveredTokens: 0 });
  });

  it('runs onEnd exactly once however the stream ends', async () => {
    const harness = await source([text('a '), text('b ')]);
    const { body, done, ends, res } = relay(harness);
    await readAll(body);
    res.emit('close');
    body.destroy();
    await done;
    expect(ends).toHaveLength(1);
  });

  it('is pull-based: a client that stops reading does not make it read the whole upstream', async () => {
    const many = Array.from({ length: 20_000 }, () => text('word '));
    const harness = await source(many);
    const { body, done } = relay(harness);

    const reader = body[Symbol.asyncIterator]();
    await reader.next();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Bounded by the stream's small buffer, not by the size of the answer (edge case 9.5).
    expect(harness.pulled()).toBeLessThan(2000);
    body.destroy();
    await done;
  });

  it('ends a stream that outlasts the maximum duration, even with a stalled provider', async () => {
    const harness = await source([text('one ')], { stall: true });
    const { body, done, ends, res } = relay(harness, { maxDurationMs: 60 });
    const reader = body[Symbol.asyncIterator]();
    await reader.next();
    await done;
    expect(res.destroyed).toBe(true);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.end).toBe('upstream_failed');
    expect(harness.aborted()).toBeGreaterThan(0);
  });
});

describe('collecting the text for the cache', () => {
  it('keeps the full text and finish reason of a stream that completed', async () => {
    const harness = await source([text('Hello '), text('world', 'stop')]);
    const r = relay(harness, { collectMaxChars: 100 });
    await readAll(r.body);
    await r.done;
    expect(r.ends[0]).toMatchObject({
      end: 'complete',
      content: 'Hello world',
      finishReason: 'stop',
    });
  });

  it('keeps nothing unless asked to', async () => {
    const harness = await source([text('Hello', 'stop')]);
    const r = relay(harness);
    await readAll(r.body);
    await r.done;
    expect(r.ends[0]!.content).toBeNull();
  });

  it('gives up on an answer larger than the cap', async () => {
    const harness = await source([text('aaaa'), text('bbbb', 'stop')]);
    const r = relay(harness, { collectMaxChars: 6 });
    await readAll(r.body);
    await r.done;
    expect(r.ends[0]!.end).toBe('complete');
    expect(r.ends[0]!.content).toBeNull();
  });

  it('never offers the text of a stream that failed midway', async () => {
    const harness = await source([text('partial ')], {
      error: new ProviderError('server_error', 'alpha', 'boom', 500),
    });
    const r = relay(harness, { collectMaxChars: 100 });
    await readAll(r.body);
    await r.done;
    expect(r.ends[0]!.end).toBe('upstream_failed');
    expect(r.ends[0]!.content).toBeNull();
  });
});
