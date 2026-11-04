import { describe, expect, it } from 'vitest';
import type { ModelInfo, RetryPolicy } from '../src/config/gatewayConfig.js';
import { FakeRegistry, type FakeOutcome } from '../src/providers/fake.js';
import type { UpstreamChunk } from '../src/providers/types.js';
import { modelChain } from '../src/routing/chain.js';
import {
  ExecuteFailure,
  executeStreamWithFailover,
  type OpenedStream,
  type StreamExecuteInput,
} from '../src/routing/executor.js';
import { resolveModel } from '../src/routing/resolve.js';
import { config } from './helpers/app.js';

const POLICY: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 1, backoffMultiplier: 2 };
const TIMEOUTS = { firstByteMs: 200, idleMs: 200, deadlineMs: 600 };
const REQUEST = { messages: [{ role: 'user' as const, content: 'What is a queue?' }], params: {} };
const fast: ModelInfo[] = modelChain(config, resolveModel(config, 'fast')!);

const transient: FakeOutcome = { type: 'error', kind: 'server_error', status: 503 };

function run(registry: FakeRegistry, overrides: Partial<StreamExecuteInput> = {}) {
  return executeStreamWithFailover({
    chain: fast,
    providers: registry,
    request: REQUEST,
    timeouts: TIMEOUTS,
    retry: POLICY,
    streamMaxMs: 5000,
    ...overrides,
  });
}

async function drain(stream: OpenedStream): Promise<UpstreamChunk[]> {
  const chunks: UpstreamChunk[] = [];
  let step = stream.first;
  while (!step.done) {
    chunks.push(step.value);
    step = await stream.iterator.next();
  }
  return chunks;
}

describe('executeStreamWithFailover', () => {
  it('returns the stream positioned after its first chunk, from the primary', async () => {
    const registry = new FakeRegistry(['alpha', 'beta']);
    const result = await run(registry);
    expect(result).toMatchObject({ fallback: false, retries: 0, attempts: 1 });
    expect(result.model.name).toBe('alpha-small');
    const chunks = await drain(result.stream);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.at(-1)!.usage).not.toBeNull();
  });

  it('retries a failure before the first chunk, then fails over', async () => {
    const registry = new FakeRegistry(['alpha', 'beta']);
    registry.must('alpha').fallback = transient;
    const result = await run(registry);
    expect(result.model.name).toBe('beta-small');
    expect(result).toMatchObject({ fallback: true, retries: 2, attempts: 4 });
  });

  it('does not retry once the first chunk has been delivered: a later failure stays an error', async () => {
    const registry = new FakeRegistry(['alpha', 'beta']);
    registry.must('alpha').script.push({ type: 'die_mid_stream', afterChunks: 2 });
    const result = await run(registry);
    await expect(drain(result.stream)).rejects.toMatchObject({ kind: 'connection' });
    expect(registry.must('alpha').calls).toHaveLength(1);
    expect(registry.must('beta').calls).toHaveLength(0);
  });

  it('gives up on a first chunk that is overdue, by the request deadline', async () => {
    const registry = new FakeRegistry(['alpha', 'beta']);
    registry.must('alpha').fallback = { type: 'hang' };
    registry.must('beta').fallback = { type: 'hang' };
    const started = Date.now();
    const failure = await run(registry).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ExecuteFailure);
    expect(Date.now() - started).toBeLessThan(TIMEOUTS.deadlineMs + 300);
    expect(registry.must('alpha').streamsInFlight).toBe(0);
    expect(registry.must('beta').streamsInFlight).toBe(0);
  });

  it('stops everything when the caller aborts while waiting for the first chunk', async () => {
    const registry = new FakeRegistry(['alpha', 'beta']);
    registry.must('alpha').fallback = { type: 'ok', latencyMs: 150 };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const failure = await run(registry, { signal: controller.signal }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ExecuteFailure);
    expect((failure as ExecuteFailure).reason).toBe('aborted');
    expect(registry.must('beta').calls).toHaveLength(0);
  });

  it('the returned abort() stops the upstream stream', async () => {
    const registry = new FakeRegistry(['alpha', 'beta'], { tokenDelayMs: 30 });
    const result = await run(registry);
    expect(registry.must('alpha').streamsInFlight).toBe(1);
    const pending = result.stream.iterator.next();
    result.stream.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(registry.must('alpha').streamsInFlight).toBe(0);
  });

  it('a stream may outlast the request deadline (only the first chunk is bounded by it)', async () => {
    const registry = new FakeRegistry(['alpha', 'beta'], { tokenDelayMs: 40 });
    const result = await run(registry, { timeouts: { ...TIMEOUTS, deadlineMs: 300 } });
    const started = Date.now();
    const chunks = await drain(result.stream);
    expect(chunks.length).toBeGreaterThan(10);
    expect(Date.now() - started).toBeGreaterThan(300);
  });
});
