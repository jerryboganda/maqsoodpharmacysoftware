// Read-side of the inventory module (18-api-plan.md §2.4): per-item balances, the append-only
// movement ledger (keyset-lite pagination -- 18 §1 "Keyset (cursor)": no totalItems on the
// 700K-row stream), and the lot browser. Plain reads, no transaction (TX-1 -- services own
// transactions; none is needed here).
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, lt, lte, sql } from "drizzle-orm";
import { customers, getDb, items, saleInvoiceLines, saleInvoices, stockBalances, stockLots, stockMovements, suppliers } from "@pharmacy/db";

import { localToday } from "../../../common/dates/index.js";
import { AppException } from "../../../common/errors/index.js";
import type { TenantBranchScope } from "../infrastructure/tenant-context.service.js";

export interface StockListFilters {
  readonly itemId?: number | undefined;
  readonly includeZero?: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface MovementListFilters {
  readonly itemId?: number | undefined;
  readonly stockLotId?: number | undefined;
  readonly limit: number;
  readonly afterId?: number | undefined;
}

export interface LotListFilters {
  readonly itemId?: number | undefined;
  readonly lotStatus?: "available" | "quarantined" | "expired" | "recalled" | "consumed" | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ExpiryDashboardFilters {
  readonly itemId?: number | undefined;
}

@Injectable()
export class StockQueryService {
  /** GET /stock -- one row per item: on-hand across lots, lot count, nearest live expiry, avg cost. */
  async listStock(scope: TenantBranchScope, filters: StockListFilters) {
    const db = getDb();
    const conditions = [eq(stockBalances.tenantId, scope.tenantId), eq(stockBalances.branchId, scope.branchId)];
    if (filters.itemId !== undefined) conditions.push(eq(stockBalances.itemId, filters.itemId));

    const qtyOnHand = sql<string>`sum(${stockBalances.qtyOnHand})`;
    const rows = await db
      .select({
        itemId: stockBalances.itemId,
        itemName: items.name,
        qtyOnHand,
        lotCount: sql<number>`count(distinct ${stockBalances.stockLotId})`,
        // Only lots still physically held contribute a "nearest expiry" (zero-qty rows are
        // retained by design, §T58 -- they must not resurrect an old expiry date here).
        nearestExpiry: sql<string | null>`min(case when ${stockBalances.qtyOnHand} > 0 then ${stockLots.expiryDate} end)`,
        avgCost: items.avgUnitCost,
      })
      .from(stockBalances)
      .innerJoin(items, eq(stockBalances.itemId, items.itemId))
      .innerJoin(stockLots, eq(stockBalances.stockLotId, stockLots.stockLotId))
      .where(and(...conditions))
      .groupBy(stockBalances.itemId, items.name, items.avgUnitCost)
      .having(filters.includeZero ? sql`1 = 1` : sql`sum(${stockBalances.qtyOnHand}) > 0`)
      .orderBy(stockBalances.itemId)
      .limit(filters.limit + 1)
      .offset(filters.offset);

    const hasMore = rows.length > filters.limit;
    return {
      data: rows.slice(0, filters.limit),
      meta: { limit: filters.limit, offset: filters.offset, hasMore },
    };
  }

  /** GET /stock/movements -- newest first, keyset-lite via `afterId` (id strictly below). */
  async listMovements(scope: TenantBranchScope, filters: MovementListFilters) {
    const db = getDb();
    const conditions = [eq(stockMovements.tenantId, scope.tenantId), eq(stockMovements.branchId, scope.branchId)];
    if (filters.itemId !== undefined) conditions.push(eq(stockMovements.itemId, filters.itemId));
    if (filters.stockLotId !== undefined) conditions.push(eq(stockMovements.stockLotId, filters.stockLotId));
    if (filters.afterId !== undefined) conditions.push(lt(stockMovements.stockMovementId, filters.afterId));

    const rows = await db
      .select({
        stockMovementId: stockMovements.stockMovementId,
        occurredAt: stockMovements.occurredAt,
        postingDate: stockMovements.postingDate,
        itemId: stockMovements.itemId,
        stockLotId: stockMovements.stockLotId,
        direction: stockMovements.direction,
        qtyDelta: stockMovements.qtyDelta,
        unitCost: stockMovements.unitCost,
        costAmount: stockMovements.costAmount,
        qtyBefore: stockMovements.qtyBefore,
        qtyAfter: stockMovements.qtyAfter,
        documentTypeId: stockMovements.documentTypeId,
        sourceDocumentId: stockMovements.sourceDocumentId,
        sourceLineId: stockMovements.sourceLineId,
        reasonId: stockMovements.reasonId,
      })
      .from(stockMovements)
      .where(and(...conditions))
      .orderBy(desc(stockMovements.stockMovementId))
      .limit(filters.limit + 1);

    const page = rows.slice(0, filters.limit);
    const hasMore = rows.length > filters.limit;
    return {
      data: page,
      meta: {
        limit: filters.limit,
        hasMore,
        nextAfterId: hasMore && page.length > 0 ? page[page.length - 1]!.stockMovementId : null,
      },
    };
  }

