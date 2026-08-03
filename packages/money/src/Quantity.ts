// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.1-6.4, §6.2's QUANTITY
// archetype (packages/db/schema/_shared.ts `QUANTITY = { precision: 15, scale: 4 }`, used by
// every stock/pack/line quantity column in the schema). A stock/sale quantity. Same design
// rules as Money: no valueOf()/toNumber(), never coerced to a JS number, arithmetic only
// through named methods.
//
// Scale is 4, matching the DB archetype exactly -- this used to be hardcoded to 3, which
// silently truncated any 4th-decimal digit on every quantity round-tripped through this class
// (a real bug: apps/api/src/common/validation/money-schemas.ts's `zQuantity` claims "field-
// specific scale ... enforced by the value-object parser", but the parser was capped one
// digit short of what the columns it feeds actually store).
import { Decimal } from "./config.js";
import { parseDecimalInput } from "./internal/parse.js";
import { ok, type ParseError, type Result, type RoundingMode } from "./types.js";

const DEFAULT_SCALE = 4;

export class Quantity {
  static readonly SCALE = DEFAULT_SCALE;
  readonly #value: Decimal;

  private constructor(value: Decimal) {
    this.#value = value;
  }

  static fromDb(raw: string): Quantity {
    return new Quantity(new Decimal(raw));
  }

  static fromInput(raw: string): Result<Quantity, ParseError> {
    const parsed = parseDecimalInput(raw, { allowNegative: false, maxScale: DEFAULT_SCALE });
    if (!parsed.ok) return parsed;
    return ok(new Quantity(parsed.value));
  }

  static zero(): Quantity {
    return new Quantity(new Decimal(0));
  }

  static of(n: number): Quantity {
    // Test/seed convenience only -- never call from application code with a runtime-derived
    // number. Application code must go through fromDb/fromInput.
    return new Quantity(new Decimal(n));
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.#value.plus(other.#value));
  }

  sub(other: Quantity): Quantity {
    return new Quantity(this.#value.minus(other.#value));
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  isNegative(): boolean {
    return this.#value.isNegative();
  }

  compare(other: Quantity): -1 | 0 | 1 {
    return this.#value.comparedTo(other.#value) as -1 | 0 | 1;
  }

  round(scale: number, _mode: RoundingMode = "HALF_UP"): Quantity {
    return new Quantity(this.#value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP));
  }

  /** For Money.mulQty -- the raw decimal, never exposed outside this package. */
  toDecimal(): Decimal {
    return this.#value;
  }

  toDb(): string {
    return this.#value.toFixed(DEFAULT_SCALE);
  }

  toJSON(): string {
    return this.toDb();
  }

  format(locale: string): string {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: DEFAULT_SCALE,
    }).format(Number(this.#value.toFixed(DEFAULT_SCALE)));
    // Number() here is presentation-only formatting of an already-rounded string, not arithmetic.
  }

  // Deliberately absent: valueOf(), toNumber(), Symbol.toPrimitive -- see Money.ts for why.
}
