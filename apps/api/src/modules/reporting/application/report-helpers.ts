// Shared plumbing for every report/dashboard query in this module: pagination + row-cap
// enforcement, date-range validation, and local-date arithmetic. Split out of reports.service.ts
// so report-queries.ts (shared between ReportsService and DashboardService) can use the same
// date helpers without a circular import.
import { BusinessRuleException } from "../../../common/errors/index.js";

/** Every report/dashboard query first fetches its FULL matched row set (no SQL LIMIT/OFFSET --
 *  simpler than chasing "LIMIT after GROUP BY/HAVING" across eight different aggregate shapes),
 *  then this function caps and pages it in application code. The cap IS this module's "reasonable
 *  ... row cap" (task instruction): a report whose filters are wide enough to match more than
 *  MAX_ROWS distinct groups 422s instead of silently truncating or paging through an unbounded
 *  result set -- the caller must narrow their filters (a smaller date range, a specific
 *  item/supplier/customer) and try again. Every report handler in this module keeps its own
 *  matched-row count well under this in ordinary use (bounded by day-count within
 *  MAX_DATE_RANGE_DAYS, or by the tenant's own item/supplier/customer catalogue size).
 */
export const MAX_ROWS = 5000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_DATE_RANGE_DAYS = 366;

export interface Page {
  readonly offset: number;
  readonly limit: number;
}

export function resolvePage(body: { readonly offset?: number | undefined; readonly limit?: number | undefined }): Page {
  return { offset: body.offset ?? 0, limit: Math.min(body.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE) };
}

export interface PagedResult<R> {
  readonly data: readonly R[];
  readonly meta: { readonly offset: number; readonly limit: number; readonly total: number; readonly hasMore: boolean };
}

/** Caps at MAX_ROWS (422 REPORT.RANGE_TOO_LARGE), then slices `rows` into one page. `rows` should
 *  already be sorted the way the caller wants the page ordered -- this function does not sort. */
export function paginate<T, R>(rows: readonly T[], page: Page, map: (row: T) => R): PagedResult<R> {
  if (rows.length > MAX_ROWS) {
    throw new BusinessRuleException(
      "REPORT.RANGE_TOO_LARGE",
      "Too many rows matched",
      `This report matched ${rows.length} rows, which exceeds the ${MAX_ROWS}-row cap. Narrow the filters (a smaller date range, or a specific item/supplier/customer) and try again.`,
      [{ path: "filters", code: "REPORT.RANGE_TOO_LARGE", message: "Too many rows matched" }],
    );
  }
  const pageRows = rows.slice(page.offset, page.offset + page.limit);
  return {
    data: pageRows.map(map),
    meta: { offset: page.offset, limit: page.limit, total: rows.length, hasMore: page.offset + page.limit < rows.length },
  };
}

/** dateFrom > dateTo, or a span wider than MAX_DATE_RANGE_DAYS -- both are semantic issues a
 *  wire-level Zod regex can't catch (the DTO only validates each string is individually
 *  YYYY-MM-DD shaped). No-op when either bound is absent (an open-ended range is bounded instead
 *  by `paginate`'s row cap, not by this check). */
export function assertDateRange(dateFrom: string | undefined, dateTo: string | undefined): void {
  if (dateFrom === undefined || dateTo === undefined) return;
  if (dateFrom > dateTo) {
    throw new BusinessRuleException(
      "REPORT.FILTER_INVALID",
      "Invalid date range",
      `filters.dateFrom (${dateFrom}) is after filters.dateTo (${dateTo}).`,
      [{ path: "filters.dateFrom", code: "REPORT.FILTER_INVALID", message: "dateFrom must be on or before dateTo" }],
    );
  }
  const days = daysBetween(dateFrom, dateTo);
  if (days > MAX_DATE_RANGE_DAYS) {
    throw new BusinessRuleException(
      "REPORT.RANGE_TOO_LARGE",
      "Date range too large",
      `The requested range (${dateFrom} to ${dateTo}, ${days} days) exceeds the maximum of ${MAX_DATE_RANGE_DAYS} days.`,
      [{ path: "filters.dateTo", code: "REPORT.RANGE_TOO_LARGE", message: `Range exceeds ${MAX_DATE_RANGE_DAYS} days` }],
    );
  }
}

