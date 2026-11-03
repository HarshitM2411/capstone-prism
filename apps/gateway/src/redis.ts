import { Redis } from 'ioredis';

export type RedisClient = Redis;

export interface RedisOptions {
  url: string;
  /** Per-command timeout. A slow Redis must fail fast rather than stall requests. */
  commandTimeoutMs: number;
  onError?: (err: Error) => void;
}

/**
 * A Redis client tuned for a request path that must never hang:
 *  - `commandTimeout` bounds every command;
 *  - `enableOfflineQueue: false` makes commands fail immediately while disconnected instead of
 *    queueing behind a dead connection;
 *  - `maxRetriesPerRequest: 0` never silently re-sends a command (a retried rate-limit script could
 *    count one client request twice);
 *  - the client keeps reconnecting in the background, so a Redis restart heals by itself.
 */
export function createRedis(options: RedisOptions): RedisClient {
  const client = new Redis(options.url, {
    commandTimeout: options.commandTimeoutMs,
    connectTimeout: Math.max(options.commandTimeoutMs, 1000),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    lazyConnect: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  // An unhandled 'error' event would crash the process; report it and keep reconnecting.
  client.on('error', (err: Error) => options.onError?.(err));
  return client;
}

/** Readiness probe for `/health`: resolves when Redis answers PING quickly. */
export async function checkRedis(client: RedisClient): Promise<void> {
  const reply = await client.ping();
  if (reply !== 'PONG') throw new Error('unexpected reply to PING');
}
