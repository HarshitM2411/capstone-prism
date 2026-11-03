import type { FastifyPluginAsync } from 'fastify';
import { verifyAdminToken } from '../http/auth.js';

export interface AdminRouteDeps {
  /** The expected token. Compared in constant time and never logged. */
  adminToken: string;
}

/**
 * The admin plane (`/admin/*`). Every route registered in this plugin requires the
 * `x-admin-token` header; virtual keys are not accepted here (decision D10) and the admin token is
 * not accepted on the data plane. The usage, logs and cache-stats routes arrive in Phases 9 and 10.
 */
export const adminRoutes =
  (deps: AdminRouteDeps): FastifyPluginAsync =>
  async (app) => {
    app.addHook('onRequest', async (request) => {
      verifyAdminToken(deps.adminToken, request.headers['x-admin-token']);
    });

    // Lets the console check that a token works before it shows anything.
    app.get('/admin/ping', async () => ({ status: 'ok' }));
  };
