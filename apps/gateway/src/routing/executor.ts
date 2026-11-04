import type { ModelInfo, RetryPolicy } from '../config/gatewayConfig.js';
import { ProviderError } from '../providers/errors.js';
import type {
  CallOptions,
  CallTimeouts,
  ProviderAdapter,
  ProviderRegistry,
  UpstreamChunk,
  UpstreamRequest,
  UpstreamResponse,
} from '../providers/types.js';

/**
 * The retry / failover engine (architecture §4.7). Given the ordered models that may serve a
 * request (the alias's fallback chain), it makes the call and decides what to do about failures:
 *
 *  - transient failures (timeout, connection, 5xx) are retried on the same model with exponential
 *    backoff and jitter, up to `maxAttempts` tries;
 *  - a provider `429`, a malformed reply, or exhausted retries move on to the next model at once;
 *  - a request or credential problem (`auth`, `bad_request`) is final: no retry, no failover;
 *  - a caller abort stops everything;
 *  - one overall deadline caps the sum of all attempts and backoffs.
 *
 * Every request starts with the primary, so traffic returns to a restored primary immediately.
 *
 * Streams use the same engine, but only up to the first chunk: once a chunk has reached the
 * caller, the provider is committed and nothing is retried or spliced (edge cases 8.14, 9.2).
 */
export interface ExecuteBase {
  /** Models in the order they are tried; the first is the primary. */
  chain: readonly ModelInfo[];
  providers: ProviderRegistry;
  timeouts: CallTimeouts;
  retry: RetryPolicy;
  signal?: AbortSignal;
  /** Called for every failed attempt, for logging. Never receives provider bodies or keys. */
  onAttemptFailed?: (event: AttemptFailure) => void;
  /** Injectable for tests. */
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  now?: () => number;
}

export interface ExecuteInput extends ExecuteBase {
  /** The client's request; `model` is replaced by each target's provider-side model id. */
  request: Omit<UpstreamRequest, 'model'>;
}

export interface StreamExecuteInput extends ExecuteInput {
  /** The longest a stream may last once it has started (the request deadline only covers the start). */
  streamMaxMs: number;
}

export interface AttemptFailure {
  model: ModelInfo;
  /** 1-based attempt number on this model. */
  attempt: number;
  error: ProviderError;
  /** What happens next. */
  next: 'retry' | 'failover' | 'stop';
  /** Backoff before the retry, when `next` is `retry`. */
  delayMs: number | null;
}

interface Served {
  /** The model that produced the response: this is what gets priced and logged. */
  model: ModelInfo;
  /** A model other than the primary served the request. */
  fallback: boolean;
  /** Same-model retries made across the whole request (failed attempts that were retried). */
  retries: number;
  /** Total provider calls made, failed ones included. */
  attempts: number;
}

export interface ExecuteSuccess extends Served {
  response: UpstreamResponse;
}

/** A stream whose first step has already been read: the provider has answered. */
export interface OpenedStream {
  /** Normally the first chunk; `done` for a stream that ended without sending anything. */
  first: IteratorResult<UpstreamChunk>;
  iterator: AsyncIterator<UpstreamChunk>;
  /** Stops the upstream call (idempotent). Used for client disconnects and the stream cap. */
  abort(): void;
}

export interface StreamSuccess extends Served {
  stream: OpenedStream;
}

/** Nothing produced a response. `lastModel` is the last one tried. */
export class ExecuteFailure extends Error {
  constructor(
    readonly reason: 'provider' | 'deadline' | 'aborted',
    readonly lastError: ProviderError | null,
    readonly lastModel: ModelInfo,
    readonly retries: number,
    readonly attempts: number,
    /** More than one model was tried. */
    readonly failedOver: boolean,
  ) {
    super(`all attempts failed (${reason})`);
    this.name = 'ExecuteFailure';
  }
}

const JITTER = 0.25;

