import { ProviderError, type ProviderErrorKind } from './errors.js';
import type {
  CallOptions,
  ProviderAdapter,
  UpstreamChunk,
  UpstreamRequest,
  UpstreamResponse,
  Usage,
} from './types.js';

/**
 * An in-process provider for deterministic, fast tests (architecture §4.6). It behaves like the
 * starter's mock provider: replies are a pure function of the prompt, tokens are counted as
 * whitespace-separated words, and streams arrive token by token. Latency, failures and timeouts
 * are injected per call, so failover and load tests are reproducible without any network.
 */
export type FakeOutcome =
  | { type: 'ok'; content?: string; usage?: Usage; latencyMs?: number }
  | { type: 'error'; kind: ProviderErrorKind; status?: number; retryAfterMs?: number }
  /** Never answers: the call ends only through the caller's timeouts or abort signal. */
  | { type: 'hang' }
  /** Streams only: delivers `afterChunks` chunks, then fails (a mid-stream failure). */
  | { type: 'die_mid_stream'; afterChunks: number }
  /** Streams only: delivers everything but never sends the usage object. */
  | { type: 'no_usage' };

export interface FakeAdapterOptions {
  /** Delay before every answer, unless the outcome sets its own. */
  latencyMs?: number;
  /** Delay between streamed chunks. */
  tokenDelayMs?: number;
}

export interface FakeCall {
  request: UpstreamRequest;
  startedAt: number;
}

export function countWords(text: string): number {
  return Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
}

/** Deterministic: the same prompt on the same model always gets the same reply. */
export function fakeReply(provider: string, request: UpstreamRequest): string {
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const topic = lastUser.split(/\s+/).filter(Boolean).slice(0, 12).join(' ');
  // Long enough that one request costs more than the budget-demo key's whole budget, as with
  // the starter mocks.
  return (
    `[${provider}:${request.model}] Here is a deterministic fake answer about: ${topic}. ` +
    'In practice, start simple, measure, then iterate, and profile before optimizing anything.'
  );
}

export function fakeUsage(provider: string, request: UpstreamRequest, reply?: string): Usage {
  return {
    promptTokens: request.messages.reduce((sum, m) => sum + countWords(m.content), 0),
    completionTokens: countWords(reply ?? fakeReply(provider, request)),
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class FakeAdapter implements ProviderAdapter {
  readonly calls: FakeCall[] = [];
  /** Outcomes consumed one per call, in order; once empty, `fallback` applies. */
  readonly script: FakeOutcome[] = [];
  /** Applies when the script is empty. Change it to flip a provider "down" and back. */
  fallback: FakeOutcome = { type: 'ok' };

  constructor(
    readonly name: string,
    private readonly options: FakeAdapterOptions = {},
  ) {}

  private next(request: UpstreamRequest): FakeOutcome {
    this.calls.push({ request, startedAt: Date.now() });
    return this.script.shift() ?? this.fallback;
  }

  /** Waits `ms`, but gives up with the same errors a real adapter reports. */
  private async wait(ms: number, limitMs: number, options: CallOptions): Promise<void> {
    const wait = Math.min(ms, limitMs, options.timeouts.deadlineMs);
    await sleep(wait, options.signal);
    if (options.signal?.aborted === true) {
      throw new ProviderError('aborted', this.name, 'the call was aborted by the caller');
    }
    if (ms > limitMs || ms > options.timeouts.deadlineMs) {
      throw new ProviderError(
        'timeout',
        this.name,
        `provider "${this.name}" did not respond in time`,
      );
    }
  }

  private fail(outcome: Extract<FakeOutcome, { type: 'error' }>): ProviderError {
    return new ProviderError(
      outcome.kind,
      this.name,
      `provider "${this.name}" failed (${outcome.kind})`,
      outcome.status ?? null,
      outcome.retryAfterMs ?? null,
    );
  }

  async chatCompletion(request: UpstreamRequest, options: CallOptions): Promise<UpstreamResponse> {
    const outcome = this.next(request);
    if (outcome.type === 'hang') {
      await this.wait(Number.POSITIVE_INFINITY, options.timeouts.firstByteMs, options);
    }
    const latency = outcome.type === 'ok' ? (outcome.latencyMs ?? this.options.latencyMs ?? 0) : 0;
    await this.wait(latency, options.timeouts.firstByteMs, options);
    if (outcome.type === 'error') throw this.fail(outcome);

    const content =
      outcome.type === 'ok' && outcome.content ? outcome.content : fakeReply(this.name, request);
    const usage =
      (outcome.type === 'ok' ? outcome.usage : undefined) ?? fakeUsage(this.name, request, content);
    return {
      id: `chatcmpl-fake-${this.calls.length}`,
      model: request.model,
      content,
      finishReason: 'stop',
      usage,
      created: Math.floor(Date.now() / 1000),
    };
  }

  async *chatCompletionStream(
    request: UpstreamRequest,
    options: CallOptions,
  ): AsyncGenerator<UpstreamChunk> {
    const outcome = this.next(request);
    if (outcome.type === 'hang') {
      await this.wait(Number.POSITIVE_INFINITY, options.timeouts.firstByteMs, options);
    }
    const latency = outcome.type === 'ok' ? (outcome.latencyMs ?? this.options.latencyMs ?? 0) : 0;
    await this.wait(latency, options.timeouts.firstByteMs, options);
    if (outcome.type === 'error') throw this.fail(outcome);

    const content =
      outcome.type === 'ok' && outcome.content ? outcome.content : fakeReply(this.name, request);
    const words = content.split(' ');
    const usage =
      (outcome.type === 'ok' ? outcome.usage : undefined) ?? fakeUsage(this.name, request, content);
    const tokenDelay = this.options.tokenDelayMs ?? 0;

    for (const [index, word] of words.entries()) {
      if (outcome.type === 'die_mid_stream' && index >= outcome.afterChunks) {
        throw new ProviderError(
          'connection',
          this.name,
          `provider "${this.name}" closed the stream before it finished`,
        );
      }
      await this.wait(tokenDelay, options.timeouts.idleMs, options);
      yield {
        content: index === words.length - 1 ? word : `${word} `,
        finishReason: null,
        usage: null,
      };
    }
    yield {
      content: '',
      finishReason: 'stop',
      usage: outcome.type === 'no_usage' ? null : usage,
    };
  }
}

/** A registry of fakes keyed by provider name, matching the sample config's `alpha` and `beta`. */
export class FakeRegistry {
  readonly adapters = new Map<string, FakeAdapter>();

  constructor(names: readonly string[], options: FakeAdapterOptions = {}) {
    for (const name of names) this.adapters.set(name, new FakeAdapter(name, options));
  }

  get(provider: string): FakeAdapter | undefined {
    return this.adapters.get(provider);
  }

  /** Like `get`, but for tests that know the provider exists. */
  must(provider: string): FakeAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) throw new Error(`no fake provider "${provider}"`);
    return adapter;
  }
}
