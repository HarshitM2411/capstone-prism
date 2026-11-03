import { createRedis, type RedisClient } from '../../src/redis.js';

/**
 * Integration tests use database 15 of the Redis from `docker compose up -d redis`, so the demo
 * data in database 0 is never touched. Override with TEST_REDIS_URL.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

export interface TestRedisOptions {
  commandTimeoutMs?: number;
}

/** A connected client on the test database, which is emptied first. */
export async function freshRedis(options: TestRedisOptions = {}): Promise<RedisClient> {
  const client = createRedis({
    url: TEST_REDIS_URL,
    commandTimeoutMs: options.commandTimeoutMs ?? 2000,
  });
  try {
    await waitReady(client);
    await client.flushdb();
  } catch (err) {
    client.disconnect();
    throw new Error(
      'Integration tests need Redis. Start it with `docker compose up -d redis` ' +
        `(or set TEST_REDIS_URL). Original error: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return client;
}

async function waitReady(client: RedisClient): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await client.ping();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** A client that points at a port nothing listens on: every command fails. */
export function deadRedis(): RedisClient {
  return createRedis({ url: 'redis://127.0.0.1:1', commandTimeoutMs: 300 });
}
