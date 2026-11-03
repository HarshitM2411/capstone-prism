/**
 * Parses and validates `seed_keys.json` into tenant definitions.
 *
 * Validation is strict and reports every problem at once (edge cases 2.7, 2.8): a typo in an
 * allowlist or a negative limit would otherwise become a silent policy bug. Exact key values,
 * team names and allowlist names are preserved because the demo flow and starter scripts
 * reference them.
 */
import { ConfigError } from '../config/env.js';
import { parseUsd } from '../money.js';
import { Secret } from '../secret.js';

export interface SeedTenant {
  team: string;
  /** The raw virtual key. Wrapped so it cannot be logged by accident. */
  virtualKey: Secret;
  /** Monthly budget in units of 1e-8 USD. */
  monthlyBudgetUnits: bigint;
  rpmLimit: number;
  /** Tokens-per-minute limit; `null` when the seed does not define one (optional feature). */
  tpmLimit: number | null;
  allowedModels: string[];
  cacheEnabled: boolean;
  /** Similarity threshold in (0, 1]; `null` when the cache is disabled for the key. */
  cacheThreshold: number | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export interface SeedValidationOptions {
  /** Aliases and model names an allowlist may reference. */
  knownModelNames: ReadonlySet<string>;
}

export function parseSeedFile(raw: unknown, options: SeedValidationOptions): SeedTenant[] {
  const problems: string[] = [];
  const tenants: SeedTenant[] = [];

  if (!isObject(raw) || !Array.isArray(raw.tenants) || raw.tenants.length === 0) {
    throw new ConfigError('seed_keys.json must contain a non-empty "tenants" array');
  }

  const teams = new Set<string>();
  const keys = new Set<string>();

  raw.tenants.forEach((entry: unknown, index) => {
    const label =
      isObject(entry) && typeof entry.team === 'string' ? `"${entry.team}"` : `#${index}`;
    const where = `seed_keys.json tenant ${label}`;
    if (!isObject(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const before = problems.length;

    const team = entry.team;
    if (typeof team !== 'string' || team.trim() === '') {
      problems.push(`${where}: team must be a non-empty string`);
    } else if (teams.has(team)) {
      problems.push(`${where}: duplicate team`);
    } else {
      teams.add(team);
    }

    const key = entry.virtual_key;
    if (typeof key !== 'string' || key.trim() === '' || /\s/.test(key) || key.length > 256) {
      problems.push(
        `${where}: virtual_key must be a non-empty string without whitespace (max 256)`,
      );
    } else if (keys.has(key)) {
      problems.push(`${where}: virtual_key is used by more than one tenant`);
    } else {
      keys.add(key);
    }

    let budget = 0n;
    try {
      budget = parseUsd(entry.monthly_budget_usd as number, 'monthly_budget_usd');
    } catch (err) {
      problems.push(`${where}: ${(err as Error).message}`);
    }

    const rateLimit = entry.rate_limit;
    let rpm = 0;
    let tpm: number | null = null;
    if (!isObject(rateLimit) || !isNonNegativeInteger(rateLimit.requests_per_minute)) {
      problems.push(`${where}: rate_limit.requests_per_minute must be a non-negative integer`);
    } else {
      rpm = rateLimit.requests_per_minute;
      if (rateLimit.tokens_per_minute !== undefined) {
        if (isNonNegativeInteger(rateLimit.tokens_per_minute)) {
          tpm = rateLimit.tokens_per_minute;
        } else {
          problems.push(`${where}: rate_limit.tokens_per_minute must be a non-negative integer`);
        }
      }
    }

    const allowlist = entry.model_allowlist;
    let allowedModels: string[] = [];
    if (!Array.isArray(allowlist) || !allowlist.every((m) => typeof m === 'string' && m !== '')) {
      problems.push(`${where}: model_allowlist must be an array of names`);
    } else {
      allowedModels = [...new Set(allowlist as string[])];
      const unknown = allowedModels.filter((name) => !options.knownModelNames.has(name));
      if (unknown.length > 0) {
        problems.push(
          `${where}: model_allowlist has unknown name(s): ${unknown.join(', ')} ` +
            `(known: ${[...options.knownModelNames].sort().join(', ')})`,
        );
      }
    }

    const cache = entry.semantic_cache;
    let cacheEnabled = false;
    let cacheThreshold: number | null = null;
    if (!isObject(cache) || typeof cache.enabled !== 'boolean') {
      problems.push(`${where}: semantic_cache.enabled must be true or false`);
    } else {
      cacheEnabled = cache.enabled;
      if (cacheEnabled) {
        const threshold = cache.similarity_threshold;
        if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) {
          problems.push(
            `${where}: semantic_cache.similarity_threshold must be a number in (0, 1] when the cache is enabled`,
          );
        } else {
          cacheThreshold = threshold;
        }
      }
    }

    if (problems.length === before) {
      tenants.push({
        team: team as string,
        virtualKey: new Secret(key as string),
        monthlyBudgetUnits: budget,
        rpmLimit: rpm,
        tpmLimit: tpm,
        allowedModels,
        cacheEnabled,
        cacheThreshold,
      });
    }
  });

  if (problems.length > 0) {
    throw new ConfigError(
      `Invalid seed data (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
  return tenants;
}
