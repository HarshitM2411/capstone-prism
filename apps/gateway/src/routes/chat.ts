import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { GatewayConfig } from '../config/gatewayConfig.js';
import type { RequestLogWriter } from '../db/requestLogs.js';
import { authenticate, type KeyStore } from '../http/auth.js';
import type { RequestContext } from '../http/context.js';
import { invalidRequest, modelNotFound } from '../http/errors.js';
import { fillMissingPrismHeaders, setPrismHeaders } from '../http/headers.js';
import { validateChatRequest, type ChatRequest } from '../http/validate.js';
import { resolveModel } from '../routing/resolve.js';

export interface ChatRouteDeps {
  config: GatewayConfig;
  keys: KeyStore;
  requestLogs: RequestLogWriter;
  /** Tracks background work (log writes) so shutdown can wait for it. */
  track: (work: Promise<unknown>) => void;
}

/**
 * Phase 2 stub: proves auth → validation → model resolution → logging → header contract end to
 * end without calling a provider. Phase 4 replaces this with the real adapter call; the shape of
 * the response (an OpenAI chat completion, or SSE for `stream: true`) stays the same.
 */
function stubCompletion(request: ChatRequest): {
  id: string;
  created: number;
  text: string;
} {
  return {
    id: `chatcmpl-stub-${Math.random().toString(36).slice(2, 12)}`,
    created: Math.floor(Date.now() / 1000),
    text: `Prism gateway stub response for model "${request.model}". No provider was called.`,
  };
}

function sendStubStream(reply: FastifyReply, request: ChatRequest): FastifyReply {
  const { id, created, text } = stubCompletion(request);
  const chunk = (delta: object, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: 'assistant', content: '' }, null) +
    chunk({ content: text }, null) +
    chunk({}, 'stop') +
    'data: [DONE]\n\n';
  return reply
    .header('content-type', 'text/event-stream')
    .header('cache-control', 'no-cache')
    .send(body);
}

export const chatRoutes =
  (deps: ChatRouteDeps): FastifyPluginAsync =>
  async (app) => {
    // Step 1 of the check order. Runs in `onRequest`, i.e. before the body is read or parsed, so a
    // bad key never reveals anything about body validation (edge cases 1.6, 2.x).
    app.addHook('onRequest', async (request) => {
      const ctx: RequestContext = {
        requestId: request.id,
        keyId: null,
        auth: null,
        requestedModel: null,
        logStatus: 'ok',
        errorCode: null,
      };
      request.prism = ctx;
      ctx.auth = await authenticate(deps.keys, request.headers.authorization, (keyId) => {
        ctx.keyId = keyId;
      });
    });

    // Safety net: whatever happened, the response carries the full x-prism-* contract.
    app.addHook('onSend', async (_request, reply, payload) => {
      fillMissingPrismHeaders(reply);
      return payload;
    });

    // One log row per request, including rejections. Runs after the response is sent, so a
    // failing log write can never fail the client's request (proposal P3).
    app.addHook('onResponse', async (request, reply) => {
      const ctx = request.prism;
      if (ctx === null) return;
      const write = deps.requestLogs
        .write({
          requestId: ctx.requestId,
          keyId: ctx.keyId,
          requestedModel: ctx.requestedModel,
          status: ctx.logStatus,
          httpStatus: reply.statusCode,
          errorCode: ctx.errorCode,
          latencyMs: reply.elapsedTime,
        })
        .catch((err: unknown) => {
          request.log.error({ err, requestId: ctx.requestId }, 'failed to write request log');
        });
      deps.track(write);
    });

    app.post('/v1/chat/completions', async (request, reply) => {
      const ctx = request.prism!;

      // Step 2: validate the body.
      const body: unknown = request.body;
      if (typeof body === 'object' && body !== null && 'model' in body) {
        const model = (body as { model?: unknown }).model;
        if (typeof model === 'string') ctx.requestedModel = model;
      }
      const validation = validateChatRequest(body);
      if (!validation.ok) throw invalidRequest(validation.message);
      const chat = validation.request;

      // Step 3: resolve the model name. Unknown → 404, never a provider call.
      if (resolveModel(deps.config, chat.model) === null) throw modelNotFound(chat.model);

      // Phase 2 stub (no allowlist, rate limit, budget or provider yet — Phases 3 and 4).
      setPrismHeaders(reply, { provider: 'none', cache: 'miss', fallback: false, costUnits: 0n });
      if (chat.stream) {
        setPrismHeaders(reply, { costUnits: null });
        return sendStubStream(reply, chat);
      }
      const { id, created, text } = stubCompletion(chat);
      return reply.send({
        id,
        object: 'chat.completion',
        created,
        model: chat.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    });
  };
