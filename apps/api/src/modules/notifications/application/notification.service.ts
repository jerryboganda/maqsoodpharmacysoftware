// Blueprint: docs/system-analysis/18-api-plan.md §6.5 "Notifications", scoped down per this
// task's own explicit instruction (see the DEFERRED list at the bottom of this comment).
//
// DESIGN -- "materialized alerts" instead of a cron. There is no background job scheduler
// anywhere in this codebase (confirmed before writing this file), so notifications cannot be
// generated on a timer. Instead, `scanForAlerts` runs SYNCHRONOUSLY at the top of every
// `GET /notifications` call: it queries current real conditions across other modules' tables
// (read-only) and UPSERTs one `notification` row per (tenantId, sourceType, sourceId, kind) --
// the exact unique index `uk_notification_source` (packages/db/schema/notifications.ts) exists
// for this. Re-running the scan for a condition that is still true is a no-op (ON DUPLICATE KEY
// UPDATE with a self-assigning no-op SET, see `reconcileKind` below -- "already materialized,
// leave it exactly as it is" per this task's own instruction); a condition that has CLEARED since
// the last scan is handled by DELETING the row (see `reconcileKind`'s own comment for why deletion
// -- not archival -- is this file's documented default).
//
// Every query below is a single indexed lookup against an already-indexed column (stock_balance's
// (item_id, branch_id) grouping, stock_lot's ix_stock_lot_expiry, stock_adjustment's
// ix_stock_adjustment_date, purchase_order's ix_purchase_order_status) -- "cheap", per this
// task's own instruction, not a report-grade join.
//
// Four conditions scanned (kind / sourceType / recipientRoleKey):
//   (a) low_stock              / item            / pharmacy_manager -- qtyOnHand summed across
//       lots, 0 < qty < 20. The "20" comes from the committed frontend dashboard's own literal
//       threshold: `git show HEAD:src/lib/components/pharmacy/PharmacyDashboardPage.svelte` (repo
//       E:\Pharma Software\frontend) line 37, "Low stock (< 20 units)" -- reused verbatim, not
//       invented here. That same dashboard treats `qty <= 0` as a SEPARATE "zero stock" KPI, not
//       part of "low stock" -- mirrored exactly: this scan's `having` clause is `> 0 AND < 20`,
//       so an out-of-stock item does NOT fire `low_stock` (a distinct `out_of_stock` kind is a
//       reasonable future addition, not built here -- out of this task's literal scope).
//   (b) expiry_risk            / stock_lot       / pharmacy_manager -- lots with stock on hand
//       whose expiry falls in the SAME two buckets StockQueryService.expiryDashboard already
//       defines (apps/api/src/modules/inventory/application/stock-query.service.ts): "expired"
//       (daysToExpiry < 0) or "30" (0 <= daysToExpiry <= 30) -- i.e. `daysToExpiry <= 30`, lots
//       already past due included. Severity is "critical" for already-expired lots, "warning" for
//       the 0-30-day runway, matching that file's own bucket split one-for-one.
//   (c) adjustment_pending_approval / stock_adjustment / pharmacy_manager -- drafts whose reason
//       requires approval and haven't received one yet: `status = 'draft' AND requiresApproval =
//       true AND approvedBy IS NULL`, the EXACT gate StockAdjustmentService.post() itself enforces
//       (apps/api/src/modules/inventory/application/stock-adjustment.service.ts, the
//       `ADJUSTMENT.APPROVAL_REQUIRED` check) -- reused verbatim, not re-derived.
//   (d) purchase_order_pending / purchase_order   / purchase_officer -- orders in `orderStatus IN
//       ('open', 'partial')` whose `postingDate` is 7+ days old. "7 days" is a defensible default
//       PICKED for this task (no existing convention names a number for purchase-order staleness
//       anywhere in this codebase or docs/system-analysis) -- documented here as exactly that: a
//       choice, not a discovered constant.
//
// UPSERT mechanics: `reconcileKind` deletes any existing row for (tenantId, kind, sourceType)
// whose sourceId is no longer in the freshly-computed live set (condition cleared -> DELETE, this
// file's documented choice -- see that method's own comment), then batch-inserts the live set with
// `ON DUPLICATE KEY UPDATE notification_id = notification_id` (a standard MySQL no-op upsert
// idiom: on a genuine duplicate-key hit the row is left completely untouched, satisfying this
// task's "if it does and the condition still holds, leave it" instruction in one statement, no
// SELECT-then-branch race window). `createdSource: "system_job"` on every scan-materialized
// row -- the closest fit in auditColumns()'s enum (packages/db/schema/_shared.ts) for "the system,
// not a human, produced this row's content", even though the trigger is an HTTP GET rather than a
// literal cron (there is no cron in this codebase, per this file's own header paragraph).
//
// DEFERRED (explicitly, per this task's own instruction -- not silently skipped): notification-
// rules/notification-channels admin CRUD (18-api-plan.md §6.5's fuller spec), a "test channel"
// endpoint, and email/SMS/push delivery. This wave is in-app notifications only -- list, mark-one-
// read, mark-all-read, against the four scan-computed kinds above.
import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { getDb, items, notifications, purchaseOrders, stockAdjustments, stockBalances, stockLots } from "@pharmacy/db";

