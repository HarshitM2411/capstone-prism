import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError, type ProviderErrorKind } from '../src/providers/errors.js';
import { OpenAICompatibleAdapter } from '../src/providers/openaiCompatible.js';
import type { CallOptions, UpstreamChunk, UpstreamRequest } from '../src/providers/types.js';
import { Secret } from '../src/secret.js';

const API_KEY = 'sk-super-secret-provider-key-9f8e7d';

const request: UpstreamRequest = {
  model: 'alpha-small',
  messages: [{ role: 'user', content: 'What is a message queue?' }],
  params: { temperature: 0.2, max_tokens: 50 },
};

const options = (
  overrides: Partial<CallOptions['timeouts']> = {},
  signal?: AbortSignal,
): CallOptions => ({
  timeouts: { firstByteMs: 400, idleMs: 400, deadlineMs: 2000, ...overrides },
  ...(signal === undefined ? {} : { signal }),
});

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server | undefined;
const sockets = new Set<Socket>();

async function provider(handler: Handler): Promise<OpenAICompatibleAdapter> {
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(parts).toString('utf8')));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return new OpenAICompatibleAdapter({
    name: 'alpha',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: new Secret(API_KEY),
  });
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const completion = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'chatcmpl-abc',
    object: 'chat.completion',
    created: 1700000000,
    model: 'alpha-small',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'A queue.' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    ...overrides,
  });

const json = (res: ServerResponse, status: number, body: string, headers = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body);
};

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected the call to fail');
}

