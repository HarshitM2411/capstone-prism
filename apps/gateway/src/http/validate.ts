/**
 * Validation of the OpenAI-compatible `POST /v1/chat/completions` body.
 *
 * Runs after authentication (architecture §3.1). Hand-written rather than schema-driven so that
 * every problem is reported in one clear message and the response always uses the gateway's own
 * error envelope. The sender's text is never echoed back or logged.
 *
 * Decisions (edge cases 1.2, 1.4, 1.7, 1.8):
 *  - `messages` must be a non-empty array; roles are `system`, `user`, `assistant`;
 *    `content` must be a string (multimodal parts are not supported and are rejected clearly).
 *  - At least one `user` message must contain non-whitespace text (nothing meaningful to embed,
 *    classify or send otherwise).
 *  - Parameters that the gateway cannot honour (`tools`, `n > 1`, `logprobs`, ...) are rejected
 *    rather than silently dropped. Other unknown fields are ignored, as OpenAI SDKs send extras.
 */

export const MAX_MESSAGES = 500;
export const MAX_MODEL_NAME_LENGTH = 200;
const ROLES = new Set(['system', 'user', 'assistant']);

/** Fields that would change behaviour in a way this gateway does not implement. */
const UNSUPPORTED_PARAMS = [
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'response_format',
  'logit_bias',
  'top_logprobs',
  'audio',
  'modalities',
  'prediction',
] as const;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Sampling parameters passed through to the provider unchanged. */
export interface PassThroughParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  /** `max_completion_tokens` if given, else `max_tokens`; used later for budget estimates. */
  maxTokens: number | null;
  params: PassThroughParams;
}

export type ValidationResult = { ok: true; request: ChatRequest } | { ok: false; message: string };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2_000_000;
}

export function validateChatRequest(body: unknown): ValidationResult {
  if (!isObject(body)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }

  const problems: string[] = [];
  const params: PassThroughParams = {};

  // model
  let model = '';
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    problems.push('"model" is required and must be a non-empty string');
  } else if (body.model.length > MAX_MODEL_NAME_LENGTH) {
    problems.push(`"model" must be at most ${MAX_MODEL_NAME_LENGTH} characters`);
  } else {
    model = body.model;
  }

  // messages
  const messages: ChatMessage[] = [];
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    problems.push('"messages" is required and must be a non-empty array');
  } else if (body.messages.length > MAX_MESSAGES) {
    problems.push(`"messages" must contain at most ${MAX_MESSAGES} items`);
  } else {
    body.messages.forEach((entry: unknown, index) => {
      const where = `messages[${index}]`;
      if (!isObject(entry)) {
        problems.push(`${where} must be an object`);
        return;
      }
      if (typeof entry.role !== 'string' || !ROLES.has(entry.role)) {
        problems.push(`${where}.role must be one of: system, user, assistant`);
        return;
      }
      if (typeof entry.content !== 'string') {
        problems.push(
          `${where}.content must be a string (multimodal or null content is not supported)`,
        );
        return;
      }
      messages.push({ role: entry.role as ChatMessage['role'], content: entry.content });
    });
    if (
      messages.length === body.messages.length &&
      !messages.some((m) => m.role === 'user' && m.content.trim() !== '')
    ) {
      problems.push('"messages" must include a user message with non-empty text');
    }
  }

  // stream
  let stream = false;
  if (body.stream !== undefined && body.stream !== null) {
    if (typeof body.stream === 'boolean') stream = body.stream;
    else problems.push('"stream" must be a boolean');
  }
  if (
    body.stream_options !== undefined &&
    body.stream_options !== null &&
    !isObject(body.stream_options)
  ) {
    problems.push('"stream_options" must be an object');
  }

  // sampling parameters
  const optional = (name: string): unknown => {
    const value = body[name];
    return value === null ? undefined : value;
  };
  const temperature = optional('temperature');
  if (temperature !== undefined) {
    if (numberInRange(temperature, 0, 2)) params.temperature = temperature;
    else problems.push('"temperature" must be a number between 0 and 2');
  }
  const topP = optional('top_p');
  if (topP !== undefined) {
    if (numberInRange(topP, 0, 1)) params.top_p = topP;
    else problems.push('"top_p" must be a number between 0 and 1');
  }
  for (const name of ['presence_penalty', 'frequency_penalty'] as const) {
    const value = optional(name);
    if (value !== undefined) {
      if (numberInRange(value, -2, 2)) params[name] = value;
      else problems.push(`"${name}" must be a number between -2 and 2`);
    }
  }
  const seed = optional('seed');
  if (seed !== undefined) {
    if (typeof seed === 'number' && Number.isSafeInteger(seed)) params.seed = seed;
    else problems.push('"seed" must be an integer');
  }
  const user = optional('user');
  if (user !== undefined) {
    if (typeof user === 'string' && user.length <= 256) params.user = user;
    else problems.push('"user" must be a string of at most 256 characters');
  }
  const stop = optional('stop');
  if (stop !== undefined) {
    const isStringList =
      Array.isArray(stop) &&
      stop.length >= 1 &&
      stop.length <= 4 &&
      stop.every((s) => typeof s === 'string');
    if (typeof stop === 'string' || isStringList) params.stop = stop as string | string[];
    else problems.push('"stop" must be a string or an array of up to 4 strings');
  }

  let maxTokens: number | null = null;
  for (const name of ['max_tokens', 'max_completion_tokens'] as const) {
    const value = optional(name);
    if (value === undefined) continue;
    if (positiveInteger(value)) {
      if (name === 'max_tokens') params.max_tokens = value;
      // `max_completion_tokens` is the newer name and wins when both are present.
      if (name === 'max_completion_tokens' || maxTokens === null) maxTokens = value;
    } else {
      problems.push(`"${name}" must be a positive integer`);
    }
  }

  // unsupported parameters: reject clearly instead of silently ignoring them
  const n = optional('n');
  if (n !== undefined && n !== 1) problems.push('"n" is not supported; only n = 1 is allowed');
  const logprobs = optional('logprobs');
  if (logprobs !== undefined && logprobs !== false) problems.push('"logprobs" is not supported');
  for (const name of UNSUPPORTED_PARAMS) {
    if (optional(name) !== undefined) problems.push(`"${name}" is not supported by this gateway`);
  }

  if (problems.length > 0) {
    return { ok: false, message: `Invalid request: ${problems.join('; ')}.` };
  }
  return { ok: true, request: { model, messages, stream, maxTokens, params } };
}
