import { randomUUID } from 'node:crypto';
import type { Secret } from '../secret.js';
import { ProviderError } from './errors.js';
import type {
  CallOptions,
  ProviderAdapter,
  UpstreamChunk,
  UpstreamRequest,
  UpstreamResponse,
  Usage,
} from './types.js';

/** A completion larger than this is not a chat reply; stop reading rather than buffer it. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** A single SSE event larger than this is malformed. */
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export interface OpenAICompatibleOptions {
  name: string;
  baseUrl: string;
  /** The provider credential: sent upstream, never logged and never part of an error message. */
  apiKey: Secret;
  /** Replaceable in tests. */
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Owns the timers and the abort controller of one provider call. Whatever fires first (a phase
 * timeout, the overall deadline, the caller's signal) aborts the in-flight request and records why,
 * so the failure can be reported as a timeout or an abort instead of a generic network error.
 */
class CallScope {
  readonly controller = new AbortController();
  reason: 'timeout' | 'aborted' | null = null;
  private phaseTimer: NodeJS.Timeout | undefined;
  private readonly deadlineTimer: NodeJS.Timeout;
  private readonly onExternalAbort = (): void => this.abort('aborted');

  constructor(private readonly options: CallOptions) {
    this.deadlineTimer = setTimeout(() => this.abort('timeout'), options.timeouts.deadlineMs);
    if (options.signal?.aborted === true) this.abort('aborted');
    else options.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
  }

  abort(reason: 'timeout' | 'aborted'): void {
    if (this.reason !== null) return;
    this.reason = reason;
    this.controller.abort();
  }

  /** Starts (or restarts) the timer for the current phase. */
  arm(ms: number): void {
    this.disarm();
    this.phaseTimer = setTimeout(() => this.abort('timeout'), ms);
  }

  disarm(): void {
    if (this.phaseTimer !== undefined) clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
  }

  close(): void {
    this.disarm();
    clearTimeout(this.deadlineTimer);
    this.options.signal?.removeEventListener('abort', this.onExternalAbort);
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: Secret;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chatCompletion(request: UpstreamRequest, options: CallOptions): Promise<UpstreamResponse> {
    const scope = new CallScope(options);
    try {
      const response = await this.post(
        { ...request.params, model: request.model, messages: request.messages, stream: false },
        scope,
        options,
      );
      if (!response.ok) throw await this.statusError(response);
      // The body is read under the overall deadline: a provider that sends headers and then
      // stalls cannot hold the request open.
      const text = await this.readText(response);
      return this.parseCompletion(text, request.model);
    } catch (err) {
      throw this.failure(err, scope);
    } finally {
      scope.close();
      scope.controller.abort();
    }
  }

  async *chatCompletionStream(
    request: UpstreamRequest,
    options: CallOptions,
  ): AsyncGenerator<UpstreamChunk> {
    const scope = new CallScope(options);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.post(
        {
          ...request.params,
          model: request.model,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
        },
        scope,
        options,
      );
      if (!response.ok) throw await this.statusError(response);
      const type = response.headers.get('content-type') ?? '';
      if (!type.includes('text/event-stream') || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderError(
          'malformed',
          this.name,
          `provider "${this.name}" did not return an event stream`,
          response.status,
        );
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        // Each wait for the next bytes has its own idle timer (edge case 9.11).
        scope.arm(options.timeouts.idleMs);
        let step: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;
        try {
          step = await reader.read();
        } finally {
          scope.disarm();
        }
        if (step.done) break;

        // Normalise the whole buffer, not just the new bytes: a CRLF can be split across reads.
        buffer = (buffer + decoder.decode(step.value, { stream: true })).replaceAll('\r\n', '\n');
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = this.eventData(event);
          if (data === '[DONE]') return;
          if (data !== null) {
            const chunk = this.parseChunk(data);
            if (chunk !== null) yield chunk;
          }
          end = buffer.indexOf('\n\n');
        }
        if (buffer.length > MAX_EVENT_BYTES) {
          throw new ProviderError(
            'malformed',
            this.name,
            `provider "${this.name}" sent an oversized stream event`,
          );
        }
      }
      throw new ProviderError(
        'connection',
        this.name,
        `provider "${this.name}" closed the stream before it finished`,
      );
    } catch (err) {
      throw this.failure(err, scope);
    } finally {
      scope.close();
      scope.controller.abort();
      await reader?.cancel().catch(() => undefined);
    }
  }

  // --- request ---------------------------------------------------------------------------

  private async post(body: unknown, scope: CallScope, options: CallOptions): Promise<Response> {
    scope.arm(options.timeouts.firstByteMs);
    try {
      return await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${this.apiKey.reveal()}`,
        },
        body: JSON.stringify(body),
        signal: scope.controller.signal,
        // A provider answering with a redirect is misconfigured; never follow it with our key.
        redirect: 'manual',
      });
    } finally {
      scope.disarm();
    }
  }

  /** Maps whatever went wrong to a `ProviderError`; the provider's body is never included. */
  private failure(err: unknown, scope: CallScope): ProviderError {
    if (err instanceof ProviderError && scope.reason === null) return err;
    if (scope.reason === 'timeout') {
      return new ProviderError(
        'timeout',
        this.name,
        `provider "${this.name}" did not respond in time`,
      );
    }
    if (scope.reason === 'aborted') {
      return new ProviderError('aborted', this.name, 'the call was aborted by the caller');
    }
    return new ProviderError(
      'connection',
      this.name,
      `provider "${this.name}" could not be reached`,
    );
  }

  private async statusError(response: Response): Promise<ProviderError> {
    await response.body?.cancel().catch(() => undefined);
    const { status } = response;
    if (status === 429) {
      return new ProviderError(
        'rate_limited',
        this.name,
        `provider "${this.name}" rate limited the request`,
        status,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (status === 401 || status === 403) {
      return new ProviderError(
        'auth',
        this.name,
        `provider "${this.name}" rejected the gateway's credentials`,
        status,
      );
    }
    if (status === 408 || status >= 500) {
      return new ProviderError(
        'server_error',
        this.name,
        `provider "${this.name}" failed with status ${status}`,
        status,
      );
    }
    return new ProviderError(
      'bad_request',
      this.name,
      `provider "${this.name}" refused the request with status ${status}`,
      status,
    );
  }

  // --- response --------------------------------------------------------------------------

  private async readText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return '';
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderError(
          'malformed',
          this.name,
          `provider "${this.name}" sent an oversized response`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  private malformed(what: string): ProviderError {
    return new ProviderError('malformed', this.name, `provider "${this.name}" ${what}`);
  }

  private parseUsage(value: unknown): Usage | null {
    if (!isObject(value)) return null;
    const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = value;
    if (!isCount(promptTokens) || !isCount(completionTokens)) return null;
    return { promptTokens, completionTokens };
  }

  private parseCompletion(text: string, requestedModel: string): UpstreamResponse {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw this.malformed('returned a response that is not valid JSON');
    }
    if (!isObject(body)) throw this.malformed('returned a response that is not a JSON object');

    const choice: unknown = Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (!isObject(choice) || !isObject(choice.message)) {
      throw this.malformed('returned a response without choices');
    }
    const content = choice.message.content;
    if (typeof content !== 'string') {
      throw this.malformed('returned a choice without text content');
    }

    // Billing depends on this, so it must be present and sane. A response with no usage, or one
    // reporting zero tokens for a non-empty exchange, is a failure, never a free request
    // (edge cases 8.13, 10.6).
    const usage = this.parseUsage(body.usage);
    if (usage === null) throw this.malformed('returned a response without valid token usage');
    if (usage.promptTokens + usage.completionTokens === 0) {
      throw this.malformed('reported zero tokens for a request');
    }

    return {
      id: typeof body.id === 'string' && body.id !== '' ? body.id : `chatcmpl-${randomUUID()}`,
      model: typeof body.model === 'string' ? body.model : requestedModel,
      content,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
      usage,
      created: isCount(body.created) ? body.created : Math.floor(Date.now() / 1000),
    };
  }

  /** The joined `data:` lines of one SSE event, or `null` for comments and other fields. */
  private eventData(event: string): string | null {
    const lines: string[] = [];
    for (const line of event.split('\n')) {
      if (!line.startsWith('data:')) continue;
      lines.push(line.slice(5).replace(/^ /, ''));
    }
    return lines.length === 0 ? null : lines.join('\n');
  }

  private parseChunk(data: string): UpstreamChunk | null {
    let body: unknown;
    try {
      body = JSON.parse(data);
    } catch {
      throw this.malformed('sent a stream event that is not valid JSON');
    }
    if (!isObject(body)) throw this.malformed('sent a stream event that is not a JSON object');
    // A provider-side error event in the stream is a failure, not data.
    if ('error' in body) throw this.malformed('reported an error in the stream');

    const choice: unknown = Array.isArray(body.choices) ? body.choices[0] : undefined;
    const usage = this.parseUsage(body.usage);
    if (!isObject(choice)) {
      // The usage-only chunk some providers send last has no choices.
      return usage === null ? null : { content: '', finishReason: null, usage };
    }
    const delta = isObject(choice.delta) ? choice.delta : {};
    return {
      content: typeof delta.content === 'string' ? delta.content : '',
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      usage,
    };
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null;
  return Math.min(Number(header.trim()) * 1000, MAX_RETRY_AFTER_MS);
}
