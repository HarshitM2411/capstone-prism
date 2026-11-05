import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { GatewayConfig, ModelInfo, RetryPolicy } from '../config/gatewayConfig.js';
import type { RequestLogEntry, RequestLogWriter } from '../db/requestLogs.js';
import { authenticate, type KeyStore } from '../http/auth.js';
import type { RequestContext } from '../http/context.js';
import {
  PrismError,
  budgetExceeded,
  clientClosed,
  invalidRequest,
  modelNotAllowed,
  modelNotFound,
  rateLimitExceeded,
  rateLimiterUnavailable,
  serviceUnavailable,
  upstreamError,
} from '../http/errors.js';
import { fillMissingPrismHeaders, setPrismHeaders } from '../http/headers.js';
import { validateChatRequest, type ChatRequest } from '../http/validate.js';
import type { BudgetStore, Reservation } from '../limits/budget.js';
import { estimateCostUnits, pricingModel } from '../limits/estimate.js';
import type { RateLimiter } from '../limits/rpm.js';
import { computeCostUnits } from '../money.js';
import type { CallTimeouts, ProviderRegistry } from '../providers/types.js';
import { modelChain } from '../routing/chain.js';
import {
  ExecuteFailure,
  executeStreamWithFailover,
  executeWithFailover,
  type AttemptFailure,
} from '../routing/executor.js';
import type { Classifier } from '../routing/classifier.js';
import { resolveModel, type ResolvedModel } from '../routing/resolve.js';
import {
  WordCounter,
  createSseBody,
  resolveStreamUsage,
  type StreamSummary,
} from '../streaming/relay.js';

export interface ChatRouteDeps {
  config: GatewayConfig;
  keys: KeyStore;
  requestLogs: RequestLogWriter;
  rateLimiter: RateLimiter;
  budget: BudgetStore;
  providers: ProviderRegistry;
  /** Decides the tier for `auto` requests. */
  classifier: Classifier;
  timeouts: CallTimeouts;
  retry: RetryPolicy;
  /** The longest one streamed response may last. */
  streamMaxMs: number;
  /** Tracks background work (log writes, releases) so shutdown can wait for it. */
  track: (work: Promise<unknown>) => void;
}

/** What the handler has established by the time it holds a budget reservation. */
interface Admitted {
  request: FastifyRequest;
  reply: FastifyReply;
  ctx: RequestContext;
  chat: ChatRequest;
  chain: readonly ModelInfo[];
  reservation: Reservation;
}

/** Prompt size by the same rule as the mock providers: whitespace-separated words. */
function promptWords(chat: ChatRequest): number {
  let total = 0;
  for (const message of chat.messages) {
    const words = new WordCounter();
    words.add(message.content);
    total += Math.max(1, words.count);
  }
  return total;
}

