import { Worker } from 'node:worker_threads';
import type { Embedder } from './embedder.js';
import { EMBEDDING_DIMENSIONS, type ModelSettings } from './embedCore.js';

export interface WorkerEmbedderOptions extends ModelSettings {
  /** The longest a single `embed` call may wait (including waiting for the model to load). */
  timeoutMs: number;
  /** After a failure, wait this long before trying to start the worker again. */
  retryAfterMs?: number;
}

type Outgoing =
  | { type: 'ready'; dimensions: number }
  | { type: 'load_failed'; message: string }
  | { type: 'result'; id: number; vector: number[] }
  | { type: 'failure'; id: number; message: string };

interface Pending {
  resolve: (vector: number[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The worker's code, run with `eval` so it behaves the same from source (dev, tests) and from the
 * built output, with no TypeScript loader or extra file to ship. It imports the library by its
 * resolved URL, since an eval'd worker has no module location of its own.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const transformers = await import(workerData.libraryUrl);
    transformers.env.cacheDir = workerData.cacheDir;
    const extractor = await transformers.pipeline('feature-extraction', workerData.model, {
      dtype: 'q8',
    });
    const embed = async (text) =>
      (await extractor([text], { pooling: 'mean', normalize: true })).tolist()[0];
    const probe = await embed('warm up');
    parentPort.postMessage({ type: 'ready', dimensions: probe.length });
    parentPort.on('message', (message) => {
      embed(message.text).then(
        (vector) => parentPort.postMessage({ type: 'result', id: message.id, vector }),
        (err) =>
          parentPort.postMessage({
            type: 'failure',
            id: message.id,
            message: String((err && err.message) || err),
          }),
      );
    });
  } catch (err) {
    parentPort.postMessage({ type: 'load_failed', message: String((err && err.message) || err) });
  }
})();
`;
/**
 * The local embedding model running in a worker thread. The model loads in the background (call
 * `ready()` at startup to warm it); until then, and whenever it fails, `embed` rejects within
 * `timeoutMs` and callers fall back instead of waiting (edge case: embedding failure is a miss).
 * A crashed worker is restarted by the next call, at most once per `retryAfterMs`.
 */
export class WorkerEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private worker: Worker | null = null;
  private loading: Promise<void> | null = null;
  private failedAt = 0;
  private failure: Error | null = null;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly options: WorkerEmbedderOptions) {}

  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the embedder is closed'));
    if (this.loading !== null) return this.loading;
    const retryAfter = this.options.retryAfterMs ?? 5000;
    if (this.failure !== null && Date.now() - this.failedAt < retryAfter) {
      return Promise.reject(this.failure);
    }
    this.failure = null;
    this.loading = this.start();
    // Observed by `ready()` callers; an unobserved rejection must not crash the process.
    this.loading.catch(() => undefined);
    return this.loading;
  }

  private start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
          model: this.options.model,
          cacheDir: this.options.cacheDir,
          libraryUrl: import.meta.resolve('@huggingface/transformers'),
        },
      });
      this.worker = worker;
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.onWorkerGone(worker, error);
      };

      worker.on('message', (message: Outgoing) => {
        if (message.type === 'ready') {
          settled = true;
          resolve();
        } else if (message.type === 'load_failed') {
          fail(new Error(`embedding model could not be loaded: ${message.message}`));
        } else {
          this.settle(message);
        }
      });
      worker.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      worker.on('exit', () => fail(new Error('the embedding worker stopped')));
    });
  }

  private onWorkerGone(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.loading = null;
    this.failure = error;
    this.failedAt = Date.now();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    void worker.terminate();
  }

  private settle(message: Extract<Outgoing, { type: 'result' | 'failure' }>): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === 'result') pending.resolve(message.vector);
    else pending.reject(new Error(message.message));
  }

  async embed(text: string): Promise<number[]> {
    const deadline = Date.now() + this.options.timeoutMs;
    await withTimeout(this.ready(), this.options.timeoutMs, 'the embedding model is still loading');
    const worker = this.worker;
    if (worker === null) throw this.failure ?? new Error('the embedding worker is not running');

    const id = this.nextId++;
    const remaining = Math.max(1, deadline - Date.now());
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('embedding timed out'));
      }, remaining);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, text });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.loading = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('the embedder is closed'));
      this.pending.delete(id);
    }
    await worker?.terminate();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