describe('OpenAICompatibleAdapter.chatCompletion', () => {
  it('sends an OpenAI-shaped request with the provider key and parses the reply', async () => {
    let seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const adapter = await provider((req, res, body) => {
      seen = {
        ...(req.url === undefined ? {} : { url: req.url }),
        ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }),
        body: JSON.parse(body) as Record<string, unknown>,
      };
      json(res, 200, completion());
    });

    const reply = await adapter.chatCompletion(request, options());

    expect(seen.url).toBe('/v1/chat/completions');
    expect(seen.auth).toBe(`Bearer ${API_KEY}`);
    expect(seen.body).toEqual({
      model: 'alpha-small',
      messages: [{ role: 'user', content: 'What is a message queue?' }],
      temperature: 0.2,
      max_tokens: 50,
      stream: false,
    });
    expect(reply).toEqual({
      id: 'chatcmpl-abc',
      model: 'alpha-small',
      content: 'A queue.',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 2 },
      created: 1700000000,
    });
  });

  it('tolerates a trailing slash in the base URL and missing optional fields', async () => {
    const adapter = await provider((_req, res) =>
      json(
        res,
        200,
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );
    const { port } = server!.address() as AddressInfo;
    const slashed = new OpenAICompatibleAdapter({
      name: 'alpha',
      baseUrl: `http://127.0.0.1:${port}/v1/`,
      apiKey: new Secret(API_KEY),
    });
    const reply = await slashed.chatCompletion(request, options());
    expect(reply.content).toBe('ok');
    expect(reply.finishReason).toBe('stop');
    expect(reply.id).toMatch(/^chatcmpl-/);
    expect(adapter.name).toBe('alpha');
  });

  describe('provider HTTP errors are classified, never forwarded', () => {
    const cases: [number, ProviderErrorKind, string][] = [
      [429, 'rate_limited', 'failover'],
      [500, 'server_error', 'retry'],
      [502, 'server_error', 'retry'],
      [503, 'server_error', 'retry'],
      [408, 'server_error', 'retry'],
      [401, 'auth', 'fatal'],
      [403, 'auth', 'fatal'],
      [400, 'bad_request', 'fatal'],
      [404, 'bad_request', 'fatal'],
      [422, 'bad_request', 'fatal'],
      [302, 'bad_request', 'fatal'],
    ];

    it.each(cases)('status %i is "%s" (%s)', async (status, kind, disposition) => {
      const adapter = await provider((_req, res) =>
        json(
          res,
          status,
          JSON.stringify({ error: { message: 'LEAKY-PROVIDER-DETAIL internal host 10.0.0.9' } }),
          {
            ...(status === 302 ? { location: 'http://evil.example/steal' } : {}),
          },
        ),
      );
      const err = await failureOf(adapter.chatCompletion(request, options()));

      expect(err.kind).toBe(kind);
      expect(err.disposition).toBe(disposition);
      expect(err.status).toBe(status);
      expect(err.provider).toBe('alpha');
      // Neither the provider's body nor our credential may appear in anything printable.
      const printed = `${err.message} ${JSON.stringify(err)} ${err.stack ?? ''}`;
      expect(printed).not.toContain('LEAKY-PROVIDER-DETAIL');
      expect(printed).not.toContain(API_KEY);
    });

    it('reads Retry-After on a 429', async () => {
      const adapter = await provider((_req, res) => json(res, 429, '{}', { 'retry-after': '5' }));
      const err = await failureOf(adapter.chatCompletion(request, options()));
      expect(err.retryAfterMs).toBe(5000);
    });

    it('ignores an unusable Retry-After', async () => {
      const adapter = await provider((_req, res) =>
        json(res, 429, '{}', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
      );
      expect((await failureOf(adapter.chatCompletion(request, options()))).retryAfterMs).toBeNull();
    });

    it('never follows a redirect (the key must not travel to another host)', async () => {
      let followed = false;
      const adapter = await provider((req, res) => {
        if (req.url === '/steal') followed = true;
        res.writeHead(307, { location: '/steal' });
        res.end();
      });
      await failureOf(adapter.chatCompletion(request, options()));
      expect(followed).toBe(false);
    });
  });

  describe('malformed upstream responses (edge cases 8.13, 10.6)', () => {
    const bad: [string, string][] = [
      ['invalid JSON', '{ not json'],
      ['an HTML error page', '<html><body>502 Bad Gateway</body></html>'],
      ['an empty body', ''],
      ['a JSON array', '[]'],
      ['a JSON null', 'null'],
      ['no choices', JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } })],
      ['empty choices', completion({ choices: [] })],
      ['choices that is not a list', completion({ choices: 'x' })],
      ['a choice without a message', completion({ choices: [{ index: 0 }] })],
      ['null content', completion({ choices: [{ message: { content: null } }] })],
      ['non-string content', completion({ choices: [{ message: { content: 42 } }] })],
      ['no usage', completion({ usage: undefined })],
      ['usage that is not an object', completion({ usage: 'lots' })],
      [
        'string token counts',
        completion({ usage: { prompt_tokens: '5', completion_tokens: '2' } }),
      ],
      ['negative token counts', completion({ usage: { prompt_tokens: -5, completion_tokens: 2 } })],
      [
        'fractional token counts',
        completion({ usage: { prompt_tokens: 5.5, completion_tokens: 2 } }),
      ],
      ['missing completion tokens', completion({ usage: { prompt_tokens: 5 } })],
      ['zero tokens in total', completion({ usage: { prompt_tokens: 0, completion_tokens: 0 } })],
    ];

    it.each(bad)(
      'rejects %s as malformed, with the dedicated kind and no billing data',
      async (_label, body) => {
        const adapter = await provider((_req, res) => json(res, 200, body));
        const err = await failureOf(adapter.chatCompletion(request, options()));
        expect(err.kind).toBe('malformed');
        expect(err.disposition).toBe('failover');
        expect(err.message).not.toContain('<html>');
      },
    );

    it('accepts a zero-token completion when the prompt was counted', async () => {
      const adapter = await provider((_req, res) =>
        json(res, 200, completion({ usage: { prompt_tokens: 3, completion_tokens: 0 } })),
      );
      expect((await adapter.chatCompletion(request, options())).usage).toEqual({
        promptTokens: 3,
        completionTokens: 0,
      });
    });
  });

  describe('timeouts never leave a call hanging (edge cases 8.1, 8.2)', () => {
    it('gives up on a provider that is slow to answer (first-byte timeout)', async () => {
      const adapter = await provider((_req, res) =>
        setTimeout(() => json(res, 200, completion()), 3000),
      );
      const started = Date.now();
      const err = await failureOf(adapter.chatCompletion(request, options({ firstByteMs: 150 })));
      expect(err.kind).toBe('timeout');
      expect(err.disposition).toBe('retry');
      expect(Date.now() - started).toBeLessThan(900);
    });

    it('gives up on a provider that sends headers and then stalls (overall deadline)', async () => {
      const adapter = await provider((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"id":');
      });
      const started = Date.now();
      const err = await failureOf(
        adapter.chatCompletion(request, options({ firstByteMs: 1000, deadlineMs: 300 })),
      );
      expect(err.kind).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(1200);
    });

    it('caps a provider that dribbles bytes forever', async () => {
      const adapter = await provider((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const timer = setInterval(() => res.write(' '), 20);
        res.on('close', () => clearInterval(timer));
      });
      const started = Date.now();
      const err = await failureOf(adapter.chatCompletion(request, options({ deadlineMs: 300 })));
      expect(err.kind).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(1200);
    });

    it('reports an unreachable provider as a connection failure, quickly', async () => {
      const adapter = new OpenAICompatibleAdapter({
        name: 'alpha',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: new Secret(API_KEY),
      });
      const started = Date.now();
      const err = await failureOf(adapter.chatCompletion(request, options()));
      expect(err.kind).toBe('connection');
      expect(err.disposition).toBe('retry');
      expect(Date.now() - started).toBeLessThan(1500);
      expect(`${err.message} ${err.stack ?? ''}`).not.toContain(API_KEY);
    });

    it('reports a connection reset mid-response as a connection failure', async () => {
      const adapter = await provider((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"id":"x"');
        setTimeout(() => res.socket?.destroy(), 20);
      });
      const err = await failureOf(adapter.chatCompletion(request, options()));
      expect(err.kind).toBe('connection');
    });
  });

  describe('caller abort', () => {
    it('aborts an in-flight call and reports it as aborted', async () => {
      const adapter = await provider(() => undefined); // never answers
      const controller = new AbortController();
      const started = Date.now();
      const pending = failureOf(adapter.chatCompletion(request, options({}, controller.signal)));
      setTimeout(() => controller.abort(), 50);
      const err = await pending;
      expect(err.kind).toBe('aborted');
      expect(err.disposition).toBe('abort');
      expect(Date.now() - started).toBeLessThan(350);
    });

    it('does not even send a request when the signal is already aborted', async () => {
      let hits = 0;
      const adapter = await provider((_req, res) => {
        hits++;
        json(res, 200, completion());
      });
      const err = await failureOf(
        adapter.chatCompletion(request, options({}, AbortSignal.abort())),
      );
      expect(err.kind).toBe('aborted');
      expect(hits).toBe(0);
    });
  });

  it('copes with many concurrent calls', async () => {
    const adapter = await provider((_req, res) =>
      setTimeout(() => json(res, 200, completion()), 20),
    );
    const replies = await Promise.all(
      Array.from({ length: 50 }, () => adapter.chatCompletion(request, options())),
    );
    expect(replies.every((r) => r.content === 'A queue.')).toBe(true);
  });
});

