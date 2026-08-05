// Blueprint: docs/system-analysis/17-technical-blueprint.md §5.6 [BINDING] -- the exact
// mysql2 driver configuration. `decimalNumbers: false` and `dateStrings` are the two lines
// that make Rule M (money is never a float) and the Expiry-as-DATE business key structurally
// impossible to violate from this connection.
//
// KNOWN INTERACTION (audited 2026-08-05, not a bug to "fix" in this file -- see
// packages/db/schema/_shared.ts's own `auditColumns()` comment for the original "store DATETIME
// in Pakistan local time" intent this collides with, and the full writeup below). §5.6's own
// binding `default_time_zone = '+05:00'` means the MySQL SERVER evaluates
// `CURRENT_TIMESTAMP()`/`NOW()` in Asia/Karachi local time (confirmed live: `@@session.time_zone`
// = `SYSTEM`, which follows the OS -- this dev machine's `NOW()` reads ~5h ahead of
// `UTC_TIMESTAMP()`) -- exactly the intended "Pakistan local wall-clock" behaviour `datetime()`
// was chosen over `timestamp()` to get. But drizzle-orm's `datetime()` column type does NOT
// actually honour that for values app code writes: `mapToDriverValue` formats a JS `Date` via
// `.toISOString()` (always UTC, ignoring this pool's own `timezone: "+05:00"` option entirely --
// mysql2's own Date-to-string timezone conversion only runs for a raw `Date` parameter, and
// drizzle never hands it one, it pre-stringifies), and `mapFromDriverValue` re-parses whatever raw
// string comes back by blindly appending "Z". So an app-set `new Date()` is actually stored as UTC
// wall-clock text (not Pakistan-local, despite the schema's own intent), while a column left to
// MySQL's own `DEFAULT CURRENT_TIMESTAMP(3)` is genuinely Pakistan-local wall-clock text -- the two
// write paths disagree with each other, and comparing a DEFAULT-stamped value against an app-set
// one is wrong by the +05:00 offset (read-back mislabels the DEFAULT-stamped one as UTC too). A
// real, live instance of exactly this was found and fixed in cashier-shift.service.ts's `open()`
// (switched `openedAt` from the schema default to an explicit `new Date()` so it's directly
// comparable to the app-set timestamps `computeExpectedCash()`'s own time-window query checks it
// against). A full audit of every other DEFAULT-stamped `datetime` column across this schema
// (`auditColumns()`'s own `createdAt`/`updatedAt`, `audit_log.occurred_at`,
// `item_visibility.changed_at`, `visibility_bulk_operation.applied_at`,
// `cash_bank_reconciliation_match.matched_at`, `stock_balance.updated_at`) found every one of them
// is EITHER already explicitly overridden by app code at insert time in every real call site (so
// the schema default never actually lands), OR never read/compared/displayed by any current
// application code at all (a currently-dormant value that would misdisplay if ever surfaced, but
// does not misbehave today). Nothing else needed fixing this pass.
// DELIBERATELY NOT "fixed" by forcing this pool's session to UTC (e.g. `SET time_zone='+00:00'`
// on connect) -- that would directly contradict §5.6's own binding `default_time_zone='+05:00'`
// decision AND `auditColumns()`'s own documented "store DATETIME in Pakistan local time" intent.
// The fix belongs at each call site, same pattern as cashier-shift.service.ts's own: whenever a
// `datetime` column's value will ever be COMPARED against, or displayed alongside, another app-set
// timestamp, set it explicitly via `new Date()` in application code -- never lean on the column's
// own `DEFAULT CURRENT_TIMESTAMP(3)` for that (both sides then go through the same drizzle-UTC
// round-trip and stay directly comparable, even though the raw stored text is UTC, not the
// Pakistan-local text `auditColumns()`'s own comment originally intended -- a real, still-open
// mismatch between that documented intent and drizzle's actual behaviour, just not one with any
// live consequence found in this audit).
import type { Pool } from "mysql2/promise";
import { createPool } from "mysql2/promise";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "./schema/index";

type Schema = typeof schema;

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

export function createDbPool(): Pool {
  return createPool({
    host: env("DB_HOST", "127.0.0.1"),
    port: Number(env("DB_PORT", "3306")),
    user: env("DB_USER", "root"),
    password: env("DB_PASSWORD"),
    database: env("DB_NAME", "pharmacy_platform"),
    decimalNumbers: false, // DECIMAL -> string, never number -- Rule M
    supportBigNumbers: true,
    bigNumberStrings: true, // BIGINT -> string; ids never lose precision
    dateStrings: ["DATE", "DATETIME"], // no implicit JS Date coercion of business dates
    timezone: "+05:00", // Asia/Karachi -- Pakistan observes no DST (§5.6)
    multipleStatements: false, // defence in depth against stacked-query injection
    connectionLimit: 20,
    enableKeepAlive: true,
  });
}

export function createDb(pool: Pool): MySql2Database<Schema> {
  return drizzle(pool, { schema, mode: "default" });
}

let _pool: Pool | undefined;
let _db: MySql2Database<Schema> | undefined;

/** Lazily-initialised singleton pool/client for application code (repositories). */
export function getDb(): MySql2Database<Schema> {
  if (!_db) {
    _pool = createDbPool();
    _db = createDb(_pool);
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
}
