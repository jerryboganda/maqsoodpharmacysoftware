// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T20 `audit_event`;
// docs/system-analysis/09-roles-permissions.md §G.2 ("the critical gap list" -- login, permission
// change, price change, posting, export, and deletion of documents are not audited today) and
// §I.5 (audit immutability, retention >= 7 years); docs/system-analysis/00b-owner-decisions-and-
// requirements.md R1.8, R2.8, R6 (isolation) -- multiple owner decisions require this "who/when/
// what/before/after" pattern everywhere, which is why this is a single generic table rather than
// one log per module.
import { sql } from "drizzle-orm";
import { char, datetime, decimal, index, json, mysqlTable, varbinary, varchar } from "drizzle-orm/mysql-core";
import { DOCUMENT_AMOUNT, fkBigInt, idPk, TIMESTAMP_FSP } from "./_shared";

/**
 * The universal who/when/what/before/after trail. §T20: "Directly closes eleven of the twelve
 * un-audited events listed in 09 §G.2 ('the critical gap list')."
 *
 * `tenantId`/`branchId` are nullable: some audited events are platform-level (a platform admin
 * creating a new tenant, per R6) and have no single tenant/branch to attach to; every
 * tenant-scoped event (item visibility change, permission grant, price change, document post,
 * export, etc.) sets them, which is what makes R6's isolation requirement ("one tenant must never
 * be able to see or affect another's data, even through a bug") auditable/provable per tenant.
 *
 * Not partitioned in this package. §T20 specifies `PARTITION BY RANGE (TO_DAYS(occurred_at))`,
 * one partition per month; drizzle-kit's schema DSL does not expose MySQL table partitioning
 * (checked against the installed drizzle-orm 0.36 mysql-core API -- no partition option exists on
 * `mysqlTable`). Per the documented "generate -> hand-review -> commit" migration workflow
 * (17§5.4), partitioning is added by hand to the generated migration SQL if/when audit_log volume
 * warrants it; the column shape and indexes below are correct either way.
 */
export const auditLog = mysqlTable(
  "audit_log",
  {
    auditLogId: idPk("audit_log_id"),
    tenantId: fkBigInt("tenant_id"), // nullable -- see class comment. Not a hard FK: audit rows must never be blocked by/lost to a later tenant-row change.
    branchId: fkBigInt("branch_id"),
    occurredAt: datetime("occurred_at", { fsp: TIMESTAMP_FSP }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    actorUserId: fkBigInt("actor_user_id"), // no FK -- see below
    // Denormalised on purpose (§T20): "the trail must stay readable even if the user row is later
    // renamed [or soft-deleted]." Same reasoning is why actorUserId itself carries no
    // `.references()` -- an audit row must remain exactly as written even if the actor's account
    // is later deleted/merged; a hard FK would either block that or (with ON DELETE SET NULL)
    // silently lose attribution, which R1.8/R2.8 explicitly require never happens.
    actorUsername: varchar("actor_username", { length: 64 }).notNull(),
    sessionId: char("session_id", { length: 36 }),
    // create, update, cancel, post, reverse, grant, revoke, login, export, visibility_change,
    // setting_change, price_change (§T20's seed list). Left as a plain, admin-extensible string
    // rather than a structural ENUM: unlike journal_entry.status or stock_movement.direction
    // (§8.3 -- ENUM reserved for values that select a code path), new auditable action kinds are
    // routinely added by new modules without needing new branching logic in the audit writer
    // itself, so a hardcoded ENUM here would violate P1.1 for no correctness benefit.
    action: varchar("action", { length: 48 }).notNull(),
    entityType: varchar("entity_type", { length: 48 }).notNull(), // target table name
    entityId: fkBigInt("entity_id"),
    entityLabel: varchar("entity_label", { length: 160 }), // human-readable identity at the time, e.g. the invoice number
    beforeJson: json("before_json"),
    afterJson: json("after_json"),
    changedFields: json("changed_fields"), // array of column names -- makes "who changed the price?" indexable
    amountImpact: decimal("amount_impact", DOCUMENT_AMOUNT), // financial magnitude, for risk-ranked review
    reason: varchar("reason", { length: 500 }), // mandatory (service-layer enforced) for cancel, reverse, visibility bulk change, permission change
    ipAddress: varbinary("ip_address", { length: 16 }),
    machineName: varchar("machine_name", { length: 64 }),
    requestId: char("request_id", { length: 36 }), // correlates one user action across multiple audit rows
  },
  (table) => ({
    // Append-only (§4.2): no updated_*/deleted_* columns, and the application's MySQL grant
    // should carry INSERT+SELECT only on this table, enforced by BEFORE UPDATE/BEFORE DELETE
    // triggers that SIGNAL SQLSTATE '45000' -- a deployment/grant concern, out of scope for this
    // Drizzle schema definition (§4.2, §9.10).
    entityIdx: index("ix_audit_entity").on(table.entityType, table.entityId, table.occurredAt),
    actorIdx: index("ix_audit_actor").on(table.actorUserId, table.occurredAt),
    actionIdx: index("ix_audit_action").on(table.action, table.occurredAt),
    requestIdx: index("ix_audit_request").on(table.requestId),
    tenantIdx: index("ix_audit_tenant").on(table.tenantId, table.occurredAt),
  }),
);
