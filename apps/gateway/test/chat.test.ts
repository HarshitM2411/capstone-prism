import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { computeCostUnits, formatUsd } from '../src/money.js';
import { readSampleRequests } from './helpers/dataDir.js';
import {
  ADMIN_TOKEN,
  KEYS,
  buildTestApp,
  config,
  waitForLogs,
  type TestApp,
} from './helpers/app.js';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function start(overrides: Parameters<typeof buildTestApp>[0] = {}): TestApp {
  current = buildTestApp(overrides);
  return current;
}

const valid = { model: 'fast', messages: [{ role: 'user', content: 'What is a message queue?' }] };

function post(
  t: TestApp,
  options: {
    key?: string | null;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...options.headers };
  const key = options.key === undefined ? KEYS.search : options.key;
  if (key !== null && headers.authorization === undefined) headers.authorization = `Bearer ${key}`;
  const payload = options.raw ?? JSON.stringify(options.body ?? valid);
  if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  return t.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload });
}

/** The full `x-prism-*` contract is present on this response (E1). */
function expectHeaderContract(res: LightMyRequestResponse, options: { cost?: boolean } = {}): void {
  expect(res.headers['x-prism-provider']).toBeTypeOf('string');
  expect(res.headers['x-prism-cache']).toMatch(/^(hit|miss)$/);
  expect(res.headers['x-prism-fallback']).toMatch(/^(true|false)$/);
  if (options.cost !== false) expect(res.headers['x-prism-cost-usd']).toMatch(/^\d+(\.\d+)?$/);
}

function expectEnvelope(
  res: LightMyRequestResponse,
  status: number,
  type: string,
  code: string,
): void {
  expect(res.statusCode).toBe(status);
  const body = res.json();
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'type']);
  expect(body.error).toMatchObject({ type, code });
  expect(body.error.message).toBeTypeOf('string');
}

