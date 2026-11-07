/**
 * Loads and validates the gateway configuration: the price table, the provider registry,
 * model aliases with their fallback chains, the retry policy and the degradation settings.
 *
 * The config is loaded once at startup into frozen, in-memory structures. It **fails fast**:
 * every problem found is reported together in one `ConfigError`, and the gateway refuses to
 * boot (edge cases 6.11, 6.12, 10.5, 11.10).
 *
 * Input shapes are the starter pack's `model_pricing.json` and `gateway_config.sample.json`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePricePer1m, type TokenPrice } from '../money.js';
import { Secret } from '../secret.js';
import { ConfigError } from './env.js';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  /** The provider credential. Never logged, never returned to a client. */
  apiKey: Secret;
  /** Models this provider serves when listed explicitly; otherwise inferred from the name. */
  explicitModels: readonly string[] | null;
}

export interface ModelInfo extends TokenPrice {
  name: string;
  provider: string;
  /** Original price per 1M tokens, kept for display only — never used for arithmetic. */
  inputPer1m: number;
  outputPer1m: number;
}

export interface TierAlias {
  name: string;
  primary: string;
  fallbacks: readonly string[];
  /** Primary followed by the fallbacks, in the order they are tried. */
  chain: readonly string[];
}

export interface RetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
}

export interface DegradationPolicy {
  errorRateThreshold: number;
  windowSeconds: number;
  p95LatencyMs: number;
}

export interface GatewayConfig {
  providers: ReadonlyMap<string, ProviderConfig>;
  /** Every priced model that is served by a registered provider. */
  models: ReadonlyMap<string, ModelInfo>;
  /** Tier aliases (`fast`, `smart`) that resolve to a model chain. */
  aliases: ReadonlyMap<string, TierAlias>;
  /** The `auto` alias: maps a difficulty class to a tier alias. `null` if not configured. */
  auto: { simple: string; complex: string } | null;
  retry: RetryPolicy;
  degradation: DegradationPolicy;
}

