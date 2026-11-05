import { describe, expect, it } from 'vitest';
import {
  MAX_SIMILARITY_CHARS,
  cacheScope,
  isTimeSensitive,
  similarityMessage,
} from '../src/cache/scope.js';
import type { ChatMessage, ChatRequest } from '../src/http/validate.js';
import { readSampleRequests } from './helpers/dataDir.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const system = (content: string): ChatMessage => ({ role: 'system', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

function chat(
  messages: ChatMessage[],
  extra: Partial<Pick<ChatRequest, 'maxTokens' | 'params'>> = {},
) {
  return { messages, maxTokens: null, params: {}, ...extra };
}

describe('cacheScope', () => {
  it('embeds the last user message, tidied', () => {
    expect(cacheScope(chat([user('  How do I   reset\nmy password? ')]))!.text).toBe(
      'How do I reset my password?',
    );
  });

  it('has nothing to key on without user text', () => {
    expect(cacheScope(chat([system('only a system prompt')]))).toBeNull();
    expect(similarityMessage([user('  ')])).toBeNull();
  });

  it('gives the same hash to the same conversation, whatever the last message says (edge case 7.4)', () => {
    const a = cacheScope(chat([system('Be brief.'), user('How do I reset my password?')]))!;
    const b = cacheScope(chat([system('Be brief.'), user('Steps to reset my password?')]))!;
    expect(a.contextHash).toBe(b.contextHash);
  });

  it.each([
    ['a different system prompt', [system('Be verbose.'), user('Q?')]],
    ['no system prompt', [user('Q?')]],
    ['an earlier turn', [system('Be brief.'), user('Earlier'), assistant('A'), user('Q?')]],
  ])('gives another hash for %s', (_label, messages) => {
    const base = cacheScope(chat([system('Be brief.'), user('Q?')]))!;
    expect(cacheScope(chat(messages))!.contextHash).not.toBe(base.contextHash);
  });

  it.each([
    ['temperature', { params: { temperature: 0.9 } }],
    ['top_p', { params: { top_p: 0.5 } }],
    ['max_tokens', { maxTokens: 50, params: { max_tokens: 50 } }],
    ['seed', { params: { seed: 7 } }],
    ['stop', { params: { stop: ['END'] } }],
  ])('gives another hash for a different %s', (_label, extra) => {
    const base = cacheScope(chat([user('Q?')]))!;
    expect(cacheScope(chat([user('Q?')], extra))!.contextHash).not.toBe(base.contextHash);
  });

  it('ignores the end-user label, which cannot change the answer', () => {
    const base = cacheScope(chat([user('Q?')]))!;
    expect(cacheScope(chat([user('Q?')], { params: { user: 'u-1' } }))!.contextHash).toBe(
      base.contextHash,
    );
  });

  it('cuts a very long message consistently, and then only allows an exact match (edge case 7.15)', () => {
    const shared = 'x'.repeat(MAX_SIMILARITY_CHARS);
    const a = cacheScope(chat([user(`${shared} ending A`)]))!;
    const b = cacheScope(chat([user(`${shared} ending B`)]))!;
    const a2 = cacheScope(chat([user(`${shared} ending A`)]))!;
    expect(a.text).toHaveLength(MAX_SIMILARITY_CHARS);
    expect(a.text).toBe(b.text);
    expect(a.contextHash).not.toBe(b.contextHash);
    expect(a.contextHash).toBe(a2.contextHash);
  });
});

describe('isTimeSensitive (edge case 7.11)', () => {
  it('flags the provided example and similar questions', () => {
    for (const text of [
      'What is the current status of the payments service?',
      'What is the weather like in Pune today?',
      'Who won the latest match?',
      'What is the stock price of ACME right now?',
      'Any breaking news about the outage?',
    ]) {
      expect(isTimeSensitive(text), text).toBe(true);
    }
  });

  it('leaves the cacheable sample prompts alone', () => {
    const cacheable = readSampleRequests().filter((r) => /^req_(cache_|basic$|stream$)/.test(r.id));
    expect(cacheable.length).toBeGreaterThanOrEqual(7);
    for (const r of cacheable) {
      const last = (r.body.messages as ChatMessage[]).at(-1)!.content;
      expect(isTimeSensitive(last), r.id).toBe(false);
    }
  });

  it('flags the no-cache sample', () => {
    const sample = readSampleRequests().find((r) => r.id === 'req_no_cache')!;
    const last = (sample.body.messages as ChatMessage[]).at(-1)!.content;
    expect(isTimeSensitive(last)).toBe(true);
  });
});