describe('POST /v1/chat/completions — success (stub)', () => {
  it('returns 200 with an OpenAI-shaped completion and the full header contract', async () => {
    const t = start();
    const res = await post(t);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'fast',
      choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }],
    });
    expect(body.choices[0].message.content).toBeTypeOf('string');
    // The stub reports real, non-zero usage ('What is a message queue?' is 5 words) ...
    expect(body.usage.prompt_tokens).toBe(5);
    expect(body.usage.completion_tokens).toBeGreaterThan(20);
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    // ... priced at the `fast` primary (alpha-small): 0.15 / 0.60 USD per 1M tokens.
    const expectedUnits = computeCostUnits(
      body.usage.prompt_tokens,
      body.usage.completion_tokens,
      config.models.get('alpha-small')!,
    );
    expect(res.headers['x-prism-cost-usd']).toBe(formatUsd(expectedUnits));
    expect(expectedUnits).toBeGreaterThan(0n);
    expect(res.headers['x-prism-provider']).toBe('none');
    expect(res.headers['x-prism-cache']).toBe('miss');
    expect(res.headers['x-prism-fallback']).toBe('false');
  });

  it.each(['fast', 'smart', 'auto'])('accepts the allowed model name "%s"', async (model) => {
    const res = await post(start(), { key: KEYS.research, body: { ...valid, model } });
    expect(res.statusCode).toBe(200);
    await current?.app.close();
  });

  it('accepts every valid starter sample request (the negative ones are rejected, with the right code)', async () => {
    const t = start();
    for (const sample of readSampleRequests()) {
      // `req_not_allowed` must be tried with a key that only allows `fast`; the rest with `research`.
      const key = sample.id === 'req_not_allowed' ? KEYS.search : KEYS.research;
      const res = await post(t, { key, body: sample.body });
      const expected: Record<string, number> = {
        req_malformed: 400,
        req_unknown_model: 404,
        req_not_allowed: 403,
      };
      expect(res.statusCode, sample.id).toBe(expected[sample.id] ?? 200);
      expectHeaderContract(res, { cost: !(sample.body.stream === true) });
    }
  });

  it('returns a request id and ignores a client-supplied one', async () => {
    const t = start();
    const res = await post(t, { headers: { 'x-request-id': 'attacker-chosen' } });

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).not.toBe('attacker-chosen');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]?.requestId).toBe(res.headers['x-request-id']);
  });

  it('streams SSE with the header contract and no cost header (edge case 9.7)', async () => {
    const t = start();
    const res = await post(t, { body: { ...valid, stream: true } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expectHeaderContract(res, { cost: false });
    expect(res.headers['x-prism-cost-usd']).toBeUndefined();
    const lines = res.body.split('\n').filter((line) => line.startsWith('data: '));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toBe('data: [DONE]');
    expect(JSON.parse(lines[0]!.slice(6)).object).toBe('chat.completion.chunk');
  });

  it('logs the request with its key, model and outcome', async () => {
    const t = start();
    const res = await post(t, { key: KEYS.research });

    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      keyId: 2,
      requestedModel: 'fast',
      resolvedModel: 'alpha-small',
      status: 'ok',
      httpStatus: res.statusCode,
      errorCode: null,
      promptTokens: 5,
    });
    expect(t.logs.entries[0]?.completionTokens).toBeGreaterThan(20);
    expect(t.logs.entries[0]?.costUnits).toBeGreaterThan(0n);
    expect(t.logs.entries[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('charges the log cost to the budget: spent equals the logged cost (edge case 5.5)', async () => {
    const t = start();
    await post(t);
    await post(t);
    await waitForLogs(t.logs, 2);

    const logged = t.logs.entries.reduce((sum, e) => sum + (e.costUnits ?? 0n), 0n);
    expect(t.budget.spent.get(1)).toBe(logged);
    expect(t.budget.reserved.get(1)).toBe(0n); // nothing left in flight
  });

  it('charges a streamed response too, although it has no cost header', async () => {
    const t = start();
    const res = await post(t, { body: { ...valid, stream: true } });
    expect(res.headers['x-prism-cost-usd']).toBeUndefined();
    expect(t.budget.spent.get(1)).toBeGreaterThan(0n);
    expect(t.budget.reserved.get(1)).toBe(0n);
  });
});

describe('authentication (check 1)', () => {
  const cases: [string, { key?: string | null; headers?: Record<string, string> }][] = [
    ['a missing Authorization header (2.1)', { key: null }],
    ['the Basic scheme (2.2)', { key: null, headers: { authorization: 'Basic dXNlcjpwYXNz' } }],
    ['an empty bearer token (2.2)', { key: null, headers: { authorization: 'Bearer ' } }],
    [
      'a token with extra whitespace (2.2)',
      { key: null, headers: { authorization: `Bearer  ${KEYS.search}` } },
    ],
    ['an unknown key', { key: 'prism-sk-unknown-000000' }],
    ['a key that differs by one character (2.3)', { key: 'prism-sk-search-1a2b3d' }],
    ['a key with different case (2.3)', { key: KEYS.search.toUpperCase() }],
    ['a very long key (2.4)', { key: 'k'.repeat(5000) }],
    ['a disabled key (2.5)', { key: KEYS.disabled }],
  ];

  it.each(cases)(
    'rejects %s with 401 and the full envelope and header contract',
    async (_label, options) => {
      const t = start();
      const res = await post(t, options);

      expectEnvelope(res, 401, 'authentication_error', 'invalid_api_key');
      expectHeaderContract(res);
      expect(res.headers['x-prism-provider']).toBe('none');
    },
  );

  it('answers a disabled key exactly like an unknown key (no oracle, 2.5)', async () => {
    const t = start();
    const disabled = await post(t, { key: KEYS.disabled });
    const unknown = await post(t, { key: 'prism-sk-unknown-000000' });

    expect(disabled.statusCode).toBe(unknown.statusCode);
    expect(disabled.json()).toEqual(unknown.json());
  });

  it('logs an unknown key with a null key id and never stores or echoes the submitted key (2.6)', async () => {
    const t = start();
    const submitted = 'prism-sk-typo-of-a-real-key';
    const res = await post(t, { key: submitted });

    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      keyId: null,
      status: 'rejected_auth',
      httpStatus: 401,
      errorCode: 'invalid_api_key',
    });
    expect(JSON.stringify(t.logs.entries)).not.toContain(submitted);
    expect(res.body).not.toContain(submitted);
  });

  it('logs a disabled key with its key id', async () => {
    const t = start();
    await post(t, { key: KEYS.disabled });
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ keyId: 9, status: 'rejected_auth' });
  });

  it('logs a missing header with a null key', async () => {
    const t = start();
    await post(t, { key: null });
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ keyId: null, status: 'rejected_auth' });
    expect(t.keys.lookups).toEqual([]);
  });

  it('runs before validation: a bad key plus a bad body is a 401, never a 400 (1.6)', async () => {
    const t = start();
    const bodies = [
      { raw: '{ not json' },
      { body: { model: 'fast', messages: [] } },
      { raw: '' },
      { raw: JSON.stringify({ ...valid, padding: 'x'.repeat(1024 * 1024 + 100) }) },
      { body: { model: 'no-such-model-xyz', messages: valid.messages } },
    ];
    for (const options of bodies) {
      const res = await post(t, { key: 'bad-key', ...options });
      expectEnvelope(res, 401, 'authentication_error', 'invalid_api_key');
    }
  });

  it('answers 503 (not 401) when the key store is unreachable, and logs it', async () => {
    const t = start({
      keys: {
        async findByRawKey() {
          throw new Error('connect ECONNREFUSED 10.9.9.9:5432');
        },
      },
    });
    const res = await post(t);

    expectEnvelope(res, 503, 'service_unavailable', 'service_unavailable');
    expect(res.body).not.toContain('ECONNREFUSED');
    expectHeaderContract(res);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'rejected_unavailable', httpStatus: 503 });
  });

  it('does not accept the admin token as a virtual key', async () => {
    const res = await post(start(), { key: ADMIN_TOKEN });
    expectEnvelope(res, 401, 'authentication_error', 'invalid_api_key');
  });
});

