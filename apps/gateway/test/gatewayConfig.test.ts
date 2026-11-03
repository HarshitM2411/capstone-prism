import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/env.js';
import {
  describeConfig,
  knownModelNames,
  loadGatewayConfig,
  parseGatewayConfig,
} from '../src/config/gatewayConfig.js';
import { loadAllConfig } from '../src/startup.js';
import { DATA_DIR, readData } from './helpers/dataDir.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Fresh, mutable copies of the known-good starter files. */
function starter(): { pricing: Json; config: Json } {
  return {
    pricing: structuredClone(readData<Json>('model_pricing.json')),
    config: structuredClone(readData<Json>('gateway_config.sample.json')),
  };
}

function problemsFor(mutate: (files: { pricing: Json; config: Json }) => void): string {
  const files = starter();
  mutate(files);
  try {
    parseGatewayConfig(files.pricing, files.config);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected parseGatewayConfig to throw');
}

describe('starter configuration', () => {
  const config = loadGatewayConfig(DATA_DIR);

  it('loads the four priced models and maps each to its provider', () => {
    expect([...config.models.keys()].sort()).toEqual([
      'alpha-large',
      'alpha-small',
      'beta-large',
      'beta-small',
    ]);
    expect(config.models.get('alpha-small')?.provider).toBe('alpha');
    expect(config.models.get('beta-large')?.provider).toBe('beta');
  });

  it('converts prices to exact integer picoUSD per token', () => {
    const alphaSmall = config.models.get('alpha-small')!;
    expect(alphaSmall.inputPicoPerToken).toBe(150_000n);
    expect(alphaSmall.outputPicoPerToken).toBe(600_000n);
    expect(config.models.get('beta-large')?.inputPicoPerToken).toBe(2_500_000n);
  });

  it('builds the fast and smart fallback chains', () => {
    expect(config.aliases.get('fast')?.chain).toEqual(['alpha-small', 'beta-small']);
    expect(config.aliases.get('smart')?.chain).toEqual(['alpha-large', 'beta-large']);
  });

  it('loads the auto routing and the retry and degradation policies', () => {
    expect(config.auto).toEqual({ simple: 'fast', complex: 'smart' });
    expect(config.retry).toEqual({ maxAttempts: 3, initialBackoffMs: 200, backoffMultiplier: 2 });
    expect(config.degradation).toEqual({
      errorRateThreshold: 0.5,
      windowSeconds: 60,
      p95LatencyMs: 5000,
    });
  });

  it('strips the trailing slash from nothing and keeps provider base URLs', () => {
    expect(config.providers.get('alpha')?.baseUrl).toBe('http://localhost:9001/v1');
    expect(config.providers.get('beta')?.baseUrl).toBe('http://localhost:9002/v1');
  });

  it('knows every name an allowlist may use', () => {
    expect(knownModelNames(config)).toEqual(
      new Set(['fast', 'smart', 'auto', 'alpha-small', 'alpha-large', 'beta-small', 'beta-large']),
    );
  });

  it('is frozen so nothing can change it at runtime', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.retry)).toBe(true);
  });

  it('never exposes provider credentials in any printable form (edge case 10.1)', () => {
    const printed = [
      JSON.stringify(describeConfig(config)),
      JSON.stringify([...config.providers.values()]),
      String(config.providers.get('alpha')?.apiKey),
    ].join(' ');
    expect(printed).not.toContain('mock-key-alpha');
    expect(printed).not.toContain('mock-key-beta');
    expect(config.providers.get('alpha')?.apiKey.reveal()).toBe('mock-key-alpha');
  });
});

