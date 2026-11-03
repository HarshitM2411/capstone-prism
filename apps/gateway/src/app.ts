import Fastify, { type FastifyInstance } from 'fastify';

export type HealthCheck = () => Promise<void>;

export interface AppOptions {
  logLevel?: string;
  /**
   * Named dependency probes for `/health` (for example `{ postgres: () => checkDatabase(pool) }`).
   * Each resolves when the dependency answers and rejects when it does not.
   */
  healthChecks?: Record<string, HealthCheck>;
}

/**
 * Builds the Fastify application. Kept separate from `index.ts` so tests can
 * exercise the app in-process (`app.inject`) without opening a socket.
 *
 * Phase 1 exposes `GET /health`, which reports dependency state. The data plane and admin
 * plane arrive in later phases.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    // Reject oversized bodies before any work is done (edge case 1.5).
    bodyLimit: 1024 * 1024,
  });

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

  return app;
}
