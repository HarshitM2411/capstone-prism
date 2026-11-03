const REDACTED = '[redacted]';

/**
 * Wraps a secret (provider API key, raw virtual key) so it cannot leak by accident:
 * logging, string interpolation, JSON serialization and `util.inspect` all print `[redacted]`.
 * The only way to read the value is the explicit `reveal()` call.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
