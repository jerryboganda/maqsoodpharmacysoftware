// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.4
// `fromInput` never throws -- cashier input errors are normal control flow (a form
// validation message), not an exception. `Result` makes that explicit at the type level.

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export type ParseError =
  | { kind: "empty" }
  | { kind: "not_a_number"; input: string }
  | { kind: "too_many_decimal_places"; input: string; maxScale: number }
  | { kind: "negative_not_allowed"; input: string };

/** Document/GL money scale is 2 (§6.2). Costing uses scale 5 (§6.5). Scale is always explicit
 *  at the call site -- never implicit -- so a mis-scaled result is a visible decision, not a bug. */
export type Scale = 2 | 3 | 4 | 5;

export type RoundingMode = "HALF_UP";
