import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv } from '../src/config/env.js';

describe('loadEnv', () => {
  it('uses defaults when nothing is set', () => {
    expect(loadEnv({})).toEqual({ port: 8080, host: '0.0.0.0', logLevel: 'info' });
  });

  it('reads overrides from the environment', () => {
    expect(loadEnv({ PORT: '9000', HOST: '127.0.0.1', LOG_LEVEL: 'debug' })).toEqual({
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'debug',
    });
  });

  it.each(['abc', '0', '70000', '80.5', ''])('rejects an invalid PORT (%s)', (port) => {
    expect(() => loadEnv({ PORT: port })).toThrow(ConfigError);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadEnv({ LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });

  it('rejects an empty HOST', () => {
    expect(() => loadEnv({ HOST: '  ' })).toThrow(ConfigError);
  });
});
