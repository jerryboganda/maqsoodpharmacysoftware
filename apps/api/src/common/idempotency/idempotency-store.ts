// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.5 [BINDING].
//
// The `idempotency_key` table's runtime contract, extracted as a port so the interceptor
// doesn't care whether it is backed by MySQL or (in tests) memory.
//
// `MySqlIdempotencyStore` is the durable, default implementation (§7.5's `idempotency_key` DDL,
// packages/db/schema/system.ts). Its `begin` translates §7.5 step 1 ("INSERT ... ON DUPLICATE
// KEY: ...") into an INSERT that is allowed to collide on the table's primary key, followed by
// the branch logic on the pre-existing row -- the same catch-duplicate-then-branch shape already
// used for `uk_stock_lot_identity` in
// apps/api/src/modules/purchasing/application/purchase-invoice.service.ts.
//
// Known gaps carried forward from the original TODO (still real work, not done here):
//   - `complete`/`fail` are their own statements against `getDb()`'s pool, NOT "on the SAME
//     connection inside the business commit" as §7.5 step 3 asks for -- that requires threading
//     the caller's transaction (`Tx`) through `IdempotencyInterceptor` into these calls, which is
//     an interceptor/tx-context change outside this task's scope (the interceptor's call sites --
//     `void this.store.complete(...)` / `void this.store.fail(...)` in the `tap` callbacks --
//     are fire-and-forget by construction today). This is a genuinely large change (every
//     mutating service opens its OWN `db.transaction(...)`; making the interceptor's transaction
//     the one every downstream service call reuses touches all of them).
//   - the `platform` sweeper for rows STUCK `in_progress` (§7.5 step 4) is DELIBERATELY still not
//     implemented, and this is a considered decision, not an oversight: a stuck `in_progress` row
//     means the real outcome (did the business action actually commit before the process
//     crashed/restarted?) is UNKNOWN. Silently resetting it to "in_progress" and letting a retry
//     re-run the handler risks executing a financial action TWICE if the original attempt had, in
//     fact, already committed before the crash -- worse than the current behaviour (permanently
//     stuck, requiring a human to check the real outcome and intervene). Correctly solving this
//     needs the SAME transaction-threading fix as the bullet above (only the interceptor, holding
//     the actual commit's own connection, can know for certain whether the business action
//     landed) -- tracked together, both explicitly deferred to their own dedicated wave rather
//     than papered over with a reset-and-hope fix here.
//
// Wave 9 fix (the part of this gap that IS safe to do without the transaction redesign):
// `pruneExpired()` below, satisfying §7.5 step 5's actual intent -- bounding `idempotency_key`
// table growth -- WITHOUT touching any request-blocking behaviour. It only ever deletes rows in a
// TERMINAL state (`succeeded`/`failed`) whose `expiresAt` has passed; a `succeeded` row's own
// `begin()` branch already replays it verbatim for as long as the row exists (no expiry check
// added there -- an expired-but-still-present `succeeded` row silently starting to "reset and
// re-run" on the next matching retry would be exactly the same double-execution risk the
// `in_progress` sweeper above is deliberately NOT doing), so deleting only after the row has
// genuinely aged out is safe: if a client somehow retries with that exact (already vanishingly
// unlikely to repeat) key+body after the row is gone, `begin()`'s INSERT just succeeds fresh, no
// different from a genuinely new action. `ix_idem_expiry` already exists for exactly this scan.
// Called as a small, bounded (`LIMIT`), fire-and-forget side effect of a normal fresh `begin()`
// insert -- no cron needed, matching notifications/application/notification.service.ts's own
// "materialize on read" convention (there is no background job scheduler anywhere in this
// codebase, confirmed before writing that file).
import { Injectable, Logger } from "@nestjs/common";
import { and, eq, lt, or } from "drizzle-orm";
import { getDb, idempotencyKeys } from "@pharmacy/db";

export type IdempotencyStatus = "in_progress" | "succeeded" | "failed";

export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly endpoint: string;
  readonly requestHash: string;
  readonly status: IdempotencyStatus;
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
  readonly createdAt: Date;
}

export type BeginOutcome =
  | { readonly outcome: "started" }
  | { readonly outcome: "hash_mismatch" }
  | { readonly outcome: "in_progress" }
  | { readonly outcome: "replay"; readonly status: number; readonly body: unknown };