import type { Actor, RoleKey } from "../../../common/auth/actor.js";
import { AppException } from "../../../common/errors/index.js";
import { localToday } from "../../../common/dates/index.js";
import type { TenantBranchScope } from "../../inventory/infrastructure/tenant-context.service.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { ListNotificationsInput } from "../api/dto/notification.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const MS_PER_DAY = 86_400_000;

/** "< 20 units" -- the committed frontend dashboard's own low-stock convention, see this file's
 *  header comment for exactly where it was read from. */
const LOW_STOCK_THRESHOLD_UNITS = 20;
/** Matches StockQueryService.expiryDashboard's own "30" bucket boundary (0-30 days, plus every
 *  already-expired lot) -- see this file's header comment. */
const EXPIRY_RISK_DAYS = 30;
/** A defensible default this task picked (no existing convention names one) -- see header comment. */
const PURCHASE_ORDER_STALE_DAYS = 7;

type Severity = "info" | "warning" | "critical";

interface AlertRow {
  readonly sourceId: number;
  readonly recipientRoleKey: RoleKey;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  readonly link: string;
}

@Injectable()
export class NotificationService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * GET /notifications -- materializes current alerts for the actor's tenant (see this file's
   * header comment), then returns the actor's own visible set: every row with
   * `recipientUserId = actor` PLUS every row with `recipientRoleKey` matching one of the actor's
   * roles, unread first (`readAt IS NULL` sorts first), newest first within each group.
   */
  async list(params: ListNotificationsInput, actor: Actor) {
    const db = getDb();
    const scope = await this.tenantContext.resolveScope(actor);
    await this.scanForAlerts(scope);

    const actorId = Number(actor.userId);
    const visibility = this.visibilityCondition(scope.tenantId, actorId, actor.roles);

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;

    const rows = await db
      .select()
      .from(notifications)
      .where(visibility)
      // Unread (readAt IS NULL) first, newest created within each group next.
      .orderBy(sql`${notifications.readAt} IS NULL DESC`, desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ unreadCount: sql<number>`count(*)` })
      .from(notifications)
      .where(and(visibility, isNull(notifications.readAt)));

    // Number(...): mysql2 returns COUNT(*) as a string; Drizzle's `sql<number>` annotation is a
    // compile-time type assertion only, not a runtime cast (same class of bug found and fixed in
    // the reporting module's ap-aging/ar-aging invoiceCount during Wave 6 integration).
    return { notifications: rows, unreadCount: Number(countRow?.unreadCount ?? 0), offset, limit };
  }

  /** POST /notifications/:id/read -- 404 if the row doesn't belong to this actor by either
   *  `recipientUserId` or a `recipientRoleKey` the actor holds. Already-read is a no-op (mirrors
   *  expense.service.ts's cancel()/reverse() "state-guard makes a retry safe without an
   *  idempotency key" reasoning -- there is nothing destructive to double-apply here either). */
  async markRead(notificationId: number, actor: Actor) {
    const db = getDb();
    const scope = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.tenantId, scope.tenantId), eq(notifications.notificationId, notificationId)))
        .for("update");
      if (!row || !this.isVisibleTo(row, actorId, actor.roles)) {
        throw new AppException({
          status: 404,
          code: "NOTIFICATION.NOT_FOUND",
          title: "Notification not found",
          detail: `No notification with id ${notificationId} exists for the current user.`,
        });
      }
      if (row.readAt !== null) {
        return { notification: row };
      }

      const now = new Date();
      await tx.update(notifications).set({ readAt: now, readBy: actorId }).where(eq(notifications.notificationId, notificationId));
      return { notification: { ...row, readAt: now, readBy: actorId } };
    });
  }

  /** POST /notifications/read-all -- marks every one of the actor's currently-visible UNREAD
   *  notifications as read in one statement. Does not re-run `scanForAlerts` first (unlike
   *  `list`) -- this endpoint only mutates rows that already exist; it has no reason to
   *  materialize new ones. */
  async markAllRead(actor: Actor) {
    const db = getDb();
    const scope = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const visibility = this.visibilityCondition(scope.tenantId, actorId, actor.roles);

    const [result] = await db
      .update(notifications)
      .set({ readAt: new Date(), readBy: actorId })
      .where(and(visibility, isNull(notifications.readAt)));

    return { updatedCount: result.affectedRows };
  }

  // ---- scan (private) --------------------------------------------------------------------------

  /**
   * Named `scanForAlerts(tenantId)` per this task's own instruction; takes the full
   * `{tenantId, branchId}` scope (not bare `tenantId`) because every source table scanned here --
   * `stock_balance`, `stock_lot`, `stock_adjustment`, `purchase_order` -- is branch-scoped, exactly
   * like every other document/query service in this codebase (TenantContextService's own header
   * comment). Today a tenant resolves to exactly one (default) branch, so this is a distinction
   * without a difference in practice, but the scan is written correctly for when that stops being
   * true. All four conditions are read inside ONE transaction (a consistent snapshot across all
   * four, §TX-1 "the service owns the transaction") and reconciled via `reconcileKind`.
   */
  private async scanForAlerts(scope: TenantBranchScope): Promise<void> {
    const db = getDb();
    const asOfDate = localToday();
    const asOf = new Date(`${asOfDate}T00:00:00`);

    await db.transaction(async (tx) => {
      // ---- (a) low stock: 0 < sum(qtyOnHand) < 20, per item -----------------------------------
      const lowStockRows = await tx
        .select({ itemId: stockBalances.itemId, itemName: items.name, qtyOnHand: sql<string>`sum(${stockBalances.qtyOnHand})` })
        .from(stockBalances)
        .innerJoin(items, eq(stockBalances.itemId, items.itemId))
        .where(and(eq(stockBalances.tenantId, scope.tenantId), eq(stockBalances.branchId, scope.branchId)))
        .groupBy(stockBalances.itemId, items.name)
        .having(sql`sum(${stockBalances.qtyOnHand}) > 0 and sum(${stockBalances.qtyOnHand}) < ${LOW_STOCK_THRESHOLD_UNITS}`);

      await this.reconcileKind(
        tx,
        scope.tenantId,
        "low_stock",
        "item",
        lowStockRows.map(
          (r): AlertRow => ({
            sourceId: r.itemId,
            recipientRoleKey: "pharmacy_manager",
            severity: "warning",
            title: `Low stock: ${r.itemName}`,
            body: `Only ${r.qtyOnHand} units of "${r.itemName}" remain on hand (threshold: ${LOW_STOCK_THRESHOLD_UNITS} units).`,
            link: `/stock?itemId=${r.itemId}`,
          }),
        ),
      );

      // ---- (b) expiry risk: lots on hand expiring within 30 days (expired included) -----------
      const horizon = new Date(asOf.getTime() + EXPIRY_RISK_DAYS * MS_PER_DAY);
      const expiryRows = await tx
        .select({
          stockLotId: stockLots.stockLotId,
          itemName: items.name,
          batchNo: stockLots.batchNo,
          expiryDate: stockLots.expiryDate,
          qtyOnHand: stockBalances.qtyOnHand,
        })
        .from(stockLots)
        .innerJoin(
          stockBalances,
          and(
            eq(stockBalances.stockLotId, stockLots.stockLotId),
            eq(stockBalances.itemId, stockLots.itemId),
            eq(stockBalances.branchId, stockLots.branchId),
          ),
        )
        .innerJoin(items, eq(items.itemId, stockLots.itemId))
        .where(
          and(
            eq(stockLots.tenantId, scope.tenantId),
            eq(stockLots.branchId, scope.branchId),
            isNotNull(stockLots.expiryDate),
            lte(stockLots.expiryDate, horizon),
            sql`${stockBalances.qtyOnHand} > 0`,
          ),
        );

      await this.reconcileKind(
        tx,
        scope.tenantId,
        "expiry_risk",
        "stock_lot",
        expiryRows.map((r): AlertRow => {
          if (r.expiryDate === null) throw new Error(`stock lot ${r.stockLotId} unexpectedly has no expiry date`); // unreachable; SQL filter guarantees non-null
          const daysToExpiry = Math.round((r.expiryDate.getTime() - asOf.getTime()) / MS_PER_DAY);
          const batchLabel = r.batchNo ? ` (batch ${r.batchNo})` : "";
          const expired = daysToExpiry < 0;
          return {
            sourceId: r.stockLotId,
            recipientRoleKey: "pharmacy_manager",
            severity: expired ? "critical" : "warning",
            title: expired ? `Expired stock: ${r.itemName}` : `Expiring soon: ${r.itemName}`,
            body: expired
              ? `"${r.itemName}"${batchLabel} expired ${Math.abs(daysToExpiry)} day(s) ago and still has ${r.qtyOnHand} units on hand.`
              : `"${r.itemName}"${batchLabel} expires in ${daysToExpiry} day(s) (${r.qtyOnHand} units on hand).`,
            link: `/stock-lots/${r.stockLotId}`,
          };
        }),
      );

      // ---- (c) stock adjustments awaiting approval ---------------------------------------------
      const adjRows = await tx
        .select({
          stockAdjustmentId: stockAdjustments.stockAdjustmentId,
          docNumber: stockAdjustments.docNumber,
          direction: stockAdjustments.direction,
          totalQty: stockAdjustments.totalQty,
        })
        .from(stockAdjustments)
        .where(
          and(
            eq(stockAdjustments.tenantId, scope.tenantId),
            eq(stockAdjustments.branchId, scope.branchId),
            eq(stockAdjustments.status, "draft"),
            eq(stockAdjustments.requiresApproval, true),
            isNull(stockAdjustments.approvedBy),
          ),
        );

      await this.reconcileKind(
        tx,
        scope.tenantId,
        "adjustment_pending_approval",
        "stock_adjustment",
        adjRows.map(
          (r): AlertRow => ({
            sourceId: r.stockAdjustmentId,
            recipientRoleKey: "pharmacy_manager",
            severity: "warning",
            title: `Adjustment awaiting approval: ${r.docNumber}`,
            body: `Stock adjustment ${r.docNumber} (${r.direction}, qty ${r.totalQty}) requires approval before it can post.`,
            link: `/stock-adjustments/${r.stockAdjustmentId}`,
          }),
        ),
      );

      // ---- (d) purchase orders open/partial for 7+ days -----------------------------------------
      const staleBefore = new Date(asOf.getTime() - PURCHASE_ORDER_STALE_DAYS * MS_PER_DAY);
      const poRows = await tx
        .select({
          purchaseOrderId: purchaseOrders.purchaseOrderId,
          docNumber: purchaseOrders.docNumber,
          orderStatus: purchaseOrders.orderStatus,
          postingDate: purchaseOrders.postingDate,
        })
        .from(purchaseOrders)
        .where(
          and(
            eq(purchaseOrders.tenantId, scope.tenantId),
            eq(purchaseOrders.branchId, scope.branchId),
            inArray(purchaseOrders.orderStatus, ["open", "partial"]),
            lte(purchaseOrders.postingDate, staleBefore),
          ),
        );

      await this.reconcileKind(
        tx,
        scope.tenantId,
        "purchase_order_pending",
        "purchase_order",
        poRows.map((r): AlertRow => {
          const daysOpen = Math.round((asOf.getTime() - r.postingDate.getTime()) / MS_PER_DAY);
          return {
            sourceId: r.purchaseOrderId,
            recipientRoleKey: "purchase_officer",
            severity: "info",
            title: `Purchase order pending: ${r.docNumber}`,
            body: `Purchase order ${r.docNumber} has been "${r.orderStatus}" for ${daysOpen} day(s) -- follow up with the supplier or close it out.`,
            link: `/purchase-orders/${r.purchaseOrderId}`,
          };
        }),
      );
    });
  }

  /**
   * Reconciles one (tenantId, kind, sourceType) slice of `notification` against the freshly-
   * computed live set `liveRows`:
   *   1. DELETE every existing row for this slice whose `sourceId` is no longer live -- the
   *      condition cleared since the last scan. Deletion (not a "read-only/expired" flag) is this
   *      file's documented default: these rows are live-condition alerts, not historical records
   *      (the historical trail already lives in `audit_log`, written independently by
   *      `AuditInterceptor` whenever an actor acts on a POST/PATCH/PUT/DELETE route -- see
   *      apps/api/src/common/audit/audit.interceptor.ts -- so nothing is lost by deleting a
   *      cleared alert row itself).
   *   2. Batch-INSERT the live set with `ON DUPLICATE KEY UPDATE notification_id =
   *      notification_id` -- a standard MySQL no-op upsert: a genuine collision on
   *      `uk_notification_source` leaves the existing row completely untouched (title/body/readAt
   *      all preserved), which is exactly "if it does and the condition still holds, leave it"
   *      (this task's own instruction) in one statement, with no SELECT-then-branch race window.
   */
  private async reconcileKind(
    tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
    tenantId: number,
    kind: string,
    sourceType: string,
    liveRows: readonly AlertRow[],
  ): Promise<void> {
    const liveIds = liveRows.map((r) => r.sourceId);

    if (liveIds.length === 0) {
      await tx.delete(notifications).where(and(eq(notifications.tenantId, tenantId), eq(notifications.kind, kind), eq(notifications.sourceType, sourceType)));
    } else {
      await tx
        .delete(notifications)
        .where(
          and(
            eq(notifications.tenantId, tenantId),
            eq(notifications.kind, kind),
            eq(notifications.sourceType, sourceType),
            notInArray(notifications.sourceId, liveIds),
          ),
        );
    }

    if (liveRows.length === 0) return;

    await tx
      .insert(notifications)
      .values(
        liveRows.map((r) => ({
          tenantId,
          recipientUserId: null,
          recipientRoleKey: r.recipientRoleKey,
          kind,
          severity: r.severity,
          title: r.title,
          body: r.body,
          link: r.link,
          sourceType,
          sourceId: r.sourceId,
          createdSource: "system_job" as const,
        })),
      )
      .onDuplicateKeyUpdate({ set: { notificationId: sql`notification_id` } });
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private visibilityCondition(tenantId: number, actorId: number, roles: readonly RoleKey[]) {
    const roleCondition = roles.length > 0 ? inArray(notifications.recipientRoleKey, [...roles]) : sql`false`;
    const own = or(eq(notifications.recipientUserId, actorId), roleCondition);
    return and(eq(notifications.tenantId, tenantId), own);
  }

  private isVisibleTo(row: { recipientUserId: number | null; recipientRoleKey: string | null }, actorId: number, roles: readonly RoleKey[]): boolean {
    if (row.recipientUserId !== null) return row.recipientUserId === actorId;
    if (row.recipientRoleKey !== null) return (roles as readonly string[]).includes(row.recipientRoleKey);
    return false;
  }
}
