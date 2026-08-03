// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.2 decision 3 / §7.9 --
// `stock_movement` (append-only) is the source of truth; `stock_balance` is the ONE synchronous
// same-transaction projection ("a cashier must not oversell"); negative stock is forbidden and
// enforced here with SELECT ... FOR UPDATE, never with a read-then-write pre-check (the legacy
// TOCTOU race, 08 §17.2). 08 §7.1: FEFO allocation order is (priority, expiry, smallest
// remaining qty); quarantined lots are excluded (08 §7.2 -- the legacy honoured `Locked`
// nowhere; this service is where the rebuild actually enforces it).
//
// TX-6 lock order note: balances are locked in stock_lot_id ASC order (deterministic across
// concurrent writers), THEN FEFO-sorted in memory -- lot counts per item are small.
import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { costAmount, Quantity } from "@pharmacy/money";
import { stockBalances, stockLots, stockMovements } from "@pharmacy/db";

import type { Tx } from "../../../common/db/index.js";
import { BusinessRuleException } from "../../../common/errors/index.js";

export interface MovementInput {
  readonly tenantId: number;
  readonly branchId: number;
  readonly itemId: number;
  readonly stockLotId: number;
  /** Signed loose-unit quantity delta as a Quantity.toDb() string; positive = in, negative = out. */
  readonly qtyDelta: string;
  /** Frozen per-loose-unit cost (AVG_COST 5dp string) -- COGS on outbound, receipt cost inbound. */
  readonly unitCost: string;
  readonly documentTypeId: number;
  readonly sourceDocumentId: number;
  readonly sourceLineId?: number;
  readonly fiscalPeriodId: number;
  readonly postingDate: string; // YYYY-MM-DD
  readonly reasonId?: number;
  readonly actorId: number;
}

export interface FefoAllocation {
  readonly stockLotId: number;
  readonly qty: string; // loose units allocated from this lot
  readonly batchNo: string | null;
  readonly expiryDate: Date | null;
  readonly unitCost: string; // the item avg cost is stamped by the caller; this echoes receipt cost
}

