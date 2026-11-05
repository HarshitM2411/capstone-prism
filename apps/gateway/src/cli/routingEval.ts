/**
 * One-command routing eval (architecture §4.4): runs a labelled prompt set through the `auto`
 * classifier and through the length-only baseline, classification only (no provider is called),
 * and prints `{ set, classifier, baseline }` where each side is
 * `{ total, correct, accuracy, cases: [{ id, expected, actual, correct, reason, note }] }`.
 *
 *   pnpm routing:eval                      # the provided data/routing_eval.jsonl (measurement only)
 *   pnpm routing:eval -- --set dev         # our own development set (used for tuning)
 *   pnpm routing:eval -- --set both
 *   pnpm routing:eval -- --structural-only # without the embedding model
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_EMBEDDING_CACHE_DIR } from '../config/env.js';
import { DEFAULT_EMBEDDING_MODEL } from '../embeddings/embedCore.js';
import { WorkerEmbedder } from '../embeddings/workerEmbedder.js';
import { DifficultyClassifier } from '../routing/classifier.js';
import {
  evaluateBaseline,
  evaluateClassifier,
  loadRoutingCases,
  type EvalReport,
} from '../routing/evaluate.js';

const DEV_FILE = fileURLToPath(new URL('../../eval/routing_dev.jsonl', import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const DEFAULT_MODEL_DIR = DEFAULT_EMBEDDING_CACHE_DIR;

type SetName = 'eval' | 'dev';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function pathFor(set: SetName): string {
  if (set === 'dev') return DEV_FILE;
  return (
    argument('--file') ??
    join(process.env.DATA_DIR?.trim() || DEFAULT_DATA_DIR, 'routing_eval.jsonl')
  );
}

function summary(name: string, set: string, r: EvalReport): string {
  const misses = r.cases.filter((c) => !c.correct).map((c) => c.id);
  return `${name.padEnd(10)} ${set.padEnd(5)} ${r.correct}/${r.total} = ${(r.accuracy * 100).toFixed(1)}%${
    misses.length > 0 ? `   misses: ${misses.join(', ')}` : ''
  }`;
}

async function main(): Promise<void> {
  const requested = argument('--set') ?? 'eval';
  const sets: SetName[] =
    requested === 'both' ? ['dev', 'eval'] : requested === 'dev' ? ['dev'] : ['eval'];
  const structuralOnly = process.argv.includes('--structural-only');

  const embedder = structuralOnly
    ? null
    : new WorkerEmbedder({
        model: process.env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
        cacheDir: process.env.EMBEDDING_CACHE_DIR?.trim() || DEFAULT_MODEL_DIR,
        timeoutMs: 120_000,
      });
  const classifier = new DifficultyClassifier(embedder);
  try {
    await classifier.warm();
  } catch (err) {
    console.error(
      `embeddings unavailable (${err instanceof Error ? err.message : String(err)}); structural only`,
    );
  }

  const output: Record<string, { classifier: EvalReport; baseline: EvalReport }> = {};
  for (const set of sets) {
    const cases = loadRoutingCases(pathFor(set));
    const result = {
      classifier: await evaluateClassifier(cases, classifier),
      baseline: evaluateBaseline(cases),
    };
    output[set] = result;
    console.error(summary('classifier', set, result.classifier));
    console.error(summary('baseline', set, result.baseline));
  }
  const single = sets.length === 1 ? output[sets[0]!] : undefined;
  console.log(JSON.stringify(single ?? output, null, 2));
  await embedder?.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
