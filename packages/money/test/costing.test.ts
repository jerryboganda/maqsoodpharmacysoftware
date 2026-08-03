// Golden checks for the canonical moving-average formulas (08-inventory-logic.md §8.2, C-2/C-3):
// exact 5-dp ROUND_HALF_UP at both steps, incoming-cost-wins on zero stock, bonus dilution
// arriving via the caller's qtyIn.
import { describe, expect, it } from "vitest";
import { costAmount, movingAverage, unitCostIn } from "../src/index.js";

describe("unitCostIn", () => {
  it("divides the pack-level cost basis by pack units at 5 dp", () => {
    expect(unitCostIn("18.0000", 10)).toBe("1.80000");
    expect(unitCostIn("100.0000", 3)).toBe("33.33333");
  });

  it("rounds HALF_UP on the fifth decimal", () => {
    // 1 / 6 = 0.1666666... -> 0.16667
    expect(unitCostIn("1.0000", 6)).toBe("0.16667");
  });

  it("rejects non-positive or fractional pack units", () => {
    expect(() => unitCostIn("10.0000", 0)).toThrow(RangeError);
    expect(() => unitCostIn("10.0000", 1.5)).toThrow(RangeError);
  });
});

describe("movingAverage", () => {
  it("computes the canonical weighted average (08 §8.2)", () => {
    // (100 × 2.00000 + 50 × 3.00000) / 150 = 2.33333...
    expect(
      movingAverage({ stockBefore: "100.0000", avgBefore: "2.00000", qtyIn: "50.0000", unitCostIn: "3.00000" }),
    ).toBe("2.33333");
  });

  it("incoming cost wins outright when stock-before is zero (fresh stock after stock-out)", () => {
    expect(
      movingAverage({ stockBefore: "0.0000", avgBefore: "9.99999", qtyIn: "10.0000", unitCostIn: "1.80000" }),
    ).toBe("1.80000");
  });

  it("bonus dilution flows through qtyIn (C-3): bonus units enter the denominator", () => {
    // 10 paid packs of 10 @ 1.80/unit + 2 bonus packs -> qtyIn 120 loose, same value in
    // value-in = 100 × 1.80 = 180; avg = 180 / 120 = 1.50
    expect(
      movingAverage({ stockBefore: "0.0000", avgBefore: "0.00000", qtyIn: "120.0000", unitCostIn: "1.50000" }),
    ).toBe("1.50000");
  });

  it("rounds HALF_UP at exactly 5 dp", () => {
    // (1 × 1.00000 + 2 × 2.00001) / 3 = 1.6666733... -> 1.66667
    expect(
      movingAverage({ stockBefore: "1.0000", avgBefore: "1.00000", qtyIn: "2.0000", unitCostIn: "2.00001" }),
    ).toBe("1.66667");
  });
});

describe("costAmount", () => {
  it("extends qty × unit cost to the 2-dp document scale, HALF_UP", () => {
    expect(costAmount("3.0000", "1.66667")).toBe("5.00"); // 5.00001 -> 5.00
    expect(costAmount("10.0000", "1.80000")).toBe("18.00");
    expect(costAmount("1.0000", "0.005")).toBe("0.01"); // half rounds up
  });
});
