// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.4-6.7 [BINDING].
//
// An exact monetary amount in PKR. Immutable. Cannot be coerced to a JS number by accident --
// that is the entire point of this class. `Number(money)`, `money + 0`, `money.toFixed()`,
// template-literal interpolation (`${money}`) must all be compile errors or, where JS makes
// that impossible, must simply not produce a usable numeric value. See docs/system-analysis/
// 17-technical-blueprint.md §6.7 "Banned constructs" for the lint rules that enforce this
// at the call site -- this class enforces it at the type/API level.
import { Decimal } from "./config.js";
import { parseDecimalInput } from "./internal/parse.js";
import type { Percent } from "./Percent.js";
import type { Quantity } from "./Quantity.js";
import { ok, type ParseError, type Result, type RoundingMode, type Scale } from "./types.js";

export class Money {
  /** Document/GL scale (§6.2). Costing uses scale 5 -- callers pass that explicitly to round(). */
  static readonly SCALE: Scale = 2;

  readonly #value: Decimal;

  private constructor(value: Decimal) {
    this.#value = value;
  }

  /** A `DECIMAL(15,2)` string exactly as returned by the mysql2 driver (§5.6: `decimalNumbers: false`). */
  static fromDb(raw: string): Money {
    return new Money(new Decimal(raw));
  }

  /** User/cashier input. Never throws -- returns a Result so the caller renders an inline
   *  validation message (§9.4) instead of crashing the transaction script. */
  static fromInput(raw: string): Result<Money, ParseError> {
    const parsed = parseDecimalInput(raw, { allowNegative: true, maxScale: Money.SCALE });
    if (!parsed.ok) return parsed;
    return ok(new Money(parsed.value));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  /** Test/seed convenience only -- application code must go through fromDb/fromInput, never
   *  construct a Money from a runtime-derived JS number. */
  static of(n: number): Money {
    return new Money(new Decimal(n));
  }

  add(other: Money): Money {
    return new Money(this.#value.plus(other.#value));
  }

  sub(other: Money): Money {
    return new Money(this.#value.minus(other.#value));
  }

  /** price * qty, with the result scale named explicitly at every call site (§6.2 archetypes). */
  mulQty(qty: Quantity, opts: { scale: Scale }): Money {
    return new Money(this.#value.times(qty.toDecimal()).toDecimalPlaces(opts.scale, Decimal.ROUND_HALF_UP));
  }

  applyPercent(pct: Percent, opts: { scale: Scale }): Money {
    return new Money(this.#value.times(pct.toFraction()).toDecimalPlaces(opts.scale, Decimal.ROUND_HALF_UP));
  }

  /**
   * Penny-exact proration by weight. `sum(result) === this` always -- the remainder is
   * distributed one unit at a time (largest-remainder method) to the weights with the
   * largest fractional share, so the parts never fail to reconcile against the header total.
   *
   * Required by §6.4: the FBR JSON contract sums only line-level discounts (11 §1.3), while
   * the legacy metric layer allocates an invoice flat discount across lines as
   * `flatdisc * line_value / invoice_gross` (10 §10.2) -- a naive per-line round loses or
   * gains paisa versus the header. This method is how that is prevented, structurally.
   */
  allocate(weights: readonly Decimal[]): Money[] {
    if (weights.length === 0) return [];
    const totalWeight = weights.reduce((a, w) => a.plus(w), new Decimal(0));
    if (totalWeight.isZero()) {
      // No basis to allocate on -- give everything to the first weight, nothing to the rest,
      // rather than dividing by zero. Callers with an all-zero weight vector are a caller bug;
      // this keeps allocate() total (never throws) rather than crashing a sale commit.
      return weights.map((_, i) => (i === 0 ? this : Money.zero()));
    }

    const scaleUnit = new Decimal(10).pow(-Money.SCALE);
    const totalUnits = this.#value.dividedBy(scaleUnit).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

    const raw = weights.map((w) => totalUnits.times(w).dividedBy(totalWeight));
    const floors = raw.map((r) => r.toDecimalPlaces(0, Decimal.ROUND_DOWN));
    const remainders = raw.map((r, i) => r.minus(floors[i] ?? new Decimal(0)));

    let distributed = floors.reduce((a, f) => a.plus(f), new Decimal(0));
    let remainingUnits = totalUnits.minus(distributed);

    const order = remainders
      .map((r, i) => ({ i, r }))
      .sort((a, b) => b.r.comparedTo(a.r));

    const unitsOut = [...floors];
    let cursor = 0;
    const step = remainingUnits.isNegative() ? new Decimal(-1) : new Decimal(1);
    while (!remainingUnits.isZero() && order.length > 0) {
      const target = order[cursor % order.length]!.i;
      unitsOut[target] = (unitsOut[target] ?? new Decimal(0)).plus(step);
      remainingUnits = remainingUnits.minus(step);
      cursor += 1;
    }

    return unitsOut.map((u) => new Money(u.times(scaleUnit)));
  }

  round(scale: Scale, _mode: RoundingMode = "HALF_UP"): Money {
    return new Money(this.#value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP));
  }

  isNegative(): boolean {
    return this.#value.isNegative();
  }

  isZero(): boolean {
    return this.#value.isZero();
  }

  compare(other: Money): -1 | 0 | 1 {
    return this.#value.comparedTo(other.#value) as -1 | 0 | 1;
  }

  /** Exactly `Money.SCALE` decimal places, for the driver -- never a JS number. */
  toDb(): string {
    return this.#value.toFixed(Money.SCALE);
  }

  toJSON(): string {
    return this.toDb();
  }

  format(locale: string): string {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "PKR",
      minimumFractionDigits: Money.SCALE,
      maximumFractionDigits: Money.SCALE,
    }).format(Number(this.#value.toFixed(Money.SCALE)));
    // The one Number() in this file: presentation-only formatting of an ALREADY-ROUNDED
    // fixed-scale string, discarded immediately into a display string. Not used in any
    // calculation. See §6.7 -- this is the documented, sanctioned exception, not a loophole.
  }

  // Deliberately absent: valueOf(), toNumber(), Symbol.toPrimitive.
  // Their absence is what makes `Number(money)` / `money + 1` / `${money}` in template
  // literals produce "[object Object]" or a type error instead of a silently wrong number --
  // a *type* error at the call site rather than a code-review hope (§6.4).
}
