import { describe, expect, it } from 'vitest';
import { validateChatRequest } from '../src/http/validate.js';
import { readSampleRequests } from './helpers/dataDir.js';

const base = { model: 'fast', messages: [{ role: 'user', content: 'hello' }] };

function messageFor(body: unknown): string {
  const result = validateChatRequest(body);
  if (result.ok) throw new Error('expected a validation failure');
  return result.message;
}

describe('validateChatRequest', () => {
  it('accepts a minimal request and applies defaults', () => {
    const result = validateChatRequest(base);
    expect(result).toEqual({
      ok: true,
      request: {
        model: 'fast',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        maxTokens: null,
        params: {},
      },
    });
  });

  it('accepts every starter sample request except the malformed one', () => {
    const samples = readSampleRequests();
    expect(samples.length).toBeGreaterThanOrEqual(14);
    for (const sample of samples) {
      const result = validateChatRequest(sample.body);
      // `req_malformed` (empty messages) is the only sample that must fail validation; the
      // unknown-model and not-allowed samples are valid bodies and fail at later checks.
      expect(result.ok, sample.id).toBe(sample.id !== 'req_malformed');
    }
  });

  it('accepts multi-turn history (edge case 1.9)', () => {
    const result = validateChatRequest({
      model: 'fast',
      messages: [
        { role: 'user', content: 'What is connection pooling?' },
        { role: 'assistant', content: 'It reuses connections.' },
        { role: 'user', content: 'What happens when the pool is exhausted?' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a system prompt plus a user message', () => {
    expect(
      validateChatRequest({
        model: 'smart',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'Hi' },
        ],
      }).ok,
    ).toBe(true);
  });

  it('keeps the sampling parameters it passes through', () => {
    const result = validateChatRequest({
      ...base,
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 50,
      stop: ['END'],
      seed: 7,
      presence_penalty: 0.5,
      frequency_penalty: -0.5,
      user: 'u-1',
      stream_options: { include_usage: true },
    });
    expect(result).toMatchObject({
      ok: true,
      request: {
        stream: true,
        maxTokens: 50,
        params: {
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: 50,
          stop: ['END'],
          seed: 7,
          presence_penalty: 0.5,
          frequency_penalty: -0.5,
          user: 'u-1',
        },
      },
    });
  });

  it('prefers max_completion_tokens over max_tokens for the output cap', () => {
    const result = validateChatRequest({ ...base, max_tokens: 10, max_completion_tokens: 99 });
    expect(result).toMatchObject({ ok: true, request: { maxTokens: 99 } });
  });

  it('treats explicit nulls as absent (OpenAI SDKs send them)', () => {
    const result = validateChatRequest({ ...base, temperature: null, stream: null, stop: null });
    expect(result).toMatchObject({ ok: true, request: { stream: false, params: {} } });
  });

  it('ignores unknown extra fields', () => {
    expect(validateChatRequest({ ...base, some_future_field: 1 }).ok).toBe(true);
  });

  describe('rejections', () => {
    it.each([null, 'text', 42, [], true])('rejects a non-object body (%j)', (body) => {
      expect(messageFor(body)).toMatch(/JSON object/);
    });

    it('rejects empty messages (the starter req_malformed)', () => {
      expect(messageFor({ model: 'fast', messages: [] })).toMatch(/"messages".*non-empty array/);
    });

    it('rejects missing messages and missing model', () => {
      expect(messageFor({ model: 'fast' })).toMatch(/"messages"/);
      expect(messageFor({ messages: base.messages })).toMatch(/"model"/);
    });

    it.each([42, '', '   ', null, ['fast'], {}])('rejects model = %j', (model) => {
      expect(messageFor({ ...base, model })).toMatch(/"model"/);
    });

    it('rejects an over-long model name', () => {
      expect(messageFor({ ...base, model: 'x'.repeat(201) })).toMatch(/"model".*at most/);
    });

    it.each(['true', 1, 'false', {}])(
      'rejects a non-boolean stream (%j) (edge case 1.4)',
      (stream) => {
        expect(messageFor({ ...base, stream })).toMatch(/"stream" must be a boolean/);
      },
    );

    it('rejects a bad role', () => {
      expect(messageFor({ model: 'fast', messages: [{ role: 'tool', content: 'x' }] })).toMatch(
        /messages\[0\]\.role/,
      );
      expect(messageFor({ model: 'fast', messages: [{ content: 'x' }] })).toMatch(/role/);
    });

    it.each([null, 42, ['hi'], [{ type: 'text', text: 'hi' }], { a: 1 }])(
      'rejects non-string content (%j) (edge case 1.8)',
      (content) => {
        expect(messageFor({ model: 'fast', messages: [{ role: 'user', content }] })).toMatch(
          /content must be a string/,
        );
      },
    );

    it('rejects messages that are not objects', () => {
      expect(messageFor({ model: 'fast', messages: ['hello'] })).toMatch(
        /messages\[0\] must be an object/,
      );
    });

    it.each(['', '   ', '\n\t'])('rejects a user message with no real text (%j)', (content) => {
      expect(messageFor({ model: 'fast', messages: [{ role: 'user', content }] })).toMatch(
        /user message with non-empty text/,
      );
    });

    it('requires a user message even when other messages have text', () => {
      expect(
        messageFor({ model: 'fast', messages: [{ role: 'system', content: 'Be concise.' }] }),
      ).toMatch(/user message/);
    });

    it('allows an empty assistant or system message as long as a user message has text', () => {
      expect(
        validateChatRequest({
          model: 'fast',
          messages: [
            { role: 'system', content: '' },
            { role: 'assistant', content: '' },
            { role: 'user', content: 'ok' },
          ],
        }).ok,
      ).toBe(true);
    });

    it('rejects too many messages', () => {
      const messages = Array.from({ length: 501 }, () => ({ role: 'user', content: 'x' }));
      expect(messageFor({ model: 'fast', messages })).toMatch(/at most 500/);
    });

    it.each([
      ['temperature', 3],
      ['temperature', -1],
      ['temperature', 'hot'],
      ['top_p', 1.5],
      ['max_tokens', 0],
      ['max_tokens', 1.5],
      ['max_tokens', 'many'],
      ['max_completion_tokens', -5],
      ['presence_penalty', 5],
      ['seed', 1.5],
      ['stop', 5],
      ['stop', []],
      ['stop', ['a', 'b', 'c', 'd', 'e']],
      ['stop', [1]],
      ['user', 5],
    ])('rejects %s = %j', (field, value) => {
      expect(messageFor({ ...base, [field]: value })).toContain(`"${field}"`);
    });

    it.each([
      ['n', 2],
      ['logprobs', true],
      ['tools', []],
      ['tool_choice', 'auto'],
      ['functions', []],
      ['response_format', { type: 'json_object' }],
      ['logit_bias', {}],
    ])('rejects the unsupported parameter %s (edge case 1.7)', (field, value) => {
      expect(messageFor({ ...base, [field]: value })).toContain(`"${field}"`);
    });

    it('accepts n = 1 and logprobs = false', () => {
      expect(validateChatRequest({ ...base, n: 1, logprobs: false }).ok).toBe(true);
    });

    it('reports every problem in one message', () => {
      const message = messageFor({ model: 5, messages: [], temperature: 9, stream: 'yes' });
      expect(message).toMatch(/"model"/);
      expect(message).toMatch(/"messages"/);
      expect(message).toMatch(/"temperature"/);
      expect(message).toMatch(/"stream"/);
    });

    it('never echoes the sender’s text in the message', () => {
      const secretText = 'my-very-private-prompt-text';
      const message = messageFor({
        model: 'fast',
        messages: [{ role: 'user', content: secretText }],
        temperature: 99,
      });
      expect(message).not.toContain(secretText);
    });
  });
});
