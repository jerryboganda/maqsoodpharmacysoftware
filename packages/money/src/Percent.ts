// A percentage (e.g. a discount % or tax %), stored as its literal percent value (7.5 means 7.5%,
// not 0.075) so it round-trips exactly with how the legacy schema and the counter staff think about it.
import { Decimal } from "./config.js";
import { parseDecimalInput } from "./internal/parse.js";
import { err, ok, type ParseError, type Result } from "./types.js";

const MAX_SCALE = 4;

export class Percent {
  readonly #value: Decimal;

  private constructor(value: Decimal) {
    this.#value = value;
  }

  static fromDb(raw: string): Percent {
    return new Percent(new Decimal(raw));
  }

  static fromInput(raw: string): Result<Percent, ParseError> {
    const parsed = parseDecimalInput(raw, { allowNegative: false, maxScale: MAX_SCALE });
    if (!parsed.ok) return parsed;
    if (parsed.value.greaterThan(100)) {
      return err({ kind: "not_a_number", input: raw });
    }
    return ok(new Percent(parsed.value));
  }

  static zero(): Percent {
    return new Percent(new Decimal(0));
  }

  static of(n: number): Percent {
    // Test/seed convenience only.
    return new Percent(new Decimal(n));
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  /** The fraction (7.5% -> 0.075) used internally by Money.applyPercent. */
  toFraction(): Decimal {
    return this.#value.dividedBy(100);
  }

  toDb(): string {
    return this.#value.toFixed(MAX_SCALE);
  }

  toJSON(): string {
    return this.toDb();
  }

  format(locale: string): string {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: MAX_SCALE }).format(Number(this.#value))}%`;
  }

  // Deliberately absent: valueOf(), toNumber(), Symbol.toPrimitive -- see Money.ts for why.
}
