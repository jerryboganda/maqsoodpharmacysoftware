// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.3 (boundary 3) and §6.7
// "Banned constructs" [BINDING].
//
// Money/quantity/percentage API fields are NEVER `z.number()`. They are decimal strings,
// validated by regex, and (where the DTO needs the value object rather than the raw wire
// string) transformed into `Money`/`Quantity`/`Percent` via the packages/money parsers --
// never via `Number()`/`parseFloat()`. A lint rule additionally bans `z.number()` on any
// contract field whose name matches a money/quantity pattern (§6.6 "schema lint"); these
// helpers are the sanctioned way to satisfy that rule.
import type { ParseError, Result } from "@pharmacy/money";
import { Money, Percent, Quantity } from "@pharmacy/money";
import { z } from "zod";

/** Renders a `packages/money` `ParseError` as a plain-language message (§9.4 rule E-3). */
function parseErrorMessage(error: ParseError): string {
  switch (error.kind) {
    case "empty":
      return "This value is required.";
    case "not_a_number":
      return `"${error.input}" is not a valid number.`;
    case "too_many_decimal_places":
      return `"${error.input}" has more than ${error.maxScale} decimal places.`;
    case "negative_not_allowed":
      return `"${error.input}" cannot be negative.`;
    default:
      return "Invalid value.";
  }
}

function unwrapOrIssue<T>(result: Result<T, ParseError>, ctx: z.RefinementCtx): T | typeof z.NEVER {
  if (result.ok) return result.value;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: parseErrorMessage(result.error) });
  return z.NEVER;
}

/** Matches every archetype in §6.2 at their widest scale: up to 15 integer digits, up to 4
 *  decimals, optional leading minus (returns/credits/adjustments are signed). Field-specific
 *  scale (2, 3, 4 or 5) is enforced by the value-object parser, not by this wire-level regex. */
export const DECIMAL_RE = /^-?\d{1,15}(?:\.\d{1,5})?$/;

/** Raw decimal-string schema. Use this when the API only needs to pass the value through
 *  (e.g. forwarding to another service) without doing arithmetic on it. */
export function zDecimalString(label = "amount") {
  return z
    .string()
    .regex(DECIMAL_RE, `${label} must be a decimal string, e.g. "123.45" (not a number)`);
}

/** A monetary amount, parsed into a `Money` value object. Arithmetic on the resulting value
 *  may only happen through `Money`'s methods (§6.7) -- this is what makes that structural
 *  rather than a code-review hope. */
export const zMoney = zDecimalString("amount").transform((raw, ctx) => unwrapOrIssue(Money.fromInput(raw), ctx));

/** A stock/pack/line quantity, parsed into a `Quantity` value object. */
export const zQuantity = zDecimalString("quantity").transform((raw, ctx) => unwrapOrIssue(Quantity.fromInput(raw), ctx));

/** A percentage (discount %, tax %, margin %, ...), parsed into a `Percent` value object. */
export const zPercent = zDecimalString("percentage").transform((raw, ctx) => unwrapOrIssue(Percent.fromInput(raw), ctx));

/** Wire-level regex for UNIT_PRICE-archetype fields: DECIMAL(15,4) columns such as
 *  sale_invoice_line.unit_sale_price. Same shape as DECIMAL_RE but caps decimals at 4 instead
 *  of 5 -- DECIMAL_RE's 5dp ceiling is the widest §6.2 archetype, not this column's actual
 *  scale, so it silently accepted a 5th decimal digit the DB would truncate. */
export const DECIMAL_4DP_RE = /^-?\d{1,15}(?:\.\d{1,4})?$/;

/** Raw decimal-string schema scaled to UNIT_PRICE-archetype fields (4dp), for callers that only
 *  need to pass the value through (mirrors `zDecimalString`'s pass-through contract, just at the
 *  narrower scale this column family actually stores). Additive alongside `zDecimalString` --
 *  does not replace it for fields whose archetype is wider (money/qty stay at their own scales). */
export function zDecimalString4dp(label = "amount") {
  return z
    .string()
    .regex(DECIMAL_4DP_RE, `${label} must be a decimal string with at most 4 decimal places, e.g. "123.4567" (not a number)`);
}
