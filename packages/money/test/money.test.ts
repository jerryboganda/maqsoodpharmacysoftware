// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.6 "Unit -- money algebra".
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money } from "../src/Money.js";
import { Decimal } from "../src/config.js";

describe("Money.fromDb / toDb round-trip", () => {
  it("is the identity for every legal DECIMAL(15,2) string", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -999_999_999, max: 999_999_999 }),
        fc.integer({ min: 0, max: 99 }),
        (whole, cents) => {
          const sign = whole < 0 ? "-" : "";
          const raw = `${sign}${Math.abs(whole)}.${String(cents).padStart(2, "0")}`;
          expect(Money.fromDb(raw).toDb()).toBe(raw);
        },
      ),
    );
  });
});

describe("Money.add / sub", () => {
  it("add is commutative", () => {
    fc.assert(
      fc.property(fc.float({ noNaN: true, min: -1e6, max: 1e6 }), fc.float({ noNaN: true, min: -1e6, max: 1e6 }), (a, b) => {
        const ma = Money.of(a).round(2);
        const mb = Money.of(b).round(2);
        expect(ma.add(mb).toDb()).toBe(mb.add(ma).toDb());
      }),
    );
  });

  it("a + b - b === a (round-trips at the same scale)", () => {
    fc.assert(
      fc.property(fc.float({ noNaN: true, min: -1e6, max: 1e6 }), fc.float({ noNaN: true, min: -1e6, max: 1e6 }), (a, b) => {
        const ma = Money.of(a).round(2);
        const mb = Money.of(b).round(2);
        expect(ma.add(mb).sub(mb).toDb()).toBe(ma.toDb());
      }),
    );
  });
});

describe("Money.allocate", () => {
  it("always sums exactly to the original, for random weight vectors", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000_00, max: 10_000_00 }), // paisa
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 }).filter((w) => w.some((x) => x > 0)),
        (paisa, weights) => {
          const total = Money.fromDb((paisa / 100).toFixed(2));
          const parts = total.allocate(weights.map((w) => new Decimal(w)));
          const sum = parts.reduce((acc, p) => acc.add(p), Money.zero());
          expect(sum.toDb()).toBe(total.toDb());
          expect(parts).toHaveLength(weights.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("splits 100.00 across weights [1,1,1] as 33.34/33.33/33.33 (largest remainder)", () => {
    const parts = Money.fromDb("100.00").allocate([new Decimal(1), new Decimal(1), new Decimal(1)]);
    const sum = parts.reduce((acc, p) => acc.add(p), Money.zero());
    expect(sum.toDb()).toBe("100.00");
    expect(parts.map((p) => p.toDb()).sort()).toEqual(["33.33", "33.33", "33.34"]);
  });

  it("gives everything to the first weight when all weights are zero, rather than throwing", () => {
    const parts = Money.fromDb("50.00").allocate([new Decimal(0), new Decimal(0)]);
    expect(() => parts).not.toThrow();
    expect(parts[0]!.toDb()).toBe("50.00");
    expect(parts[1]!.toDb()).toBe("0.00");
  });
});

describe("Money.fromInput", () => {
  it("never throws, and rejects malformed input as a Result error", () => {
    for (const bad of ["", "abc", "1.2.3", "1.999", "--5", "5-"]) {
      const result = Money.fromInput(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("accepts well-formed input", () => {
    const result = Money.fromInput("1234.56");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.toDb()).toBe("1234.56");
  });
});

describe("Money does not silently coerce to a number", () => {
  it("has no valueOf/toNumber that would make arithmetic-by-accident type-check", () => {
    const m = Money.of(5);
    // @ts-expect-error -- Money must not expose toNumber(); this line should fail to compile.
    expect(typeof m.toNumber).toBe("undefined");
  });
});
