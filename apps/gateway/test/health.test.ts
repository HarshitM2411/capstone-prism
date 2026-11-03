import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppOptions } from '../src/app.js';
import { buildTestApp } from './helpers/app.js';

describe('GET /health', () => {
  let app: FastifyInstance;

  function start(options: Partial<AppOptions> = {}): FastifyInstance {
    app = buildTestApp(options).app;
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

  it('is not written to the request log (it is not a data-plane request)', async () => {
    const { app: instance, logs } = buildTestApp();
    app = instance;
    await instance.inject({ method: 'GET', url: '/health' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logs.entries).toHaveLength(0);
  });
});
