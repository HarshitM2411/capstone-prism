import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  /** Upper bound on clients (edge case 11.3). */
  max: number;
  /** Max wait to open or acquire a connection before failing fast instead of hanging. */
  connectionTimeoutMs: number;
  /** Called for errors on idle clients so they never become an unhandled 'error' event. */
  onError?: (err: Error) => void;
}

export type Pool = pg.Pool;

export function createPool(options: PoolOptions): Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: 'prism-gateway',
  });
  pool.on('error', (err) => options.onError?.(err));
  return pool;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries `SELECT 1` until Postgres answers or the deadline passes (edge case 11.1). */
export async function waitForDatabase(
  pool: Pool,
  options: { timeoutMs?: number; intervalMs?: number; onRetry?: (err: Error) => void } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() + intervalMs >= deadline) {
        throw new Error(`Postgres did not become available within ${timeoutMs} ms`, {
          cause: err,
        });
      }
      options.onRetry?.(err as Error);
      await sleep(intervalMs);
    }
  }
}

/** A readiness probe for `/health`: resolves if Postgres answers quickly, rejects otherwise. */
export async function checkDatabase(pool: Pool, timeoutMs = 1_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('database check timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The semantic cache needs `pgvector`; fail at startup with a clear message if it is missing. */
export async function verifyVectorExtension(pool: Pool): Promise<void> {
  const { rowCount } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  if (rowCount === 0) {
    throw new Error(
      'The pgvector extension is not installed in this database. ' +
        'Use a Postgres image with pgvector (for example pgvector/pgvector:pg16).',
    );
  }
}
