// Read-side of the inventory module (18-api-plan.md §2.4): per-item balances, the append-only
// movement ledger (keyset-lite pagination -- 18 §1 "Keyset (cursor)": no totalItems on the
// 700K-row stream), and the lot browser. Plain reads, no transaction (TX-1 -- services own
// transactions; none is needed here).
import { Injectable } from "@nestjs/common";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb, items, stockBalances, stockLots, stockMovements } from "@pharmacy/db";

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
}
