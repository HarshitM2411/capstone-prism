import { describe, expect, it } from 'vitest';
import type { Embedder } from '../src/embeddings/embedder.js';
import {
  BASELINE_LENGTH_CHARS,
  DifficultyClassifier,
  lengthBaseline,
} from '../src/routing/classifier.js';
import { COMPLEX_EXEMPLARS, SIMPLE_EXEMPLARS } from '../src/routing/exemplars.js';
import {
  HEAD_CHARS,
  SHORT_PROMPT_CHARS,
  TAIL_CHARS,
  analyze,
  instructionWindow,
  taskText,
} from '../src/routing/features.js';

const user = (content: string) => ({ role: 'user' as const, content });
const system = (content: string) => ({ role: 'system' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });

/** Complex exemplars sit at [1, 0], simple ones at [0, 1]; anything else is told by its wording. */
function stubEmbedder(options: { fail?: boolean } = {}): Embedder & { embedded: string[] } {
  const complex = new Set(COMPLEX_EXEMPLARS);
  const simple = new Set(SIMPLE_EXEMPLARS);
  const embedded: string[] = [];
  return {
    embedded,
    dimensions: 2,
    async ready() {
      if (options.fail) throw new Error('no model');
    },
    async embed(text) {
      if (options.fail) throw new Error('no model');
      embedded.push(text);
      if (complex.has(text)) return [1, 0];
      if (simple.has(text)) return [0, 1];
      return /prove|design|why/i.test(text) ? [1, 0] : [0, 1];
    },
    async close() {},
  };
}

describe('the exemplars', () => {
  it('are two disjoint sets of reasonable size', () => {
    expect(SIMPLE_EXEMPLARS.length).toBeGreaterThanOrEqual(10);
    expect(COMPLEX_EXEMPLARS.length).toBeGreaterThanOrEqual(10);
    const complex = new Set(COMPLEX_EXEMPLARS);
    expect(SIMPLE_EXEMPLARS.filter((text) => complex.has(text))).toEqual([]);
  });
});

describe('structural features', () => {
  it('see a proof request as hard even though it is short', () => {
    const a = analyze('Prove that the square root of 2 is irrational.');
    expect(a.signals).toContain('+proof');
    expect(a.score).toBeGreaterThan(1);
  });

  it('see a plain rewrite as easy even though it is long', () => {
    const text = `Rewrite the following in a friendlier tone: ${'The meeting has been moved to Thursday at noon. '.repeat(
      12,
    )}`;
    const a = analyze(text);
    expect(a.signals).toContain('-transform');
    expect(a.score).toBeLessThan(1);
  });

  it('do not let length alone make a prompt hard', () => {
    expect(analyze('word '.repeat(1000)).score).toBeLessThan(1);
  });

  it('analyse short prompts whole and bound long ones', () => {
    const short = instructionWindow('What is the capital of France?');
    expect(short).toEqual({ window: 'What is the capital of France?', windowed: false });

    const long = instructionWindow(
      `Here is a long log. ${'line of noise. '.repeat(5000)}Now explain why the service crashed.`,
    );
    expect(long.windowed).toBe(true);
    expect(long.window.length).toBeLessThanOrEqual(HEAD_CHARS + TAIL_CHARS + 1);
    expect(long.window).toContain('explain why the service crashed');
    expect(SHORT_PROMPT_CHARS).toBeGreaterThan(0);
  });

  it('judge the final instruction of a long prompt', () => {
    const noise = 'The quick brown fox jumps over the lazy dog. '.repeat(100);
    const a = analyze(`Review this text. ${noise}Prove that the algorithm above is correct.`);
    expect(a.windowed).toBe(true);
    expect(a.signals).toContain('+proof');
  });

  it('are deterministic', () => {
    const text = 'Design a rate limiter that survives a Redis outage and compare two approaches.';
    expect(analyze(text)).toEqual(analyze(text));
  });

  it('handle empty and odd input without throwing', () => {
    for (const text of [
      '',
      '   ',
      '\n\n',
      '🙂🙂🙂',
      '日本語のテキスト',
      '```\ncode\n```',
      '\u0000',
    ]) {
      expect(() => analyze(text)).not.toThrow();
    }
  });
});

describe('taskText', () => {
  it('is the last non-empty user message, not the system prompt or earlier turns', () => {
    const messages = [
      system('You are a very long and elaborate persona. '.repeat(100)),
      user('First question'),
      assistant('An answer'),
      user('What is 2 + 2?'),
    ];
    expect(taskText(messages)).toBe('What is 2 + 2?');
  });

  it('skips blank user messages and copes with no user message at all', () => {
    expect(taskText([user('Real question'), user('   ')])).toBe('Real question');
    expect(taskText([system('only a system prompt')])).toBe('only a system prompt');
    expect(taskText([])).toBe('');
  });
});

