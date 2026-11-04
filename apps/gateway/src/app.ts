import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { GatewayConfig, RetryPolicy } from './config/gatewayConfig.js';
import type { RequestLogWriter } from './db/requestLogs.js';
import type { KeyStore } from './http/auth.js';
import { toPrismError } from './http/errors.js';
import type { BudgetStore } from './limits/budget.js';
import type { RateLimiter } from './limits/rpm.js';
import type { CallTimeouts, ProviderRegistry } from './providers/types.js';
import { adminRoutes } from './routes/admin.js';
import { chatRoutes } from './routes/chat.js';

export type HealthCheck = () => Promise<void>;

export interface AppOptions {
  logLevel?: string;
  /** Validated gateway configuration (aliases, models, providers). */
  config: GatewayConfig;
  /** Resolves a raw virtual key to its tenant. */
  keys: KeyStore;
  /** Writes one `request_logs` row per data-plane request. */
  requestLogs: RequestLogWriter;
  /** Per-key requests-per-minute limiter (Redis sliding window). */
  rateLimiter: RateLimiter;
  /** Monthly budget reserve → settle. */
  budget: BudgetStore;
  /** Adapters for the providers named in the config. */
  providers: ProviderRegistry;
  /** Limits applied to every provider call; `deadlineMs` also caps all attempts of a request. */
  timeouts: CallTimeouts;
  /** Overrides the retry policy from the gateway config (tests use a fast one). */
  retry?: RetryPolicy;
  /** The longest one streamed response may last (default two minutes). */
  streamMaxMs?: number;
  /** The expected `x-admin-token` value for `/admin/*`. */
  adminToken: string;
  /**
   * Named dependency probes for `/health` (for example `{ postgres: () => checkDatabase(pool) }`).
   * Each resolves when the dependency answers and rejects when it does not.
   */
  healthChecks?: Record<string, HealthCheck>;
}

/**
 * Builds the Fastify application. Kept separate from `index.ts` so tests can exercise the app
 * in-process (`app.inject`) without opening a socket.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    // Reject oversized bodies before any work is done (edge case 1.5).
    bodyLimit: 1024 * 1024,
    // One line per request is written by us (below), without the noisy health probes.
    logController: new LogController({ disableRequestLogging: true }),
    // Ids are always generated here; a client-supplied id is never trusted or logged.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  // JSON only: Fastify also parses text/plain by default, which would turn a wrong Content-Type
  // into a confusing validation error instead of a clear 415.
  app.removeContentTypeParser('text/plain');

  app.decorateRequest('prism', null);

  // Background work (request-log writes) that shutdown must wait for.
  const pending = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  app.addHook('onClose', async () => {
    await Promise.allSettled([...pending]);
  });

  // The client can quote this id when reporting a problem; it is also the request log's id.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/health') return;
    request.log.info(
      {
        method: request.method,
        path: request.url.split('?')[0],
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        keyId: request.prism?.keyId ?? null,
      },
      'request completed',
    );
  });

  // Every failure — ours or the framework's — leaves as the standard envelope.
  app.setErrorHandler((err, request, reply) => {
    const error = toPrismError(err);
    if (error.httpStatus >= 500) {
      request.log.error({ err, reqId: request.id }, 'request failed');
    }
    if (request.prism !== null) {
      request.prism.logStatus = error.logStatus;
      request.prism.errorCode = error.code;
    }
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
    return reply.code(error.httpStatus).send(error.toEnvelope());
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: {
        message: 'Route not found.',
        type: 'not_found_error',
        code: 'route_not_found',
      },
    }),
  );

  const healthChecks = options.healthChecks ?? {};

  app.get('/health', async (_request, reply) => {
    const names = Object.keys(healthChecks);
    const outcomes = await Promise.allSettled(names.map((name) => healthChecks[name]!()));

    const dependencies: Record<string, 'up' | 'down'> = {};
    outcomes.forEach((outcome, index) => {
      const name = names[index]!;
      dependencies[name] = outcome.status === 'fulfilled' ? 'up' : 'down';
      if (outcome.status === 'rejected') {
        // Details go to the log only; the response never leaks internals.
        app.log.warn({ dependency: name, err: outcome.reason }, 'health check failed');
      }
    });

    const healthy = Object.values(dependencies).every((state) => state === 'up');
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      service: 'prism-gateway',
      uptime_seconds: Math.round(process.uptime()),
      dependencies,
    });
  });

  void app.register(
    chatRoutes({
      config: options.config,
      keys: options.keys,
      requestLogs: options.requestLogs,
      rateLimiter: options.rateLimiter,
      budget: options.budget,
      providers: options.providers,
      timeouts: options.timeouts,
      retry: options.retry ?? options.config.retry,
      streamMaxMs: options.streamMaxMs ?? 120_000,
      track,
    }),
  );
  void app.register(adminRoutes({ adminToken: options.adminToken }));

  return app;
}