/** `initial × multiplier^(attempt-1)`, spread ±25% so simultaneous clients do not retry in step. */
export function backoffDelayMs(
  policy: RetryPolicy,
  failedAttempt: number,
  random: () => number = Math.random,
): number {
  const base = policy.initialBackoffMs * policy.backoffMultiplier ** (failedAttempt - 1);
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** What one attempt may spend, derived from the time left before the request deadline. */
interface AttemptBudget {
  firstByteMs: number;
  idleMs: number;
  remainingMs: number;
}

/**
 * The retry / failover loop shared by plain and streaming requests. `attempt` makes one call on
 * one model and resolves with its result (or rejects with a `ProviderError`).
 */
async function runChain<T>(
  input: ExecuteBase,
  attempt: (adapter: ProviderAdapter, model: ModelInfo, budget: AttemptBudget) => Promise<T>,
): Promise<{ value: T } & Served> {
  const { chain, retry } = input;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const random = input.random ?? Math.random;
  const deadline = now() + input.timeouts.deadlineMs;

  let attempts = 0;
  let retries = 0;
  let lastError: ProviderError | null = null;
  let lastModel = chain[0]!;

  for (const [index, model] of chain.entries()) {
    lastModel = model;
    const adapter = input.providers.get(model.provider);
    if (adapter === undefined) {
      // Startup validation guarantees every priced model has a registered provider.
      throw new Error(`no adapter registered for provider "${model.provider}"`);
    }

    for (let attemptNumber = 1; ; attemptNumber++) {
      if (input.signal?.aborted === true) {
        throw new ExecuteFailure('aborted', lastError, model, retries, attempts, index > 0);
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new ExecuteFailure('deadline', lastError, model, retries, attempts, index > 0);
      }

      attempts++;
      try {
        // No call may outlive the request deadline, whatever its own timeouts say.
        const value = await attempt(adapter, model, {
          firstByteMs: Math.min(input.timeouts.firstByteMs, remaining),
          idleMs: input.timeouts.idleMs,
          remainingMs: remaining,
        });
        return { value, model, fallback: index > 0, retries, attempts };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        lastError = err;

        const disposition = err.disposition;
        const canRetry = disposition === 'retry' && attemptNumber < retry.maxAttempts;
        const delayMs = canRetry ? backoffDelayMs(retry, attemptNumber, random) : null;
        // A retry that could not even start before the deadline is pointless: move on.
        const retryFits = delayMs !== null && delayMs < deadline - now();
        const hasNextModel = index < chain.length - 1;

        let next: AttemptFailure['next'];
        if (disposition === 'abort' || disposition === 'fatal') next = 'stop';
        else if (canRetry && retryFits) next = 'retry';
        else next = hasNextModel ? 'failover' : 'stop';

        input.onAttemptFailed?.({
          model,
          attempt: attemptNumber,
          error: err,
          next,
          delayMs: next === 'retry' ? delayMs : null,
        });

        if (next === 'retry') {
          retries++;
          await sleep(delayMs!, input.signal);
          continue;
        }
        if (next === 'failover') break;

        const reason = disposition === 'abort' ? 'aborted' : 'provider';
        throw new ExecuteFailure(reason, err, model, retries, attempts, index > 0);
      }
    }
  }

  // Unreachable in practice (the last model ends in a return or a throw), but keep it explicit.
  throw new ExecuteFailure('provider', lastError, lastModel, retries, attempts, chain.length > 1);
}

export async function executeWithFailover(input: ExecuteInput): Promise<ExecuteSuccess> {
  const { value, ...served } = await runChain(input, (adapter, model, budget) => {
    const options: CallOptions = {
      timeouts: {
        firstByteMs: budget.firstByteMs,
        idleMs: budget.idleMs,
        deadlineMs: budget.remainingMs,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    return adapter.chatCompletion({ ...input.request, model: model.name }, options);
  });
  return { response: value, ...served };
}

/**
 * Opens a stream on the first model that produces a first chunk, retrying and failing over
 * exactly like a plain call. The request deadline bounds the wait for that first chunk; after it
 * the stream may run for up to `streamMaxMs`. The returned stream is positioned after its first
 * step, which the caller must still relay.
 */
export async function executeStreamWithFailover(input: StreamExecuteInput): Promise<StreamSuccess> {
  const { value, ...served } = await runChain(input, async (adapter, model, budget) => {
    // Our own abort handle: it fires when the first chunk is overdue (the request deadline) and
    // is what the caller uses later to stop the stream. The client's signal is folded in.
    const stop = new AbortController();
    let overdue = false;
    const timer = setTimeout(() => {
      overdue = true;
      stop.abort();
    }, budget.remainingMs);
    const signal =
      input.signal === undefined ? stop.signal : AbortSignal.any([input.signal, stop.signal]);

    const iterator = adapter
      .chatCompletionStream(
        { ...input.request, model: model.name },
        {
          timeouts: {
            firstByteMs: budget.firstByteMs,
            idleMs: budget.idleMs,
            deadlineMs: Math.max(input.streamMaxMs, budget.remainingMs),
          },
          signal,
        },
      )
      [Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      return { first, iterator, abort: () => stop.abort() } satisfies OpenedStream;
    } catch (err) {
      if (overdue && err instanceof ProviderError && err.kind === 'aborted') {
        throw new ProviderError(
          'timeout',
          err.provider,
          `provider "${err.provider}" did not respond in time`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  });
  return { stream: value, ...served };
}
