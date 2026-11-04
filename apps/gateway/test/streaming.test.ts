import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { computeCostUnits } from '../src/money.js';
import { countWords, fakeReply, fakeUsage, type FakeOutcome } from '../src/providers/fake.js';
import type { UpstreamRequest } from '../src/providers/types.js';
import { KEYS, TENANTS, buildTestApp, config, waitForLogs, type TestApp } from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  // A client that was aborted may have left a fresh, idle connection behind (undici reconnects);
  // closing it explicitly keeps `close()` from waiting on it.
  current?.app.server.closeAllConnections();
  await current?.app.close();
  current = undefined;
});

function start(overrides: Parameters<typeof buildTestApp>[0] = {}, tokenDelayMs = 0): TestApp {
  current = buildTestApp(overrides, { tokenDelayMs });
  return current;
}

const PROMPT = 'What is a message queue?';
const PROMPT_WORDS = 5;
const RESEARCH_ID = TENANTS[KEYS.research]!.id;
const ALPHA_SMALL = config.models.get('alpha-small')!;

function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'fast',
    stream: true,
    messages: [{ role: 'user', content: PROMPT }],
    ...extra,
  });
}

function post(
  t: TestApp,
  extra: Record<string, unknown> = {},
  key: string = KEYS.research,
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    payload: body(extra),
  });
}

/** The `data:` payloads of an SSE body, in order. */
function dataLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6));
}

function contentOf(text: string): string {
  return dataLines(text)
    .filter((line) => line !== '[DONE]' && !line.includes('"error"'))
    .map((line) => JSON.parse(line).choices[0]?.delta?.content ?? '')
    .join('');
}

const down: FakeOutcome = { type: 'error', kind: 'server_error', status: 503 };

function spent(t: TestApp): bigint {
  return t.budget.spent.get(RESEARCH_ID) ?? 0n;
}

