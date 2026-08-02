// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.4 [BINDING]
// Global decimal.js configuration. Imported once, before any Money/Quantity/Percent
// value is constructed anywhere in the monorepo.
// Named import, not default -- decimal.js's own .d.ts recommends this form for re-export
// scenarios like this one (config.ts is the single place Decimal enters the package).
import { Decimal } from "decimal.js";

Decimal.set({
  precision: 34, // well above any intermediate value this system produces
  rounding: Decimal.ROUND_HALF_UP, // "round half away from zero" for positives -- see §6.5
  toExpNeg: -9e15,
  toExpPos: 9e15, // never switch to exponential notation in string output
});

export { Decimal };
