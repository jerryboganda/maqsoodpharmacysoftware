// Business-date helpers (§3.6: business dates are `YYYY-MM-DD`, Pakistan local time, no DST --
// see packages/db/schema/_shared.ts's TIMESTAMP_FSP comment). `Date#toISOString().slice(0, 10)`
// would silently roll to the wrong calendar day for any server-local instant whose UTC offset
// crosses midnight (Asia/Karachi is UTC+5, so every local time between 19:00 and 23:59 renders
// as "tomorrow" in UTC) -- `localToday()` reads the calendar fields off a server-local `Date`
// instead, matching the `YYYY-MM-DD` business-date convention already used everywhere else in
// this codebase (MovementInput.postingDate, CreateAdjustmentInput.documentDate, ...).
export function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
