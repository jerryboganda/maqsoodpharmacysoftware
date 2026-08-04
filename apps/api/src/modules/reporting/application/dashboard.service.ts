// GET /dashboards/summary -- one real aggregate call the dashboard frontend page can use instead
// of composing money totals client-side (Rule M forbids client-side money aggregation, per the
// task instruction). Every money field below is a real server-side SQL SUM (or the shared
// report-queries.ts helpers, themselves SQL SUMs) -- never a client-composed total.
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, purchaseInvoices, purchaseOrders, saleInvoices, stockAdjustments } from "@pharmacy/db";
import { Quantity } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import { localToday } from "../../../common/dates/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import { toBusinessDate } from "./report-helpers.js";
import { computeExpiryBuckets, DEFAULT_LOW_STOCK_THRESHOLD, getCashBankBalances, queryLowStockItems } from "./report-queries.js";

@Injectable()
export class DashboardService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async summary(actor: Actor) {
    const db = getDb();
    const scope = await this.tenantContext.resolveScope(actor);
    const today = toBusinessDate(localToday());

    const [todaysSales] = await db
      .select({
        total: sql<string>`cast(coalesce(sum(${saleInvoices.netAmount}), 0) as decimal(15,2))`,
        count: sql<number>`count(*)`,
      })
      .from(saleInvoices)
      .where(
        and(
          eq(saleInvoices.tenantId, scope.tenantId),
          eq(saleInvoices.branchId, scope.branchId),
          eq(saleInvoices.status, "posted"),
          eq(saleInvoices.postingDate, today),
        ),
      );

    const [ap] = await db
      .select({ total: sql<string>`cast(coalesce(sum(${purchaseInvoices.balanceAmount}), 0) as decimal(15,2))` })
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.tenantId, scope.tenantId), eq(purchaseInvoices.branchId, scope.branchId), eq(purchaseInvoices.status, "posted")));

    const [ar] = await db
      .select({ total: sql<string>`cast(coalesce(sum(${saleInvoices.balanceAmount}), 0) as decimal(15,2))` })
      .from(saleInvoices)
      .where(and(eq(saleInvoices.tenantId, scope.tenantId), eq(saleInvoices.branchId, scope.branchId), eq(saleInvoices.status, "posted")));

    const cashBankBalances = await getCashBankBalances(scope);

    const [pendingPo] = await db
      .select({ count: sql<number>`count(*)` })
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, scope.tenantId),
          eq(purchaseOrders.branchId, scope.branchId),
          inArray(purchaseOrders.orderStatus, ["open", "partial"]),
        ),
      );

    // Default threshold (20 units, PharmacyDashboardPage.svelte's convention) -- the dashboard
    // summary has no per-request filter to override it, unlike the low-stock report itself.
    const lowStockThreshold = Quantity.fromDb(DEFAULT_LOW_STOCK_THRESHOLD);
    const lowStockRows = await queryLowStockItems(scope, lowStockThreshold);

    const expiry = await computeExpiryBuckets(scope);

    const [adjustments] = await db
      .select({ count: sql<number>`count(*)` })
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

    // Number(...) on every count: mysql2 returns COUNT(*) as a string; Drizzle's `sql<number>`
    // annotation is a compile-time type assertion only, not a runtime cast (same bug class found
    // and fixed in reports.service.ts/report-queries.ts/notification.service.ts during Wave 6
    // integration -- these three were type-wrong, not computationally wrong, since none of them
    // get added to anything here, but a frontend consuming this DTO as `number` deserves a real
    // number, not a numeric-looking string).
    return {
      todaysSalesTotal: todaysSales?.total ?? "0.00",
      todaysSaleCount: Number(todaysSales?.count ?? 0),
      outstandingApTotal: ap?.total ?? "0.00",
      outstandingArTotal: ar?.total ?? "0.00",
      cashBankBalances,
      pendingPurchaseOrderCount: Number(pendingPo?.count ?? 0),
      lowStockCount: lowStockRows.length,
      expiryValueAtRisk: expiry.totalValue,
      adjustmentsAwaitingApprovalCount: Number(adjustments?.count ?? 0),
    };
  }
}