describe('a streamed completion (eval E5)', () => {
  it('relays the provider reply as SSE and ends with exactly one [DONE]', async () => {
    const t = start();
    const res = await post(t);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const upstream = t.providers.must('alpha').calls[0]!.request;
    const lines = dataLines(res.body);
    expect(lines.filter((l) => l === '[DONE]')).toHaveLength(1);
    expect(lines.at(-1)).toBe('[DONE]');
    expect(contentOf(res.body)).toBe(fakeReply('alpha', upstream));

    const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(chunks.every((c) => c.model === 'fast')).toBe(true); // what the client asked for
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
  });

  it('carries the header contract, without a cost header (edge case 9.7)', async () => {
    const t = start();
    const res = await post(t);
    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(res.headers['x-prism-cache']).toBe('miss');
    expect(res.headers['x-prism-fallback']).toBe('false');
    expect(res.headers).not.toHaveProperty('x-prism-cost-usd');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('sends the upstream request with the provider-side model id and the client parameters', async () => {
    const t = start();
    await post(t, { temperature: 0.2, max_tokens: 50 });
    const upstream: UpstreamRequest = t.providers.must('alpha').calls[0]!.request;
    expect(upstream.model).toBe('alpha-small');
    expect(upstream.params).toMatchObject({ temperature: 0.2, max_tokens: 50 });
  });

  it('meters it from the final usage chunk: one log row, tokens, cost, first-token time', async () => {
    const t = start();
    const res = await post(t);
    await waitForLogs(t.logs, 1);

    const upstream = t.providers.must('alpha').calls[0]!.request;
    const usage = fakeUsage('alpha', upstream);
    const cost = computeCostUnits(usage.promptTokens, usage.completionTokens, ALPHA_SMALL);
    expect(cost).toBeGreaterThan(0n);
    expect(t.logs.entries[0]).toMatchObject({
      requestId: res.headers['x-request-id'],
      status: 'ok',
      httpStatus: 200,
      errorCode: null,
      resolvedProvider: 'alpha',
      resolvedModel: 'alpha-small',
      fallback: false,
      retries: 0,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUnits: cost,
      usageEstimated: false,
    });
    expect(t.logs.entries[0]!.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    // Budget and log agree, and the hold is gone (edge case 5.5).
    expect(spent(t)).toBe(cost);
    expect(t.budget.holds.size).toBe(0);
    expect(t.budget.reserved.get(RESEARCH_ID) ?? 0n).toBe(0n);
  });

  it('bills the same as the identical non-streaming request', async () => {
    const t = start();
    await post(t);
    await waitForLogs(t.logs, 1);
    const streamed = t.logs.entries[0]!.costUnits;
    const plain = await post(t, { stream: false });
    await waitForLogs(t.logs, 2);
    expect(plain.statusCode).toBe(200);
    expect(t.logs.entries[1]!.costUnits).toBe(streamed);
  });

  it('adds a final usage chunk only when stream_options.include_usage is set', async () => {
    const t = start();
    const without = dataLines((await post(t)).body);
    expect(without.some((l) => l !== '[DONE]' && 'usage' in JSON.parse(l))).toBe(false);

    const withUsage = dataLines((await post(t, { stream_options: { include_usage: true } })).body);
    const last = JSON.parse(withUsage.at(-2)!);
    const usage = fakeUsage('alpha', t.providers.must('alpha').calls[1]!.request);
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    });
  });

  it('counts one RPM hit and writes exactly one log row per streamed request (edge case 10.1)', async () => {
    const t = start();
    await post(t);
    await post(t);
    await waitForLogs(t.logs, 2);
    expect(t.limiter.counts.get(RESEARCH_ID)).toBe(2);
    expect(new Set(t.logs.entries.map((e) => e.requestId)).size).toBe(2);
  });
});

describe('before the first chunk the stream retries and fails over (edge cases 8.14, 9.7)', () => {
  it('retries a transient failure on the same model, invisibly', async () => {
    const t = start();
    t.providers.must('alpha').script.push(down);
    const res = await post(t);

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(res.headers['x-prism-fallback']).toBe('false');
    expect(t.providers.must('alpha').calls).toHaveLength(2);
    expect(dataLines(res.body).at(-1)).toBe('[DONE]');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'ok', retries: 1, fallback: false });
  });

  it('fails over to the next model when the primary is down, and the headers say so', async () => {
    const t = start();
    t.providers.must('alpha').fallback = down;
    const res = await post(t);

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('beta/beta-small');
    expect(res.headers['x-prism-fallback']).toBe('true');
    expect(contentOf(res.body)).toContain('[beta:beta-small]');
    expect(dataLines(res.body)).not.toContain('[DONE][DONE]');
    expect(res.body).not.toContain('event: error');

    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      status: 'ok',
      resolvedProvider: 'beta',
      resolvedModel: 'beta-small',
      fallback: true,
      retries: 2,
    });
    // Billed once, at the model that answered.
    const usage = fakeUsage('beta', t.providers.must('beta').calls[0]!.request);
    const beta = config.models.get('beta-small')!;
    expect(spent(t)).toBe(computeCostUnits(usage.promptTokens, usage.completionTokens, beta));
  });

  it('fails over at once on a provider 429', async () => {
    const t = start();
    t.providers.must('alpha').fallback = { type: 'error', kind: 'rate_limited', status: 429 };
    const res = await post(t);
    expect(res.headers['x-prism-provider']).toBe('beta/beta-small');
    expect(t.providers.must('alpha').calls).toHaveLength(1);
  });

  it('a provider that never starts answering is abandoned within the deadline', async () => {
    const t = start();
    t.providers.must('alpha').fallback = { type: 'hang' };
    const started = Date.now();
    const res = await post(t);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('beta/beta-small');
    expect(Date.now() - started).toBeLessThan(2200);
    expect(t.providers.must('alpha').streamsInFlight).toBe(0);
  });

  it('when nothing answers, it is a normal JSON 502, not an SSE body, and nothing is billed', async () => {
    const t = start();
    t.providers.must('alpha').fallback = down;
    t.providers.must('beta').fallback = down;
    const res = await post(t);

    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().error).toMatchObject({ type: 'upstream_error', code: 'upstream_error' });
    expect(res.body).not.toContain('data:');

    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'upstream_error', httpStatus: 502 });
    expect(spent(t)).toBe(0n);
    expect(t.budget.holds.size).toBe(0);
    expect(t.budget.released).toHaveLength(1);
  });

  it('a non-retryable provider error is a 502 without failover', async () => {
    const t = start();
    t.providers.must('alpha').fallback = { type: 'error', kind: 'auth', status: 401 };
    const res = await post(t);
    expect(res.statusCode).toBe(502);
    expect(t.providers.must('beta').calls).toHaveLength(0);
  });
});

