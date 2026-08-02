// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.3 boundary 4 ("Browser"),
// §6.7 banned constructs [BINDING]. Money is NEVER a JS number in this app. Every amount the
// API returns is a decimal string (§6.1); this module is the ONLY place that turns one into a
// display string, using `@pharmacy/money`'s formatter -- never `Number()`, `parseFloat()`, or
// `toFixed()` on a raw string.
import { Money, Quantity } from "@pharmacy/money";

/** Formats a `DECIMAL(15,2)` string from the API (e.g. "1234.50") as a localised currency
 *  string (e.g. "PKR 1,234.50"). */
export function formatMoney(raw: string, locale = "en-PK"): string {
  return Money.fromDb(raw).format(locale);
}

/** Formats a quantity string from the API for display. */
export function formatQuantity(raw: string, locale = "en-PK"): string {
  return Quantity.fromDb(raw).format(locale);
}

/**
 * Parses a cashier/admin's raw keystrokes into a `Money`, for use with a `<MoneyInput>`
 * (§8.5) that reads `event.target.value` -- never `input.valueAsNumber` (§6.7). Returns the
 * `Result` from `packages/money` unchanged so the caller renders an inline, focus-managed
 * validation message (§9.4 E-4) instead of throwing.
 */
export function parseMoneyInput(raw: string) {
  return Money.fromInput(raw);
}
