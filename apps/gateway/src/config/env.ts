/**
 * Process environment, parsed once at startup.
 *
 * Fail fast: a malformed value stops the gateway from booting with a clear message
 * instead of surfacing later as a confusing runtime error (edge case 11.10).
 * Secrets (admin token, provider keys, DB/Redis URLs) come from the environment only, and
 * error messages never echo a secret value back.
 */
import { fileURLToPath } from 'node:url';
import { Secret } from '../secret.js';

export interface Env {
  port: number;
  host: string;
  logLevel: string;
  /** Postgres connection string. Contains credentials — never log it. */
  databaseUrl: string;
  /** Maximum clients in the Postgres pool (bounded, edge case 11.3). */
  dbPoolMax: number;
  /** How long to wait to acquire or open a DB connection before failing fast. */
  dbConnectTimeoutMs: number;
  /** Directory holding the seed/config JSON files. */
  dataDir: string;
  /** File inside `dataDir` with the provider registry, aliases and retry policy. */
  gatewayConfigFile: string;
  /** Token for the /admin/* routes (sent in x-admin-token). Never log it. */
  adminToken: Secret;
  /** Run the (idempotent) tenant seed at startup. */
  seedOnStart: boolean;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** `<repo>/data`, resolved from this file so it works from `src/` (dev) and `dist/` (built). */
const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function parseInteger(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = source[name] ?? String(fallback);
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function parseBoolean(source: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = source[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}")`);
}

export interface LoadEnvOptions {
  /** The db CLI never serves requests, so it does not need the admin token. Default: required. */
  requireAdminToken?: boolean;
}

const MIN_ADMIN_TOKEN_LENGTH = 8;

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: LoadEnvOptions = {},
): Env {
  const port = parseInteger(source, 'PORT', 8080, 1, 65535);

  const logLevel = source.LOG_LEVEL ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${logLevel}")`);
  }

  const host = source.HOST ?? '0.0.0.0';
  if (host.trim() === '') {
    throw new ConfigError('HOST must not be empty');
  }

  const databaseUrl = source.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new ConfigError('DATABASE_URL is required (a postgres:// connection string)');
  }
  let protocol: string;
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    // Deliberately do not echo the value: it contains credentials.
    throw new ConfigError('DATABASE_URL is not a valid URL');
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new ConfigError('DATABASE_URL must start with postgres:// or postgresql://');
  }

  let adminToken = new Secret('');
  if (options.requireAdminToken !== false) {
    const raw = source.ADMIN_TOKEN?.trim() ?? '';
    if (raw === '') {
      throw new ConfigError('ADMIN_TOKEN is required (it protects the /admin routes)');
    }
    if (raw.length < MIN_ADMIN_TOKEN_LENGTH) {
      throw new ConfigError(`ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
    }
    adminToken = new Secret(raw);
  }

  const dataDir = source.DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  const gatewayConfigFile = source.GATEWAY_CONFIG_FILE?.trim() || 'gateway_config.sample.json';

  return {
    port,
    host,
    logLevel,
    databaseUrl,
    dbPoolMax: parseInteger(source, 'DB_POOL_MAX', 10, 1, 200),
    dbConnectTimeoutMs: parseInteger(source, 'DB_CONNECT_TIMEOUT_MS', 5000, 100, 120_000),
    adminToken,
    dataDir,
    gatewayConfigFile,
    seedOnStart: parseBoolean(source, 'SEED_ON_START', true),
  };
}