describe('a failure after the first chunk (edge cases 8.14, 9.2, 5.8)', () => {
  it('ends with an error event and [DONE]; never switches provider; bills what was delivered', async () => {
    const t = start();
    t.providers.must('alpha').script.push({ type: 'die_mid_stream', afterChunks: 3 });
    const res = await post(t);

    // The headers were already sent: the status stays 200 and the failure is in the stream.
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-prism-provider']).toBe('alpha/alpha-small');
    expect(res.body).toContain('event: error\n');
    expect(res.body.indexOf('data: [DONE]')).toBeGreaterThan(res.body.indexOf('event: error'));
    expect(dataLines(res.body).filter((l) => l === '[DONE]')).toHaveLength(1);
    expect(res.body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(t.providers.must('alpha').calls).toHaveLength(1); // not retried
    expect(t.providers.must('beta').calls).toHaveLength(0); // not spliced
    expect(res.body).not.toContain('closed the stream'); // the provider's detail stays inside

    await waitForLogs(t.logs, 1);
    const cost = computeCostUnits(PROMPT_WORDS, 3, ALPHA_SMALL);
    expect(t.logs.entries[0]).toMatchObject({
      status: 'upstream_error',
      errorCode: 'upstream_error',
      promptTokens: PROMPT_WORDS,
      completionTokens: 3,
      costUnits: cost,
      usageEstimated: true,
    });
    expect(spent(t)).toBe(cost);
    expect(t.budget.holds.size).toBe(0);
  });

  it('a stream that ends without the provider usage is estimated from the delivered text and flagged', async () => {
    const t = start();
    t.providers.must('alpha').script.push({ type: 'no_usage' });
    const res = await post(t);
    expect(res.statusCode).toBe(200);
    expect(dataLines(res.body).at(-1)).toBe('[DONE]');

    await waitForLogs(t.logs, 1);
    const reply = fakeReply('alpha', t.providers.must('alpha').calls[0]!.request);
    const cost = computeCostUnits(PROMPT_WORDS, countWords(reply), ALPHA_SMALL);
    expect(t.logs.entries[0]).toMatchObject({
      status: 'ok',
      promptTokens: PROMPT_WORDS,
      completionTokens: countWords(reply),
      costUnits: cost,
      usageEstimated: true,
    });
    expect(spent(t)).toBe(cost);
  });

  it('a provider-reported usage is never replaced by the estimate', async () => {
    const t = start();
    t.providers
      .must('alpha')
      .script.push({ type: 'ok', usage: { promptTokens: 40, completionTokens: 70 } });
    await post(t);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      promptTokens: 40,
      completionTokens: 70,
      usageEstimated: false,
      costUnits: computeCostUnits(40, 70, ALPHA_SMALL),
    });
  });
});

