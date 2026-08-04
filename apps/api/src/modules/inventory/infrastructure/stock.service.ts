// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.2 decision 3 / §7.9 --
// `stock_movement` (append-only) is the source of truth; `stock_balance` is the ONE synchronous
// same-transaction projection ("a cashier must not oversell"); negative stock is forbidden and
// enforced here with SELECT ... FOR UPDATE, never with a read-then-write pre-check (the legacy
// TOCTOU race, 08 §17.2). 08 §7.1: FEFO allocation order is (priority, expiry, smallest
// remaining qty); quarantined lots are excluded (08 §7.2 -- the legacy honoured `Locked`
// nowhere; this service is where the rebuild actually enforces it).
//
// Expiry-by-DATE fix (post-audit): `allocateFefo` also excludes lots whose `expiryDate` is
// before the caller's `asOfDate` -- nothing in this codebase ever transitions `lot_status` to
// 'expired' automatically, so date-based exclusion has to happen here, not by trusting the
// status column alone. See `allocateFefo`'s own comment for the full rationale.
//
// TX-6 lock order note: balances are locked in stock_lot_id ASC order (deterministic across
// concurrent writers), THEN FEFO-sorted in memory -- lot counts per item are small.
import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { costAmount, Quantity } from "@pharmacy/money";
import { stockBalances, stockLots, stockMovements } from "@pharmacy/db";

import type { DbOrTx, Tx } from "../../../common/db/index.js";
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
   *
   * Takes `DbOrTx`, not just `Tx` (widened for sale-invoices.service.ts's `preview` -- a dry run
   * that deliberately never opens a write transaction, per that method's own header comment).
   * Called with a plain `Db`, the `FOR UPDATE` lock is still valid SQL (MySQL auto-commits each
   * standalone statement, so the lock is acquired and released within that one SELECT) -- it just
   * cannot hold across multiple statements the way it does inside a real transaction. That is
   * exactly right for a preview: it reports availability as of right now, on a best-effort basis,
   * same as every other "how much is on hand" read in this codebase (StockQueryService has none
   * of these locks at all) -- it was never going to guarantee the allocation still holds by the
   * time a real `POST /sale-invoices` follows it. Every real write path (`createCashSale`) still
   * passes its own `Tx`, so the lock keeps its full cross-statement meaning there.
   */
  async allocateFefo(
    tx: DbOrTx,
    params: {
      tenantId: number;
      branchId: number;
      itemId: number;
      qtyRequired: string;
      /** The business date this allocation happens on, `"YYYY-MM-DD"` -- same convention as
       *  `MovementInput.postingDate` / `CreateAdjustmentInput.documentDate`. Required (not
       *  defaulted to a raw `new Date()` in here): this runs inside the caller's transaction,
       *  and every other date-sensitive write in this module takes "now" from the caller's
       *  business date for the same reason -- deterministic, replayable, no server-clock read
       *  inside a DB transaction. Lots whose `expiryDate` is strictly before this date are
       *  excluded from allocation (see the filter below). */
      asOfDate: string;
    },
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

    // B-7: quarantined/recalled/consumed lots are NOT silently consumable (fixes the legacy
    // `Locked` no-op) -- filtered by lotStatus here.
    const usableStatusRows = rows.filter(
      (r) => r.lotStatus === "available" && !Quantity.fromDb(r.qtyOnHand).isZero(),
    );

    // Expiry-by-DATE fix: an 'available'-status lot whose expiryDate has already passed used to
    // be allocated anyway -- nothing anywhere in this codebase ever flips lot_status to
    // 'expired' automatically (no scheduled job, no write path sets it), so relying on lotStatus
    // alone silently sold expired stock. `expiryDate === null` (unknown expiry, §T56) is NEVER
    // excluded here -- an unknown expiry is not a known-past expiry. A lot expiring exactly on
    // `asOfDate` is still usable (excluded only once strictly before it).
    const asOf = new Date(`${params.asOfDate}T00:00:00`);
    const candidates = usableStatusRows
      .filter((r) => r.expiryDate === null || r.expiryDate.getTime() >= asOf.getTime())
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
      // Every 'available'-status lot with stock is past its expiry -- distinct from ordinary
      // insufficient stock (post-audit fix instruction): the generic INSUFFICIENT_STOCK message
      // would read as "no stock exists" when stock in fact exists but is expired, a materially
      // different situation for staff to act on (write-off/return vs reorder). Only raised when
      // NO non-expired candidate exists at all; a partial shortfall alongside some expired lots
      // still reports as ordinary INSUFFICIENT_STOCK below.
      if (candidates.length === 0 && usableStatusRows.length > 0) {
        throw new BusinessRuleException(
          "INVENTORY.EXPIRED_STOCK_ONLY",
          "Only expired stock available",
          `Item ${params.itemId}: ${usableStatusRows.length} lot(s) with stock on hand exist but all are past their expiry date as of ${params.asOfDate}; none can be allocated.`,
        );
      }
      throw new BusinessRuleException(
        "INVENTORY.INSUFFICIENT_STOCK",
        "Not enough stock",
        `Item ${params.itemId}: short by ${remaining.toDb()} loose units across available lots.`,
      );
    }
    return allocations;
  }
}
