import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cacheScope } from '../src/cache/scope.js';
import { DEFAULT_EMBEDDING_CACHE_DIR } from '../src/config/env.js';
import { dot } from '../src/embeddings/embedder.js';
import { DEFAULT_EMBEDDING_MODEL } from '../src/embeddings/embedCore.js';
import { WorkerEmbedder } from '../src/embeddings/workerEmbedder.js';
import type { VirtualKey } from '../src/db/keys.js';
import { readSampleRequests } from './helpers/dataDir.js';
import { KEYS, TENANTS, buildTestApp, type TestApp } from './helpers/app.js';
import { MemoryCache, waitForEntries } from './helpers/memoryCache.js';

/**
 * Threshold calibration with the real embedding model, against the starter's own cache cases
 * (`data/sample_requests.jsonl`). Skipped where the model has not been downloaded.
 *
 * Measured with Xenova/all-MiniLM-L6-v2 (cosine similarity):
 *   a1 vs a2 (paraphrase)      0.953  -> hits at 0.92 and 0.85
 *   a1 vs a3 (other intent)    0.741  -> misses at both
 *   b1 vs b2 (paraphrase)      0.684  -> misses at both: honest limitation, see the plan
 *   a1 vs unrelated            ~0.0   -> misses
 * Lowering a threshold to catch pair B (below 0.68) would also let a3 (0.74) hit, which returns a
 * wrong answer; a miss only costs a provider call. So the seeded thresholds stay.
 */
const cacheDir = process.env.EMBEDDING_CACHE_DIR?.trim() || DEFAULT_EMBEDDING_CACHE_DIR;
const modelCached =
  existsSync(join(cacheDir, DEFAULT_EMBEDDING_MODEL)) &&
  readdirSync(join(cacheDir, DEFAULT_EMBEDDING_MODEL)).length > 0;

function sample(id: string): string {
  const request = readSampleRequests().find((r) => r.id === id);
  if (request === undefined) throw new Error(`no sample ${id}`);
  const messages = request.body.messages as { role: string; content: string }[];
  return messages.at(-1)!.content;
}

describe.skipIf(!modelCached)('cache threshold calibration with the real model', () => {
  const embedder = new WorkerEmbedder({
    model: DEFAULT_EMBEDDING_MODEL,
    cacheDir,
    timeoutMs: 30_000,
  });
  let current: TestApp | undefined;

  beforeAll(async () => {
    await embedder.ready();
  }, 60_000);
  afterEach(async () => {
    await current?.app.close();
    current = undefined;
  });
  afterAll(async () => {
    await embedder.close();
  });

  const similarity = async (a: string, b: string): Promise<number> =>
    dot(
      await embedder.embed(cacheScope(chat(a))!.text),
      await embedder.embed(cacheScope(chat(b))!.text),
    );
  const chat = (content: string) => ({
    messages: [{ role: 'user' as const, content }],
    maxTokens: null,
    params: {},
  });

  it('separates paraphrases from near-misses by the seeded thresholds', async () => {
    const a = await similarity(sample('req_cache_a1'), sample('req_cache_a2'));
    const a3 = await similarity(sample('req_cache_a1'), sample('req_cache_a3'));
    const unrelated = await similarity(sample('req_cache_a1'), sample('req_basic'));
    expect(a).toBeGreaterThanOrEqual(0.92);
    expect(a3).toBeLessThan(0.85);
    expect(unrelated).toBeLessThan(0.5);
    // Pair B is only a loose paraphrase: report it, and make sure it never beats the near-miss.
    const b = await similarity(sample('req_cache_b1'), sample('req_cache_b2'));
    expect(b).toBeLessThan(0.92);
  });

  it('behaves as the smoke test expects through the whole pipeline, per key', async () => {
    const cache = new MemoryCache();
    const tenants: Record<string, VirtualKey> = {
      [KEYS.search]: { ...TENANTS[KEYS.search]!, cacheEnabled: true, cacheThreshold: 0.92 },
      'prism-sk-free-test': {
        ...TENANTS[KEYS.search]!,
        id: 7,
        team: 'free-tier',
        cacheEnabled: true,
        cacheThreshold: 0.85,
      },
    };
    const t = buildTestApp({
      cache,
      embedder,
      keys: { findByRawKey: async (raw) => tenants[raw] ?? null },
    });
    current = t;
    const ask = (key: string, content: string) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'fast', messages: [{ role: 'user', content }] },
      });

    for (const key of [KEYS.search, 'prism-sk-free-test']) {
      const salt = `calibration-${key}`;
      const a1 = `${sample('req_cache_a1')} (${salt})`;
      const a2 = `${sample('req_cache_a2')} (${salt})`;
      const a3 = `${sample('req_cache_a3')} (${salt})`;

      expect((await ask(key, a1)).headers['x-prism-cache'], 'first ask').toBe('miss');
      await waitForEntries(cache, cache.entries.length + 1);
      expect((await ask(key, a1)).headers['x-prism-cache'], 'identical repeat').toBe('hit');
      expect((await ask(key, a2)).headers['x-prism-cache'], 'paraphrase').toBe('hit');
      expect((await ask(key, a3)).headers['x-prism-cache'], 'near-miss').toBe('miss');
      expect((await ask(key, `${sample('req_basic')} (${salt})`)).headers['x-prism-cache']).toBe(
        'miss',
      );
    }
  }, 60_000);
});
