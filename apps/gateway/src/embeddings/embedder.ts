/**
 * Turns text into a unit-length vector, locally (architecture §4.5). The semantic cache and the
 * `auto` classifier both use it, so a prompt is never sent to a third party just to be compared.
 */
export interface Embedder {
  /** Length of every vector. The cache table's `vector(384)` column must match it. */
  readonly dimensions: number;
  /**
   * Whether the model is loaded right now, without waiting. Callers on the request path use it to
   * skip optional work (the cache) while the model is still starting, instead of waiting for it.
   */
  isReady?(): boolean;
  /** Resolves when the model is loaded; rejects if it cannot be. Safe to call repeatedly. */
  ready(): Promise<void>;
  /** A normalised embedding, so cosine similarity is a plain dot product. Rejects on failure. */
  embed(text: string): Promise<number[]>;
  close(): Promise<void>;
}

/** Cosine similarity of two unit vectors. */
export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/** The mean of unit vectors, scaled back to unit length. */
export function centroid(vectors: readonly (readonly number[])[]): number[] {
  const first = vectors[0];
  if (first === undefined) throw new Error('centroid of no vectors');
  const mean = new Array<number>(first.length).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < mean.length; i++) mean[i]! += vector[i] ?? 0;
  }
  const norm = Math.sqrt(mean.reduce((sum, x) => sum + x * x, 0)) || 1;
  return mean.map((x) => x / norm);
}