/** A YYYY-MM-DD business-date string as a local-midnight `Date`, for LOCAL JS DATE ARITHMETIC
 *  ONLY (`addDays`/`daysBetween` below) -- mirrors expense.service.ts's identical
 *  `new Date(`${x}T00:00:00`)` convention (a date-time string with no zone suffix parses as LOCAL
 *  time per ECMA-262, so this is safe; see common/dates/business-date.ts's header comment for the
 *  trap this avoids: a bare `new Date("YYYY-MM-DD")`, or any `.toISOString().slice(0,10)`
 *  round-trip, is UTC and can roll to the wrong calendar day for Asia/Karachi local time).
 *
 *  Do NOT use this for a Drizzle `gte`/`lte`/`eq` comparison against a `date()`-mode column --
 *  see `businessDateParam` below for that case specifically; the two are NOT interchangeable
 *  despite both nominally producing "a Date for the same calendar day". */
export function toBusinessDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`);
}

/** For a Drizzle `gte`/`lte`/`eq` comparison against a `date()`-mode column (e.g.
 *  `sale_invoice.posting_date`) -- deliberately NOT `toBusinessDate` above, despite both taking a
 *  `YYYY-MM-DD` string.
 *
 *  Real bug found live (CI-reproducible, and once found, also reproducible locally under
 *  `TZ=UTC`): passing a JS `Date` object (e.g. `toBusinessDate(dateStr)`) into a Drizzle query
 *  filter against a `date()`-mode column serializes that Date via `.toISOString()` --
 *  `"2026-08-05T00:00:00.000Z"` -- as the literal SQL parameter (confirmed via `.toSQL()`
 *  directly: `PARAMS: ["2026-08-05T00:00:00.000Z"]`). MySQL's implicit string-to-DATE coercion
 *  does not correctly compare that ISO-with-"T"/"Z" string against a stored `DATE` value the way
 *  it does a plain `"YYYY-MM-DD"` string -- the row silently never matches, even though the
 *  SAME Date object read back from the SAME column (`.getTime()`) is byte-identical to the one
 *  being compared against. Confirmed directly: passing the raw `YYYY-MM-DD` string instead
 *  (bypassing `toBusinessDate` entirely) produces `PARAMS: ["2026-08-05"]` and matches correctly.
 *
 *  This is why `POST /reports/sales-summary/run` and `GET /dashboards/summary`'s "today" filters
 *  could return zero rows for a real, correctly-posted invoice dated exactly "today" -- not a
 *  timezone bug in the traditional sense (this reproduces under ANY server OS timezone, since the
 *  broken serialization happens entirely inside Drizzle/mysql2, before the query ever leaves the
 *  process), just a Date-vs-string parameter-typing mismatch for this specific column mode.
 *
 *  The `as unknown as Date` cast is deliberate: Drizzle's own TypeScript types require a `Date`
 *  argument here (matching the column's SELECT-side type), but its ACTUAL runtime SQL parameter
 *  serialization is exactly right for a plain string and exactly wrong for a real Date object --
 *  the cast documents that this is intentionally fighting the type system to get the CORRECT
 *  runtime behavior, not an oversight. */
export function businessDateParam(dateStr: string): Date {
  return dateStr as unknown as Date;
}

/** `dateStr` + `days` calendar days, as a YYYY-MM-DD string -- local-time arithmetic throughout
 *  (construct local midnight, mutate with `setDate`, read back local getters), never
 *  `toISOString()` (same UTC-rollover trap `toBusinessDate`'s doc comment describes). */
export function addDays(dateStr: string, days: number): string {
  const d = toBusinessDate(dateStr);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysBetween(fromStr: string, toStr: string): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((toBusinessDate(toStr).getTime() - toBusinessDate(fromStr).getTime()) / MS_PER_DAY);
}

/** A date-mode `Date` read back off a Drizzle `date()` column (e.g. `sale_invoice.posting_date`)
 *  as a YYYY-MM-DD string -- mirrors expenses/application/expense.service.ts's identical
 *  `toDateString` helper verbatim (same file-local reasoning: no shared Asia/Karachi
 *  "format this stored date back out" helper exists yet in common/dates). */
export function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}
