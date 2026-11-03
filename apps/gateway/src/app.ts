import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  logLevel?: string;
}

/**
 * Builds the Fastify application. Kept separate from `index.ts` so tests can
 * exercise the app in-process (`app.inject`) without opening a socket.
 *
 * Phase 0 exposes only `GET /health`. The data plane and admin plane arrive in
 * later phases.
 */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    // Reject oversized bodies before any work is done (edge case 1.5).
    bodyLimit: 1024 * 1024,
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'prism-gateway',
    uptime_seconds: Math.round(process.uptime()),
  }));

  return app;
}
