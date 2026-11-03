/**
 * Money handling — decided once, used everywhere (architecture §4.9, edge cases 5.13/5.14).
 *
 * Rules:
 *  - Money is never held in a floating-point number once it is inside the gateway.
 *  - An amount of USD is a `bigint` count of "units", where 1 unit = 0.00000001 USD (1e-8).
 *  - Prices are USD per 1M tokens. A price is converted to an integer number of picoUSD
 *    (1e-12 USD) per token: `price_per_1m * 1e6`. This is exact for prices with up to
 *    6 decimals, which covers every price in the starter pack and real provider price pages.
 *  - A request's cost is `tokens * picoPerToken`, summed, then rounded half-up to whole units.
 *    For prices with at most 2 decimals (the starter pack) the result is already exact, so the
 *    sum of the `x-prism-cost-usd` headers equals the usage API total with no rounding gap.
 */

export const USD_DECIMALS = 8;
const UNITS_PER_USD = 10n ** BigInt(USD_DECIMALS);
const PICO_PER_UNIT = 10_000n; // 1e-8 USD / 1e-12 USD
const PRICE_DECIMALS = 6;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** Converts a non-negative decimal string to a scaled bigint with exactly `decimals` places. */
function decimalStringToScaled(text: string, decimals: number, what: string): bigint {
  if (!DECIMAL_PATTERN.test(text)) {
    throw new MoneyError(`${what} must be a non-negative decimal number (got "${text}")`);
  }
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > decimals) {
    const extra = fraction.slice(decimals);
    if (/[^0]/.test(extra)) {
      throw new MoneyError(`${what} has more than ${decimals} decimal places (got "${text}")`);
    }
  }
  const padded = fraction.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded);
}

/** A JSON number (or numeric string) → scaled bigint, rejecting values that need more precision. */
function toScaled(value: number | string, decimals: number, what: string): bigint {
  if (typeof value === 'string') {
    return decimalStringToScaled(value.trim(), decimals, what);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new MoneyError(`${what} must be a finite, non-negative number (got ${value})`);
  }
  const scale = 10 ** decimals;
  const scaled = Math.round(value * scale);
  // `value * scale` carries float noise (e.g. 0.15 * 1e6 = 150000.00000000003); anything
  // larger than that noise means the number really has more decimals than we can represent.
  if (Math.abs(value * scale - scaled) > 1e-3) {
    throw new MoneyError(`${what} has more than ${decimals} decimal places (got ${value})`);
  }
  if (!Number.isSafeInteger(scaled)) {
    throw new MoneyError(`${what} is too large (got ${value})`);
  }
  return BigInt(scaled);
}

/** Parses a USD amount (number or decimal string) into units of 1e-8 USD. */
export function parseUsd(value: number | string, what = 'amount'): bigint {
  return toScaled(value, USD_DECIMALS, what);
}

/** A price in USD per 1M tokens → picoUSD per token (exact for up to 6 decimals). */
export function parsePricePer1m(value: number | string, what = 'price'): bigint {
  return toScaled(value, PRICE_DECIMALS, what);
}

/** Units → decimal string with trailing zeros trimmed; `0` for zero. Used for the cost header. */
export function formatUsd(units: bigint): string {
  if (units < 0n) {
    throw new MoneyError('cannot format a negative amount');
  }
  const whole = units / UNITS_PER_USD;
  const fraction = (units % UNITS_PER_USD).toString().padStart(USD_DECIMALS, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole.toString() : `${whole}.${trimmed}`;
}

/** Units → fixed 8-decimal string, the exact form Postgres NUMERIC(20,8) parameters take. */
export function toSqlNumeric(units: bigint): string {
  const whole = units / UNITS_PER_USD;
  const fraction = (units % UNITS_PER_USD).toString().padStart(USD_DECIMALS, '0');
  return `${whole}.${fraction}`;
}

/** Postgres NUMERIC text (any number of decimals, as a string) → units. */
export function fromSqlNumeric(text: string): bigint {
  return decimalStringToScaled(text, USD_DECIMALS, 'database amount');
}

export interface TokenPrice {
  /** picoUSD per input (prompt) token. */
  inputPicoPerToken: bigint;
  /** picoUSD per output (completion) token. */
  outputPicoPerToken: bigint;
}

/** Cost of one request in units of 1e-8 USD, rounded half-up. Uses provider-reported tokens. */
export function computeCostUnits(
  promptTokens: number,
  completionTokens: number,
  price: TokenPrice,
): bigint {
  for (const [label, tokens] of [
    ['promptTokens', promptTokens],
    ['completionTokens', completionTokens],
  ] as const) {
    if (!Number.isInteger(tokens) || tokens < 0) {
      throw new MoneyError(`${label} must be a non-negative integer (got ${tokens})`);
    }
  }
  const pico =
    BigInt(promptTokens) * price.inputPicoPerToken +
    BigInt(completionTokens) * price.outputPicoPerToken;
  return (pico + PICO_PER_UNIT / 2n) / PICO_PER_UNIT;
}
