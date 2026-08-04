// Blueprint: Wave 6 (real audit trail + reporting registry + dashboard aggregates +
// notifications). No dedicated §T-number exists for this table in
// docs/system-analysis/19-mysql-schema-blueprint.md -- notifications are a Wave 6 addition, not
// part of the original blueprint's table catalogue. Modelled after this package's existing
// conventions (idPk, soft refs for created_by-style attribution, tenant-scoped uniqueIndex) and
// docs/system-analysis/18-api-plan.md's operational-alerts surface (low stock, expiry risk,
// pending approvals, overdue AP/AR).
//
// Ownership split, deliberate: exactly ONE of `recipientUserId`/`recipientRoleKey` is set per row
// -- a notification either targets one specific user (a targeted alert, e.g. "your purchase order
// was rejected") or broadcasts to every user holding a given role within the tenant (e.g. "low
// stock" fanned out to every `pharmacy_manager`). This is NOT enforced as a DB CHECK constraint
// (drizzle-kit's MySQL dialect does not reliably emit CHECK clauses, same documented limitation as
// payments.ts/ledger.ts) -- the notifications module's own service layer enforces "exactly one of
// the two" before insert.
//
// UPSERT-on-rescan: `uk_notification_source` (tenantId, sourceType, sourceId, kind) lets a
// periodic scan job (e.g. the low-stock scanner re-running every N minutes) upsert into this
// table instead of re-inserting a duplicate alert for a condition that is still true -- see the
// notifications module's own scan-job documentation for how this key is used.
import { datetime, index, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, fkBigInt, fkBigIntNotNull, idPk } from "./_shared";
import { appUsers } from "./identity";
import { tenants } from "./tenant";

/**
 * A single in-app notification, targeted at either one user or every user holding a given role
 * within the tenant. Read by the notifications module's list/mark-read endpoints; written by
 * whatever module/scan-job detects the underlying condition (low stock, expiry risk, a pending
 * approval, an overdue AP/AR balance, ...).
 */
export const notifications = mysqlTable(
  "notification",
  {
    notificationId: idPk("notification_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    // Real FK (not a soft ref like auditColumns().createdBy) -- unlike an audit row, a
    // notification's whole purpose is to be looked up BY its recipient (`WHERE recipient_user_id
    // = ?`), so a dangling reference to a deleted user would silently orphan real, actionable
    // rows rather than merely losing attribution on a historical record. Exactly one of
    // `recipientUserId`/`recipientRoleKey` is set -- enforced at the service layer, see class
    // comment above.
    recipientUserId: fkBigInt("recipient_user_id").references(() => appUsers.userId),
    recipientRoleKey: varchar("recipient_role_key", { length: 64 }), // e.g. "pharmacy_manager" -- see access.ts roleKey's own length
    // e.g. "low_stock", "expiry_risk", "adjustment_pending_approval", "purchase_order_pending",
    // "ap_overdue", "ar_overdue". Left a plain, module-extensible string rather than a structural
    // ENUM for the same reason audit.ts's own `action` column is (new notification kinds are
    // routinely added by new modules/scan-jobs without needing a schema migration).
    kind: varchar("kind", { length: 48 }).notNull(),
    severity: mysqlEnum("severity", ["info", "warning", "critical"]).notNull().default("info"),
    title: varchar("title", { length: 200 }).notNull(),
    body: varchar("body", { length: 1000 }).notNull(),
    link: varchar("link", { length: 255 }), // frontend route path to navigate to on click, e.g. "/inventory/stock/123"
    sourceType: varchar("source_type", { length: 48 }).notNull(), // the table/entity kind that triggered this notification, e.g. "stock_lot", "purchase_order"
    sourceId: fkBigInt("source_id"), // soft ref -- the specific row that triggered it; nullable for kinds with no single source row
    readAt: datetime("read_at", { fsp: 3 }),
    readBy: fkBigInt("read_by"), // soft ref, same reasoning as auditColumns().createdBy -- who marked it read, not necessarily the recipient (e.g. a role-broadcast row)
    ...auditColumns(),
  },
  (table) => ({
    // Lets a re-scan UPSERT ("is this exact alert already materialized?") instead of duplicating
    // an already-open notification for a condition that is still true on the next scan pass.
    sourceUnique: uniqueIndex("uk_notification_source").on(table.tenantId, table.sourceType, table.sourceId, table.kind),
    recipientIdx: index("ix_notification_recipient").on(table.tenantId, table.recipientUserId, table.readAt),
    roleIdx: index("ix_notification_role").on(table.tenantId, table.recipientRoleKey, table.readAt),
  }),
);
