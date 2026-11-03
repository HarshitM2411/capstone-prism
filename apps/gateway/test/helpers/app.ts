import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../../src/app.js';
import { loadGatewayConfig } from '../../src/config/gatewayConfig.js';
import type { VirtualKey } from '../../src/db/keys.js';
import type { RequestLogEntry, RequestLogWriter } from '../../src/db/requestLogs.js';
import type { KeyStore } from '../../src/http/auth.js';
import { DATA_DIR } from './dataDir.js';

export const config = loadGatewayConfig(DATA_DIR);

export const ADMIN_TOKEN = 'test-admin-token-123';

/** Raw keys of the in-memory tenants used by the HTTP tests. */
export const KEYS = {
  search: 'prism-sk-search-1a2b3c',
  research: 'prism-sk-research-4d5e6f',
  disabled: 'prism-sk-disabled-9z9z9z',
} as const;

function tenant(overrides: Partial<VirtualKey>): VirtualKey {
  return {
    id: 1,
    team: 'search',
    status: 'active',
    keyHint: '…2b3c',
    monthlyBudgetUnits: 5_000_000_000n,
    rpmLimit: 60,
    tpmLimit: 100000,
    allowedModels: ['fast'],
    cacheEnabled: true,
    cacheThreshold: 0.92,
    createdAt: new Date(),
    ...overrides,
  };
}

export const TENANTS: Record<string, VirtualKey> = {
  [KEYS.search]: tenant({ id: 1 }),
  [KEYS.research]: tenant({ id: 2, team: 'research', allowedModels: ['fast', 'smart', 'auto'] }),
  [KEYS.disabled]: tenant({ id: 9, team: 'old-team', status: 'disabled' }),
};

export function memoryKeys(): KeyStore & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async findByRawKey(rawKey) {
      lookups.push(rawKey);
      return TENANTS[rawKey] ?? null;
    },
  };
}

export function memoryLogs(): RequestLogWriter & { entries: RequestLogEntry[] } {
  const entries: RequestLogEntry[] = [];
  return {
    entries,
    async write(entry) {
      entries.push(entry);
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  keys: ReturnType<typeof memoryKeys>;
  logs: ReturnType<typeof memoryLogs>;
}

export function buildTestApp(overrides: Partial<AppOptions> = {}): TestApp {
  const keys = memoryKeys();
  const logs = memoryLogs();
  const app = buildApp({
    logLevel: 'silent',
    config,
    keys,
    requestLogs: logs,
    adminToken: ADMIN_TOKEN,
    ...overrides,
  });
  return { app, keys, logs };
}

/** Request logs are written just after the response is sent, so poll briefly for them. */
export async function waitForLogs(logs: { entries: unknown[] }, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (logs.entries.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(logs.entries).toHaveLength(count);
}