export abstract class IdempotencyStore {
  abstract begin(key: string, endpoint: string, requestHash: string): Promise<BeginOutcome>;
  abstract complete(key: string, endpoint: string, status: number, body: unknown): Promise<void>;
  abstract fail(key: string, endpoint: string): Promise<void>;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000; // §7.5 "expires_at ... created_at + 7 days"
/** Deliberately small -- this runs as a fire-and-forget side effect of every fresh idempotency-key
 *  insert, not a dedicated batch job; bounding it keeps that side effect cheap regardless of how
 *  large the backlog of prunable rows ever gets. */
const PRUNE_BATCH_LIMIT = 200;

/**
 * True when `error` is a MySQL duplicate-key error (ER_DUP_ENTRY / errno 1062) raised by the
 * `idempotency_key` insert in `begin`. Unlike `isDuplicateKeyError` in
 * purchase-invoice.service.ts, this table carries exactly one unique constraint -- its composite
 * primary key `(idem_key, endpoint)` -- so there is no other unique index the collision could be
 * mistaken for and no key-name check is needed to disambiguate.
 */
function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const mysqlError = error as { code?: unknown; errno?: unknown };
  return mysqlError.code === "ER_DUP_ENTRY" || mysqlError.errno === 1062;
}

/** Durable, default `IdempotencyStore` (§7.5). See the file header for the algorithm mapping. */
@Injectable()
export class MySqlIdempotencyStore extends IdempotencyStore {
  private readonly logger = new Logger(MySqlIdempotencyStore.name);

  async begin(key: string, endpoint: string, requestHash: string): Promise<BeginOutcome> {
    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SEVEN_DAYS_MS);

    try {
      // §7.5 step 1: "INSERT ... (status='in_progress')."
      await db.insert(idempotencyKeys).values({
        idemKey: key,
        endpoint,
        requestHash,
        status: "in_progress",
        createdAt: now,
        expiresAt,
      });
      // Wave 9: bounded, fire-and-forget prune of unrelated expired TERMINAL-state rows -- see
      // this file's header comment for why only terminal rows are ever eligible, and why this is
      // the safe half of the sweeper gap. Never awaited: pruning must never add latency to the
      // request that happened to trigger it, and a failed prune attempt is harmless (the next
      // fresh `begin()` anywhere just tries again).
      void this.pruneExpired().catch((error: unknown) => this.logger.warn(`pruneExpired failed (non-fatal): ${String(error)}`));
      return { outcome: "started" };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Fall through to the "on duplicate key" branch below.
    }

    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.idemKey, key), eq(idempotencyKeys.endpoint, endpoint)));
    if (!existing) {
      // Unreachable: the duplicate-key error proves a row exists (same reasoning as the
      // stockLots race-safety re-select in purchase-invoice.service.ts).
      throw new Error(`idempotency_key insert reported a duplicate for ${endpoint} but no row was found`);
    }

    // §7.5 step 1, "on duplicate key":
    if (existing.requestHash !== requestHash) return { outcome: "hash_mismatch" };
    // `in_progress` always blocks, regardless of age -- deliberately unchanged from before this
    // wave; see the file header for exactly why a stale-row reset is NOT done here.
    if (existing.status === "in_progress") return { outcome: "in_progress" };
    if (existing.status === "succeeded") {
      return { outcome: "replay", status: existing.responseStatus ?? 200, body: existing.responseBody };
    }
    // status === "failed" -> allow a fresh attempt (reset to in_progress). Safe: "failed" means
    // the original handler threw, and every mutating service wraps its work in
    // `db.transaction(...)`, so a thrown error already rolled back whatever it attempted --
    // nothing was actually persisted, so re-running is not a double-execution risk.
    await db
      .update(idempotencyKeys)
      .set({ status: "in_progress", responseStatus: null, responseBody: null, completedAt: null })
      .where(and(eq(idempotencyKeys.idemKey, key), eq(idempotencyKeys.endpoint, endpoint)));
    return { outcome: "started" };
  }

  async complete(key: string, endpoint: string, status: number, body: unknown): Promise<void> {
    const db = getDb();
    // §7.5 step 3 (partial -- see file header "known gaps": not yet on the business connection).
    await db
      .update(idempotencyKeys)
      .set({ status: "succeeded", responseStatus: status, responseBody: body, completedAt: new Date() })
      .where(and(eq(idempotencyKeys.idemKey, key), eq(idempotencyKeys.endpoint, endpoint)));
  }

  async fail(key: string, endpoint: string): Promise<void> {
    const db = getDb();
    await db
      .update(idempotencyKeys)
      .set({ status: "failed", completedAt: new Date() })
      .where(and(eq(idempotencyKeys.idemKey, key), eq(idempotencyKeys.endpoint, endpoint)));
  }

  /** Deletes up to `PRUNE_BATCH_LIMIT` rows that are BOTH in a terminal state (`succeeded` or
   *  `failed` -- never `in_progress`, see this file's header comment) AND past their own
   *  `expiresAt`. Returns the number of rows actually deleted, for tests/observability -- callers
   *  on the hot path (see `begin()` above) fire this without awaiting the result. */
  async pruneExpired(): Promise<number> {
    const db = getDb();
    const now = new Date();
    const candidates = await db
      .select({ idemKey: idempotencyKeys.idemKey, endpoint: idempotencyKeys.endpoint })
      .from(idempotencyKeys)
      .where(and(or(eq(idempotencyKeys.status, "succeeded"), eq(idempotencyKeys.status, "failed")), lt(idempotencyKeys.expiresAt, now)))
      .limit(PRUNE_BATCH_LIMIT);
    if (candidates.length === 0) return 0;

    // No composite-key `IN` helper in this Drizzle version -- delete one at a time inside a single
    // batch of statements rather than building a raw SQL tuple-IN (same tradeoff this codebase's
    // other insert-then-reselect patterns already accept: correctness and readability over one
    // fewer round trip, for a background-hygiene path that is never on a user-facing request's
    // critical path).
    for (const row of candidates) {
      await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.idemKey, row.idemKey), eq(idempotencyKeys.endpoint, row.endpoint)));
    }
    return candidates.length;
  }
}

