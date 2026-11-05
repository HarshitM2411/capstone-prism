import { centroid, dot, type Embedder } from '../embeddings/embedder.js';
import type { ChatMessage } from '../http/validate.js';
import { COMPLEX_EXEMPLARS, SIMPLE_EXEMPLARS } from './exemplars.js';
import { analyze, taskText } from './features.js';

export type Difficulty = 'simple' | 'complex';

export interface Classification {
  difficulty: Difficulty;
  /** Structural score plus the embedding term; at or above `threshold` means complex. */
  score: number;
  threshold: number;
  /** Matched structural signals, strongest first. */
  signals: string[];
  /** Similarity to the complex centroid minus similarity to the simple one; `null` without it. */
  embedDelta: number | null;
  /** Human-readable explanation, stored as `route_reason` (never contains prompt text). */
  reason: string;
}

/** What the router depends on. Classification never throws: it degrades instead. */
export interface Classifier {
  classify(messages: readonly ChatMessage[]): Promise<Classification>;
}

/** Score at or above which a prompt is routed to the complex tier. Tuned on the dev set. */
export const COMPLEX_THRESHOLD = 1.0;
/** Scales the embedding term (a cosine difference of about ±0.2) to the structural scale. */
export const EMBED_WEIGHT = 6;
/** After a failed attempt to build the centroids, wait before trying again. */
const RETRY_CENTROIDS_MS = 15_000;

interface Centroids {
  simple: number[];
  complex: number[];
}

/**
 * Difficulty classifier for `auto` (architecture §4.4). Combines structural signals read from the
 * final instruction with the similarity of that instruction to known-simple and known-complex
 * reference prompts. If the embedding model is not available it still answers from the
 * structural signals alone, and says so in the reason.
 */
export class DifficultyClassifier implements Classifier {
  private centroids: Centroids | null = null;
  private building: Promise<Centroids> | null = null;
  private failedAt = 0;

  constructor(private readonly embedder: Embedder | null) {}

  /** Loads the model and embeds the reference prompts. Call at startup so the first request is fast. */
  async warm(): Promise<void> {
    if (this.embedder !== null) await this.getCentroids();
  }

  private getCentroids(): Promise<Centroids> {
    if (this.centroids !== null) return Promise.resolve(this.centroids);
    if (this.building !== null) return this.building;
    if (Date.now() - this.failedAt < RETRY_CENTROIDS_MS) {
      return Promise.reject(new Error('embeddings unavailable'));
    }
    const embedder = this.embedder!;
    this.building = (async () => {
      await embedder.ready();
      const simple: number[][] = [];
      const complex: number[][] = [];
      for (const text of SIMPLE_EXEMPLARS) simple.push(await embedder.embed(text));
      for (const text of COMPLEX_EXEMPLARS) complex.push(await embedder.embed(text));
      return (this.centroids = { simple: centroid(simple), complex: centroid(complex) });
    })();
    this.building.then(
      () => (this.building = null),
      () => {
        this.building = null;
        this.failedAt = Date.now();
      },
    );
    return this.building;
  }

  /** `null` when embeddings cannot be used right now. */
  private async embeddingDelta(window: string): Promise<number | null> {
    if (this.embedder === null) return null;
    try {
      const centroids = await this.getCentroids();
      const vector = await this.embedder.embed(window);
      return dot(vector, centroids.complex) - dot(vector, centroids.simple);
    } catch {
      return null;
    }
  }

  async classify(messages: readonly ChatMessage[]): Promise<Classification> {
    const analysis = analyze(taskText(messages));
    const embedDelta = await this.embeddingDelta(analysis.window);
    const score = analysis.score + (embedDelta === null ? 0 : EMBED_WEIGHT * embedDelta);
    const difficulty: Difficulty = score >= COMPLEX_THRESHOLD ? 'complex' : 'simple';

    const parts = [
      `score ${score.toFixed(2)} ${score >= COMPLEX_THRESHOLD ? '>=' : '<'} ${COMPLEX_THRESHOLD.toFixed(2)}`,
    ];
    if (analysis.signals.length > 0) parts.push(analysis.signals.slice(0, 4).join(' '));
    parts.push(
      embedDelta === null
        ? 'structural only: embeddings unavailable'
        : `embed ${embedDelta >= 0 ? '+' : ''}${embedDelta.toFixed(2)}`,
    );
    if (analysis.windowed) parts.push('long prompt: final instruction judged');

    return {
      difficulty,
      score,
      threshold: COMPLEX_THRESHOLD,
      signals: analysis.signals,
      embedDelta,
      reason: parts.join('; '),
    };
  }
}

/**
 * The comparison point (architecture §4.4): complex if the prompt is long, whatever it asks.
 * The threshold was fixed up front, not tuned.
 */
export const BASELINE_LENGTH_CHARS = 150;

export function lengthBaseline(messages: readonly ChatMessage[]): Difficulty {
  return taskText(messages).length > BASELINE_LENGTH_CHARS ? 'complex' : 'simple';
}
