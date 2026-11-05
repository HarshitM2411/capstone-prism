import { readFileSync } from 'node:fs';
import type { Classifier, Difficulty } from './classifier.js';
import { lengthBaseline } from './classifier.js';

/** One labelled prompt of a routing set (`data/routing_eval.jsonl` or the development set). */
export interface RoutingCase {
  id: string;
  expectedTier: 'fast' | 'smart';
  note: string;
  prompt: string;
}

export interface CaseResult {
  id: string;
  expected: 'fast' | 'smart';
  actual: 'fast' | 'smart';
  correct: boolean;
  /** The classifier's explanation (the baseline's is a fixed rule). */
  reason: string;
  note: string;
}

export interface EvalReport {
  total: number;
  correct: number;
  accuracy: number;
  cases: CaseResult[];
}

const TIER: Record<Difficulty, 'fast' | 'smart'> = { simple: 'fast', complex: 'smart' };

export function parseRoutingCases(text: string, source: string): RoutingCase[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      const tier = row.expected_tier;
      if (
        typeof row.id !== 'string' ||
        typeof row.prompt !== 'string' ||
        (tier !== 'fast' && tier !== 'smart')
      ) {
        throw new Error(`${source} line ${index + 1}: needs id, prompt and expected_tier`);
      }
      return {
        id: row.id,
        expectedTier: tier,
        note: typeof row.note === 'string' ? row.note : '',
        prompt: row.prompt,
      };
    });
}

export function loadRoutingCases(path: string): RoutingCase[] {
  return parseRoutingCases(readFileSync(path, 'utf8'), path);
}

function report(cases: CaseResult[]): EvalReport {
  const correct = cases.filter((c) => c.correct).length;
  return {
    total: cases.length,
    correct,
    accuracy: cases.length === 0 ? 0 : Math.round((correct / cases.length) * 1000) / 1000,
    cases,
  };
}

/**
 * Classification only: nothing is sent upstream. The labels are read here, to score the answers,
 * and nowhere in the classifier (architecture §4.4).
 */
export async function evaluateClassifier(
  cases: readonly RoutingCase[],
  classifier: Classifier,
): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const result = await classifier.classify([{ role: 'user', content: c.prompt }]);
    const actual = TIER[result.difficulty];
    results.push({
      id: c.id,
      expected: c.expectedTier,
      actual,
      correct: actual === c.expectedTier,
      reason: result.reason,
      note: c.note,
    });
  }
  return report(results);
}

export function evaluateBaseline(cases: readonly RoutingCase[]): EvalReport {
  return report(
    cases.map((c) => {
      const actual = TIER[lengthBaseline([{ role: 'user', content: c.prompt }])];
      return {
        id: c.id,
        expected: c.expectedTier,
        actual,
        correct: actual === c.expectedTier,
        reason: `length ${c.prompt.length} chars`,
        note: c.note,
      };
    }),
  );
}
