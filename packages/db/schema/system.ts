// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.5 [BINDING] -- "Idempotency for
// financial POSTs". DDL reproduced column-for-column from §7.5's fenced `CREATE TABLE
// idempotency_key (...)` block, via this package's standard column helpers/conventions (idPk not
// used -- the blueprint's PK is the composite `(idem_key, endpoint)`, not a surrogate id).
//
// Which module owns it (§7.5): `common/idempotency` (this table) + `platform` (the sweeper job
// for rows stuck `in_progress` > 5 minutes, and the nightly `expires_at` pruning -- neither is
// implemented by this package; see apps/api/src/common/idempotency/idempotency-store.ts).
import { char, date, datetime, index, int, json, mysqlEnum, mysqlTable, primaryKey, smallint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, fkBigInt, idPk, TIMESTAMP_FSP } from "./_shared";

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

/**
 * Wave 10a (`platform` module) -- §T07 `feature_capability`, the D1 register: "every legacy
 * capability and its rebuild status" (18-api-plan.md §1.4 `GET/PATCH /admin/feature-capabilities`).
 * D1 itself (00b-owner-decisions-and-requirements.md) is the owner decision this table makes
 * queryable instead of leaving buried in prose: "Pharmacy business system in full ... Non-pharmacy
 * verticals ... are catalogued but deferred -- never silently dropped."
 *
 * Platform-wide, not tenant-scoped (like `permission`, access.ts's own header reasoning applies
 * here too: a legacy capability's rebuild status is a fact about THIS rebuild project, not data
 * any one tenant owns).
 *
 * `status` mirrors 19-mysql-schema-blueprint.md T07 exactly: `in_scope` (built), `deferred`
 * (catalogued, not yet built, no decision to exclude), `excluded` (deliberately not building,
 * e.g. task #28's tax/FBR items), `replaced` (superseded by a different rebuild approach).
 */
export const featureCapabilities = mysqlTable(
  "feature_capability",
  {
    featureCapabilityId: idPk("feature_capability_id"),
    code: varchar("code", { length: 64 }).notNull(), // e.g. `tax_engine`, `fbr_fiscalization`, `veterinary_vertical`
    name: varchar("name", { length: 160 }).notNull(),
    module: varchar("module", { length: 64 }), // free-text grouping label; no module catalogue table exists yet
    status: mysqlEnum("status", ["in_scope", "deferred", "excluded", "replaced"]).notNull().default("deferred"),
    legacyTableCount: int("legacy_table_count", { unsigned: true }),
    legacyEvidence: varchar("legacy_evidence", { length: 500 }),
    decisionRef: varchar("decision_ref", { length: 32 }), // e.g. `D1`, `U-060`
    decidedOn: date("decided_on"),
    rationale: varchar("rationale", { length: 1000 }), // PATCH requires >=20 chars, 18-api-plan.md §1.4
    ...auditColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_feature_capability_code").on(table.code),
  }),
);