  /** GET /stock-lots -- lots with their current branch on-hand joined from the projection. */
  async listLots(scope: TenantBranchScope, filters: LotListFilters) {
    const db = getDb();
    const conditions = [eq(stockLots.tenantId, scope.tenantId), eq(stockLots.branchId, scope.branchId)];
    if (filters.itemId !== undefined) conditions.push(eq(stockLots.itemId, filters.itemId));
    if (filters.lotStatus !== undefined) conditions.push(eq(stockLots.lotStatus, filters.lotStatus));

    const rows = await db
      .select({
        stockLotId: stockLots.stockLotId,
        itemId: stockLots.itemId,
        batchNo: stockLots.batchNo,
        expiryDate: stockLots.expiryDate,
        lotStatus: stockLots.lotStatus,
        priority: stockLots.priority,
        receiptUnitCost: stockLots.receiptUnitCost,
        qtyOnHand: sql<string>`coalesce(${stockBalances.qtyOnHand}, '0.0000')`,
      })
      .from(stockLots)
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.stockLotId, stockLots.stockLotId),
          eq(stockBalances.itemId, stockLots.itemId),
          eq(stockBalances.branchId, stockLots.branchId),
        ),
      )
      .where(and(...conditions))
      .orderBy(stockLots.stockLotId)
      .limit(filters.limit + 1)
      .offset(filters.offset);

