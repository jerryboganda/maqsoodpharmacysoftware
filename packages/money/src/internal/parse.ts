// Shared parsing for Money/Quantity/Percent.fromInput -- never throws.
import { Decimal } from "../config.js";
import { err, ok, type ParseError, type Result } from "../types.js";

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function parseDecimalInput(
  raw: string,
  opts: { allowNegative: boolean; maxScale: number },
): Result<Decimal, ParseError> {
  const input = raw.trim();
  if (input.length === 0) return err({ kind: "empty" });
  if (!DECIMAL_RE.test(input)) return err({ kind: "not_a_number", input });

  const [, fraction] = input.split(".");
  if (fraction !== undefined && fraction.length > opts.maxScale) {
    return err({ kind: "too_many_decimal_places", input, maxScale: opts.maxScale });
  }

  const value = new Decimal(input);
  if (!opts.allowNegative && value.isNegative()) {
    return err({ kind: "negative_not_allowed", input });
  }
  return ok(value);
}