describe('validation (check 2)', () => {
  const invalidBodies: [
    string,
    { body?: unknown; raw?: string; headers?: Record<string, string> },
  ][] = [
    ['empty messages (req_malformed, 1.2)', { body: { model: 'fast', messages: [] } }],
    ['missing messages', { body: { model: 'fast' } }],
    ['missing model', { body: { messages: valid.messages } }],
    ['a non-string model', { body: { model: 7, messages: valid.messages } }],
    ['a non-boolean stream (1.4)', { body: { ...valid, stream: 'true' } }],
    [
      'a whitespace-only prompt (1.8)',
      { body: { model: 'fast', messages: [{ role: 'user', content: '   ' }] } },
    ],
    [
      'non-text content (1.8)',
      { body: { model: 'fast', messages: [{ role: 'user', content: [{ type: 'image_url' }] }] } },
    ],
    ['an unsupported parameter (1.7)', { body: { ...valid, tools: [] } }],
    ['n greater than 1 (1.7)', { body: { ...valid, n: 3 } }],
    ['a JSON array body', { body: [valid] }],
    ['a JSON null body', { raw: 'null' }],
    ['malformed JSON (1.1)', { raw: '{ "model": "fast", ' }],
    ['an empty body with a JSON content type', { raw: '' }],
  ];

  it.each(invalidBodies)('rejects %s with 400 and logs it', async (_label, options) => {
    const t = start();
    const res = await post(t, options);

    expectEnvelope(res, 400, 'invalid_request_error', res.json().error.code);
    expectHeaderContract(res);
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      keyId: 1,
      status: 'rejected_validation',
      httpStatus: 400,
    });
  });

  it('uses the documented code for the empty-messages case', async () => {
    const res = await post(start(), { body: { model: 'fast', messages: [] } });
    expectEnvelope(res, 400, 'invalid_request_error', 'invalid_request');
  });

  it('distinguishes malformed JSON with its own code and never echoes the body', async () => {
    const res = await post(start(), { raw: '{ "secret-field": "very-private", ' });
    expectEnvelope(res, 400, 'invalid_request_error', 'invalid_json');
    expect(res.body).not.toContain('very-private');
  });

  it('rejects a non-JSON content type with 415', async () => {
    const res = await post(start(), {
      raw: 'model=fast',
      headers: { 'content-type': 'text/plain' },
    });
    expectEnvelope(res, 415, 'invalid_request_error', 'unsupported_media_type');
  });

  it('rejects a body over the size limit with 413 before doing any work (1.5)', async () => {
    const t = start();
    const big = JSON.stringify({
      model: 'fast',
      messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 10) }],
    });
    const res = await post(t, { raw: big });

    expectEnvelope(res, 413, 'invalid_request_error', 'request_too_large');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({ status: 'rejected_validation', httpStatus: 413 });
  });

  it('never writes the prompt text into the request log', async () => {
    const t = start();
    await post(t, {
      body: {
        model: 'fast',
        messages: [{ role: 'user', content: 'private-prompt-text' }],
        temperature: 99,
      },
    });
    await waitForLogs(t.logs, 1);
    expect(JSON.stringify(t.logs.entries)).not.toContain('private-prompt-text');
  });
});