describe('parseGatewayConfig fail-fast', () => {
  it('accepts the unchanged starter files', () => {
    const { pricing, config } = starter();
    expect(() => parseGatewayConfig(pricing, config)).not.toThrow();
  });

  it('rejects a primary model that is not priced', () => {
    const message = problemsFor(({ pricing }) => delete pricing['alpha-small']);
    expect(message).toMatch(/model_aliases\.fast.*"alpha-small".*priced/);
  });

  it('rejects an alias model that no provider serves', () => {
    const message = problemsFor(({ config }) => {
      config.model_aliases.fast.fallbacks = ['gamma-small'];
    });
    expect(message).toMatch(/"gamma-small"/);
  });

  it('rejects a model priced for a provider that is not registered', () => {
    const message = problemsFor(({ config }) => {
      config.providers = config.providers.filter((p: Json) => p.name !== 'beta');
    });
    expect(message).toMatch(/"beta-small"/);
  });

  it('rejects a model repeated within one chain', () => {
    const message = problemsFor(({ config }) => {
      config.model_aliases.fast.fallbacks = ['alpha-small'];
    });
    expect(message).toMatch(/more than once/);
  });

  it('requires the fast and smart aliases', () => {
    expect(problemsFor(({ config }) => delete config.model_aliases.smart)).toMatch(
      /must define the "smart" alias/,
    );
    expect(problemsFor(({ config }) => delete config.model_aliases.fast)).toMatch(
      /must define the "fast" alias/,
    );
  });

  it('rejects auto routing to an alias that does not exist', () => {
    const message = problemsFor(({ config }) => {
      config.model_aliases.auto.route_by_difficulty.complex = 'genius';
    });
    expect(message).toMatch(/unknown alias.*genius/);
  });

  it('rejects duplicate provider names', () => {
    const message = problemsFor(({ config }) => {
      config.providers.push({ ...config.providers[0] });
    });
    expect(message).toMatch(/duplicate provider name "alpha"/);
  });

  it.each(['not a url', 'ftp://localhost/v1', ''])('rejects the provider base_url "%s"', (url) => {
    const message = problemsFor(({ config }) => {
      config.providers[0].base_url = url;
    });
    expect(message).toMatch(/base_url/);
  });

  it('rejects a provider with no api_key', () => {
    const message = problemsFor(({ config }) => delete config.providers[0].api_key);
    expect(message).toMatch(/api_key/);
  });

  it('rejects an empty provider list', () => {
    expect(problemsFor(({ config }) => (config.providers = []))).toMatch(/non-empty array/);
  });

  it.each([
    ['a missing price', { input_per_1m: 1 }],
    ['a negative price', { input_per_1m: -1, output_per_1m: 1 }],
    ['a string price', { input_per_1m: '1', output_per_1m: 1 }],
    ['a price with too many decimals', { input_per_1m: 0.0000001, output_per_1m: 1 }],
  ])('rejects %s', (_label, entry) => {
    const message = problemsFor(({ pricing }) => (pricing['beta-large'] = entry));
    expect(message).toMatch(/model_pricing\.json: "beta-large"/);
  });

  it('rejects an empty price table', () => {
    const message = problemsFor(({ pricing }) => {
      for (const key of Object.keys(pricing)) delete pricing[key];
    });
    expect(message).toMatch(/no priced models/);
  });

  it.each([
    ['max_attempts', 0],
    ['max_attempts', 1.5],
    ['initial_backoff_ms', -5],
    ['backoff_multiplier', 0.5],
  ])('rejects retry.%s = %s', (field, value) => {
    const message = problemsFor(({ config }) => (config.retry[field] = value));
    expect(message).toMatch(new RegExp(`retry\\.${field}`));
  });

  it('rejects an out-of-range degradation threshold', () => {
    const message = problemsFor(({ config }) => (config.degradation.error_rate_threshold = 1.5));
    expect(message).toMatch(/error_rate_threshold/);
  });

  it('reports every problem at once, not just the first (edge case 6.12)', () => {
    const message = problemsFor(({ config }) => {
      config.model_aliases.auto.route_by_difficulty.complex = 'genius';
      config.degradation.error_rate_threshold = 2;
      config.retry.max_attempts = 0;
    });
    expect(message).toMatch(/3 problems/);
    expect(message).toMatch(/genius/);
    expect(message).toMatch(/error_rate_threshold/);
    expect(message).toMatch(/max_attempts/);
  });

  it('rejects non-object input without throwing a TypeError', () => {
    expect(() => parseGatewayConfig(null, 'x')).toThrow(ConfigError);
    expect(() => parseGatewayConfig([], [])).toThrow(ConfigError);
  });

  describe('model-to-provider mapping', () => {
    it('honours an explicit models list over the name prefix', () => {
      const { pricing, config } = starter();
      pricing['gamma-fast'] = { input_per_1m: 1, output_per_1m: 2 };
      config.providers[0].models = ['alpha-small', 'alpha-large', 'gamma-fast'];
      config.model_aliases.fast.fallbacks = ['gamma-fast'];
      const parsed = parseGatewayConfig(pricing, config);
      expect(parsed.models.get('gamma-fast')?.provider).toBe('alpha');
    });

    it('rejects a model listed by two providers', () => {
      const message = problemsFor(({ config }) => {
        config.providers[0].models = ['alpha-small', 'alpha-large', 'beta-small'];
        config.providers[1].models = ['beta-small', 'beta-large'];
      });
      expect(message).toMatch(/listed by two providers/);
    });
  });
});

describe('loading from disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDataDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'prism-config-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  }

  const good = (name: string): string => JSON.stringify(readData(name));

  it('loads the starter data directory end to end', () => {
    const { config, tenants } = loadAllConfig({
      dataDir: DATA_DIR,
      gatewayConfigFile: 'gateway_config.sample.json',
    });
    expect(config.aliases.size).toBe(2);
    expect(tenants.map((t) => t.team)).toEqual(['search', 'research', 'free-tier', 'budget-demo']);
  });

  it('fails clearly when a file is missing (edge case 6.11)', () => {
    const dir = tempDataDir({ 'model_pricing.json': good('model_pricing.json') });
    expect(() => loadGatewayConfig(dir)).toThrow(/gateway_config\.sample\.json could not be read/);
  });

  it('fails clearly when the seed file is missing', () => {
    const dir = tempDataDir({
      'model_pricing.json': good('model_pricing.json'),
      'gateway_config.sample.json': good('gateway_config.sample.json'),
    });
    expect(() =>
      loadAllConfig({ dataDir: dir, gatewayConfigFile: 'gateway_config.sample.json' }),
    ).toThrow(/seed_keys\.json could not be read/);
  });

  it('fails clearly on malformed JSON without echoing its content', () => {
    const dir = tempDataDir({
      'model_pricing.json': '{ "alpha-small": SECRET-PRICE-TOKEN ',
      'gateway_config.sample.json': good('gateway_config.sample.json'),
    });
    let message = '';
    try {
      loadGatewayConfig(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/model_pricing\.json.*not valid JSON/);
    expect(message).not.toContain('SECRET-PRICE-TOKEN');
  });

  it('can load an alternative config file by name', () => {
    const dir = tempDataDir({
      'model_pricing.json': good('model_pricing.json'),
      'custom.json': good('gateway_config.sample.json'),
    });
    expect(loadGatewayConfig(dir, 'custom.json').aliases.has('fast')).toBe(true);
  });
});
