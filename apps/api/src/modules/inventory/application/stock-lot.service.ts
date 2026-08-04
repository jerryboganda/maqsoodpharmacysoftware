// Stock-lot lifecycle mutations: hold (quarantine) and release. 18-api-plan.md §2.5 documents
// these as `POST /stock-lots/{id}/hold` and `/release` -- see stock.dto.ts's HoldStockLotSchema/
// ReleaseStockLotSchema and packages/db/scripts/seed.ts's PERMISSIONS block comment for where this
// increment's naming/role scheme deliberately diverges from that doc (explicit task instruction).
//
// Same lock-then-validate-then-update shape as StockAdjustmentService.approve()/post(): the row
// is loaded FOR UPDATE, its current lotStatus is checked, then updated in place. A held
// ('quarantined') lot is excluded from FEFO allocation automatically -- StockService.allocateFefo
// only ever considers lotStatus === 'available' rows, so no extra filter is needed there.
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { getDb, stockLots } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { BusinessRuleException } from "../../../common/errors/index.js";
import type { TenantBranchScope } from "../infrastructure/tenant-context.service.js";

export interface HoldStockLotInput {
  readonly holdReasonId?: number | undefined;
  readonly reason?: string | undefined;
}

export interface ReleaseStockLotInput {
  readonly reason?: string | undefined;
}

@Injectable()
export class StockLotService {
  /**
   * POST /stock-lots/:id/hold -- 'available' -> 'quarantined'. `holdReasonId` is the real
   * soft-ref column on `stock_lot` (catalog.ts, -> option_item) and is persisted when supplied.
   * `reason` is accepted for the request's audit trail (mirrors StockAdjustmentService.approve()'s
   * identical choice) but there is no free-text column on `stock_lot` to persist it.
   */
  async hold(scope: TenantBranchScope, actor: Actor, stockLotId: number, input: HoldStockLotInput) {
    const db = getDb();
    const actorId = Number(actor.userId);
    void input.reason; // accepted for the API contract, not persisted (no column yet)

    await db.transaction(async (tx) => {
      const [lot] = await tx
        .select()
        .from(stockLots)
        .where(and(eq(stockLots.tenantId, scope.tenantId), eq(stockLots.branchId, scope.branchId), eq(stockLots.stockLotId, stockLotId)))
        .for("update");
      if (!lot) {
        throw new BusinessRuleException(
          "INVENTORY.STOCK_LOT_NOT_FOUND",
          "Stock lot missing",
          `Stock lot ${stockLotId} does not exist.`,
        );
      }
      if (lot.lotStatus !== "available") {
        // Covers "already held" as well as recalled/expired/consumed -- hold is specifically the
        // available -> quarantined transition; every other starting status is a 422, not a no-op.
        throw new BusinessRuleException(
          "INVENTORY.LOT_NOT_HOLDABLE",
          "Cannot hold this lot",
          `Stock lot ${stockLotId} is '${lot.lotStatus}', not 'available'; only an available lot can be put on hold.`,
        );
      }

      await tx
        .update(stockLots)
        .set({
          lotStatus: "quarantined",
          holdReasonId: input.holdReasonId ?? null,
          updatedBy: actorId,
        })
        .where(eq(stockLots.stockLotId, stockLotId));
    });

    return this.getRow(scope, stockLotId);
  }

  /**
   * POST /stock-lots/:id/release -- 'quarantined' -> 'available'. 422 `INVENTORY.LOT_NOT_HELD`
   * when the lot is not currently held (this task's explicit precondition).
   */
  async release(scope: TenantBranchScope, actor: Actor, stockLotId: number, input: ReleaseStockLotInput) {
    const db = getDb();
    const actorId = Number(actor.userId);
    void input.reason; // accepted for the API contract, not persisted (no column yet)

    await db.transaction(async (tx) => {
      const [lot] = await tx
        .select()
        .from(stockLots)
        .where(and(eq(stockLots.tenantId, scope.tenantId), eq(stockLots.branchId, scope.branchId), eq(stockLots.stockLotId, stockLotId)))
        .for("update");
      if (!lot) {
        throw new BusinessRuleException(
          "INVENTORY.STOCK_LOT_NOT_FOUND",
          "Stock lot missing",
          `Stock lot ${stockLotId} does not exist.`,
        );
      }
      if (lot.lotStatus !== "quarantined") {
        throw new BusinessRuleException(
          "INVENTORY.LOT_NOT_HELD",
          "Lot is not held",
          `Stock lot ${stockLotId} is '${lot.lotStatus}', not 'quarantined'; only a held lot can be released.`,
        );
      }

      await tx
        .update(stockLots)
        .set({ lotStatus: "available", holdReasonId: null, updatedBy: actorId })
        .where(eq(stockLots.stockLotId, stockLotId));
    });

    return this.getRow(scope, stockLotId);
  }

  private async getRow(scope: TenantBranchScope, stockLotId: number) {
    const db = getDb();
    const [lot] = await db
      .select()
      .from(stockLots)
      .where(and(eq(stockLots.tenantId, scope.tenantId), eq(stockLots.stockLotId, stockLotId)));
    if (!lot) throw new Error(`stock_lot ${stockLotId} vanished after update`); // unreachable; defensive
    return lot;
  }
}