// --- streaming ---------------------------------------------------------------------------------

const sse = (data: unknown): string =>
  `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const delta = (content: string, finish: string | null = null, extra: object = {}) =>
  sse({
    id: 'c1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: content === '' ? {} : { content }, finish_reason: finish }],
    ...extra,
  });

function eventStream(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

async function collect(iterable: AsyncIterable<UpstreamChunk>): Promise<UpstreamChunk[]> {
  const chunks: UpstreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe('OpenAICompatibleAdapter.chatCompletionStream', () => {
  const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };

  it('requests a stream with usage and yields each increment as it arrives', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = await provider((_req, res, body) => {
      sent = JSON.parse(body) as Record<string, unknown>;
      eventStream(res);
      res.write(delta('', null));
      res.write(delta('Hello '));
      res.write(delta('world'));
      res.write(delta('', 'stop', { usage }));
      res.end('data: [DONE]\n\n');
    });

    const chunks = await collect(adapter.chatCompletionStream(request, options()));

    expect(sent).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      model: 'alpha-small',
    });
    expect(chunks.map((c) => c.content).join('')).toBe('Hello world');
    expect(chunks.at(-1)).toEqual({
      content: '',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 3 },
    });
    expect(chunks.filter((c) => c.usage !== null)).toHaveLength(1);
  });

  it('delivers chunks progressively, not all at the end (edge case 9.14)', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      let n = 0;
      const timer = setInterval(() => {
        if (n < 4) res.write(delta(`t${n++} `));
        else {
          clearInterval(timer);
          res.write(delta('', 'stop', { usage }));
          res.end('data: [DONE]\n\n');
        }
      }, 60);
    });

    const started = Date.now();
    const arrivals: number[] = [];
    for await (const chunk of adapter.chatCompletionStream(request, options())) {
      if (chunk.content !== '') arrivals.push(Date.now() - started);
    }
    expect(arrivals).toHaveLength(4);
    expect(arrivals[3]! - arrivals[0]!).toBeGreaterThan(100);
  });

  it('reassembles events split across network writes, and CRLF line endings', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      const wire = (
        delta('Hel') +
        delta('lo') +
        delta('', 'stop', { usage }) +
        'data: [DONE]\n\n'
      ).replaceAll('\n', '\r\n');
      let i = 0;
      const timer = setInterval(() => {
        if (i >= wire.length) {
          clearInterval(timer);
          return res.end();
        }
        res.write(wire.slice(i, i + 7));
        i += 7;
      }, 2);
    });
    const chunks = await collect(adapter.chatCompletionStream(request, options()));
    expect(chunks.map((c) => c.content).join('')).toBe('Hello');
    expect(chunks.at(-1)?.usage).toEqual({ promptTokens: 5, completionTokens: 3 });
  });

  it('handles a trailing usage-only chunk with no choices', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      res.write(delta('Hi'));
      res.write(delta('', 'stop'));
      res.write(sse({ id: 'c1', choices: [], usage }));
      res.end('data: [DONE]\n\n');
    });
    const chunks = await collect(adapter.chatCompletionStream(request, options()));
    expect(chunks.at(-1)).toEqual({
      content: '',
      finishReason: null,
      usage: { promptTokens: 5, completionTokens: 3 },
    });
  });

  it('ignores comments and unknown fields in the event stream', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      res.write(': keep-alive\n\n');
      res.write(`event: message\nid: 7\n${delta('Hi')}`);
      res.write(delta('', 'stop', { usage }));
      res.end('data: [DONE]\n\n');
    });
    const chunks = await collect(adapter.chatCompletionStream(request, options()));
    expect(chunks.map((c) => c.content).join('')).toBe('Hi');
  });

  it('maps an error status before the stream starts, so the caller can still fail over (9.3)', async () => {
    const adapter = await provider((_req, res) => json(res, 503, '{"error":"LEAKY"}'));
    const err = await failureOf(collect(adapter.chatCompletionStream(request, options())));
    expect(err.kind).toBe('server_error');
    expect(err.message).not.toContain('LEAKY');
  });

  it('rejects a 200 that is not an event stream', async () => {
    const adapter = await provider((_req, res) => json(res, 200, completion()));
    const err = await failureOf(collect(adapter.chatCompletionStream(request, options())));
    expect(err.kind).toBe('malformed');
  });

  it('times out waiting for the first byte', async () => {
    const adapter = await provider(() => undefined);
    const started = Date.now();
    const err = await failureOf(
      collect(adapter.chatCompletionStream(request, options({ firstByteMs: 150 }))),
    );
    expect(err.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('times out a stream that goes silent between chunks (edge case 9.11)', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      res.write(delta('Hi'));
      // ...and then nothing.
    });
    const received: string[] = [];
    const started = Date.now();
    const err = await failureOf(
      (async () => {
        for await (const chunk of adapter.chatCompletionStream(request, options({ idleMs: 150 }))) {
          received.push(chunk.content);
        }
      })(),
    );
    expect(received).toEqual(['Hi']);
    expect(err.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('caps the total duration of a stream that keeps trickling', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      const timer = setInterval(() => res.write(delta('x')), 30);
      res.on('close', () => clearInterval(timer));
    });
    const started = Date.now();
    const err = await failureOf(
      collect(adapter.chatCompletionStream(request, options({ idleMs: 1000, deadlineMs: 300 }))),
    );
    expect(err.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it('fails when the connection dies before [DONE] (edge case 9.2)', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      res.write(delta('Hi'));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const err = await failureOf(collect(adapter.chatCompletionStream(request, options())));
    expect(err.kind).toBe('connection');
  });

  it('fails when the stream ends cleanly without [DONE]', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      res.end(delta('Hi'));
    });
    const err = await failureOf(collect(adapter.chatCompletionStream(request, options())));
    expect(err.kind).toBe('connection');
  });

  it.each([
    ['an event that is not JSON', 'data: {oops\n\n'],
    ['an event that is not an object', 'data: 42\n\n'],
    ['an error event', 'data: {"error":{"message":"LEAKY upstream failure"}}\n\n'],
  ])('fails on %s', async (_label, wire) => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      res.write(delta('Hi'));
      res.write(wire);
      res.end('data: [DONE]\n\n');
    });
    const err = await failureOf(collect(adapter.chatCompletionStream(request, options())));
    expect(err.kind).toBe('malformed');
    expect(err.message).not.toContain('LEAKY');
  });

  it('stops the upstream request when the consumer stops reading (client disconnect, 9.1)', async () => {
    let upstreamClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    const adapter = await provider((_req, res) => {
      eventStream(res);
      const timer = setInterval(() => res.write(delta('x')), 10);
      res.on('close', () => {
        clearInterval(timer);
        upstreamClosed();
      });
    });
    for await (const chunk of adapter.chatCompletionStream(request, options())) {
      if (chunk.content !== '') break;
    }
    await Promise.race([
      closed,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('upstream stayed open')), 1000),
      ),
    ]);
  });

  it('aborts a stream from the caller’s signal', async () => {
    const adapter = await provider((_req, res) => {
      eventStream(res);
      res.write(delta('Hi'));
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const err = await failureOf(
      collect(adapter.chatCompletionStream(request, options({}, controller.signal))),
    );
    expect(err.kind).toBe('aborted');
  });
});
