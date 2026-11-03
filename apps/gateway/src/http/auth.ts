import { createHash, timingSafeEqual } from 'node:crypto';
import type { VirtualKey } from '../db/keys.js';
import { invalidAdminToken, invalidApiKey, serviceUnavailable } from './errors.js';

/** Looks up a tenant by the raw key (hashed inside). Resolves `null` when the key is unknown. */
export interface KeyStore {
  findByRawKey(rawKey: string): Promise<VirtualKey | null>;
}

/** Longest bearer token we will even hash; real keys are far shorter (edge case 2.4). */
const MAX_KEY_LENGTH = 256;

/**
 * Extracts the token from `Authorization: Bearer <token>`. Returns `null` for anything else:
 * a missing header, another scheme, an empty token, extra whitespace or a token with spaces.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  const token = match?.[1];
  if (token === undefined || token.length > MAX_KEY_LENGTH) return null;
  return token;
}

export interface AuthContext {
  keyId: number;
  team: string;
  allowedModels: readonly string[];
  rpmLimit: number;
  tpmLimit: number | null;
  /** Monthly budget in units of 1e-8 USD. */
  monthlyBudgetUnits: bigint;
  cache: { enabled: boolean; threshold: number | null };
}

export interface AuthResult {
  auth: AuthContext;
}

/**
 * Authenticates a data-plane request. Throws a 401 `PrismError` for a missing, malformed, unknown
 * or disabled key (all indistinguishable to the caller, edge cases 2.1–2.5) and a 503 when the
 * key store cannot be reached. `onKnownKey` fires as soon as the tenant is known, so the log row
 * for a disabled key still carries its id (an unknown key is logged with a null key).
 */
export async function authenticate(
  keys: KeyStore,
  authorizationHeader: string | undefined,
  onKnownKey: (keyId: number) => void,
): Promise<AuthContext> {
  const token = extractBearerToken(authorizationHeader);
  if (token === null) throw invalidApiKey();

  let key: VirtualKey | null;
  try {
    key = await keys.findByRawKey(token);
  } catch {
    throw serviceUnavailable('The service is temporarily unavailable. Please retry shortly.');
  }
  if (key === null) throw invalidApiKey();

  onKnownKey(key.id);
  if (key.status !== 'active') throw invalidApiKey();

  return {
    keyId: key.id,
    team: key.team,
    allowedModels: key.allowedModels,
    rpmLimit: key.rpmLimit,
    tpmLimit: key.tpmLimit,
    monthlyBudgetUnits: key.monthlyBudgetUnits,
    cache: { enabled: key.cacheEnabled, threshold: key.cacheThreshold },
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of the admin token (edge cases 2.9, 2.10). */
export function verifyAdminToken(expected: string, header: string | string[] | undefined): void {
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== 'string' || provided === '') throw invalidAdminToken();
  // Hash first so both buffers have equal length and the comparison does not leak the length.
  if (!timingSafeEqual(sha256(provided), sha256(expected))) throw invalidAdminToken();
}
