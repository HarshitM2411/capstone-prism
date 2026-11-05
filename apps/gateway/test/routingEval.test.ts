import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_EMBEDDING_CACHE_DIR } from '../src/config/env.js';
import { DEFAULT_EMBEDDING_MODEL } from '../src/embeddings/embedCore.js';
import { WorkerEmbedder } from '../src/embeddings/workerEmbedder.js';
import { DifficultyClassifier } from '../src/routing/classifier.js';
import {
  evaluateBaseline,
  evaluateClassifier,
  loadRoutingCases,
  parseRoutingCases,
} from '../src/routing/evaluate.js';
import { DATA_DIR } from './helpers/dataDir.js';

const DEV_SET = fileURLToPath(new URL('../eval/routing_dev.jsonl', import.meta.url));
const PROVIDED_SET = join(DATA_DIR, 'routing_eval.jsonl');

const cacheDir = process.env.EMBEDDING_CACHE_DIR?.trim() || DEFAULT_EMBEDDING_CACHE_DIR;
const modelCached =
  existsSync(join(cacheDir, DEFAULT_EMBEDDING_MODEL)) &&
  readdirSync(join(cacheDir, DEFAULT_EMBEDDING_MODEL)).length > 0;

describe('routing case files', () => {
  it('parse and reject malformed lines', () => {
    expect(parseRoutingCases('{"id":"a","prompt":"p","expected_tier":"fast"}\n', 'x')).toEqual([
      { id: 'a', expectedTier: 'fast', note: '', prompt: 'p' },
    ]);
    expect(() => parseRoutingCases('{"id":"a","prompt":"p"}', 'x')).toThrow(/expected_tier/);
  });

  it('hold the development set: our own prompts, none copied from the provided set', () => {
    const dev = loadRoutingCases(DEV_SET);
    const provided = new Set(loadRoutingCases(PROVIDED_SET).map((c) => c.prompt.trim()));
    expect(dev.length).toBeGreaterThanOrEqual(60);
    expect(dev.filter((c) => provided.has(c.prompt.trim()))).toEqual([]);
    expect(dev.filter((c) => c.expectedTier === 'fast').length).toBeGreaterThan(20);
    expect(dev.filter((c) => c.expectedTier === 'smart').length).toBeGreaterThan(20);
    expect(new Set(dev.map((c) => c.id)).size).toBe(dev.length);
  });

  it('leave exemplars disjoint from every evaluation prompt (edge case 6.14)', async () => {
    const { COMPLEX_EXEMPLARS, SIMPLE_EXEMPLARS } = await import('../src/routing/exemplars.js');
    const used = new Set(
      [...loadRoutingCases(DEV_SET), ...loadRoutingCases(PROVIDED_SET)].map((c) => c.prompt.trim()),
    );
    expect([...SIMPLE_EXEMPLARS, ...COMPLEX_EXEMPLARS].filter((e) => used.has(e.trim()))).toEqual(
      [],
    );
  });
});

describe('structural classifier', () => {
  const classifier = new DifficultyClassifier(null);

  it('beats the length baseline on the development set by a wide margin', async () => {
    const dev = loadRoutingCases(DEV_SET);
    const ours = await evaluateClassifier(dev, classifier);
    const baseline = evaluateBaseline(dev);
    expect(ours.accuracy).toBeGreaterThanOrEqual(0.85);
    expect(ours.accuracy).toBeGreaterThan(baseline.accuracy + 0.2);
  });

  it('reports a reason for every case', async () => {
    const report = await evaluateClassifier(loadRoutingCases(PROVIDED_SET), classifier);
    expect(report.total).toBe(20);
    expect(report.cases.every((c) => c.reason.length > 0)).toBe(true);
  });
});

// With the real model. Skipped where it has not been downloaded (`pnpm routing:eval` fetches it).
describe.skipIf(!modelCached)('classifier with the embedding model', () => {
  const embedder = new WorkerEmbedder({
    model: DEFAULT_EMBEDDING_MODEL,
    cacheDir,
    timeoutMs: 30_000,
  });
  const classifier = new DifficultyClassifier(embedder);

  beforeAll(async () => {
    await classifier.warm();
  }, 60_000);
  afterAll(async () => {
    await embedder.close();
  });

  it('is clearly above the baseline on the development set', async () => {
    const dev = loadRoutingCases(DEV_SET);
    const ours = await evaluateClassifier(dev, classifier);
    expect(ours.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(ours.accuracy).toBeGreaterThan(evaluateBaseline(dev).accuracy + 0.3);
  });

  it('meets the Phase 7 exit criteria on the provided routing eval', async () => {
    const cases = loadRoutingCases(PROVIDED_SET);
    const ours = await evaluateClassifier(cases, classifier);
    const baseline = evaluateBaseline(cases);
    expect(ours.total).toBe(20);
    expect(ours.accuracy).toBeGreaterThanOrEqual(0.8);
    expect(ours.accuracy).toBeGreaterThan(baseline.accuracy);
    expect(ours.cases.every((c) => c.reason.length > 0)).toBe(true);
  });
});