/** Dev/test-only store. Not durable across restarts, not shared across instances -- kept only as
 *  an explicitly-named export for unit/integration tests that want to avoid a real MySQL
 *  connection. Must never be wired as the `IdempotencyStore` provider outside tests (§7.5). */
@Injectable()
export class InMemoryIdempotencyStore extends IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  private key(key: string, endpoint: string): string {
    // Printable delimiter (was a literal embedded NUL byte -- \x00 -- which is un-greppable and
    // an easy source of silent key collisions/mismatches; ":" cannot appear in `endpoint` because
    // routeOptions?.url/request.url never contain it, and is not expected in a UUID key).
    return `${endpoint}:${key}`;
  }

  async begin(key: string, endpoint: string, requestHash: string): Promise<BeginOutcome> {
    const existing = this.records.get(this.key(key, endpoint));
    if (!existing) {
      this.records.set(this.key(key, endpoint), {
        idempotencyKey: key,
        endpoint,
        requestHash,
        status: "in_progress",
        createdAt: new Date(),
      });
      return Promise.resolve({ outcome: "started" });
    }
    if (existing.requestHash !== requestHash) return Promise.resolve({ outcome: "hash_mismatch" });
    if (existing.status === "in_progress") return Promise.resolve({ outcome: "in_progress" });
    if (existing.status === "succeeded") {
      return Promise.resolve({ outcome: "replay", status: existing.responseStatus ?? 200, body: existing.responseBody });
    }
    // status === 'failed' -> allow a fresh attempt (§7.5 step 1, last bullet).
    this.records.set(this.key(key, endpoint), { ...existing, status: "in_progress" });
    return Promise.resolve({ outcome: "started" });
  }

  async complete(key: string, endpoint: string, status: number, body: unknown): Promise<void> {
    const existing = this.records.get(this.key(key, endpoint));
    if (!existing) return Promise.resolve();
    this.records.set(this.key(key, endpoint), { ...existing, status: "succeeded", responseStatus: status, responseBody: body });
    return Promise.resolve();
  }

  async fail(key: string, endpoint: string): Promise<void> {
    const existing = this.records.get(this.key(key, endpoint));
    if (!existing) return Promise.resolve();
    this.records.set(this.key(key, endpoint), { ...existing, status: "failed" });
    return Promise.resolve();
  }
}
