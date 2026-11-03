import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';

const DB = 'postgres://prism:s3cret-pw@localhost:5432/prism';
const base = { DATABASE_URL: DB, ADMIN_TOKEN: 'demo-admin-token' };

describe('loadEnv', () => {
  it('uses defaults when only the required values are set', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      logLevel: 'info',
      databaseUrl: DB,
      dbPoolMax: 10,
      dbConnectTimeoutMs: 5000,
      gatewayConfigFile: 'gateway_config.sample.json',
      seedOnStart: true,
    });
  });

  it('reads the admin token as a redacted secret', () => {
    const { adminToken } = loadEnv(base);
    expect(adminToken.reveal()).toBe('demo-admin-token');
    expect(JSON.stringify(adminToken)).not.toContain('demo-admin-token');
  });

  describe('ADMIN_TOKEN', () => {
    it('is required', () => {
      expect(() => loadEnv({ DATABASE_URL: DB })).toThrow(/ADMIN_TOKEN is required/);
      expect(() => loadEnv({ ...base, ADMIN_TOKEN: '   ' })).toThrow(/ADMIN_TOKEN is required/);
    });

    it('must be reasonably long, and the message does not echo it', () => {
      expect(() => loadEnv({ ...base, ADMIN_TOKEN: 'short' })).toThrow(/at least 8/);
      try {
        loadEnv({ ...base, ADMIN_TOKEN: 'short' });
      } catch (err) {
        expect((err as Error).message).not.toContain('short');
      }
    });

    it('is optional for the db CLI', () => {
      expect(() => loadEnv({ DATABASE_URL: DB }, { requireAdminToken: false })).not.toThrow();
    });
  });

  it('defaults dataDir to the repository data folder', () => {
    const { dataDir } = loadEnv(base);
    expect(existsSync(join(dataDir, 'model_pricing.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'seed_keys.json'))).toBe(true);
  });

  it('reads overrides from the environment', () => {
    const env = loadEnv({
      ...base,
      PORT: '9000',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      DB_POOL_MAX: '4',
      DB_CONNECT_TIMEOUT_MS: '1500',
      DATA_DIR: '/data',
      GATEWAY_CONFIG_FILE: 'gateway_config.json',
      SEED_ON_START: 'false',
    });
    expect(env).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'debug',
      dbPoolMax: 4,
      dbConnectTimeoutMs: 1500,
      dataDir: '/data',
      gatewayConfigFile: 'gateway_config.json',
      seedOnStart: false,
    });
  });

  it.each(['abc', '0', '70000', '80.5', ''])('rejects an invalid PORT (%s)', (port) => {
    expect(() => loadEnv({ ...base, PORT: port })).toThrow(ConfigError);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });

  it('rejects an empty HOST', () => {
    expect(() => loadEnv({ ...base, HOST: '  ' })).toThrow(ConfigError);
  });

  describe('DATABASE_URL', () => {
    it('is required', () => {
      expect(() => loadEnv({ ADMIN_TOKEN: 'demo-admin-token' })).toThrow(
        /DATABASE_URL is required/,
      );
      expect(() => loadEnv({ DATABASE_URL: '  ' })).toThrow(/DATABASE_URL is required/);
    });

    it('must be a URL', () => {
      expect(() => loadEnv({ DATABASE_URL: 'not a url' })).toThrow(/not a valid URL/);
    });

    it('must use a postgres scheme', () => {
      expect(() => loadEnv({ DATABASE_URL: 'mysql://u:p@h/db' })).toThrow(/postgres/);
    });

    it('accepts the postgresql:// scheme too', () => {
      expect(loadEnv({ ...base, DATABASE_URL: 'postgresql://u:p@h/db' }).databaseUrl).toContain(
        'postgresql',
      );
    });

    it('never echoes the credentials in an error message (edge case 2.10)', () => {
      for (const bad of ['mysql://prism:s3cret-pw@h/db', 'nope s3cret-pw']) {
        try {
          loadEnv({ DATABASE_URL: bad });
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).not.toContain('s3cret-pw');
        }
      }
    });
  });

  it.each([
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '1000'],
    ['DB_POOL_MAX', 'many'],
    ['DB_CONNECT_TIMEOUT_MS', '10'],
    ['DB_CONNECT_TIMEOUT_MS', ''],
  ])('rejects an invalid %s (%s)', (name, value) => {
    expect(() => loadEnv({ ...base, [name]: value })).toThrow(ConfigError);
  });

  it.each(['maybe', '2'])('rejects an invalid SEED_ON_START (%s)', (value) => {
    expect(() => loadEnv({ ...base, SEED_ON_START: value })).toThrow(ConfigError);
  });
});