describe('model resolution (check 3)', () => {
  it('rejects an unknown model with 404 and logs it (1.3)', async () => {
    const t = start();
    const res = await post(t, { body: { ...valid, model: 'no-such-model-xyz' } });

    expectEnvelope(res, 404, 'not_found_error', 'model_not_found');
    expectHeaderContract(res);
    expect(res.json().error.message).toContain('no-such-model-xyz');
    await waitForLogs(t.logs, 1);
    expect(t.logs.entries[0]).toMatchObject({
      keyId: 1,
      requestedModel: 'no-such-model-xyz',
      status: 'rejected_not_found',
      httpStatus: 404,
      errorCode: 'model_not_found',
    });
  });

  it.each(['FAST', 'Fast', 'fast ', ' fast', 'alpha', 'alpha-medium', 'gpt-4'])(
    'does not fall through for the near-miss "%s"',
    async (model) => {
      const res = await post(start(), { body: { ...valid, model } });
      expectEnvelope(res, 404, 'not_found_error', 'model_not_found');
      await current?.app.close();
    },
  );

  it('validates before resolving: a missing model is 400, not 404', async () => {
    const res = await post(start(), { body: { messages: valid.messages } });
    expect(res.statusCode).toBe(400);
  });

  it('logs a model name containing a NUL byte safely', async () => {
    const t = start();
    const res = await post(t, { body: { ...valid, model: 'bad\u0000model' } });
    expect(res.statusCode).toBe(404);
    await waitForLogs(t.logs, 1);
  });
});

describe('request logging (every path)', () => {
  it('writes exactly one row per request, whatever the outcome', async () => {
    const t = start();
    await post(t); // 200
    await post(t, { key: null }); // 401
    await post(t, { body: { model: 'fast', messages: [] } }); // 400
    await post(t, { body: { ...valid, model: 'nope' } }); // 404
    await post(t, { body: { ...valid, stream: true } }); // 200 stream

    await waitForLogs(t.logs, 5);
    expect(t.logs.entries.map((e) => e.status)).toEqual([
      'ok',
      'rejected_auth',
      'rejected_validation',
      'rejected_not_found',
      'ok',
    ]);
    expect(new Set(t.logs.entries.map((e) => e.requestId)).size).toBe(5);
  });

  it('does not fail the client request when the log write fails (P3)', async () => {
    const t = start({
      requestLogs: {
        async write() {
          throw new Error('database is on fire');
        },
      },
    });
    // A rejection is logged by the `onResponse` writer; its failure must not reach the client.
    const res = await post(t, { key: 'prism-sk-unknown-000000' });
    expect(res.statusCode).toBe(401);
    await t.app.close(); // shutdown still completes even though the write failed
  });

  it('waits for in-flight log writes when the app closes', async () => {
    const written: string[] = [];
    const t = start({
      requestLogs: {
        async write(entry) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          written.push(entry.requestId);
        },
      },
    });
    await post(t, { key: 'prism-sk-unknown-000000' });
    await t.app.close();
    expect(written).toHaveLength(1);
  });
});

describe('unknown routes', () => {
  it('returns the standard envelope for an unknown route', async () => {
    const res = await start().app.inject({ method: 'GET', url: '/nope' });
    expectEnvelope(res, 404, 'not_found_error', 'route_not_found');
  });

  it('does not serve the chat route over GET', async () => {
    const res = await start().app.inject({ method: 'GET', url: '/v1/chat/completions' });
    expect(res.statusCode).toBe(404);
  });
});

describe('admin plane skeleton (2.9, 2.10)', () => {
  const adminGet = (
    t: TestApp,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    t.app.inject({ method: 'GET', url: '/admin/ping', headers });

  it('accepts the admin token', async () => {
    const res = await adminGet(start(), { 'x-admin-token': ADMIN_TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { 'x-admin-token': 'wrong-token-value' }],
    ['an empty token', { 'x-admin-token': '' }],
    ['a virtual key as the token', { 'x-admin-token': KEYS.research }],
    ['a virtual key as a bearer token', { authorization: `Bearer ${KEYS.research}` }],
    ['the admin token as a bearer token', { authorization: `Bearer ${ADMIN_TOKEN}` }],
  ])('rejects %s with 401', async (_label, headers) => {
    const res = await adminGet(start(), headers);
    expectEnvelope(res, 401, 'authentication_error', 'invalid_admin_token');
  });

  it('never reveals the admin token in a response', async () => {
    const res = await adminGet(start(), { 'x-admin-token': 'wrong-token-value' });
    expect(res.body).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(ADMIN_TOKEN);
  });

  it('does not write admin requests to the data-plane request log', async () => {
    const t = start();
    await adminGet(t, { 'x-admin-token': ADMIN_TOKEN });
    await adminGet(t);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.logs.entries).toHaveLength(0);
  });
});
