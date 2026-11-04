import { describe, expect, it } from 'vitest';
import type { ModelInfo, RetryPolicy } from '../src/config/gatewayConfig.js';
import { ProviderError } from '../src/providers/errors.js';
import { FakeRegistry, type FakeOutcome } from '../src/providers/fake.js';
import type {
  CallOptions,
  ProviderAdapter,
  ProviderRegistry,
  UpstreamRequest,
} from '../src/providers/types.js';
import { modelChain } from '../src/routing/chain.js';
import {
  ExecuteFailure,
  backoffDelayMs,
  executeWithFailover,
  type AttemptFailure,
  type ExecuteInput,
} from '../src/routing/executor.js';
import { resolveModel } from '../src/routing/resolve.js';
import { config } from './helpers/app.js';

const POLICY: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 200, backoffMultiplier: 2 };
const TIMEOUTS = { firstByteMs: 2000, idleMs: 10_000, deadlineMs: 15_000 };
const REQUEST = { messages: [{ role: 'user' as const, content: 'What is a queue?' }], params: {} };

const chainFor = (name: string): ModelInfo[] => modelChain(config, resolveModel(config, name)!);

const transient: FakeOutcome = { type: 'error', kind: 'server_error', status: 503 };
const rateLimited: FakeOutcome = { type: 'error', kind: 'rate_limited', status: 429 };

interface Harness {
  registry: FakeRegistry;
  delays: number[];
  failures: AttemptFailure[];
  run: (overrides?: Partial<ExecuteInput>) => ReturnType<typeof executeWithFailover>;
}

/** Sleeps are recorded, not waited for, and jitter is pinned, so the schedule is exact. */
function harness(chain = chainFor('fast')): Harness {
  const registry = new FakeRegistry(['alpha', 'beta']);
  const delays: number[] = [];
  const failures: AttemptFailure[] = [];
  return {
    registry,
    delays,
    failures,
    run: (overrides = {}) =>
      executeWithFailover({
        chain,
        providers: registry,
        request: REQUEST,
        timeouts: TIMEOUTS,
        retry: POLICY,
        random: () => 0.5,
        sleep: async (ms) => void delays.push(ms),
        onAttemptFailed: (event) => failures.push(event),
        ...overrides,
      }),
  };
}

async function failureOf(promise: Promise<unknown>): Promise<ExecuteFailure> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ExecuteFailure);
    return err as ExecuteFailure;
  }
  throw new Error('expected the execution to fail');
}

describe('modelChain', () => {
  it('is the alias’s primary followed by its fallbacks', () => {
    expect(chainFor('fast').map((m) => m.name)).toEqual(['alpha-small', 'beta-small']);
    expect(chainFor('smart').map((m) => m.name)).toEqual(['alpha-large', 'beta-large']);
  });

  it('is the model alone when the caller named a concrete model', () => {
    expect(chainFor('beta-large').map((m) => m.name)).toEqual(['beta-large']);
  });

  it('uses the smart chain for `auto` until the classifier exists', () => {
    expect(chainFor('auto').map((m) => m.name)).toEqual(['alpha-large', 'beta-large']);
  });
});

describe('backoffDelayMs', () => {
  it('doubles each time (200, 400, 800 ms) around the midpoint', () => {
    const delays = [1, 2, 3].map((n) => backoffDelayMs(POLICY, n, () => 0.5));
    expect(delays).toEqual([200, 400, 800]);
  });

  it('spreads each delay by ±25% so clients do not retry in lockstep', () => {
    expect(backoffDelayMs(POLICY, 1, () => 0)).toBe(150);
    expect(backoffDelayMs(POLICY, 1, () => 1)).toBe(250);
    expect(backoffDelayMs(POLICY, 2, () => 0)).toBe(300);
    expect(backoffDelayMs(POLICY, 2, () => 1)).toBe(500);
  });

  it('always increases from one retry to the next, whatever the jitter', () => {
    for (let i = 0; i < 200; i++) {
      const first = backoffDelayMs(POLICY, 1);
      const second = backoffDelayMs(POLICY, 2);
      expect(second).toBeGreaterThan(first);
    }
  });

  it('follows the configured policy', () => {
    const slow = { maxAttempts: 5, initialBackoffMs: 1000, backoffMultiplier: 3 };
    expect(backoffDelayMs(slow, 3, () => 0.5)).toBe(9000);
  });
});

