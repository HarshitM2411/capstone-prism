import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../../src/app.js';
import { loadGatewayConfig } from '../../src/config/gatewayConfig.js';
import type { VirtualKey } from '../../src/db/keys.js';
import type { RequestLogEntry, RequestLogWriter } from '../../src/db/requestLogs.js';
import type { KeyStore } from '../../src/http/auth.js';
import {
  budgetPeriod,
  type BudgetStore,
  type Reservation,
  type ReserveInput,
} from '../../src/limits/budget.js';
import type { RateLimitDecision, RateLimiter } from '../../src/limits/rpm.js';
import { FakeRegistry } from '../../src/providers/fake.js';
import { DATA_DIR } from './dataDir.js';

export const config = loadGatewayConfig(DATA_DIR);

export const ADMIN_TOKEN = 'test-admin-token-123';

/** Raw keys of the in-memory tenants used by the HTTP tests. */
export const KEYS = {
  search: 'prism-sk-search-1a2b3c',
  research: 'prism-sk-research-4d5e6f',
  /** Allowlist is empty: it may use nothing (edge case 3.4). */
  locked: 'prism-sk-locked-5k5k5k',
  /** Budget is tiny: smaller than one request's cost. */
  demo: 'prism-sk-budget-demo-0j1k2l',
  /** Limit of 2 requests per minute. */
  slow: 'prism-sk-slow-2r2r2r',
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
  [KEYS.locked]: tenant({ id: 3, team: 'locked', allowedModels: [] }),
  [KEYS.demo]: tenant({ id: 4, team: 'budget-demo', monthlyBudgetUnits: 1000n }),
  [KEYS.slow]: tenant({ id: 5, team: 'slow', rpmLimit: 2 }),
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

/** Records the order in which the pipeline stages were reached. */
export type Events = string[];

/** A per-key counter that mirrors the sliding window's decisions without a clock. */
export function memoryRateLimiter(
  events: Events = [],
): RateLimiter & { counts: Map<number, number>; failWith: Error | null } {
  const counts = new Map<number, number>();
  const limiter = {
    counts,
    failWith: null as Error | null,
    async check(keyId: number, limit: number): Promise<RateLimitDecision> {
      events.push('rate-limit');
      if (limiter.failWith !== null) throw limiter.failWith;
      const used = counts.get(keyId) ?? 0;
      if (used >= limit) return { allowed: false, retryAfterMs: 42_500 };
      counts.set(keyId, used + 1);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
  return limiter;
}

export interface MemoryBudget extends BudgetStore {
  spent: Map<number, bigint>;
  reserved: Map<number, bigint>;
  holds: Map<string, bigint>;
  reservations: Reservation[];
  released: string[];
  settled: { requestId: string; actualUnits: bigint }[];
  failReserveWith: Error | null;
  failSettleWith: Error | null;
}

/** The same admission rules as `PgBudgetStore`, in memory, for HTTP-level tests. */
export function memoryBudget(logs: RequestLogWriter, events: Events = []): MemoryBudget {
  const store: MemoryBudget = {
    spent: new Map(),
    reserved: new Map(),
    holds: new Map(),
    reservations: [],
    released: [],
    settled: [],
    failReserveWith: null,
    failSettleWith: null,
    async reserve(input: ReserveInput) {
      events.push('budget-reserve');
      if (store.failReserveWith !== null) throw store.failReserveWith;
      const spent = store.spent.get(input.keyId) ?? 0n;
      const reserved = store.reserved.get(input.keyId) ?? 0n;
      if (spent + reserved >= input.budgetUnits) return null;
      const remaining = input.budgetUnits - spent - reserved;
      const amount = input.estimateUnits < remaining ? input.estimateUnits : remaining;
      store.reserved.set(input.keyId, reserved + amount);
      store.holds.set(input.requestId, amount);
      const reservation: Reservation = {
        requestId: input.requestId,
        keyId: input.keyId,
        period: budgetPeriod(input.now ?? new Date()),
        reservedUnits: amount,
      };
      store.reservations.push(reservation);
      return reservation;
    },
    async settle(reservation, actualUnits, log) {
      events.push('budget-settle');
      if (store.failSettleWith !== null) throw store.failSettleWith;
      const hold = store.holds.get(reservation.requestId) ?? 0n;
      store.holds.delete(reservation.requestId);
      store.reserved.set(reservation.keyId, (store.reserved.get(reservation.keyId) ?? 0n) - hold);
      store.spent.set(reservation.keyId, (store.spent.get(reservation.keyId) ?? 0n) + actualUnits);
      store.settled.push({ requestId: reservation.requestId, actualUnits });
      await logs.write(log);
    },
    async release(reservation) {
      events.push('budget-release');
      const hold = store.holds.get(reservation.requestId) ?? 0n;
      store.holds.delete(reservation.requestId);
      store.reserved.set(reservation.keyId, (store.reserved.get(reservation.keyId) ?? 0n) - hold);
      store.released.push(reservation.requestId);
    },
  };
  return store;
}

/** Short limits so timeout tests finish quickly. */
export const TEST_TIMEOUTS = { firstByteMs: 300, idleMs: 300, deadlineMs: 1500 };

export interface TestApp {
  app: FastifyInstance;
  providers: FakeRegistry;
  keys: ReturnType<typeof memoryKeys>;
  logs: ReturnType<typeof memoryLogs>;
  limiter: ReturnType<typeof memoryRateLimiter>;
  budget: MemoryBudget;
  events: Events;
}

export function buildTestApp(overrides: Partial<AppOptions> = {}): TestApp {
  const events: Events = [];
  const keys = memoryKeys();
  const logs = memoryLogs();
  const limiter = memoryRateLimiter(events);
  const budget = memoryBudget(logs, events);
  const providers = new FakeRegistry([...config.providers.keys()]);
  const app = buildApp({
    logLevel: 'silent',
    config,
    keys,
    requestLogs: logs,
    rateLimiter: limiter,
    budget,
    providers,
    timeouts: TEST_TIMEOUTS,
    adminToken: ADMIN_TOKEN,
    ...overrides,
  });
  return { app, providers, keys, logs, limiter, budget, events };
}

/** Request logs are written just after the response is sent, so poll briefly for them. */
export async function waitForLogs(logs: { entries: unknown[] }, count: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (logs.entries.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(logs.entries).toHaveLength(count);
}