export const chatRoutes =
  (deps: ChatRouteDeps): FastifyPluginAsync =>
  async (app) => {
    // Step 1 of the check order. Runs in `onRequest`, i.e. before the body is read or parsed, so a
    // bad key never reveals anything about body validation (edge cases 1.6, 2.x).
    app.addHook('onRequest', async (request, reply) => {
      const ctx: RequestContext = {
        requestId: request.id,
        keyId: null,
        auth: null,
        requestedModel: null,
        resolvedModel: null,
        resolvedProvider: null,
        fallback: false,
        retries: 0,
        routeReason: null,
        logStatus: 'ok',
        errorCode: null,
        logged: false,
        clientGone: false,
        responseReady: false,
      };
      request.prism = ctx;
      // A client that hangs up never gets `onResponse`; make sure its request is still logged.
      reply.raw.once('close', () => {
        if (reply.raw.writableFinished) return;
        ctx.clientGone = true;
        if (ctx.responseReady) writeLog(request, reply);
      });
      ctx.auth = await authenticate(deps.keys, request.headers.authorization, (keyId) => {
        ctx.keyId = keyId;
      });
    });

    // Safety net: whatever happened, the response carries the full x-prism-* contract.
    app.addHook('onSend', async (request, reply, payload) => {
      fillMissingPrismHeaders(reply);
      const ctx = request.prism;
      if (ctx !== null) {
        ctx.responseReady = true;
        // The client left while the handler was still working: the response will never be
        // delivered, so no `onResponse` will follow. Log it now that its outcome is known.
        if (ctx.clientGone) writeLog(request, reply);
      }
      return payload;
    });

    // One log row per request, including rejections. Successful requests were already logged
    // together with their budget settlement (streams: when the stream ended); everything else is
    // logged after the response is sent (or abandoned), so a failing log write can never fail the
    // client's request (proposal P3).
    app.addHook('onResponse', async (request, reply) => writeLog(request, reply));

    function writeLog(request: FastifyRequest, reply: FastifyReply): void {
      const ctx = request.prism;
      if (ctx === null || ctx.logged) return;
      ctx.logged = true;
      const write = deps.requestLogs
        .write({
          requestId: ctx.requestId,
          keyId: ctx.keyId,
          requestedModel: ctx.requestedModel,
          resolvedModel: ctx.resolvedModel,
          resolvedProvider: ctx.resolvedProvider,
          fallback: ctx.fallback,
          retries: ctx.retries,
          status: ctx.logStatus,
          httpStatus: reply.statusCode,
          errorCode: ctx.errorCode,
          routeReason: ctx.routeReason,
          latencyMs: reply.elapsedTime,
        })
        .catch((err: unknown) => {
          request.log.error({ err, requestId: ctx.requestId }, 'failed to write request log');
        });
      deps.track(write);
    }

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

    /**
     * Step 6: for `auto`, pick the tier. The reason is recorded before anything else can reject
     * the request, so a later 402 or 403 still leaves it in the log (edge case 6.15). The chosen
     * tier must be allowed for the key: a `smart` verdict downgrades to `fast` if that is all the
     * key may use (and says so in the reason), otherwise the request is refused (edge case 3.2).
     */
    async function routeAuto(
      request: FastifyRequest,
      ctx: RequestContext,
      chat: ChatRequest,
    ): Promise<ResolvedModel> {
      const tiers = deps.config.auto!;
      let tier: string;
      let reason: string;
      try {
        const verdict = await deps.classifier.classify(chat.messages);
        tier = verdict.difficulty === 'complex' ? tiers.complex : tiers.simple;
        reason = verdict.reason;
      } catch (err) {
        // The classifier is built not to fail; if it does, the safe answer is the strong tier.
        request.log.error({ err, requestId: ctx.requestId }, 'classifier failed');
        tier = tiers.complex;
        reason = 'classifier error: using the strong tier';
      }
      ctx.routeReason = `${tier}: ${reason}`;

      const allowed = ctx.auth!.allowedModels;
      if (!allowed.includes(tier)) {
        if (tier !== tiers.simple && allowed.includes(tiers.simple)) {
          ctx.routeReason = `${tiers.simple}: downgraded from ${tier} (not allowed for this key); ${reason}`;
          tier = tiers.simple;
        } else {
          throw modelNotAllowed(tier);
        }
      }
      return { kind: 'alias', name: tier };
    }

    /**
     * Step 9: runs the provider call (plain or up to the first stream chunk) through the retry /
     * failover engine, bounded by the request deadline. If nothing answers, the client gets a
     * generic `502` (nothing is billed; the caller releases the hold). The provider's own
     * message, body and key never reach the client.
     */
    async function callProvider<T extends { retries: number; fallback: boolean }>(
      { request, reply, ctx }: Pick<Admitted, 'request' | 'reply' | 'ctx'>,
      run: (signal: AbortSignal, onAttemptFailed: (event: AttemptFailure) => void) => Promise<T>,
    ): Promise<T> {
      // If the client goes away before the answer is ready, stop paying for the upstream call.
      const abort = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) abort.abort();
      };
      reply.raw.once('close', onClose);
      try {
        return await run(abort.signal, (event) =>
          request.log.warn(
            {
              requestId: ctx.requestId,
              provider: event.model.provider,
              model: event.model.name,
              attempt: event.attempt,
              kind: event.error.kind,
              status: event.error.status,
              next: event.next,
              delayMs: event.delayMs,
            },
            'provider attempt failed',
          ),
        );
      } catch (err) {
        if (!(err instanceof ExecuteFailure)) throw err;
        // Record what was tried, so the log row of the failed request is useful.
        ctx.resolvedModel = err.lastModel.name;
        ctx.resolvedProvider = err.lastModel.provider;
        ctx.fallback = err.failedOver;
        ctx.retries = err.retries;
        request.log.warn(
          {
            requestId: ctx.requestId,
            reason: err.reason,
            attempts: err.attempts,
            lastKind: err.lastError?.kind ?? null,
          },
          'provider call failed: no model produced a response',
        );
        throw err.reason === 'aborted' ? clientClosed() : upstreamError();
      } finally {
        reply.raw.off('close', onClose);
      }
    }

    /** A non-streaming request: the complete answer, billed from the provider's usage. */
    async function respondComplete(admitted: Admitted) {
      const { reply, ctx, chat, chain, reservation } = admitted;
      const result = await callProvider(admitted, (signal, onAttemptFailed) =>
        executeWithFailover({
          chain,
          providers: deps.providers,
          request: { messages: chat.messages, params: chat.params },
          timeouts: deps.timeouts,
          retry: deps.retry,
          signal,
          onAttemptFailed,
        }),
      );
      // The model that served the request is what is priced and logged. For a fallback it can
      // differ from the primary the budget estimate was based on (edge case 5.16).
      const served = result.model;
      ctx.resolvedModel = served.name;
      ctx.resolvedProvider = served.provider;
      const { promptTokens, completionTokens } = result.response.usage;

      // Billed from the provider-reported usage of the attempt that answered, at that model's
      // price; failed attempts are never billed. Never from client-supplied numbers.
      const costUnits = computeCostUnits(promptTokens, completionTokens, served);

      // Settlement and the request's log row are written in one transaction, so
      // `spent_usd` always equals the sum of the logged `cost_usd` (edge case 5.5).
      await deps.budget.settle(reservation, costUnits, {
        requestId: ctx.requestId,
        keyId: ctx.auth!.keyId,
        requestedModel: ctx.requestedModel,
        resolvedModel: served.name,
        resolvedProvider: served.provider,
        fallback: result.fallback,
        retries: result.retries,
        status: 'ok',
        httpStatus: 200,
        errorCode: null,
        promptTokens,
        completionTokens,
        costUnits,
        routeReason: ctx.routeReason,
        latencyMs: reply.elapsedTime,
      });
      ctx.logged = true;

      setPrismHeaders(reply, {
        provider: `${served.provider}/${served.name}`,
        cache: 'miss',
        fallback: result.fallback,
        costUnits,
      });
      return reply.send({
        id: `chatcmpl-${ctx.requestId.replaceAll('-', '').slice(0, 24)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: chat.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.response.content },
            finish_reason: result.response.finishReason,
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    }

    /**
     * A streaming request. Everything up to the first upstream chunk behaves like a plain call
     * (retry, failover, a JSON `502` if nothing answers), so the headers below are accurate. From
     * then on the stream owns the request: it settles the budget and writes the log row when it
     * ends, however it ends.
     */
    async function respondStreaming(admitted: Admitted) {
      const { request, reply, ctx, chat, chain, reservation } = admitted;
      const opened = await callProvider(admitted, (signal, onAttemptFailed) =>
        executeStreamWithFailover({
          chain,
          providers: deps.providers,
          request: { messages: chat.messages, params: chat.params },
          timeouts: deps.timeouts,
          retry: deps.retry,
          streamMaxMs: deps.streamMaxMs,
          signal,
          onAttemptFailed,
        }),
      );
      const served = opened.model;
      ctx.resolvedModel = served.name;
      ctx.resolvedProvider = served.provider;
      ctx.fallback = opened.fallback;
      ctx.retries = opened.retries;
      const promptEstimate = promptWords(chat);

      const finish = async (summary: StreamSummary): Promise<void> => {
        const { usage, estimated } = resolveStreamUsage(summary, promptEstimate);
        const costUnits = computeCostUnits(usage.promptTokens, usage.completionTokens, served);
        const entry: RequestLogEntry = {
          requestId: ctx.requestId,
          keyId: ctx.auth!.keyId,
          requestedModel: ctx.requestedModel,
          resolvedModel: served.name,
          resolvedProvider: served.provider,
          fallback: opened.fallback,
          retries: opened.retries,
          ...(summary.end === 'complete'
            ? { status: 'ok', httpStatus: 200, errorCode: null }
            : summary.end === 'upstream_failed'
              ? { status: 'upstream_error', httpStatus: 200, errorCode: 'upstream_error' }
              : {
                  status: 'client_disconnect',
                  httpStatus: 499,
                  errorCode: 'client_closed_request',
                }),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          costUnits,
          usageEstimated: estimated,
          routeReason: ctx.routeReason,
          latencyMs: reply.elapsedTime,
          timeToFirstTokenMs: summary.timeToFirstTokenMs,
        };
        if (summary.end !== 'complete') {
          request.log.warn(
            { requestId: ctx.requestId, end: summary.end, lastKind: summary.failure?.kind ?? null },
            'stream ended early',
          );
        }
        try {
          await deps.budget.settle(reservation, costUnits, entry);
        } catch (err) {
          request.log.error(
            { err, requestId: ctx.requestId },
            'failed to settle a streamed request (releasing the hold)',
          );
          await deps.budget.release(reservation).catch(() => undefined);
        }
      };

      const { body, done } = createSseBody({
        opened: opened.stream,
        res: reply.raw,
        id: `chatcmpl-${ctx.requestId.replaceAll('-', '').slice(0, 24)}`,
        created: Math.floor(Date.now() / 1000),
        model: chat.model,
        includeUsage: chat.includeUsage,
        promptTokensEstimate: promptEstimate,
        maxDurationMs: deps.streamMaxMs,
        elapsedMs: () => reply.elapsedTime,
        onEnd: finish,
      });
      // From here the stream settles the reservation and writes the log row itself.
      ctx.logged = true;
      deps.track(done);

      // The cost is not known up front, so there is no cost header on a stream; it goes to the
      // log and usage records when the stream ends.
      setPrismHeaders(reply, {
        provider: `${served.provider}/${served.name}`,
        cache: 'miss',
        fallback: opened.fallback,
        costUnits: null,
      });
      return (
        reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-cache, no-transform')
          // Ask reverse proxies (nginx) not to hold the stream back.
          .header('x-accel-buffering', 'no')
          .send(body)
      );
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

      // Step 6: `auto` becomes a concrete tier; from here on it is treated like a named alias.
      const route = resolved.kind === 'auto' ? await routeAuto(request, ctx, chat) : resolved;
      ctx.resolvedModel = pricingModel(deps.config, route).name;

      // Step 7: reserve budget. Nothing is held when this rejects.
      let reservation: Reservation | null;
      try {
        reservation = await deps.budget.reserve({
          requestId: ctx.requestId,
          keyId: auth.keyId,
          budgetUnits: auth.monthlyBudgetUnits,
          estimateUnits: estimateCostUnits(deps.config, route, chat),
        });
      } catch (err) {
        request.log.error({ err, keyId: auth.keyId }, 'budget store unavailable');
        throw serviceUnavailable('The service is temporarily unavailable. Please retry shortly.');
      }
      if (reservation === null) throw budgetExceeded();

      // From here on the reservation must be settled or released, whatever happens.
      try {
        // Step 8 (cache) arrives in Phase 8. Step 9: the provider.
        const admitted: Admitted = {
          request,
          reply,
          ctx,
          chat,
          chain: modelChain(deps.config, route),
          reservation,
        };
        return await (chat.stream ? respondStreaming(admitted) : respondComplete(admitted));
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