describe('rejected streaming requests are normal JSON errors (edge case 9.15)', () => {
  it('401, 403, 404, 400, 429 and 402 are never SSE', async () => {
    const t = start();
    const send = (
      extra: Record<string, unknown>,
      key: string = KEYS.research,
    ): Promise<LightMyRequestResponse> => post(t, extra, key);

    // The demo key's budget is smaller than one request: the first is served, the next is not.
    expect((await send({}, KEYS.demo)).statusCode).toBe(200);
    const results = [
      [401, await send({}, 'prism-sk-not-a-key')],
      [403, await send({ model: 'smart' }, KEYS.search)],
      [404, await send({ model: 'no-such-model' })],
      [400, await send({ messages: [] })],
      [402, await send({}, KEYS.demo)],
    ] as const;
    for (const [status, res] of results) {
      expect(res.statusCode).toBe(status);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().error.message).toBeTruthy();
      expect(res.headers).toHaveProperty('x-prism-provider');
    }

    await send({}, KEYS.slow);
    await send({}, KEYS.slow);
    const limited = await send({}, KEYS.slow);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/json');
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});

describe('over a real connection', () => {
  async function listen(t: TestApp): Promise<string> {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const address = t.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function open(base: string, signal?: AbortSignal): Promise<Response> {
    return fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEYS.research}` },
      body: body(),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  it('is not buffered: chunks arrive progressively while the provider is still talking (edge case 9.14)', async () => {
    const t = start({}, 20);
    const base = await listen(t);
    const started = Date.now();
    const res = await open(base);
    expect(res.status).toBe(200);

    const arrivals: number[] = [];
    let text = '';
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now() - started);
      text += decoder.decode(value, { stream: true });
    }

    const words = countWords(fakeReply('alpha', t.providers.must('alpha').calls[0]!.request));
    expect(arrivals.length).toBeGreaterThan(words / 2); // many reads, not one big one
    const spread = arrivals.at(-1)! - arrivals[0]!;
    expect(spread).toBeGreaterThan(words * 20 * 0.6); // paced like the provider, not all at once
    // The first piece shows up long before the last one.
    expect(arrivals[0]!).toBeLessThan(arrivals.at(-1)! - spread * 0.5);
    expect(dataLines(text).at(-1)).toBe('[DONE]');
    await waitForLogs(t.logs, 1);
  });

  it('a client that disconnects mid-stream: upstream aborted, delivered tokens billed as an estimate (edge case 9.1)', async () => {
    const t = start({}, 20);
    const base = await listen(t);
    const controller = new AbortController();
    const res = await open(base, controller.signal);
    const reader = res.body!.getReader();
    await reader.read(); // at least one chunk got through...
    await reader.read();
    controller.abort(); // ...then the client goes away
    await reader.read().catch(() => undefined);

    await waitForLogs(t.logs, 1);
    const entry = t.logs.entries[0]!;
    const total = countWords(fakeReply('alpha', t.providers.must('alpha').calls[0]!.request));
    expect(entry).toMatchObject({
      status: 'client_disconnect',
      httpStatus: 499,
      errorCode: 'client_closed_request',
      usageEstimated: true,
      promptTokens: PROMPT_WORDS,
    });
    expect(entry.completionTokens).toBeGreaterThan(0);
    expect(entry.completionTokens).toBeLessThan(total); // it did not run on to the end
    expect(entry.costUnits).toBe(
      computeCostUnits(PROMPT_WORDS, entry.completionTokens ?? 0, ALPHA_SMALL),
    );

    // Nothing is left behind: no upstream stream, no hold, and the spend matches the log.
    expect(t.providers.must('alpha').streamsInFlight).toBe(0);
    expect(t.budget.holds.size).toBe(0);
    expect(spent(t)).toBe(entry.costUnits);
    expect(t.providers.must('beta').calls).toHaveLength(0);
  });

  it('a client that disconnects before any content: nothing is billed', async () => {
    const t = start({}, 20);
    t.providers.must('alpha').script.push({ type: 'ok', latencyMs: 150 });
    const base = await listen(t);
    const controller = new AbortController();
    const pending = open(base, controller.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 40)); // the provider has not answered yet
    controller.abort();
    await pending;

    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'client_disconnect', httpStatus: 499 });
    expect(spent(t)).toBe(0n);
    expect(t.budget.holds.size).toBe(0);
    expect(t.providers.must('alpha').streamsInFlight).toBe(0);
  });

  it('a stream longer than the maximum duration is cut off and accounted', async () => {
    const t = start({ streamMaxMs: 200 }, 20);
    const base = await listen(t);
    const res = await open(base);
    const reader = res.body!.getReader();
    let failed = false;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true); // the connection was cut, not completed

    await waitForLogs(t.logs, 1);
    const entry = t.logs.entries[0]!;
    expect(entry).toMatchObject({ status: 'upstream_error', usageEstimated: true });
    expect(entry.completionTokens).toBeGreaterThan(0);
    expect(t.providers.must('alpha').streamsInFlight).toBe(0);
    expect(t.budget.holds.size).toBe(0);
  });

  it('many concurrent streams all complete and are all accounted (edge case 9.12)', async () => {
    const t = start({}, 5);
    const base = await listen(t);
    const results = await Promise.all(
      Array.from({ length: 25 }, async () => {
        const res = await open(base);
        return { status: res.status, text: await res.text() };
      }),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => dataLines(r.text).filter((l) => l === '[DONE]').length === 1)).toBe(
      true,
    );
    await waitForLogs(t.logs, 25);
    expect(t.logs.entries.every((e) => e.status === 'ok')).toBe(true);
    expect(t.providers.must('alpha').streamsInFlight).toBe(0);
    expect(t.budget.holds.size).toBe(0);
  });
});
