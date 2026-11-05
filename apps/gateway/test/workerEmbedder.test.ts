import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EMBEDDING_CACHE_DIR } from '../src/config/env.js';
import { centroid, dot } from '../src/embeddings/embedder.js';
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../src/embeddings/embedCore.js';
import { WorkerEmbedder } from '../src/embeddings/workerEmbedder.js';

const cacheDir = process.env.EMBEDDING_CACHE_DIR?.trim() || DEFAULT_EMBEDDING_CACHE_DIR;
const modelCached =
  existsSync(join(cacheDir, DEFAULT_EMBEDDING_MODEL)) &&
  readdirSync(join(cacheDir, DEFAULT_EMBEDDING_MODEL)).length > 0;

describe('vector helpers', () => {
  it('compute dot products and unit-length centroids', () => {
    expect(dot([1, 0], [0.6, 0.8])).toBeCloseTo(0.6);
    const c = centroid([
      [1, 0],
      [0, 1],
    ]);
    expect(Math.hypot(...c)).toBeCloseTo(1);
    expect(() => centroid([])).toThrow();
  });
});

const open: WorkerEmbedder[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});

function create(options: Partial<ConstructorParameters<typeof WorkerEmbedder>[0]> = {}) {
  const embedder = new WorkerEmbedder({
    model: DEFAULT_EMBEDDING_MODEL,
    cacheDir,
    timeoutMs: 30_000,
    ...options,
  });
  open.push(embedder);
  return embedder;
}

describe('WorkerEmbedder failure handling', () => {
  it('rejects instead of waiting when the model is not ready in time', async () => {
    const embedder = create({ timeoutMs: 1 });
    await expect(embedder.embed('hello')).rejects.toThrow();
  });

  it('rejects calls after it was closed', async () => {
    const embedder = create();
    await embedder.close();
    await expect(embedder.embed('hello')).rejects.toThrow(/closed/);
    await expect(embedder.ready()).rejects.toThrow(/closed/);
  });

  it('reports a model that cannot be loaded, without crashing the process', async () => {
    // A local-only cache directory with nothing in it and an id that cannot be fetched offline.
    const embedder = create({ model: 'prism-test/not-a-real-model', timeoutMs: 20_000 });
    await expect(embedder.ready()).rejects.toThrow();
  }, 30_000);
});

describe.skipIf(!modelCached)('WorkerEmbedder with the real model', () => {
  it('returns unit-length 384-dimensional vectors', async () => {
    const embedder = create();
    await embedder.ready();
    const vector = await embedder.embed('How do I reset my password?');
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embedder.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 3);
  }, 60_000);

  it('places paraphrases closer than unrelated sentences, deterministically', async () => {
    const embedder = create();
    await embedder.ready();
    const [a, b, c, a2] = await Promise.all([
      embedder.embed('How do I reset my password?'),
      embedder.embed('What is the way to change a forgotten password?'),
      embedder.embed('The stock market closed higher on Tuesday.'),
      embedder.embed('How do I reset my password?'),
    ]);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
    expect(dot(a!, a2!)).toBeCloseTo(1, 5);
  }, 60_000);

  it('handles concurrent requests and empty text', async () => {
    const embedder = create();
    await embedder.ready();
    const vectors = await Promise.all(
      ['one', 'two', 'three', '', '日本語', '🙂'].map((text) => embedder.embed(text)),
    );
    expect(vectors.every((v) => v.length === EMBEDDING_DIMENSIONS)).toBe(true);
  }, 60_000);
});