/** Names the router must always know: the demo flow and starter scripts reference them. */
const REQUIRED_ALIASES = ['fast', 'smart'] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Reads and parses a JSON file. Errors name the file but never echo its content. */
export function readJsonFile(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`${label} could not be read at ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError(`${label} at ${path} is not valid JSON`);
  }
}

function parsePricing(raw: unknown, problems: string[]): Map<string, ModelInfoPrice> {
  const prices = new Map<string, ModelInfoPrice>();
  if (!isObject(raw)) {
    problems.push('model_pricing.json must be a JSON object keyed by model name');
    return prices;
  }
  for (const [model, entry] of Object.entries(raw)) {
    if (model.startsWith('_')) continue; // `_comment` and friends
    if (!isObject(entry)) {
      problems.push(`model_pricing.json: "${model}" must be an object`);
      continue;
    }
    try {
      const input = entry.input_per_1m;
      const output = entry.output_per_1m;
      if (typeof input !== 'number' || typeof output !== 'number') {
        throw new Error('input_per_1m and output_per_1m must both be numbers');
      }
      prices.set(model, {
        inputPer1m: input,
        outputPer1m: output,
        inputPicoPerToken: parsePricePer1m(input, `${model}.input_per_1m`),
        outputPicoPerToken: parsePricePer1m(output, `${model}.output_per_1m`),
      });
    } catch (err) {
      problems.push(`model_pricing.json: "${model}": ${(err as Error).message}`);
    }
  }
  if (prices.size === 0) {
    problems.push('model_pricing.json contains no priced models');
  }
  return prices;
}

type ModelInfoPrice = Omit<ModelInfo, 'name' | 'provider'>;

/**
 * A provider's `api_key` (and `base_url`) is either the value itself (the mock providers' placeholder
 * keys and URLs) or `env:NAME`, which reads it from that environment variable so a real key never has
 * to be written into a file. A missing or empty variable is a configuration error naming the variable
 * (never its value).
 */
function resolveEnvRef(
  raw: string,
  field: string,
  where: string,
  env: NodeJS.ProcessEnv,
  problems: string[],
): string | null {
  if (!raw.startsWith('env:')) return raw;
  const variable = raw.slice('env:'.length).trim();
  const value = variable === '' ? undefined : env[variable]?.trim();
  if (value === undefined || value === '') {
    problems.push(
      `${where}.${field} refers to the environment variable "${variable}" which is not set`,
    );
    return null;
  }
  return value;
}

function parseProviders(
  raw: unknown,
  problems: string[],
  env: NodeJS.ProcessEnv,
): Map<string, ProviderConfig> {
  const providers = new Map<string, ProviderConfig>();
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push('config: "providers" must be a non-empty array');
    return providers;
  }
  raw.forEach((entry: unknown, index) => {
    const where = `config: providers[${index}]`;
    if (!isObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { name, base_url: baseUrlRaw, api_key: apiKey, models } = entry;
    if (!isNonEmptyString(name)) {
      problems.push(`${where}.name must be a non-empty string`);
      return;
    }
    if (providers.has(name)) {
      problems.push(`${where}: duplicate provider name "${name}"`);
      return;
    }
    if (!isNonEmptyString(baseUrlRaw)) {
      problems.push(`${where} ("${name}").base_url must be a non-empty string`);
      return;
    }
    const baseUrl = resolveEnvRef(baseUrlRaw, 'base_url', `${where} ("${name}")`, env, problems);
    if (baseUrl === null) return;
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      problems.push(`${where} ("${name}").base_url must be an http(s) URL`);
      return;
    }
    if (!isNonEmptyString(apiKey)) {
      problems.push(`${where} ("${name}").api_key must be a non-empty string`);
      return;
    }
    const resolvedKey = resolveEnvRef(apiKey, 'api_key', `${where} ("${name}")`, env, problems);
    if (resolvedKey === null) return;
    let explicitModels: string[] | null = null;
    if (models !== undefined) {
      if (!Array.isArray(models) || !models.every(isNonEmptyString)) {
        problems.push(`${where} ("${name}").models must be an array of model names`);
        return;
      }
      explicitModels = [...models];
    }
    providers.set(name, {
      name,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: new Secret(resolvedKey),
      explicitModels,
    });
  });
  return providers;
}

/**
 * Which provider serves a model: an explicit `models` list wins; otherwise the provider whose
 * name is the model's `<provider>-` prefix (`alpha-small` → `alpha`).
 */
function resolveModelProviders(
  prices: Map<string, ModelInfoPrice>,
  providers: Map<string, ProviderConfig>,
  problems: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  const explicitOwner = new Map<string, string>();
  for (const provider of providers.values()) {
    for (const model of provider.explicitModels ?? []) {
      const existing = explicitOwner.get(model);
      if (existing !== undefined && existing !== provider.name) {
        problems.push(
          `model "${model}" is listed by two providers ("${existing}", "${provider.name}")`,
        );
      } else {
        explicitOwner.set(model, provider.name);
      }
    }
  }
  for (const model of prices.keys()) {
    const owner = explicitOwner.get(model);
    if (owner !== undefined) {
      result.set(model, owner);
      continue;
    }
    const candidates = [...providers.values()].filter(
      (p) => p.explicitModels === null && model.startsWith(`${p.name}-`),
    );
    if (candidates.length === 1) {
      result.set(model, candidates[0]!.name);
    } else if (candidates.length > 1) {
      problems.push(
        `model "${model}" matches several providers by name prefix (${candidates
          .map((c) => c.name)
          .join(', ')}); list models explicitly`,
      );
    }
    // No provider serves it: fine unless an alias uses it (checked below).
  }
  return result;
}

function parseAliases(
  raw: unknown,
  models: ReadonlyMap<string, ModelInfo>,
  problems: string[],
): { aliases: Map<string, TierAlias>; auto: GatewayConfig['auto'] } {
  const aliases = new Map<string, TierAlias>();
  let auto: GatewayConfig['auto'] = null;
  if (!isObject(raw)) {
    problems.push('config: "model_aliases" must be an object');
    return { aliases, auto };
  }

  for (const [alias, entry] of Object.entries(raw)) {
    if (alias.startsWith('_')) continue;
    const where = `config: model_aliases.${alias}`;
    if (!isObject(entry)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    if (alias === 'auto') continue; // handled after the tier aliases are known
    const { primary, fallbacks } = entry;
    if (!isNonEmptyString(primary)) {
      problems.push(`${where}.primary must be a non-empty string`);
      continue;
    }
    if (!Array.isArray(fallbacks) || !fallbacks.every(isNonEmptyString)) {
      problems.push(`${where}.fallbacks must be an array of model names`);
      continue;
    }
    const chain = [primary, ...fallbacks];
    if (new Set(chain).size !== chain.length) {
      problems.push(`${where}: a model appears more than once in its chain (${chain.join(', ')})`);
      continue;
    }
    const missing = chain.filter((model) => !models.has(model));
    if (missing.length > 0) {
      problems.push(
        `${where}: ${missing.map((m) => `"${m}"`).join(', ')} must be priced in model_pricing.json ` +
          'and served by a registered provider',
      );
      continue;
    }
    aliases.set(alias, { name: alias, primary, fallbacks: [...fallbacks], chain });
  }

  for (const required of REQUIRED_ALIASES) {
    if (
      !aliases.has(required) &&
      !problems.some((p) => p.startsWith(`config: model_aliases.${required}`))
    ) {
      problems.push(`config: model_aliases must define the "${required}" alias`);
    }
  }

  const autoEntry = raw.auto;
  if (autoEntry !== undefined) {
    const where = 'config: model_aliases.auto';
    const route = isObject(autoEntry) ? autoEntry.route_by_difficulty : undefined;
    if (!isObject(route) || !isNonEmptyString(route.simple) || !isNonEmptyString(route.complex)) {
      problems.push(`${where}.route_by_difficulty must define "simple" and "complex" aliases`);
    } else {
      const bad = [route.simple, route.complex].filter((tier) => !aliases.has(tier));
      if (bad.length > 0) {
        problems.push(
          `${where}.route_by_difficulty refers to unknown alias(es): ${bad.join(', ')}`,
        );
      } else {
        auto = { simple: route.simple, complex: route.complex };
      }
    }
  }
  return { aliases, auto };
}

function positiveNumber(value: unknown, integer: boolean): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    (!integer || Number.isInteger(value))
  );
}

function parseRetry(raw: unknown, problems: string[]): RetryPolicy {
  const fallback: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 200, backoffMultiplier: 2 };
  if (raw === undefined) return fallback;
  if (!isObject(raw)) {
    problems.push('config: "retry" must be an object');
    return fallback;
  }
  const {
    max_attempts: attempts,
    initial_backoff_ms: backoff,
    backoff_multiplier: multiplier,
  } = raw;
  let ok = true;
  if (!positiveNumber(attempts, true)) {
    problems.push('config: retry.max_attempts must be a positive integer');
    ok = false;
  }
  if (!positiveNumber(backoff, false)) {
    problems.push('config: retry.initial_backoff_ms must be a positive number');
    ok = false;
  }
  if (!positiveNumber(multiplier, false) || (multiplier as number) < 1) {
    problems.push('config: retry.backoff_multiplier must be a number >= 1');
    ok = false;
  }
  return ok
    ? {
        maxAttempts: attempts as number,
        initialBackoffMs: backoff as number,
        backoffMultiplier: multiplier as number,
      }
    : fallback;
}

function parseDegradation(raw: unknown, problems: string[]): DegradationPolicy {
  const fallback: DegradationPolicy = {
    errorRateThreshold: 0.5,
    windowSeconds: 60,
    p95LatencyMs: 5000,
  };
  if (raw === undefined) return fallback;
  if (!isObject(raw)) {
    problems.push('config: "degradation" must be an object');
    return fallback;
  }
  const { error_rate_threshold: rate, window_seconds: windowSeconds, p95_latency_ms: p95 } = raw;
  let ok = true;
  if (typeof rate !== 'number' || !(rate > 0 && rate <= 1)) {
    problems.push('config: degradation.error_rate_threshold must be a number in (0, 1]');
    ok = false;
  }
  if (!positiveNumber(windowSeconds, true)) {
    problems.push('config: degradation.window_seconds must be a positive integer');
    ok = false;
  }
  if (!positiveNumber(p95, false)) {
    problems.push('config: degradation.p95_latency_ms must be a positive number');
    ok = false;
  }
  return ok
    ? {
        errorRateThreshold: rate as number,
        windowSeconds: windowSeconds as number,
        p95LatencyMs: p95 as number,
      }
    : fallback;
}

/** Pure parse + validate step: takes already-parsed JSON so it is trivial to unit test. */
export function parseGatewayConfig(
  pricingJson: unknown,
  configJson: unknown,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const problems: string[] = [];

  const prices = parsePricing(pricingJson, problems);

  let providers = new Map<string, ProviderConfig>();
  let aliasesRaw: unknown;
  let retryRaw: unknown;
  let degradationRaw: unknown;
  if (!isObject(configJson)) {
    problems.push('gateway config must be a JSON object');
  } else {
    providers = parseProviders(configJson.providers, problems, env);
    aliasesRaw = configJson.model_aliases;
    retryRaw = configJson.retry;
    degradationRaw = configJson.degradation;
  }

  const modelProvider = resolveModelProviders(prices, providers, problems);
  const models = new Map<string, ModelInfo>();
  for (const [name, price] of prices) {
    const provider = modelProvider.get(name);
    if (provider !== undefined) models.set(name, { name, provider, ...price });
  }

  const { aliases, auto } = parseAliases(aliasesRaw, models, problems);
  const retry = parseRetry(retryRaw, problems);
  const degradation = parseDegradation(degradationRaw, problems);

  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid gateway configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }

  return Object.freeze({
    providers,
    models,
    aliases,
    auto,
    retry: Object.freeze(retry),
    degradation: Object.freeze(degradation),
  });
}

/** Reads `model_pricing.json` and the gateway config file from `dataDir`, then validates them. */
export function loadGatewayConfig(
  dataDir: string,
  gatewayConfigFile = 'gateway_config.sample.json',
): GatewayConfig {
  const pricing = readJsonFile(join(dataDir, 'model_pricing.json'), 'model_pricing.json');
  const config = readJsonFile(join(dataDir, gatewayConfigFile), gatewayConfigFile);
  return parseGatewayConfig(pricing, config);
}

/** Every name a caller (and therefore an allowlist) may use: tier aliases, `auto`, model names. */
export function knownModelNames(config: GatewayConfig): Set<string> {
  const names = new Set<string>([...config.aliases.keys(), ...config.models.keys()]);
  if (config.auto !== null) names.add('auto');
  return names;
}

/** A log-safe summary of the loaded config. Contains no credentials. */
export function describeConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    providers: [...config.providers.values()].map((p) => ({ name: p.name, baseUrl: p.baseUrl })),
    models: [...config.models.values()].map((m) => ({
      name: m.name,
      provider: m.provider,
      inputPer1m: m.inputPer1m,
      outputPer1m: m.outputPer1m,
    })),
    aliases: Object.fromEntries([...config.aliases.values()].map((a) => [a.name, a.chain])),
    auto: config.auto,
    retry: config.retry,
    degradation: config.degradation,
  };
}
