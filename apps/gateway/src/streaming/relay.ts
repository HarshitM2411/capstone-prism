import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ProviderError } from '../providers/errors.js';
import type { Usage } from '../providers/types.js';
import type { OpenedStream } from '../routing/executor.js';

/**
 * Relays an upstream stream to the client as OpenAI-style server-sent events (architecture §4.8).
 *
 * The body is pull-based: the next upstream chunk is only read when the client has taken the
 * previous one, so a slow client slows the provider read instead of growing a buffer (edge case
 * 9.5). Nothing is accumulated except counters (and, only when the caller asks for it so the answer\n * can be cached, the text up to a size cap). Once the first chunk has been relayed the
 * provider is final: a failure ends the stream with an SSE `error` event and `[DONE]`, never with
 * a switch to another provider (edge cases 8.14, 9.2).
 *
 * However the stream ends (completed, provider failure, client gone, time cap), `onEnd` runs
 * exactly once with what was delivered, so the request is always metered, settled and logged.
 */

export type StreamEnd = 'complete' | 'upstream_failed' | 'client_disconnect';

export interface StreamSummary {
  end: StreamEnd;
  /** Token counts reported by the provider; `null` when its final usage chunk never arrived. */
  usage: Usage | null;
  /** Tokens (counted like the mock providers: whitespace-separated words) actually relayed. */
  deliveredTokens: number;
  timeToFirstTokenMs: number | null;
  /** The provider failure behind an `upstream_failed` end, when there was one. */
  failure: ProviderError | null;
  /**
   * The complete text, only for a stream that completed and was asked to collect it (and fit in
   * the cap); `null` otherwise. This is what the semantic cache stores.
   */
  content: string | null;
  /** The provider's finish reason, if it sent one. */
  finishReason: string | null;
}

export interface BilledUsage {
  usage: Usage;
  /** True when the numbers are our estimate, not the provider's (`request_logs.usage_estimated`). */
  estimated: boolean;
}

/**
 * The usage to bill. Provider-reported numbers when they exist; otherwise tokens estimated from
 * what was delivered, flagged as such, and nothing at all if nothing was delivered (edge cases
 * 5.8, 9.6).
 */
export function resolveStreamUsage(
  summary: Pick<StreamSummary, 'usage' | 'deliveredTokens'>,
  promptTokensEstimate: number,
): BilledUsage {
  const reported = summary.usage;
  if (reported !== null && reported.promptTokens + reported.completionTokens > 0) {
    return { usage: reported, estimated: false };
  }
  if (summary.deliveredTokens === 0) {
    return { usage: { promptTokens: 0, completionTokens: 0 }, estimated: true };
  }
  return {
    usage: { promptTokens: promptTokensEstimate, completionTokens: summary.deliveredTokens },
    estimated: true,
  };
}

/** Counts whitespace-separated words across chunk boundaries, without keeping the text. */
export class WordCounter {
  count = 0;
  private inWord = false;

  add(text: string): void {
    for (const part of text.matchAll(/\S+|\s+/g)) {
      if (part[0].trimStart() === '') {
        this.inWord = false;
      } else {
        if (!this.inWord) this.count++;
        this.inWord = true;
      }
    }
  }
}

export interface RelayOptions {
  opened: OpenedStream;
  /** The raw response: its `close` tells us the client went away. */
  res: Pick<ServerResponse, 'once' | 'off' | 'destroy'>;
  id: string;
  created: number;
  /** The model name echoed in every chunk: what the client asked for. */
  model: string;
  /** The client asked for `stream_options.include_usage`. */
  includeUsage: boolean;
  /** Used when the provider never reports usage. */
  promptTokensEstimate: number;
  /** Keep the delivered text, up to this many characters, for the summary. `0` keeps none. */
  collectMaxChars?: number;
  /** The longest the whole stream may last, however slow the client or the provider. */
  maxDurationMs: number;
  /** Milliseconds since the request started. */
  elapsedMs: () => number;
  /** Runs exactly once, after the last byte was written (or the stream was abandoned). */
  onEnd: (summary: StreamSummary) => Promise<void>;
}

export interface SseBody {
  body: Readable;
  /** Resolves once `onEnd` has finished. */
  done: Promise<void>;
}

const DONE_EVENT = 'data: [DONE]\n\n';
const ERROR_EVENT =
  'event: error\n' +
  `data: ${JSON.stringify({
    error: {
      message: 'The upstream model provider failed while streaming the response.',
      type: 'upstream_error',
      code: 'upstream_error',
    },
  })}\n\n`;