describe('DifficultyClassifier without embeddings', () => {
  const classifier = new DifficultyClassifier(null);

  it('routes hard prompts to complex and easy ones to simple', async () => {
    expect(
      (await classifier.classify([user('Prove that there are infinitely many primes.')]))
        .difficulty,
    ).toBe('complex');
    expect((await classifier.classify([user('What is the capital of Japan?')])).difficulty).toBe(
      'simple',
    );
  });

  it('explains itself without quoting the prompt', async () => {
    const result = await classifier.classify([user('Prove that qwertyuiop-secret is irrational.')]);
    expect(result.reason).toMatch(/score/);
    expect(result.reason).toContain('structural only');
    expect(result.reason).not.toContain('qwertyuiop');
  });

  it('is deterministic', async () => {
    const messages = [user('Compare quicksort and mergesort for nearly sorted data.')];
    expect(await classifier.classify(messages)).toEqual(await classifier.classify(messages));
  });

  it('answers an empty prompt with simple (edge case 6.3)', async () => {
    expect((await classifier.classify([user('')])).difficulty).toBe('simple');
    expect((await classifier.classify([user('   \n ')])).difficulty).toBe('simple');
  });

  it('is not swayed by a long system prompt around a trivial question (edge case 6.5)', async () => {
    const result = await classifier.classify([
      system('You are a careful, thorough, senior engineer. '.repeat(200)),
      user('What is the capital of Spain?'),
    ]);
    expect(result.difficulty).toBe('simple');
  });

  it('survives a huge prompt quickly (edge case 6.10)', async () => {
    const started = Date.now();
    const result = await classifier.classify([
      user(`${'lorem ipsum dolor sit amet '.repeat(40_000)} Why does this happen?`),
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(['simple', 'complex']).toContain(result.difficulty);
  });
});

describe('DifficultyClassifier with embeddings', () => {
  it('adds the similarity to the reference prompts to the score', async () => {
    const withEmbeddings = new DifficultyClassifier(stubEmbedder());
    const without = new DifficultyClassifier(null);
    const messages = [user('Tell me something about trees and why they grow.')];
    const a = await withEmbeddings.classify(messages);
    const b = await without.classify(messages);
    expect(a.embedDelta).toBeGreaterThan(0);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.reason).toContain('embed +');
  });

  it('embeds only the bounded window, not the whole prompt', async () => {
    const embedder = stubEmbedder();
    const classifier = new DifficultyClassifier(embedder);
    await classifier.warm();
    embedder.embedded.length = 0;
    await classifier.classify([user(`${'filler sentence. '.repeat(20_000)}Why is the sky blue?`)]);
    expect(embedder.embedded).toHaveLength(1);
    expect(embedder.embedded[0]!.length).toBeLessThanOrEqual(HEAD_CHARS + TAIL_CHARS + 1);
  });

  it('builds the reference vectors once', async () => {
    const embedder = stubEmbedder();
    const classifier = new DifficultyClassifier(embedder);
    await classifier.classify([user('hi')]);
    const after = embedder.embedded.length;
    await classifier.classify([user('hello')]);
    expect(embedder.embedded.length).toBe(after + 1);
  });

  it('falls back to structural features when the model is unavailable (edge case 6.9)', async () => {
    const classifier = new DifficultyClassifier(stubEmbedder({ fail: true }));
    const hard = await classifier.classify([
      user('Prove that the square root of 2 is irrational.'),
    ]);
    expect(hard.difficulty).toBe('complex');
    expect(hard.embedDelta).toBeNull();
    expect(hard.reason).toContain('structural only');
    expect((await classifier.classify([user('What is the capital of Peru?')])).difficulty).toBe(
      'simple',
    );
  });
});

describe('the length baseline', () => {
  it('is complex exactly when the last message is longer than the limit', () => {
    expect(lengthBaseline([user('x'.repeat(BASELINE_LENGTH_CHARS))])).toBe('simple');
    expect(lengthBaseline([user('x'.repeat(BASELINE_LENGTH_CHARS + 1))])).toBe('complex');
  });

  it('is fooled by a short proof and a long trivial request, which is the point', () => {
    expect(lengthBaseline([user('Prove that sqrt(2) is irrational.')])).toBe('simple');
    expect(lengthBaseline([user(`Look this up: ${'name, '.repeat(60)}`)])).toBe('complex');
  });
});
