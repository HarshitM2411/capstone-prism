import { describe, expect, it } from 'vitest';
import { PrismError } from '../src/http/errors.js';
import { authenticate, extractBearerToken, verifyAdminToken } from '../src/http/auth.js';
import { KEYS, memoryKeys } from './helpers/app.js';

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer prism-sk-abc')).toBe('prism-sk-abc');
  });

  it('accepts the scheme case-insensitively', () => {
    expect(extractBearerToken('bearer prism-sk-abc')).toBe('prism-sk-abc');
    expect(extractBearerToken('BEARER prism-sk-abc')).toBe('prism-sk-abc');
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    'Bearer  two-spaces',
    ' Bearer leading-space',
    'Bearer trailing-space ',
    'Bearer two tokens',
    'Basic dXNlcjpwYXNz',
    'prism-sk-no-scheme',
    'Token abc',
    'Bearer\tabc',
    'Bearer abc\r\nX-Injected: 1',
  ])('rejects %j (edge case 2.2)', (header) => {
    expect(extractBearerToken(header)).toBeNull();
  });

  it('rejects an absurdly long token without hashing it (edge case 2.4)', () => {
    expect(extractBearerToken(`Bearer ${'a'.repeat(257)}`)).toBeNull();
    expect(extractBearerToken(`Bearer ${'a'.repeat(256)}`)).not.toBeNull();
  });
});

describe('authenticate', () => {
  async function failure(header: string | undefined, keys = memoryKeys()): Promise<PrismError> {
    try {
      await authenticate(keys, header, () => undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(PrismError);
      return err as PrismError;
    }
    throw new Error('expected authentication to fail');
  }

  it('returns the tenant policy for an active key', async () => {
    const auth = await authenticate(memoryKeys(), `Bearer ${KEYS.research}`, () => undefined);
    expect(auth).toEqual({
      keyId: 2,
      team: 'research',
      allowedModels: ['fast', 'smart', 'auto'],
      rpmLimit: 60,
      tpmLimit: 100000,
      monthlyBudgetUnits: 5_000_000_000n,
      cache: { enabled: true, threshold: 0.92 },
    });
  });

  it('answers 401 invalid_api_key for missing, unknown and disabled keys alike', async () => {
    const results = await Promise.all([
      failure(undefined),
      failure('Bearer not-a-key'),
      failure(`Bearer ${KEYS.disabled}`),
    ]);
    for (const err of results) {
      expect(err.httpStatus).toBe(401);
      expect(err.type).toBe('authentication_error');
      expect(err.code).toBe('invalid_api_key');
      expect(err.logStatus).toBe('rejected_auth');
    }
    // No oracle: the message is identical whether the key exists, is disabled, or is missing.
    expect(new Set(results.map((e) => e.message)).size).toBe(1);
  });

  it('does not query the key store for a malformed header', async () => {
    const keys = memoryKeys();
    await failure('Basic abc', keys);
    await failure(undefined, keys);
    expect(keys.lookups).toEqual([]);
  });

  it('reports the key id of a disabled key (so its log row is attributable)', async () => {
    const seen: number[] = [];
    await expect(
      authenticate(memoryKeys(), `Bearer ${KEYS.disabled}`, (id) => seen.push(id)),
    ).rejects.toBeInstanceOf(PrismError);
    expect(seen).toEqual([9]);
  });

  it('does not report an id for an unknown key', async () => {
    const seen: number[] = [];
    await expect(
      authenticate(memoryKeys(), 'Bearer unknown', (id) => seen.push(id)),
    ).rejects.toBeInstanceOf(PrismError);
    expect(seen).toEqual([]);
  });

  it('turns a key store failure into 503, not a crash or a 401', async () => {
    const broken = {
      async findByRawKey(): Promise<never> {
        throw new Error('connect ECONNREFUSED 10.1.2.3:5432');
      },
    };
    const err = await failure(`Bearer ${KEYS.search}`, broken as never);
    expect(err.httpStatus).toBe(503);
    expect(err.logStatus).toBe('rejected_unavailable');
    expect(err.message).not.toContain('ECONNREFUSED');
  });
});

describe('verifyAdminToken', () => {
  const token = 'correct-admin-token';

  it('accepts the exact token', () => {
    expect(() => verifyAdminToken(token, token)).not.toThrow();
  });

  it.each([
    undefined,
    '',
    'wrong',
    'correct-admin-toke',
    'correct-admin-token ',
    'CORRECT-ADMIN-TOKEN',
  ])('rejects %j', (provided) => {
    expect(() => verifyAdminToken(token, provided)).toThrow(/admin token/);
  });

  it('rejects a repeated header unless its first value is right', () => {
    expect(() => verifyAdminToken(token, ['wrong', token])).toThrow();
    expect(() => verifyAdminToken(token, [token, 'wrong'])).not.toThrow();
  });
});
