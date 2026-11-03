import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/env.js';
import { knownModelNames, loadGatewayConfig } from '../src/config/gatewayConfig.js';
import { parseSeedFile } from '../src/seed/seedFile.js';
import { DATA_DIR, readData } from './helpers/dataDir.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const known = knownModelNames(loadGatewayConfig(DATA_DIR));

function seed(): Json {
  return structuredClone(readData<Json>('seed_keys.json'));
}

function errorFor(mutate: (file: Json) => void): string {
  const file = seed();
  mutate(file);
  try {
    parseSeedFile(file, { knownModelNames: known });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected parseSeedFile to throw');
}

describe('starter seed file', () => {
  const tenants = parseSeedFile(seed(), { knownModelNames: known });
  const byTeam = (team: string) => tenants.find((t) => t.team === team)!;

  it('parses the four sample tenants in order', () => {
    expect(tenants.map((t) => t.team)).toEqual(['search', 'research', 'free-tier', 'budget-demo']);
  });

  it('preserves exact key values, which the starter scripts rely on', () => {
    expect(byTeam('search').virtualKey.reveal()).toBe('prism-sk-search-1a2b3c');
    expect(byTeam('research').virtualKey.reveal()).toBe('prism-sk-research-4d5e6f');
    expect(byTeam('free-tier').virtualKey.reveal()).toBe('prism-sk-free-7g8h9i');
    expect(byTeam('budget-demo').virtualKey.reveal()).toBe('prism-sk-budget-demo-0j1k2l');
  });

  it('converts budgets to exact units', () => {
    expect(byTeam('search').monthlyBudgetUnits).toBe(5_000_000_000n);
    expect(byTeam('budget-demo').monthlyBudgetUnits).toBe(1000n);
  });

  it('keeps rate limits, allowlists and cache policy per tenant', () => {
    expect(byTeam('free-tier')).toMatchObject({
      rpmLimit: 10,
      tpmLimit: 20000,
      allowedModels: ['fast'],
      cacheEnabled: true,
      cacheThreshold: 0.85,
    });
    expect(byTeam('research')).toMatchObject({
      rpmLimit: 300,
      allowedModels: ['fast', 'smart', 'auto'],
      cacheEnabled: false,
      cacheThreshold: null,
    });
    expect(byTeam('budget-demo').cacheEnabled).toBe(false);
  });

  it('never prints a raw key (edge case 2.10)', () => {
    const printed = JSON.stringify(tenants, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(printed).not.toContain('prism-sk-');
  });
});

describe('parseSeedFile validation', () => {
  it('rejects a file with no tenants', () => {
    expect(errorFor((f) => (f.tenants = []))).toMatch(/non-empty "tenants" array/);
    expect(() => parseSeedFile({}, { knownModelNames: known })).toThrow(ConfigError);
    expect(() => parseSeedFile(null, { knownModelNames: known })).toThrow(ConfigError);
  });

  it('rejects an allowlist entry that is a typo (edge case 2.7)', () => {
    const message = errorFor((f) => (f.tenants[0].model_allowlist = ['fast', 'smrt']));
    expect(message).toMatch(/unknown name\(s\): smrt/);
    expect(message).toMatch(/"search"/);
  });

  it('accepts concrete model names in an allowlist', () => {
    const file = seed();
    file.tenants[0].model_allowlist = ['alpha-small'];
    expect(parseSeedFile(file, { knownModelNames: known })[0]?.allowedModels).toEqual([
      'alpha-small',
    ]);
  });

  it('de-duplicates allowlist entries', () => {
    const file = seed();
    file.tenants[0].model_allowlist = ['fast', 'fast'];
    expect(parseSeedFile(file, { knownModelNames: known })[0]?.allowedModels).toEqual(['fast']);
  });

  it('allows an empty allowlist (it blocks every model)', () => {
    const file = seed();
    file.tenants[0].model_allowlist = [];
    expect(parseSeedFile(file, { knownModelNames: known })[0]?.allowedModels).toEqual([]);
  });

  it('rejects duplicate teams and duplicate keys', () => {
    expect(errorFor((f) => (f.tenants[1].team = 'search'))).toMatch(/duplicate team/);
    expect(errorFor((f) => (f.tenants[1].virtual_key = f.tenants[0].virtual_key))).toMatch(
      /used by more than one tenant/,
    );
  });

  it.each(['', '  ', 'has space', 'tab\tkey', 123, null])('rejects the virtual_key %j', (key) => {
    expect(errorFor((f) => (f.tenants[0].virtual_key = key))).toMatch(/virtual_key/);
  });

  it.each([-1, 1.5, '10', null])('rejects requests_per_minute = %j', (rpm) => {
    expect(errorFor((f) => (f.tenants[0].rate_limit.requests_per_minute = rpm))).toMatch(
      /requests_per_minute/,
    );
  });

  it('accepts requests_per_minute = 0 (blocks the key, edge case 2.8)', () => {
    const file = seed();
    file.tenants[0].rate_limit.requests_per_minute = 0;
    expect(parseSeedFile(file, { knownModelNames: known })[0]?.rpmLimit).toBe(0);
  });

  it('treats tokens_per_minute as optional but validates it when present', () => {
    const file = seed();
    delete file.tenants[0].rate_limit.tokens_per_minute;
    expect(parseSeedFile(file, { knownModelNames: known })[0]?.tpmLimit).toBeNull();
    expect(errorFor((f) => (f.tenants[0].rate_limit.tokens_per_minute = -5))).toMatch(
      /tokens_per_minute/,
    );
  });

  it.each([-1, 'abc', 0.123456789, null])('rejects monthly_budget_usd = %j', (budget) => {
    expect(errorFor((f) => (f.tenants[0].monthly_budget_usd = budget))).toMatch(
      /monthly_budget_usd/,
    );
  });

  it('accepts a zero budget (every request is then rejected as over budget)', () => {
    const file = seed();
    file.tenants[0].monthly_budget_usd = 0;
    expect(parseSeedFile(file, { knownModelNames: known })[0]?.monthlyBudgetUnits).toBe(0n);
  });

  it('requires a similarity threshold in (0, 1] when the cache is enabled', () => {
    for (const threshold of [0, 1.5, -0.2, 'high', undefined]) {
      expect(
        errorFor(
          (f) => (f.tenants[0].semantic_cache = { enabled: true, similarity_threshold: threshold }),
        ),
      ).toMatch(/similarity_threshold/);
    }
    const file = seed();
    file.tenants[0].semantic_cache = { enabled: true, similarity_threshold: 1 };
    expect(parseSeedFile(file, { knownModelNames: known })[0]?.cacheThreshold).toBe(1);
  });

  it('requires an explicit cache enabled flag', () => {
    expect(errorFor((f) => (f.tenants[0].semantic_cache = {}))).toMatch(/semantic_cache\.enabled/);
    expect(errorFor((f) => delete f.tenants[0].semantic_cache)).toMatch(/semantic_cache\.enabled/);
  });

  it('reports every problem at once, naming the tenant', () => {
    const message = errorFor((f) => {
      f.tenants[0].model_allowlist = ['nope'];
      f.tenants[1].rate_limit.requests_per_minute = -1;
      f.tenants[2].monthly_budget_usd = 'abc';
    });
    expect(message).toMatch(/3 problems/);
    expect(message).toMatch(/"search"/);
    expect(message).toMatch(/"research"/);
    expect(message).toMatch(/"free-tier"/);
  });
});
