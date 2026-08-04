// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.5 [BINDING] -- "Idempotency for
// financial POSTs". DDL reproduced column-for-column from §7.5's fenced `CREATE TABLE
// idempotency_key (...)` block, via this package's standard column helpers/conventions (idPk not
// used -- the blueprint's PK is the composite `(idem_key, endpoint)`, not a surrogate id).
//
// Which module owns it (§7.5): `common/idempotency` (this table) + `platform` (the sweeper job
// for rows stuck `in_progress` > 5 minutes, and the nightly `expires_at` pruning -- neither is
// implemented by this package; see apps/api/src/common/idempotency/idempotency-store.ts).
import { char, datetime, index, json, mysqlEnum, mysqlTable, primaryKey, smallint, varchar } from "drizzle-orm/mysql-core";
import { fkBigInt, TIMESTAMP_FSP } from "./_shared";

/**
 * §7.5's `idempotency_key` table -- the durable half of the begin/complete/fail contract in
 * `IdempotencyStore` (apps/api). One row per (idem_key, endpoint); `status` starts `in_progress`
 * on the INSERT that opens the window (§7.5 step 1), is updated to `succeeded`/`failed` by the
 * interceptor (steps 2-3), and is later swept/pruned by the not-yet-built `platform` job (steps
 * 4-5).
 *
 * DEVIATION from §7.5's literal DDL -- `actor_user_id BIGINT NOT NULL`: this package's
 * `IdempotencyStore.begin(key, endpoint, requestHash)` contract (the interceptor's exact,
 * preserved signature) has no actor parameter to thread through yet -- `IdempotencyInterceptor`
 * does not currently read `request.actor` (see apps/api/src/common/auth/session.guard.ts). Making
 * this column NOT NULL today would mean writing a fake sentinel id on every row, which is exactly
 * the kind of silently-wrong data §7.5's audit trail exists to prevent. Left nullable and
 * unenforced (soft reference, same reasoning as `_shared.ts` `auditColumns().createdBy` and
 * `audit.ts` `actorUserId`) until the interceptor is extended to pass the authenticated actor
 * through `begin`/`complete`/`fail` -- a TODO, not a design decision.
 */
export const idempotencyKeys = mysqlTable(
  "idempotency_key",
  {
    idemKey: char("idem_key", { length: 36 }).notNull(),
    endpoint: varchar("endpoint", { length: 120 }).notNull(),
    actorUserId: fkBigInt("actor_user_id"), // see DEVIATION above -- §7.5 specifies NOT NULL
    requestHash: char("request_hash", { length: 64 }).notNull(), // SHA-256 hex of the canonicalised body
    status: mysqlEnum("status", ["in_progress", "succeeded", "failed"]).notNull(),
    responseStatus: smallint("response_status"),
    responseBody: json("response_body"),
    resourceType: varchar("resource_type", { length: 64 }),
    resourceId: fkBigInt("resource_id"),
    createdAt: datetime("created_at", { fsp: TIMESTAMP_FSP }).notNull(),
    completedAt: datetime("completed_at", { fsp: TIMESTAMP_FSP }),
    expiresAt: datetime("expires_at", { fsp: TIMESTAMP_FSP }).notNull(), // created_at + 7 days (§7.5)
  },
  (table) => ({
    pk: primaryKey({ columns: [table.idemKey, table.endpoint] }),
    expiryIdx: index("ix_idem_expiry").on(table.expiresAt),
  }),
);