describe('executeWithFailover', () => {
  it('serves from the primary when it is healthy', async () => {
    const h = harness();
    const result = await h.run();

    expect(result.model.name).toBe('alpha-small');
    expect(result.fallback).toBe(false);
    expect(result.retries).toBe(0);
    expect(result.attempts).toBe(1);
    expect(h.registry.must('beta').calls).toHaveLength(0);
    expect(h.delays).toEqual([]);
  });

  it('sends the provider-side model id and the client’s messages', async () => {
    const h = harness();
    await h.run();
    expect(h.registry.must('alpha').calls[0]?.request).toMatchObject({
      model: 'alpha-small',
      messages: REQUEST.messages,
    });
  });

  describe('transient errors are retried with exponential backoff (edge case 8.3)', () => {
    it('retries on the same model, waits 200 then 400 ms, and does not count as a fallback (8.15)', async () => {
      const h = harness();
      h.registry.must('alpha').script.push(transient, transient);

      const result = await h.run();

      expect(h.delays).toEqual([200, 400]);
      expect(result.model.name).toBe('alpha-small');
      expect(result.fallback).toBe(false);
      expect(result.retries).toBe(2);
      expect(result.attempts).toBe(3);
      expect(h.registry.must('alpha').calls).toHaveLength(3);
      expect(h.registry.must('beta').calls).toHaveLength(0);
    });

    it.each([
      ['timeout', { type: 'error', kind: 'timeout' }],
      ['connection', { type: 'error', kind: 'connection' }],
      ['server_error', transient],
    ] as [string, FakeOutcome][])('treats a %s as transient', async (_label, outcome) => {
      const h = harness();
      h.registry.must('alpha').script.push(outcome);
      const result = await h.run();
      expect(result.retries).toBe(1);
      expect(result.model.name).toBe('alpha-small');
    });

    it('retries a hung provider (the call times out) and then succeeds', async () => {
      const h = harness();
      h.registry.must('alpha').script.push({ type: 'hang' });
      const result = await h.run({ timeouts: { ...TIMEOUTS, firstByteMs: 40 } });
      expect(result.retries).toBe(1);
      expect(result.model.name).toBe('alpha-small');
    });

    it('reports each failed attempt with what happens next', async () => {
      const h = harness();
      h.registry.must('alpha').script.push(transient, transient, transient);
      await h.run();

      expect(h.failures.map((f) => [f.model.name, f.attempt, f.next, f.delayMs])).toEqual([
        ['alpha-small', 1, 'retry', 200],
        ['alpha-small', 2, 'retry', 400],
        ['alpha-small', 3, 'failover', null],
      ]);
      expect(JSON.stringify(h.failures.map((f) => f.error.message))).not.toMatch(/mock-key/);
    });
  });

  describe('failover (edge cases 8.4, 8.6)', () => {
    it('fails over to the next model once retries are exhausted, and flags it', async () => {
      const h = harness();
      h.registry.must('alpha').fallback = transient; // alpha is down

      const result = await h.run();

      expect(result.model.name).toBe('beta-small');
      expect(result.model.provider).toBe('beta');
      expect(result.fallback).toBe(true);
      expect(result.retries).toBe(2); // two retries on alpha, none needed on beta
      expect(result.attempts).toBe(4); // 3 on alpha + 1 on beta
      expect(h.delays).toEqual([200, 400]);
    });

    it('fails over immediately, without retrying, on a provider 429', async () => {
      const h = harness();
      h.registry.must('alpha').fallback = rateLimited;

      const result = await h.run();

      expect(result.model.name).toBe('beta-small');
      expect(result.fallback).toBe(true);
      expect(result.retries).toBe(0);
      expect(h.registry.must('alpha').calls).toHaveLength(1);
      expect(h.delays).toEqual([]);
    });

    it('fails over immediately on a malformed reply (it is not billed or retried)', async () => {
      const h = harness();
      h.registry.must('alpha').script.push({ type: 'error', kind: 'malformed' });
      const result = await h.run();
      expect(result.model.name).toBe('beta-small');
      expect(h.registry.must('alpha').calls).toHaveLength(1);
    });

    it('one retry then one failover: three provider calls, retries = 1', async () => {
      const h = harness();
      h.registry.must('alpha').script.push(transient, rateLimited);
      const result = await h.run();
      expect(result.attempts).toBe(3);
      expect(result.retries).toBe(1);
      expect(result.fallback).toBe(true);
      expect(result.model.name).toBe('beta-small');
    });

    it('also retries on the fallback before giving up on it', async () => {
      const h = harness();
      h.registry.must('alpha').fallback = rateLimited;
      h.registry.must('beta').script.push(transient);
      const result = await h.run();
      expect(result.model.name).toBe('beta-small');
      expect(result.retries).toBe(1);
    });

    it('returns to the primary on the very next request once it is healthy again (8.9)', async () => {
      const h = harness();
      const alpha = h.registry.must('alpha');
      alpha.fallback = transient;
      expect((await h.run()).model.name).toBe('beta-small');

      alpha.fallback = { type: 'ok' };
      const next = await h.run();
      expect(next.model.name).toBe('alpha-small');
      expect(next.fallback).toBe(false);
    });

    it('tries the primary first every time, even right after it failed', async () => {
      const h = harness();
      h.registry.must('alpha').fallback = transient;
      await h.run();
      const callsBefore = h.registry.must('alpha').calls.length;
      await h.run();
      expect(h.registry.must('alpha').calls.length).toBe(callsBefore + 3);
    });
  });

  describe('failures that end the request', () => {
    it.each([
      ['bad_request', 404],
      ['auth', 401],
    ] as const)(
      'a provider %s is final: no retry, no failover (edge case 8.5)',
      async (kind, status) => {
        const h = harness();
        h.registry.must('alpha').fallback = { type: 'error', kind, status };

        const failure = await failureOf(h.run());

        expect(failure.reason).toBe('provider');
        expect(failure.lastError?.kind).toBe(kind);
        expect(failure.attempts).toBe(1);
        expect(failure.retries).toBe(0);
        expect(failure.failedOver).toBe(false);
        expect(h.registry.must('beta').calls).toHaveLength(0);
        expect(h.delays).toEqual([]);
      },
    );

    it('reports every model failing, with what was tried (edge case 8.8)', async () => {
      const h = harness();
      h.registry.must('alpha').fallback = transient;
      h.registry.must('beta').fallback = transient;

      const failure = await failureOf(h.run());

      expect(failure.reason).toBe('provider');
      expect(failure.lastModel.name).toBe('beta-small');
      expect(failure.attempts).toBe(6);
      expect(failure.retries).toBe(4);
      expect(failure.failedOver).toBe(true);
    });

    it('does not fail over from a concrete model (the caller chose it)', async () => {
      const h = harness(chainFor('alpha-small'));
      h.registry.must('alpha').fallback = transient;
      const failure = await failureOf(h.run());
      expect(failure.failedOver).toBe(false);
      expect(h.registry.must('beta').calls).toHaveLength(0);
    });

    it('a fatal error on the fallback also ends the request', async () => {
      const h = harness();
      h.registry.must('alpha').fallback = rateLimited;
      h.registry.must('beta').fallback = { type: 'error', kind: 'auth', status: 401 };
      const failure = await failureOf(h.run());
      expect(failure.lastModel.name).toBe('beta-small');
      expect(failure.lastError?.kind).toBe('auth');
    });

    it('lets unexpected exceptions through untouched', async () => {
      const h = harness();
      h.registry.must('alpha').chatCompletion = () => Promise.reject(new TypeError('bug'));
      await expect(h.run()).rejects.toBeInstanceOf(TypeError);
    });

    it('throws a plain error if the config names a provider with no adapter', async () => {
      const h = harness();
      (h.registry.adapters as Map<string, unknown>).delete('alpha');
      await expect(h.run()).rejects.toThrow(/no adapter registered/);
    });
  });

  describe('the overall deadline (edge case 8.2)', () => {
    it('never plans a retry that cannot start before the deadline', async () => {
      // Clock: only the injected sleep moves time.
      let clock = 0;
      const h = harness();
      h.registry.must('alpha').fallback = transient;
      h.registry.must('beta').fallback = transient;

      const failure = await failureOf(
        h.run({
          now: () => clock,
          sleep: async (ms) => void (clock += ms),
          timeouts: { ...TIMEOUTS, deadlineMs: 500 },
        }),
      );

      expect(clock).toBeLessThanOrEqual(500);
      expect(failure.reason).toBe('provider');
      // alpha: attempt, 200 ms backoff fits, attempt, then 400 ms does not fit (300 left) so it
      // fails over; beta: attempt, then even 200 ms does not fit (100 left). Never all six.
      expect(failure.attempts).toBe(4);
    });

    it('hands each attempt only the time that is left', async () => {
      let clock = 0;
      const seen: CallOptions['timeouts'][] = [];
      const adapter: ProviderAdapter = {
        name: 'alpha',
        async chatCompletion(_request: UpstreamRequest, options: CallOptions) {
          seen.push(options.timeouts);
          throw new ProviderError('server_error', 'alpha', 'down', 503);
        },
        chatCompletionStream() {
          throw new Error('unused');
        },
      };
      const providers: ProviderRegistry = { get: () => adapter };
      await failureOf(
        executeWithFailover({
          chain: [chainFor('fast')[0]!],
          providers,
          request: REQUEST,
          timeouts: { firstByteMs: 2000, idleMs: 10_000, deadlineMs: 1000 },
          retry: POLICY,
          random: () => 0.5,
          now: () => clock,
          sleep: async (ms) => void (clock += ms),
        }),
      );

      // 1000 ms at the start, 800 after the 200 ms backoff, 400 after the next 400 ms backoff.
      expect(seen.map((t) => t.deadlineMs)).toEqual([1000, 800, 400]);
      // Capped by what is left, not by the 2000 ms first-byte setting.
      expect(seen.map((t) => t.firstByteMs)).toEqual([1000, 800, 400]);
    });

    it('stops with a deadline failure when no time is left', async () => {
      let clock = 0;
      const h = harness();
      h.registry.must('alpha').fallback = rateLimited;
      const failure = await failureOf(
        h.run({
          // Each look at the clock burns 600 ms: the second model starts with nothing left.
          now: () => (clock += 600),
          timeouts: { ...TIMEOUTS, deadlineMs: 1000 },
        }),
      );
      expect(failure.reason).toBe('deadline');
    });
  });

  describe('caller abort', () => {
    it('stops at once, and makes no further attempts', async () => {
      const controller = new AbortController();
      const h = harness();
      h.registry.must('alpha').fallback = transient;

      const failure = await failureOf(
        h.run({
          signal: controller.signal,
          sleep: async (ms) => {
            h.delays.push(ms);
            controller.abort(); // the client leaves during the first backoff
          },
        }),
      );

      expect(failure.reason).toBe('aborted');
      expect(h.registry.must('alpha').calls).toHaveLength(1);
      expect(h.registry.must('beta').calls).toHaveLength(0);
    });

    it('does not start when the signal is already aborted', async () => {
      const h = harness();
      const failure = await failureOf(h.run({ signal: AbortSignal.abort() }));
      expect(failure.reason).toBe('aborted');
      expect(h.registry.must('alpha').calls).toHaveLength(0);
    });

    it('treats an abort reported by the adapter as final', async () => {
      const h = harness();
      h.registry.must('alpha').script.push({ type: 'error', kind: 'aborted' });
      const failure = await failureOf(h.run());
      expect(failure.reason).toBe('aborted');
      expect(h.registry.must('beta').calls).toHaveLength(0);
    });
  });
});
