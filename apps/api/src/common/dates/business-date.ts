// Business-date helpers (§3.6: business dates are `YYYY-MM-DD`, Pakistan local time, no DST --
// see packages/db/schema/_shared.ts's TIMESTAMP_FSP comment). `Date#toISOString().slice(0, 10)`
// would silently roll to the wrong calendar day for any instant whose UTC offset crosses midnight
// (Asia/Karachi is UTC+5, so every Pakistan-local time between 19:00 and 23:59 renders as
// "tomorrow" in UTC).
//
// Bug fix (found live via CI, not reproducible on this project's own dev machine): the previous
// version of this function read `now.getFullYear()`/`getMonth()`/`getDate()` -- the SERVER
// PROCESS's OWN OS-configured timezone, not specifically Asia/Karachi. That happened to be
// correct throughout this project's development because the dev machine's own OS timezone is
// already Asia/Karachi -- but it silently computes the WRONG business date on literally any
// server whose OS timezone is anything else (GitHub Actions' runners default to UTC; so does
// virtually every real cloud host -- AWS/GCP/Azure/most VPS providers), for the exact same
// class of "crosses midnight" bug this function's own comment already warned about, just at the
// OS-timezone layer instead of the UTC-string-slicing layer. Confirmed live: a real posted sale
// invoice's own `documentDate` (server-computed) didn't match what `GET /dashboards/summary`'s
// "today" filter and `POST /reports/sales-summary/run`'s "today" grouping considered "today",
// once the whole request pipeline ran under a UTC-timezone process.
//
// Fixed with `Intl.DateTimeFormat`'s explicit `timeZone: "Asia/Karachi"` option, which computes
// the calendar date IN that timezone regardless of what OS timezone the Node process itself is
// running under -- the only correct way to pin a "local date" to a SPECIFIC timezone rather than
// whatever the host happens to be configured with.
const BUSINESS_TIMEZONE = "Asia/Karachi";
const businessDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function localToday(): string {
  // en-CA's built-in date format is exactly YYYY-MM-DD -- no manual field assembly needed, and
  // no risk of the assembly itself reintroducing a UTC/local mismatch.
  return businessDateFormatter.format(new Date());
}

/**
 * For a Drizzle `gte`/`lte`/`eq` comparison against a `date()`-mode column -- deliberately NOT a
 * plain `new Date(...)`. This is a SEPARATE bug from the one this file's own header comment
 * documents (that one is about reading "now" in the wrong timezone; this one is about how
 * Drizzle's mysql2 adapter serializes a JS `Date` object into a SQL parameter for a date-column
 * comparison, and reproduces under ANY server timezone including Asia/Karachi itself).
 *
 * Root cause (confirmed live via `.toSQL()` + a real query, not guessed): passing a JS `Date`
 * into a `gte`/`lte`/`eq` filter against a `date()`-mode column serializes that Date via
 * `.toISOString()` -- e.g. `"2026-08-31T00:00:00.000Z"` -- as the literal SQL parameter. MySQL's
 * implicit string-to-DATE coercion does not reliably treat that ISO-with-"T"/"Z" string as
 * exactly equal to the plain date it represents: an `eq()` filter against it matches ZERO rows
 * even for a column that genuinely holds that exact date, and a `gte`/`lte` RANGE filter using it
 * matches most dates "by luck" (the malformed string still sorts approximately correctly) but
 * fails EXACTLY at a range boundary -- confirmed live: `common/docflow/fiscal-period.service.ts`'s
 * `resolveOpenPeriod` silently rejected a posting date equal to a fiscal period's own `endDate`
 * (i.e. the last calendar day of every month), throwing 422 `PERIOD.CLOSED`-adjacent
 * `PERIOD.NOT_CONFIGURED` for a date that IS configured -- a real, previously-undetected
 * production defect discovered while building Wave 9's fiscal-period close/reopen endpoints. This
 * is the same underlying serialization bug already fixed independently in
 * `reporting/application/report-helpers.ts`'s `businessDateParam` and
 * `notifications/application/notification.service.ts`'s `dateOnlyParam` -- promoted here as the
 * one shared, canonical version for `common/` code (docflow, and any future common-layer date
 * filter) to use, rather than a third private duplicate.
 *
 * The `as unknown as Date` cast is deliberate: Drizzle's own TypeScript types require a `Date`
 * argument here (matching the column's SELECT-side type), but its ACTUAL runtime SQL parameter
 * serialization is exactly right for a plain string and exactly wrong for a real Date object --
 * the cast documents that this is intentionally fighting the type system to get the CORRECT
 * runtime behavior, not an oversight.
 */
export function businessDateParam(dateStr: string): Date {
  return dateStr as unknown as Date;
}
