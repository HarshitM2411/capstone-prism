import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig } from '../config/gatewayConfig.js';
import type { RequestLogWriter } from '../db/requestLogs.js';
import { authenticate, type KeyStore } from '../http/auth.js';
import type { RequestContext } from '../http/context.js';
import {
  PrismError,
  budgetExceeded,
  invalidRequest,
  modelNotAllowed,
  modelNotFound,
  rateLimitExceeded,
  rateLimiterUnavailable,
  serviceUnavailable,
} from '../http/errors.js';
import { fillMissingPrismHeaders, setPrismHeaders } from '../http/headers.js';
import { validateChatRequest, type ChatRequest } from '../http/validate.js';
import type { BudgetStore, Reservation } from '../limits/budget.js';
import { estimateCostUnits, pricingModel } from '../limits/estimate.js';
import type { RateLimiter } from '../limits/rpm.js';
import { computeCostUnits } from '../money.js';
import { resolveModel } from '../routing/resolve.js';

export interface ChatRouteDeps {
  config: GatewayConfig;
  keys: KeyStore;
  requestLogs: RequestLogWriter;
  rateLimiter: RateLimiter;
  budget: BudgetStore;
  /** Tracks background work (log writes, releases) so shutdown can wait for it. */
  track: (work: Promise<unknown>) => void;
}

/**
 * Phase 2/3 stub: proves the whole admission pipeline (auth → validation → model resolution →
 * allowlist → rate limit → budget → metering → log) end to end without calling a provider. It
 * reports realistic, non-zero usage so budgets are really spent and settled. Phase 4 replaces it
 * with the adapter call; the response shape (an OpenAI chat completion, or SSE) stays the same.
 */
const STUB_TEXT =
  'Prism gateway stub response. No provider was called; this placeholder is replaced by a real ' +
  'provider reply once the adapter layer is built in a later phase of the project.';

/** Same counting rule as the starter's mock providers: whitespace-separated words. */
function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, words);
}

function sendStubStream(reply: FastifyReply, chat: ChatRequest, id: string, created: number) {
  const chunk = (delta: object, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: chat.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: 'assistant', content: '' }, null) +
    chunk({ content: STUB_TEXT }, null) +
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
        resolvedModel: null,
        logStatus: 'ok',
        errorCode: null,
        logged: false,
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

    // One log row per request, including rejections. Successful requests were already logged
    // together with their budget settlement; everything else is logged here, after the response
    // is sent, so a failing log write can never fail the client's request (proposal P3).
    app.addHook('onResponse', async (request, reply) => {
      const ctx = request.prism;
      if (ctx === null || ctx.logged) return;
      const write = deps.requestLogs
        .write({
          requestId: ctx.requestId,
          keyId: ctx.keyId,
          requestedModel: ctx.requestedModel,
          resolvedModel: ctx.resolvedModel,
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

    /** Step 5: the per-key requests-per-minute window. Fails closed if Redis cannot answer. */
    async function enforceRateLimit(request: FastifyRequest, ctx: RequestContext): Promise<void> {
      const auth = ctx.auth!;
      let decision;
      try {
        decision = await deps.rateLimiter.check(auth.keyId, auth.rpmLimit);
      } catch (err) {
        request.log.error({ err, keyId: auth.keyId }, 'rate limiter unavailable (failing closed)');
        throw rateLimiterUnavailable();
      }
      if (!decision.allowed) throw rateLimitExceeded(decision.retryAfterMs);
    }

    app.post('/v1/chat/completions', async (request, reply) => {
      const ctx = request.prism!;
      const auth = ctx.auth!;

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
      const resolved = resolveModel(deps.config, chat.model);
      if (resolved === null) throw modelNotFound(chat.model);

      // Step 4: allowlist, checked against the requested name. In-memory; costs nothing.
      if (!auth.allowedModels.includes(chat.model)) throw modelNotAllowed(chat.model);

      // Step 5: requests per minute.
      await enforceRateLimit(request, ctx);

      // (Step 6, `auto` classification, arrives in Phase 7.)
      const priced = pricingModel(deps.config, resolved);
      ctx.resolvedModel = priced.name;

      // Step 7: reserve budget. Nothing is held when this rejects.
      let reservation: Reservation | null;
      try {
        reservation = await deps.budget.reserve({
          requestId: ctx.requestId,
          keyId: auth.keyId,
          budgetUnits: auth.monthlyBudgetUnits,
          estimateUnits: estimateCostUnits(deps.config, resolved, chat),
        });
      } catch (err) {
        request.log.error({ err, keyId: auth.keyId }, 'budget store unavailable');
        throw serviceUnavailable('The service is temporarily unavailable. Please retry shortly.');
      }
      if (reservation === null) throw budgetExceeded();

      // From here on the reservation must be settled or released, whatever happens.
      try {
        // Steps 8–9 (cache, provider) arrive in Phases 4 and 8; the stub answers instead.
        const promptTokens = chat.messages.reduce((sum, m) => sum + countWords(m.content), 0);
        const completionTokens = countWords(STUB_TEXT);
        const costUnits = computeCostUnits(promptTokens, completionTokens, priced);

        // Settlement and the request's log row are written in one transaction, so
        // `spent_usd` always equals the sum of the logged `cost_usd` (edge case 5.5).
        await deps.budget.settle(reservation, costUnits, {
          requestId: ctx.requestId,
          keyId: auth.keyId,
          requestedModel: ctx.requestedModel,
          resolvedModel: priced.name,
          status: 'ok',
          httpStatus: 200,
          errorCode: null,
          promptTokens,
          completionTokens,
          costUnits,
          latencyMs: reply.elapsedTime,
        });
        ctx.logged = true;

        const id = `chatcmpl-stub-${ctx.requestId.slice(0, 12)}`;
        const created = Math.floor(Date.now() / 1000);
        setPrismHeaders(reply, { provider: 'none', cache: 'miss', fallback: false, costUnits });
        if (chat.stream) {
          setPrismHeaders(reply, { costUnits: null }); // the cost header is never sent on streams
          return sendStubStream(reply, chat, id, created);
        }
        return reply.send({
          id,
          object: 'chat.completion',
          created,
          model: chat.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: STUB_TEXT }, finish_reason: 'stop' },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });
      } catch (err) {
        if (!ctx.logged) {
          // Not settled: give the hold back so it cannot block the key's budget (edge case 5.6).
          deps.track(
            deps.budget.release(reservation).catch((releaseErr: unknown) => {
              request.log.error(
                { err: releaseErr, requestId: ctx.requestId },
                'failed to release budget reservation (the reconciler will clear it)',
              );
            }),
          );
        }
        if (err instanceof PrismError) throw err;
        request.log.error({ err, requestId: ctx.requestId }, 'request failed after reservation');
        throw serviceUnavailable('The request could not be completed. Please retry.');
      }
    });
  };
