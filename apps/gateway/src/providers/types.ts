import type { ChatMessage, PassThroughParams } from '../http/validate.js';

/** The gateway-internal request an adapter sends upstream. The model is the provider's own id. */
export interface UpstreamRequest {
  model: string;
  messages: readonly ChatMessage[];
  params: PassThroughParams;
}

/** Token counts as reported by the provider. These, never client numbers, are what gets billed. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface UpstreamResponse {
  id: string;
  /** The model name the provider echoed. Logged and priced by what the gateway resolved instead. */
  model: string;
  content: string;
  finishReason: string;
  usage: Usage;
  created: number;
}

/** One streamed increment. `usage` is present on the final chunk when the provider reports it. */
export interface UpstreamChunk {
  content: string;
  finishReason: string | null;
  usage: Usage | null;
}

/** Limits enforced at the adapter boundary on every call (architecture §4.6). */
export interface CallTimeouts {
  /** Time to the first response bytes (the response headers). */
  firstByteMs: number;
  /** Streams only: the longest silence between two chunks. */
  idleMs: number;
  /** The whole call, from sending the request to the last byte. */
  deadlineMs: number;
}

export interface CallOptions {
  timeouts: CallTimeouts;
  /** Aborts the call, for example when the client disconnects. */
  signal?: AbortSignal;
}

/**
 * What every provider, mock or real, implements. Gateway code never knows which it is calling.
 * Both methods reject with a `ProviderError`, and only with that.
 */
export interface ProviderAdapter {
  readonly name: string;
  chatCompletion(request: UpstreamRequest, options: CallOptions): Promise<UpstreamResponse>;
  chatCompletionStream(
    request: UpstreamRequest,
    options: CallOptions,
  ): AsyncIterable<UpstreamChunk>;
}

/** Looks up the adapter for a provider name from the gateway config. */
export interface ProviderRegistry {
  get(provider: string): ProviderAdapter | undefined;
}
