import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/app.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  function start(options: AppOptions = {}): FastifyInstance {
    app = buildApp({ logLevel: 'silent', ...options });
    return app;
  }

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with a status payload and no dependencies by default', async () => {
    const res = await start().inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toMatchObject({ status: 'ok', service: 'prism-gateway', dependencies: {} });
  });

  it('does not require authentication', async () => {
    const res = await start().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('reports each dependency that is up', async () => {
    const res = await start({
      healthChecks: { postgres: async () => undefined },
    }).inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies).toEqual({ postgres: 'up' });
  });

  it('returns 503 and names the dependency that is down (edge case 11.1)', async () => {
    const res = await start({
      healthChecks: {
        postgres: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
        },
      },
    }).inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.dependencies).toEqual({ postgres: 'down' });
    // Internal error details must never leak into the response.
    expect(res.body).not.toContain('hunter2');
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('is degraded when any one of several dependencies is down', async () => {
    const res = await start({
      healthChecks: {
        postgres: async () => undefined,
        redis: async () => {
          throw new Error('down');
        },
      },
    }).inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(503);
    expect(res.json().dependencies).toEqual({ postgres: 'up', redis: 'down' });
  });

  it('returns 404 for routes that do not exist yet', async () => {
    const res = await start().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});