@Injectable()
export class StockService {
  /**
   * Append one stock movement and synchronously project it onto stock_balance. The balance row
   * is locked FOR UPDATE; a decrement that would go negative throws `422
   * INVENTORY.INSUFFICIENT_STOCK` and rolls the caller's transaction back (N-3). Movements are
   * deltas -- callers never compute absolute quantities (N-4).
   */
  async applyMovement(tx: Tx, input: MovementInput): Promise<void> {
    const delta = Quantity.fromDb(input.qtyDelta);
    if (delta.isZero()) {
      throw new BusinessRuleException(
        "INVENTORY.ZERO_MOVEMENT",
        "Empty movement",
        "A stock movement must change quantity (ck_stock_movement_qty).",
      );
    }

    const [balance] = await tx
      .select()
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.branchId, input.branchId),
          eq(stockBalances.itemId, input.itemId),
          eq(stockBalances.stockLotId, input.stockLotId),
        ),
      )
      .for("update");

    const before = balance ? Quantity.fromDb(balance.qtyOnHand) : Quantity.zero();
    const after = before.add(delta);
    if (after.isNegative()) {
      throw new BusinessRuleException(
        "INVENTORY.INSUFFICIENT_STOCK",
        "Not enough stock",
        `Lot ${input.stockLotId} has ${before.toDb()} on hand; cannot remove ${delta.toDb().replace("-", "")}.`,
      );
    }

    await tx.insert(stockMovements).values({
      tenantId: input.tenantId,
      branchId: input.branchId,
      itemId: input.itemId,
      stockLotId: input.stockLotId,
      occurredAt: new Date(),
      postingDate: new Date(`${input.postingDate}T00:00:00`),
      fiscalPeriodId: input.fiscalPeriodId,
      documentTypeId: input.documentTypeId,
      sourceDocumentId: input.sourceDocumentId,
      sourceLineId: input.sourceLineId ?? null,
      qtyDelta: delta.toDb(),
      unitCost: input.unitCost,
      costAmount: costAmount(delta.toDb(), input.unitCost).replace("-", ""),
      qtyBefore: before.toDb(),
      qtyAfter: after.toDb(),
      reasonId: input.reasonId ?? null,
      createdBy: input.actorId,
      createdSource: "api",
    });

    if (balance) {
      await tx
        .update(stockBalances)
        .set({ qtyOnHand: after.toDb(), lastMovementAt: new Date() })
        .where(
          and(
            eq(stockBalances.branchId, input.branchId),
            eq(stockBalances.itemId, input.itemId),
            eq(stockBalances.stockLotId, input.stockLotId),
          ),
        );
    } else {
      await tx.insert(stockBalances).values({
        tenantId: input.tenantId,
        branchId: input.branchId,
        itemId: input.itemId,
        stockLotId: input.stockLotId,
        qtyOnHand: after.toDb(),
        qtyReserved: "0.0000",
        lastMovementAt: new Date(),
      });
    }
  }

  /**
   * FEFO-allocate `qtyRequired` loose units of an item across its available lots (B-2: lowest
   * priority, earliest expiry, smallest remaining qty). Locks every candidate balance FOR
   * UPDATE in stock_lot_id ASC order first (TX-6 deterministic lock order), then sorts. Throws
   * `422 INVENTORY.INSUFFICIENT_STOCK` when the item cannot cover the request.
   */
  async allocateFefo(
    tx: Tx,
    params: { tenantId: number; branchId: number; itemId: number; qtyRequired: string },
  ): Promise<FefoAllocation[]> {
    const rows = await tx
      .select({
        stockLotId: stockBalances.stockLotId,
        qtyOnHand: stockBalances.qtyOnHand,
        priority: stockLots.priority,
        expiryDate: stockLots.expiryDate,
        expiryKey: stockLots.expiryKey,
        batchNo: stockLots.batchNo,
        lotStatus: stockLots.lotStatus,
        receiptUnitCost: stockLots.receiptUnitCost,
      })
      .from(stockBalances)
      .innerJoin(stockLots, eq(stockBalances.stockLotId, stockLots.stockLotId))
      .where(and(eq(stockBalances.branchId, params.branchId), eq(stockBalances.itemId, params.itemId)))
      .orderBy(asc(stockBalances.stockLotId))
      .for("update");

    // B-7: quarantined/recalled/expired lots are NOT silently consumable (fixes the legacy
    // `Locked` no-op). Expired-lot *dates* are guarded at the sale service layer (B-9 warn/
    // block/allow option); here only hard lot statuses filter.
    const candidates = rows
      .filter((r) => r.lotStatus === "available" && !Quantity.fromDb(r.qtyOnHand).isZero())
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority; // B-2 (1) priority
        const ax = a.expiryKey?.getTime() ?? Infinity;
        const bx = b.expiryKey?.getTime() ?? Infinity;
        if (ax !== bx) return ax - bx; // B-2 (2) FEFO
        const qcmp = Quantity.fromDb(a.qtyOnHand).compare(Quantity.fromDb(b.qtyOnHand));
        if (qcmp !== 0) return qcmp; // B-2 (3) drain fragments first
        return a.stockLotId - b.stockLotId; // stable tie-break
      });

    const allocations: FefoAllocation[] = [];
    let remaining = Quantity.fromDb(params.qtyRequired);
    for (const lot of candidates) {
      if (remaining.isZero()) break;
      const onHand = Quantity.fromDb(lot.qtyOnHand);
      const take = onHand.compare(remaining) <= 0 ? onHand : remaining;
      allocations.push({
        stockLotId: lot.stockLotId,
        qty: take.toDb(),
        batchNo: lot.batchNo,
        expiryDate: lot.expiryDate,
        unitCost: lot.receiptUnitCost ?? "0.0000",
      });
      remaining = remaining.sub(take);
    }

    if (!remaining.isZero()) {
      throw new BusinessRuleException(
        "INVENTORY.INSUFFICIENT_STOCK",
        "Not enough stock",
        `Item ${params.itemId}: short by ${remaining.toDb()} loose units across available lots.`,
      );
    }
    return allocations;
  }
}
