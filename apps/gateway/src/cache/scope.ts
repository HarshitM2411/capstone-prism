import { createHash } from 'node:crypto';
import type { ChatMessage, ChatRequest } from '../http/validate.js';

/**
 * What the semantic cache compares and what it requires to match exactly (architecture §4.5).
 *
 *  - The similarity match runs on the last user message only.
 *  - Everything else that shapes the answer (system prompt, earlier turns, the sampling
 *    parameters) goes into a hash that must be identical, so a different conversation or
 *    different settings can never be answered from another's entry (edge case 7.4).
 */

/**
 * The embedding model reads roughly this much text (about 256 word pieces). A longer last message
 * is cut at this length consistently for the lookup and for storage (edge case 7.15); because the
 * cut would hide differences, such a message is only ever matched exactly (its full text is part
 * of the context hash).
 */
export const MAX_SIMILARITY_CHARS = 1000;

export interface CacheScope {
  /** The text that is embedded: the last user message, normalised and bounded. */
  text: string;
  /** SHA-256 of everything that must match exactly. */
  contextHash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The prompt the cache keys on, or `null` when there is nothing to key on. */
export function similarityMessage(messages: readonly ChatMessage[]): {
  index: number;
  content: string;
} | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'user' && message.content.trim() !== '') {
      return { index: i, content: message.content };
    }
  }
  return null;
}

/** `null` when the request cannot be cached (no user text to compare). */
export function cacheScope(
  chat: Pick<ChatRequest, 'messages' | 'maxTokens' | 'params'>,
): CacheScope | null {
  const last = similarityMessage(chat.messages);
  if (last === null) return null;

  const normalised = last.content.replace(/\s+/g, ' ').trim();
  const truncated = normalised.length > MAX_SIMILARITY_CHARS;
  const { params } = chat;

  const context = JSON.stringify([
    chat.messages.slice(0, last.index).map((m) => [m.role, m.content]),
    chat.messages.slice(last.index + 1).map((m) => [m.role, m.content]),
    // Every parameter that can change the answer. `user` is only an end-user label.
    params.temperature ?? null,
    params.top_p ?? null,
    chat.maxTokens,
    params.max_tokens ?? null,
    params.stop ?? null,
    params.seed ?? null,
    params.presence_penalty ?? null,
    params.frequency_penalty ?? null,
    // Too long to compare by meaning: only an identical message may hit.
    truncated ? sha256(last.content) : null,
  ]);

  return {
    text: truncated ? normalised.slice(0, MAX_SIMILARITY_CHARS) : normalised,
    contextHash: sha256(context),
  };
}

/**
 * A small, documented keyword heuristic for prompts whose answer goes stale: they are never
 * cached (edge case 7.11). It errs towards not caching, which costs a provider call but is never
 * wrong.
 */
const TIME_SENSITIVE =
  /\b(current(ly)?|right now|at the moment|as of (now|today)|today|tonight|tomorrow|yesterday|latest|newest|breaking|real[- ]?time|live|up[- ]to[- ]date|ongoing|this (morning|afternoon|evening|week|weekend|month|year)|status of|weather|stock price|exchange rate|score of|news)\b/i;

export function isTimeSensitive(text: string): boolean {
  return TIME_SENSITIVE.test(text);
}
