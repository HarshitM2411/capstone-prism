import type { Embedder } from '../../src/embeddings/embedder.js';
import type {
  CacheEntryInput,
  CacheHit,
  CacheQuery,
  CacheStats,
  CacheStore,
} from '../../src/cache/store.js';

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
}

function unit(vector: number[]): number[] {
  const norm = Math.hypot(...vector) || 1;
  return vector.map((x) => x / norm);
}

/**
 * Embeddings the tests control: listed texts get the given vector (normalised), anything else a
 * hashed bag of words. `embedCalls` records what was embedded.
 */
export class StubEmbedder implements Embedder {
  constructor(readonly dimensions = 8) {}
  readonly vectors = new Map<string, number[]>();
  readonly embedCalls: string[] = [];
  failWith: Error | null = null;
  ready_ = true;

  isReady(): boolean {
    return this.ready_;
  }
  async ready(): Promise<void> {}
  async close(): Promise<void> {}

  set(text: string, vector: number[]): this {
    this.vectors.set(
      text,
      unit([...vector, ...new Array<number>(Math.max(0, this.dimensions - vector.length)).fill(0)]),
    );
    return this;
  }

  async embed(text: string): Promise<number[]> {
    this.embedCalls.push(text);
    if (this.failWith !== null) throw this.failWith;
    const known = this.vectors.get(text);
    if (known !== undefined) return known;
    const bag = new Array<number>(this.dimensions).fill(0);
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 997;
      bag[h % this.dimensions]! += 1;
    }
    return unit(bag);
  }
}

export interface StoredEntry extends CacheEntryInput {
  hitCount: number;
  expired: boolean;
}

/** The same lookup rules as `PgCacheStore`, in memory, for HTTP-level tests. */
export class MemoryCache implements CacheStore {
  readonly entries: StoredEntry[] = [];
  readonly lookups: CacheQuery[] = [];
  failLookup: Error | null = null;
  failWrite: Error | null = null;
  statsResult: CacheStats = { keys: [] };
  failStats: Error | null = null;

  async lookup(query: CacheQuery): Promise<CacheHit | null> {
    this.lookups.push(query);
    if (this.failLookup !== null) throw this.failLookup;
    let best: { entry: StoredEntry; similarity: number } | null = null;
    for (const entry of this.entries) {
      if (entry.expired) continue;
      if (
        entry.keyId !== query.keyId ||
        entry.alias !== query.alias ||
        entry.contextHash !== query.contextHash
      ) {
        continue;
      }
      const similarity = dot(entry.embedding, query.embedding);
      if (best === null || similarity > best.similarity) best = { entry, similarity };
    }
    if (best === null || best.similarity < query.threshold) return null;
    best.entry.hitCount++;
    return { response: best.entry.response, similarity: best.similarity };
  }

  async write(entry: CacheEntryInput): Promise<void> {
    if (this.failWrite !== null) throw this.failWrite;
    this.entries.push({ ...entry, hitCount: 0, expired: false });
  }

  async deleteExpired(): Promise<number> {
    return 0;
  }

  async stats(): Promise<CacheStats> {
    if (this.failStats !== null) throw this.failStats;
    return this.statsResult;
  }
}

/** Writes are fire-and-forget; wait for one to land. */
export async function waitForEntries(cache: MemoryCache, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (cache.entries.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
