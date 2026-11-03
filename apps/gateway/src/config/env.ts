/**
 * Process environment, parsed once at startup.
 *
 * Fail fast: a malformed value stops the gateway from booting with a clear message
 * instead of surfacing later as a confusing runtime error (edge case 11.10).
 * Secrets (admin token, provider keys, DB/Redis URLs) come from the environment only.
 */

export interface Env {
  port: number;
  host: string;
  logLevel: string;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const rawPort = source.PORT ?? '8080';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
  }

  const logLevel = source.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${logLevel}")`);
  }

  const host = source.HOST ?? '0.0.0.0';
  if (host.trim() === '') {
    throw new ConfigError('HOST must not be empty');
  }

  return { port, host, logLevel };
}
