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
