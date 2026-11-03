import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTPUT_CAP_TOKENS,
  estimateCostUnits,
  estimatePromptTokens,
  pricingModel,
} from '../src/limits/estimate.js';
import { computeCostUnits } from '../src/money.js';
import { resolveModel } from '../src/routing/resolve.js';
import { config } from './helpers/app.js';

const msg = (content: string, role: 'user' | 'system' | 'assistant' = 'user') => ({
  role,
  content,
});

function resolved(name: string) {
  const r = resolveModel(config, name);
  if (r === null) throw new Error(`unknown model ${name}`);
  return r;
}

describe('estimatePromptTokens', () => {
  it('is half the characters, rounded up, plus 4 per message', () => {
    expect(estimatePromptTokens([msg('abcd')])).toBe(2 + 4);
    expect(estimatePromptTokens([msg('abcde')])).toBe(3 + 4);
    expect(estimatePromptTokens([msg('abcd'), msg('ab', 'assistant')])).toBe(2 + 1 + 8);
  });

  it('counts an empty message as its overhead only', () => {
    expect(estimatePromptTokens([msg('')])).toBe(4);
  });

  it('never goes below the whitespace-separated word count the mock providers use', () => {
    const samples = [
      'What is a message queue?',
      'a b c d e f g h i j',
      'x',
      ' '.repeat(5) + 'word',
      'one two  three\tfour\nfive',
      'ünïcödé wörds hëre',
    ];
    for (const text of samples) {
      const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
      expect(estimatePromptTokens([msg(text)])).toBeGreaterThanOrEqual(words);
    }
  });
});

describe('pricingModel (edge case 5.16)', () => {
  it('prices an alias at the primary of its chain', () => {
    expect(pricingModel(config, resolved('fast')).name).toBe('alpha-small');
    expect(pricingModel(config, resolved('smart')).name).toBe('alpha-large');
  });

  it('prices a concrete model at itself', () => {
    expect(pricingModel(config, resolved('beta-small')).name).toBe('beta-small');
  });

  it('prices `auto` at the expensive tier, so the estimate stays an upper bound', () => {
    expect(pricingModel(config, resolved('auto')).name).toBe('alpha-large');
  });
});

describe('estimateCostUnits', () => {
  it('assumes the default output cap when max_tokens is absent', () => {
    // 'hello world' = 11 chars → 6 + 4 = 10 prompt tokens on alpha-small (0.15 / 0.60 per 1M)
    const chat = { messages: [msg('hello world')], maxTokens: null };
    const pico = 10n * 150_000n + BigInt(DEFAULT_OUTPUT_CAP_TOKENS) * 600_000n;
    expect(estimateCostUnits(config, resolved('fast'), chat)).toBe(pico / 10_000n);
  });

  it('uses max_tokens as the output cap when given', () => {
    const chat = { messages: [msg('hello world')], maxTokens: 10 };
    expect(estimateCostUnits(config, resolved('fast'), chat)).toBe(
      (10n * 150_000n + 10n * 600_000n) / 10_000n,
    );
  });

  it('costs more on the expensive tier', () => {
    const chat = { messages: [msg('hello world')], maxTokens: 100 };
    expect(estimateCostUnits(config, resolved('smart'), chat)).toBeGreaterThan(
      estimateCostUnits(config, resolved('fast'), chat),
    );
  });

  it('rounds up, never down', () => {
    const chat = { messages: [msg('x')], maxTokens: 1 };
    const model = pricingModel(config, resolved('fast'));
    const pico = 5n * model.inputPicoPerToken + 1n * model.outputPicoPerToken;
    expect(estimateCostUnits(config, resolved('fast'), chat) * 10_000n).toBeGreaterThanOrEqual(
      pico,
    );
  });

  it('is an upper bound on what the stub then charges for the same request', () => {
    const prompts = ['What is a message queue?', 'hi', 'a '.repeat(500)];
    for (const text of prompts) {
      const chat = { messages: [msg(text)], maxTokens: null };
      const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
      const actual = computeCostUnits(words, 31, pricingModel(config, resolved('fast')));
      expect(estimateCostUnits(config, resolved('fast'), chat)).toBeGreaterThanOrEqual(actual);
    }
  });
});
