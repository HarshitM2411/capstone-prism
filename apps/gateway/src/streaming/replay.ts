/**
 * A cached answer replayed as a server-sent event stream (architecture §4.5): one content chunk,
 * a closing chunk with the finish reason, an optional usage chunk, then `data: [DONE]`.
 * The whole body is known up front, so it is returned as a string.
 */
export interface ReplayOptions {
  id: string;
  created: number;
  /** The model name the client asked for. */
  model: string;
  content: string;
  finishReason: string;
  includeUsage: boolean;
  promptTokens: number;
  completionTokens: number;
}

export function replayAsSse(options: ReplayOptions): string {
  const base = {
    id: options.id,
    object: 'chat.completion.chunk',
    created: options.created,
    model: options.model,
  };
  const event = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

  let body = event({
    ...base,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: options.content },
        finish_reason: null,
      },
    ],
  });
  body += event({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: options.finishReason }],
  });
  if (options.includeUsage) {
    body += event({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: options.promptTokens,
        completion_tokens: options.completionTokens,
        total_tokens: options.promptTokens + options.completionTokens,
      },
    });
  }
  return `${body}data: [DONE]\n\n`;
}