    const hasMore = rows.length > filters.limit;
    return {
      data: rows.slice(0, filters.limit),
      meta: { limit: filters.limit, offset: filters.offset, hasMore },
    };
  }

  /**
   * GET /stock-lots/:id -- full lot detail: the lot row (same fields as `listLots`, plus
   * `holdReasonId`/`expiryStatus`/`manufacturedOn`/`receivedOn`/source-document soft refs) with
   * its current branch on-hand, plus its most recent movements (reuses `listMovements`'
   * `stockLotId` filter). 18-api-plan.md §2.5 additionally documents a resolved `sourceDocument`
   * object -- deferred here: `sourceDocumentTypeId`/`sourceDocumentId` are already on the row for
   * a caller to resolve, and a generic cross-document-type join is a separate increment, not
   * something this audit-fix task asked for.
   */
  async getLotById(scope: TenantBranchScope, stockLotId: number) {
    const db = getDb();
    const [lot] = await db
      .select({
        stockLotId: stockLots.stockLotId,
        itemId: stockLots.itemId,
        batchNo: stockLots.batchNo,
        expiryDate: stockLots.expiryDate,
        expiryStatus: stockLots.expiryStatus,
        manufacturedOn: stockLots.manufacturedOn,
        supplierId: stockLots.supplierId,
        sourceDocumentTypeId: stockLots.sourceDocumentTypeId,
        sourceDocumentId: stockLots.sourceDocumentId,
        receivedOn: stockLots.receivedOn,
        receiptUnitCost: stockLots.receiptUnitCost,
        lotStatus: stockLots.lotStatus,
        holdReasonId: stockLots.holdReasonId,
        priority: stockLots.priority,
        qtyOnHand: sql<string>`coalesce(${stockBalances.qtyOnHand}, '0.0000')`,
      })
      .from(stockLots)
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.stockLotId, stockLots.stockLotId),
          eq(stockBalances.itemId, stockLots.itemId),
          eq(stockBalances.branchId, stockLots.branchId),
        ),
      )
      .where(
        and(
          eq(stockLots.tenantId, scope.tenantId),
          eq(stockLots.branchId, scope.branchId),
          eq(stockLots.stockLotId, stockLotId),
        ),
      );
    if (!lot) {
      throw new AppException({
        status: 404,
        code: "INVENTORY.STOCK_LOT_NOT_FOUND",
        title: "Stock lot not found",
        detail: `No stock lot with id ${stockLotId} exists.`,
      });
    }

    const movements = await this.listMovements(scope, { stockLotId, limit: 100 });
    return { ...lot, movements: movements.data };
  }

  /**
   * `GET /stock-lots/:id/recall-trace` -- Wave 9, R4.5's own literal promise: "given a batch,
   * every sale that dispensed it" (catalog.ts's own `stockLots` class comment names this "THE
   * recall link"). A patient-safety feature: if a manufacturer recalls a batch, this is the query
   * that answers "who did we sell it to". Every `sale_invoice_line` row that ever drew from this
   * lot -- INCLUDING lines on a since-cancelled/reversed invoice (a recall coordinator needs the
   * full dispensing history, not just what's still "active"; `status` is returned per row so the
   * caller can filter or highlight as needed, never silently dropped). 404 mirrors `getLotById`'s
   * own tenant/branch-scoped not-found handling exactly -- this is not a separate resource, just
   * a different read of the same lot.
   */
  async getRecallTrace(scope: TenantBranchScope, stockLotId: number) {
    const db = getDb();
    const [lot] = await db
      .select({
        stockLotId: stockLots.stockLotId,
        itemId: stockLots.itemId,
        itemName: items.name,
        batchNo: stockLots.batchNo,
        expiryDate: stockLots.expiryDate,
        lotStatus: stockLots.lotStatus,
        supplierId: stockLots.supplierId,
        supplierName: suppliers.name,
        sourceDocumentTypeId: stockLots.sourceDocumentTypeId,
        sourceDocumentId: stockLots.sourceDocumentId,
        receivedOn: stockLots.receivedOn,
      })
      .from(stockLots)
      .innerJoin(items, eq(items.itemId, stockLots.itemId))
      .leftJoin(suppliers, eq(suppliers.supplierId, stockLots.supplierId))
      .where(and(eq(stockLots.tenantId, scope.tenantId), eq(stockLots.branchId, scope.branchId), eq(stockLots.stockLotId, stockLotId)));
    if (!lot) {
      throw new AppException({
        status: 404,
        code: "INVENTORY.STOCK_LOT_NOT_FOUND",
        title: "Stock lot not found",
        detail: `No stock lot with id ${stockLotId} exists.`,
      });
    }

    const sales = await db
      .select({
        saleInvoiceLineId: saleInvoiceLines.saleInvoiceLineId,
        saleInvoiceId: saleInvoices.saleInvoiceId,
        docNumber: saleInvoices.docNumber,
        postingDate: saleInvoices.postingDate,
        status: saleInvoices.status,
        customerId: saleInvoices.customerId,
        customerName: customers.name,
        qtyBase: saleInvoiceLines.qtyBase,
        dispensingNote: saleInvoiceLines.dispensingNote, // U-062/D18/R7 -- same recall relevance a controlled-drug batch would need
      })
      .from(saleInvoiceLines)
      .innerJoin(saleInvoices, eq(saleInvoices.saleInvoiceId, saleInvoiceLines.saleInvoiceId))
      .leftJoin(customers, eq(customers.customerId, saleInvoices.customerId))
      .where(eq(saleInvoiceLines.stockLotId, stockLotId))
      .orderBy(desc(saleInvoices.postingDate), asc(saleInvoiceLines.saleInvoiceLineId));

    return { lot, sales };
  }

  /**
   * GET /inventory/expiry-dashboard -- lots with stock still on hand (`qtyOnHand > 0`),
   * expiring within 90 days of today (already-past-due lots included -- bucket `"expired"` --
   * since those are exactly the stock the `allocateFefo` expiry fix now refuses to sell, and
   * surfacing them is the whole point of this dashboard). Returns a flat, soonest-first list with
   * a computed `daysToExpiry`/`bucket` field per lot, matching every other list endpoint in this
   * file (`{ data, meta }`) -- NOT 18-api-plan.md §2.5's three-array-of-buckets response shape;
   * this task's instruction explicitly allowed either shape, and the flat list needs no separate
   * response contract. Unknown-expiry lots (`expiryDate: null`, §T56) never appear here -- R4.6's
   * separate unknown-expiry queue is a different, undelivered endpoint.
   */
  async expiryDashboard(scope: TenantBranchScope, filters: ExpiryDashboardFilters) {
    const db = getDb();
    const asOfDate = localToday();
    const asOf = new Date(`${asOfDate}T00:00:00`);
    const MS_PER_DAY = 86_400_000;
    const horizon = new Date(asOf.getTime() + 90 * MS_PER_DAY);

    const conditions = [
      eq(stockLots.tenantId, scope.tenantId),
      eq(stockLots.branchId, scope.branchId),
      isNotNull(stockLots.expiryDate),
      lte(stockLots.expiryDate, horizon),
    ];
    if (filters.itemId !== undefined) conditions.push(eq(stockLots.itemId, filters.itemId));

    const rows = await db
      .select({
        stockLotId: stockLots.stockLotId,
        itemId: stockLots.itemId,
        itemName: items.name,
        batchNo: stockLots.batchNo,
        expiryDate: stockLots.expiryDate,
        lotStatus: stockLots.lotStatus,
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
      .where(and(...conditions, sql`${stockBalances.qtyOnHand} > 0`))
      .orderBy(asc(stockLots.expiryDate));

    const data = rows.map((r) => {
      if (r.expiryDate === null) {
        throw new Error(`stock lot ${r.stockLotId} unexpectedly has no expiry date`); // unreachable; SQL filter guarantees non-null
      }
      const daysToExpiry = Math.round((r.expiryDate.getTime() - asOf.getTime()) / MS_PER_DAY);
      const bucket = daysToExpiry < 0 ? "expired" : daysToExpiry <= 30 ? "30" : daysToExpiry <= 60 ? "60" : "90";
      return { ...r, expiryDate: r.expiryDate, daysToExpiry, bucket };
    });

    return { data, meta: { asOfDate } };
  }
}
