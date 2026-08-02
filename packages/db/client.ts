// Blueprint: docs/system-analysis/17-technical-blueprint.md §5.6 [BINDING] -- the exact
// mysql2 driver configuration. `decimalNumbers: false` and `dateStrings` are the two lines
// that make Rule M (money is never a float) and the Expiry-as-DATE business key structurally
// impossible to violate from this connection.
import { createPool } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "./schema/index";

function env(name, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

export function createDbPool() {
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

export function createDb(pool) {
  return drizzle(pool, { schema, mode: "default" });
}

let _pool;
let _db;

/** Lazily-initialised singleton pool/client for application code (repositories). */
export function getDb() {
  if (!_db) {
    _pool = createDbPool();
    _db = createDb(_pool);
  }
  return _db;
}

export async function closeDb() {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
    _db = undefined;
  }
}
