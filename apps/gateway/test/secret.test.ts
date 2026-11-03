import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/secret.js';

describe('Secret', () => {
  const secret = new Secret('prism-sk-top-secret');

  it('reveals the value only through reveal()', () => {
    expect(secret.reveal()).toBe('prism-sk-top-secret');
  });

  it('is redacted by every common way of printing', () => {
    const outputs = [
      String(secret),
      `${secret}`,
      JSON.stringify(secret),
      JSON.stringify({ nested: { key: secret } }),
      inspect(secret),
      inspect({ key: secret }, { depth: 5 }),
    ];
    for (const out of outputs) {
      expect(out).not.toContain('top-secret');
      expect(out).toContain('[redacted]');
    }
  });
});
