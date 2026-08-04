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
