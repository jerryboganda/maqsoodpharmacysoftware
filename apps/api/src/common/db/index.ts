// Shared Drizzle handle/transaction types for repositories and posting services.
//
// Blueprint 17§7.1 TX-1: "The application service owns the transaction. Repositories never
// open one." Services call `getDb().transaction(...)` and pass the `Tx` down; every repository
// and helper that participates in a posting flow takes `DbOrTx` so it runs inside the caller's
// transaction (or standalone for plain reads).
import type { getDb } from "@pharmacy/db";

export type Db = ReturnType<typeof getDb>;
/** The transaction handle Drizzle passes to the `db.transaction(async (tx) => ...)` callback. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