export function createSseBody(options: RelayOptions): SseBody {
  const { opened } = options;
  const counter = new WordCounter();
  let usage: Usage | null = null;
  let timeToFirstTokenMs: number | null = null;
  let end: StreamEnd | null = null;
  let failure: ProviderError | null = null;
  let capped = false;
  const collectMax = options.collectMaxChars ?? 0;
  let text = '';
  let textOverflow = false;
  let finishReason: string | null = null;
  let finalizing: Promise<void> | null = null;
  const timers: { cap?: NodeJS.Timeout } = {};
  let markDone!: () => void;
  const done = new Promise<void>((resolve) => (markDone = resolve));

  const summary = (): StreamSummary => ({
    end: end ?? (capped ? 'upstream_failed' : 'client_disconnect'),
    usage,
    deliveredTokens: counter.count,
    timeToFirstTokenMs,
    failure,
    content: collectMax > 0 && end === 'complete' && !textOverflow ? text : null,
    finishReason,
  });

  const onResponseClosed = (): void => {
    // Closed before the stream completed: the client is gone. Stop paying for the provider.
    if (end === null) opened.abort();
  };
  options.res.once('close', onResponseClosed);

  const finalize = (): Promise<void> => {
    finalizing ??= (async () => {
      clearTimeout(timers.cap);
      options.res.off('close', onResponseClosed);
      opened.abort();
      try {
        await opened.iterator.return?.();
      } catch {
        // The upstream generator is already finished; nothing else to release.
      }
      try {
        await options.onEnd(summary());
      } catch {
        // `onEnd` reports its own failures; the stream is over either way.
      }
      markDone();
    })();
    return finalizing;
  };

  const chunk = (delta: Record<string, string>, finishReason: string | null): string =>
    `data: ${JSON.stringify({
      id: options.id,
      object: 'chat.completion.chunk',
      created: options.created,
      model: options.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  async function* events(): AsyncGenerator<string> {
    let sentRole = false;
    let sentFinish = false;
    const delta = (content: string): Record<string, string> => {
      const first = !sentRole;
      sentRole = true;
      if (first) return { role: 'assistant', content };
      return content === '' ? {} : { content };
    };

    try {
      let step = opened.first;
      while (!step.done) {
        const piece = step.value;
        if (piece.usage !== null) usage = piece.usage;
        if (piece.finishReason !== null) finishReason = piece.finishReason;
        if (collectMax > 0 && !textOverflow) {
          if (text.length + piece.content.length > collectMax) {
            textOverflow = true;
            text = '';
          } else {
            text += piece.content;
          }
        }
        if (piece.content !== '' || piece.finishReason !== null) {
          if (piece.content !== '') {
            counter.add(piece.content);
            timeToFirstTokenMs ??= options.elapsedMs();
          }
          if (piece.finishReason !== null) sentFinish = true;
          yield chunk(delta(piece.content), piece.finishReason);
        }
        step = await opened.iterator.next();
      }

      end = 'complete';
      if (!sentFinish) yield chunk(delta(''), 'stop');
      if (options.includeUsage) {
        const billed = resolveStreamUsage(summary(), options.promptTokensEstimate).usage;
        yield `data: ${JSON.stringify({
          id: options.id,
          object: 'chat.completion.chunk',
          created: options.created,
          model: options.model,
          choices: [],
          usage: {
            prompt_tokens: billed.promptTokens,
            completion_tokens: billed.completionTokens,
            total_tokens: billed.promptTokens + billed.completionTokens,
          },
        })}\n\n`;
      }
      yield DONE_EVENT;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'aborted' && !capped) {
        end = 'client_disconnect';
        return;
      }
      end = 'upstream_failed';
      failure = err instanceof ProviderError ? err : null;
      yield ERROR_EVENT;
      yield DONE_EVENT;
    } finally {
      // Settle and log before the response is closed, so a finished request is always accounted.
      await finalize();
    }
  }

  const body = Readable.from(events(), { objectMode: false });

  // A destroyed body (client gone) must also release a pending upstream read at once; otherwise
  // closing it would wait for that read to finish on its own.
  const destroy = body.destroy.bind(body);
  body.destroy = (error?: Error): Readable => {
    if (end === null) opened.abort();
    return destroy(error);
  };
  body.once('close', () => void finalize());

  // The whole stream, including one stuck behind a client that stopped reading, ends by itself.
  timers.cap = setTimeout(() => {
    capped = true;
    opened.abort();
    options.res.destroy();
    body.destroy();
  }, options.maxDurationMs);
  timers.cap.unref();

  return { body, done };
}
