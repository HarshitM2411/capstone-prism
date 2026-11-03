import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  computeCostUnits,
  formatUsd,
  fromSqlNumeric,
  parsePricePer1m,
  parseUsd,
  toSqlNumeric,
} from '../src/money.js';

describe('parseUsd', () => {
  it.each([
    [50, 5_000_000_000n],
    [0.5, 50_000_000n],
    [0, 0n],
    [0.00001, 1000n], // the budget-demo budget
    [0.00000001, 1n], // smallest representable amount
    [1234.56789012, 123_456_789_012n],
    ['0.00001', 1000n],
    ['5', 500_000_000n],
    ['0.100000000', 10_000_000n], // trailing zeros beyond 8 places are harmless
  ])('parses %s exactly', (input, expected) => {
    expect(parseUsd(input)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.000000001, 1e300])('rejects %s', (input) => {
    expect(() => parseUsd(input)).toThrow(MoneyError);
  });

  it.each(['abc', '', '-5', '1e5', '1,5', '0.123456789', '.5'])('rejects the string "%s"', (s) => {
    expect(() => parseUsd(s)).toThrow(MoneyError);
  });

  it('names the field in the error message', () => {
    expect(() => parseUsd(-1, 'monthly_budget_usd')).toThrow(/monthly_budget_usd/);
  });
});

describe('parsePricePer1m', () => {
  it('converts a USD-per-1M price to picoUSD per token', () => {
    expect(parsePricePer1m(0.15)).toBe(150_000n);
    expect(parsePricePer1m(0.6)).toBe(600_000n);
    expect(parsePricePer1m(15)).toBe(15_000_000n);
  });

  it('rejects prices needing more than 6 decimals', () => {
    expect(() => parsePricePer1m(0.0000001)).toThrow(MoneyError);
  });
});

describe('formatUsd', () => {
  it.each([
    [0n, '0'],
    [1n, '0.00000001'],
    [1100n, '0.000011'],
    [1000n, '0.00001'],
    [100_000_000n, '1'],
    [150_000_000n, '1.5'],
    [5_000_000_000n, '50'],
    [123_456_789_012n, '1234.56789012'],
  ])('formats %s as %s', (units, text) => {
    expect(formatUsd(units)).toBe(text);
  });

  it('rejects negative amounts', () => {
    expect(() => formatUsd(-1n)).toThrow(MoneyError);
  });

  it('round-trips through parseUsd', () => {
    for (const units of [0n, 1n, 999n, 1000n, 100_000_001n, 5_000_000_000n]) {
      expect(parseUsd(formatUsd(units))).toBe(units);
    }
  });
});

describe('SQL NUMERIC conversion', () => {
  it('writes exactly 8 decimals', () => {
    expect(toSqlNumeric(1000n)).toBe('0.00001000');
    expect(toSqlNumeric(0n)).toBe('0.00000000');
    expect(toSqlNumeric(5_000_000_000n)).toBe('50.00000000');
  });

  it('reads Postgres text back to the same units', () => {
    for (const units of [0n, 1n, 1000n, 123_456_789_012n]) {
      expect(fromSqlNumeric(toSqlNumeric(units))).toBe(units);
    }
    expect(fromSqlNumeric('0.00001')).toBe(1000n);
  });
});

describe('computeCostUnits', () => {
  const alphaSmall = {
    inputPicoPerToken: parsePricePer1m(0.15),
    outputPicoPerToken: parsePricePer1m(0.6),
  };
  const alphaLarge = {
    inputPicoPerToken: parsePricePer1m(3),
    outputPicoPerToken: parsePricePer1m(15),
  };

  it('prices a typical alpha-small request', () => {
    // 5 * 0.15e-6 + 17 * 0.60e-6 = 0.00001095 USD
    expect(computeCostUnits(5, 17, alphaSmall)).toBe(1095n);
    expect(formatUsd(1095n)).toBe('0.00001095');
  });

  it('prices alpha-large at the documented rate', () => {
    // 1M prompt + 1M completion tokens = 3 + 15 USD
    expect(computeCostUnits(1_000_000, 1_000_000, alphaLarge)).toBe(1_800_000_000n);
  });

  it('costs zero tokens as zero', () => {
    expect(computeCostUnits(0, 0, alphaSmall)).toBe(0n);
  });

  it('shows the budget-demo budget is below one request cost at mock prices', () => {
    // Budget is 1000 units; even a tiny alpha-small request exceeds it.
    expect(computeCostUnits(5, 17, alphaSmall)).toBeGreaterThan(1000n);
  });

  it('rounds half-up to whole units', () => {
    // 1 pico/token * 5000 tokens = 5000 pico = exactly half a unit -> rounds up
    expect(computeCostUnits(5000, 0, { inputPicoPerToken: 1n, outputPicoPerToken: 0n })).toBe(1n);
    // 4999 pico is below half a unit -> rounds down
    expect(computeCostUnits(4999, 0, { inputPicoPerToken: 1n, outputPicoPerToken: 0n })).toBe(0n);
  });

  it.each([
    [-1, 0],
    [0, -1],
    [1.5, 0],
    [Number.NaN, 0],
  ])('rejects invalid token counts (%s, %s)', (p, c) => {
    expect(() => computeCostUnits(p, c, alphaSmall)).toThrow(MoneyError);
  });

  it('has no drift: summed per-request costs equal the cost of the summed tokens', () => {
    // Starter prices have at most 2 decimals, so each request cost is exact and the sum of
    // `x-prism-cost-usd` headers must equal the usage API total (eval E7).
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    let sumUnits = 0n;
    let promptTotal = 0n;
    let completionTotal = 0n;
    for (let i = 0; i < 2000; i += 1) {
      const prompt = next() % 4000;
      const completion = next() % 2000;
      sumUnits += computeCostUnits(prompt, completion, alphaSmall);
      promptTotal += BigInt(prompt);
      completionTotal += BigInt(completion);
    }
    const exactPico =
      promptTotal * alphaSmall.inputPicoPerToken + completionTotal * alphaSmall.outputPicoPerToken;
    expect(exactPico % 10_000n).toBe(0n);
    expect(sumUnits).toBe(exactPico / 10_000n);
  });
});
