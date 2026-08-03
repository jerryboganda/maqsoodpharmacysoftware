// Blueprint: docs/system-analysis/08-inventory-logic.md §8.1-§8.4 -- perpetual moving weighted
// average, maintained at ITEM level (`item.avg_unit_cost`), recomputed on every inbound
// movement, item-total stock across all locations as the denominator base. Which documents move
// the average is a per-document decision the CALLER makes (C-5 defaults: purchase always;
// adjustment-increase yes; sale/returns never). Every application writes an immutable
// `item_cost_snapshot` row (C-9) so the average is replayable, not a client-side mystery.
//
// The arithmetic itself lives in @pharmacy/money (Rule M): `movingAverage`/`unitCostIn`.
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { movingAverage, Quantity } from "@pharmacy/money";
import { itemCostSnapshots, items, stockBalances } from "@pharmacy/db";

import type { Tx } from "../../../common/db/index.js";
import { BusinessRuleException } from "../../../common/errors/index.js";

export interface ApplyInboundCostInput {
  readonly tenantId: number;
  readonly itemId: number;
  /** Total inbound loose units INCLUDING bonus (C-3 -- bonus units are cost-diluting). */
  readonly qtyIn: string;
  /** Per-loose-unit incoming cost, already at 5dp (Costing.unitCostIn). */
  readonly unitCostIn: string;
  readonly costBasis: "net_rate" | "gross_price" | "manual" | "migration";
  readonly documentTypeId: number;
  readonly sourceDocumentId: number;
  readonly postingDate: string;
  readonly actorId: number;
}

@Injectable()
export class CostingService {
  /**
   * Recompute and persist the item's moving average for one inbound line, locking the item row
   * (TX-6: item lock comes after doc_counter, before gl inserts). Returns
   * `{ avgBefore, avgAfter }` so document lines can stamp both (§T78 avg_cost_before/after).
   */
  async applyInbound(tx: Tx, input: ApplyInboundCostInput): Promise<{ avgBefore: string; avgAfter: string }> {
    const [item] = await tx
      .select({ itemId: items.itemId, avgUnitCost: items.avgUnitCost })
      .from(items)
      .where(and(eq(items.tenantId, input.tenantId), eq(items.itemId, input.itemId)))
      .for("update");
    if (!item) {
      throw new BusinessRuleException("CATALOG.ITEM_MISSING", "Unknown item", `Item ${input.itemId} does not exist.`);
    }

    // C-2: StockBefore = the item's total on-hand across ALL locations, loose units. Summed from
    // the synchronous stock_balance projection inside this same transaction. NOTE: the caller
    // must apply costing BEFORE writing this line's own stock movement, so the balance still
    // reads pre-receipt (matching the legacy formula's read point, 08 §8.2).
    // Locked (SELECT ... FOR UPDATE), same as the item row above: under REPEATABLE READ an
    // unlocked read here could miss a concurrently-committing write to a different lot's
    // stock_balance row for this item (e.g. a concurrent adjustment that doesn't touch `items`
    // and so isn't blocked by the lock two lines up), producing a stale StockBefore.
    const balances = await tx
      .select({ qtyOnHand: stockBalances.qtyOnHand })
      .from(stockBalances)
      .where(and(eq(stockBalances.tenantId, input.tenantId), eq(stockBalances.itemId, input.itemId)))
      .for("update");
    let stockBefore = Quantity.zero();
    for (const b of balances) stockBefore = stockBefore.add(Quantity.fromDb(b.qtyOnHand));

    const avgBefore = item.avgUnitCost;
    const avgAfter = movingAverage({
      stockBefore: stockBefore.toDb(),
      avgBefore,
      qtyIn: input.qtyIn,
      unitCostIn: input.unitCostIn,
    });

    await tx.update(items).set({ avgUnitCost: avgAfter }).where(eq(items.itemId, input.itemId));
    await tx.insert(itemCostSnapshots).values({
      tenantId: input.tenantId,
      itemId: input.itemId,
      effectiveAt: new Date(),
      postingDate: new Date(`${input.postingDate}T00:00:00`),
      avgUnitCost: avgAfter,
      previousAvgUnitCost: avgBefore,
      qtyOnHandBefore: stockBefore.toDb(),
      qtyIn: input.qtyIn,
      unitCostIn: input.unitCostIn,
      costBasis: input.costBasis,
      documentTypeId: input.documentTypeId,
      sourceDocumentId: input.sourceDocumentId,
      createdBy: input.actorId,
      createdSource: "api",
    });

    return { avgBefore, avgAfter };
  }
}
