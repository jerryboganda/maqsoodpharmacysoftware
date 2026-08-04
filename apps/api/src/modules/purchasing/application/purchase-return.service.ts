// Blueprint: docs/system-analysis/05b-workflows-purchase.md (supplier return), 19-mysql-schema-
// blueprint.md §T80/§T81, 17-technical-blueprint.md §7 (TX rules). Structural mirror of
// purchase-invoice.service.ts's createAndPost -- a purchase return is the SAME seriousness of
// financial/inventory event as a purchase invoice, just the reverse direction, so it gets the
// same create-and-post-in-one-transaction shape (no separate draft/approve/post workflow).
//
// Costing (explicit scope decision, per the task this file was written against): purchase
// returns do NOT re-run the moving-average costing formula in reverse. Moving average is a
// one-way aggregation (it folds every receipt's cost into a single rolling number) and is not
// cleanly invertible -- "undo this one receipt's contribution to the average" requires replaying
// the full cost history from that point forward, which is out of scope here. Instead, a return
// posts stock OUT and the GL entry at the ORIGINAL invoice line's own unit_cost_in (never a
// freshly recomputed average), and item.avg_unit_cost is left completely untouched. The line's
// avg_cost_before/avg_cost_after columns (informational costing-chain snapshots, §T78/§T81) are
// stamped to the item's CURRENT average on both sides -- honestly representing "this document
// did not move the average" rather than defaulting to a misleading 0.00000.
//
// GL (mirrors purchase-invoice.service.ts's S-5 perpetual-inventory posting, reversed):
//   Dr supplier.glAccountId  netTotal   (reduces what we owe the supplier -- AP is credit-normal,
//                                        so a return reduces it with a DEBIT, the opposite side
//                                        from purchase-invoice.service.ts's own supplier leg)
//   Cr 1200 Inventory        netTotal
//
// Quantity invariant (the task's explicit ask, beyond what StockService's own negative-balance
// guard gives for free): returnQty must not exceed what was actually received on the referenced
// purchase-invoice line, net of any prior returns already posted against that same line. This is
// a STRICTER, more specific invariant than "enough physical stock in the lot" -- a lot can be
// topped up by a LATER, unrelated receipt, so the lot's on-hand balance alone would not catch
// "returning more against invoice X's line than invoice X's line ever contributed." Both guards
// run: this service's own over-return check, AND (for free, via StockService.applyMovement)
// the lot-balance non-negativity guard purchase-invoice.service.ts / stock.service.ts already
// rely on for every other document type.
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  getDb,
  glAccounts,
  items,
  purchaseCategories,
  purchaseInvoiceLines,
  purchaseInvoices,
  purchaseReturnLines,
  purchaseReturns,
  suppliers,
} from "@pharmacy/db";
import { costAmount, Money, Quantity } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { StockService } from "../../inventory/infrastructure/stock.service.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreatePurchaseReturnInput, PurchaseReturnLineInput } from "../api/dto/purchase-return.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type PurchaseInvoiceLineRow = typeof purchaseInvoiceLines.$inferSelect;

@Injectable()
export class PurchaseReturnService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
    private readonly stock: StockService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(params: {
    supplierId?: number | undefined;
    purchaseInvoiceId?: number | undefined;
    status?: "draft" | "confirmed" | "posted" | "cancelled" | "reversed" | undefined;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(purchaseReturns.tenantId, tenantId)];
    if (params.supplierId !== undefined) conditions.push(eq(purchaseReturns.supplierId, params.supplierId));
    if (params.purchaseInvoiceId !== undefined) conditions.push(eq(purchaseReturns.purchaseInvoiceId, params.purchaseInvoiceId));
    if (params.status !== undefined) conditions.push(eq(purchaseReturns.status, params.status));
    if (params.dateFrom !== undefined) conditions.push(gte(purchaseReturns.postingDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(purchaseReturns.postingDate, new Date(`${params.dateTo}T00:00:00`)));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(purchaseReturns)
      .where(and(...conditions))
      .orderBy(desc(purchaseReturns.postingDate), desc(purchaseReturns.purchaseReturnId))
      .limit(limit)
      .offset(offset);
    return { purchaseReturns: rows, offset, limit };
  }

  async getById(purchaseReturnId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [header] = await db
      .select()
      .from(purchaseReturns)
      .where(and(eq(purchaseReturns.tenantId, tenantId), eq(purchaseReturns.purchaseReturnId, purchaseReturnId)));
    if (!header) {
      throw new AppException({
        status: 404,
        code: "PURCHASE_RETURN.NOT_FOUND",
        title: "Purchase return not found",
        detail: `No purchase return with id ${purchaseReturnId} exists.`,
      });
    }
    const lines = await db
      .select()
      .from(purchaseReturnLines)
      .where(eq(purchaseReturnLines.purchaseReturnId, purchaseReturnId))
      .orderBy(purchaseReturnLines.lineNo);
    return { purchaseReturn: header, lines };
  }

  /** Create AND post a purchase return in one transaction -- P-1's pattern, mirrored. */
  async createAndPost(input: CreatePurchaseReturnInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const postingDate = input.documentDate;

    return db.transaction(async (tx) => {
      // ---- Validation (before any lock is taken) --------------------------------------------
      const [supplier] = await tx
        .select()
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, input.supplierId)));
      if (!supplier) {
        throw new AppException({
          status: 404,
          code: "PURCHASE_RETURN.SUPPLIER_NOT_FOUND",
          title: "Supplier not found",
          detail: `No supplier with id ${input.supplierId} exists.`,
        });
      }
      if (!supplier.isActive) {
        throw new BusinessRuleException(
          "PURCHASE_RETURN.SUPPLIER_INACTIVE",
          "Supplier is inactive",
          `Supplier "${supplier.name}" is inactive; reactivate it before returning stock to it.`,
        );
      }

      const [invoice] = await tx
        .select()
        .from(purchaseInvoices)
        .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.purchaseInvoiceId, input.purchaseInvoiceId)));
      if (!invoice) {
        throw new AppException({
          status: 404,
          code: "PURCHASE_RETURN.INVOICE_NOT_FOUND",
          title: "Purchase invoice not found",
          detail: `No purchase invoice with id ${input.purchaseInvoiceId} exists.`,
        });
      }
      if (invoice.supplierId !== input.supplierId) {
        throw new BusinessRuleException(
          "PURCHASE_RETURN.INVOICE_SUPPLIER_MISMATCH",
          "Invoice belongs to a different supplier",
          `Purchase invoice ${invoice.docNumber} was not issued by supplier ${input.supplierId}.`,
        );
      }
      if (invoice.status !== "posted") {
        throw new BusinessRuleException(
          "PURCHASE_RETURN.INVOICE_NOT_POSTED",
          "Invoice not posted",
          `Purchase invoice ${invoice.docNumber} is ${invoice.status}; only a posted invoice can be returned against.`,
        );
      }

      const purchaseCategoryId = await this.resolveCategory(tx, tenantId, input.purchaseCategoryId);
      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, postingDate);

      // ---- Resolve (unlocked) which original invoice line(s) each requested line returns
      // against, BEFORE the doc-counter lock (N-1/TX-6: doc_counter must be the FIRST lock this
      // flow takes -- doc-number.service.ts's own header comment -- so nothing here may take a
      // row lock yet). A line's request shape only carries itemId+stockLotId (not a lineId), so
      // this join IS the "was this actually received on this invoice" check the task asks for --
      // no match means a 422, not a guess.
      const candidatesByLine: PurchaseInvoiceLineRow[][] = [];
      const allMatchedIds = new Set<number>();
      for (const [index, line] of input.lines.entries()) {
        await this.assertItemExists(tx, tenantId, line.itemId, index);
        const matches = await tx
          .select()
          .from(purchaseInvoiceLines)
          .where(
            and(
              eq(purchaseInvoiceLines.tenantId, tenantId),
              eq(purchaseInvoiceLines.purchaseInvoiceId, input.purchaseInvoiceId),
              eq(purchaseInvoiceLines.itemId, line.itemId),
              eq(purchaseInvoiceLines.stockLotId, line.stockLotId),
            ),
          )
          .orderBy(asc(purchaseInvoiceLines.purchaseInvoiceLineId));
        if (matches.length === 0) {
          throw new BusinessRuleException(
            "PURCHASE_RETURN.LINE_NOT_RECEIVED",
            "Nothing received to return",
            `Line ${index + 1}: item ${line.itemId} / lot ${line.stockLotId} was not received on invoice ${invoice.docNumber}.`,
            [{ path: `lines.${index}.stockLotId`, code: "PURCHASE_RETURN.LINE_NOT_RECEIVED", message: "Not received on this invoice" }],
          );
        }
        candidatesByLine.push(matches);
        for (const m of matches) allMatchedIds.add(m.purchaseInvoiceLineId);
      }

      // ---- TX-6 lock 1: the document counter (must be first -- see the comment above) --------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "PR");

      // ---- TX-6 lock 2: the implicated original invoice line(s), FOR UPDATE, in ascending id
      // order -- deterministic across concurrent writers (the same discipline
      // purchase-invoice.service.ts documents for costing's item lock, and
      // sale-invoices.service.ts documents for allocateFefo's cross-item lock: two concurrent
      // returns touching overlapping original lines, submitted with lines in different orders,
      // must not lock-order-invert and deadlock). This lock is also what makes the
      // "already returned" read inside computeLine safe: InnoDB locking reads always see the
      // latest committed data, so a second return transaction that had to wait on this lock will
      // correctly see the first one's committed insert once it proceeds.
      const sortedIds = [...allMatchedIds].sort((a, b) => a - b);
      const lockedRows = await tx
        .select()
        .from(purchaseInvoiceLines)
        .where(and(eq(purchaseInvoiceLines.tenantId, tenantId), inArray(purchaseInvoiceLines.purchaseInvoiceLineId, sortedIds)))
        .orderBy(asc(purchaseInvoiceLines.purchaseInvoiceLineId))
        .for("update");
      const lockedById = new Map(lockedRows.map((row) => [row.purchaseInvoiceLineId, row]));

      // Prior-returned pool per distinct matched-id-set (keyed by the sorted id tuple) --
      // shared across requested lines that resolve to the same original line(s), so two lines
      // in THIS SAME request both returning against the same lot cannot each independently pass
      // the check and together over-return (a within-request race the DB lock alone cannot
      // catch, since neither of this request's own inserts has landed yet).
      const pool = new Map<string, Quantity>();
      const poolKeyFor = (ids: readonly number[]): string => [...ids].sort((a, b) => a - b).join(",");

      const computed: ComputedReturnLine[] = [];
      for (const [index, line] of input.lines.entries()) {
        const matches = candidatesByLine[index]!.map((m) => lockedById.get(m.purchaseInvoiceLineId)!);
        computed.push(await this.computeLine(tx, tenantId, index, line, matches, pool, poolKeyFor));
      }

      // Header (zero totals) so lines/movements can reference its id; totals + journal link are
      // stamped in the closing update below (mirrors purchase-invoice.service.ts exactly).
      await tx.insert(purchaseReturns).values({
        tenantId,
        branchId,
        docNumber: allocated.docNumber,
        docSeriesId: allocated.docSeriesId,
        documentTypeId: allocated.documentTypeId,
        documentDate: new Date(`${input.documentDate}T00:00:00`),
        postingDate: new Date(`${postingDate}T00:00:00`),
        fiscalPeriodId,
        status: "draft",
        purchaseInvoiceId: input.purchaseInvoiceId,
        supplierId: input.supplierId,
        purchaseCategoryId,
        reasonId: input.reasonId ?? null,
        notes: input.notes ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [headerRow] = await tx
        .select({ purchaseReturnId: purchaseReturns.purchaseReturnId })
        .from(purchaseReturns)
        .where(and(eq(purchaseReturns.tenantId, tenantId), eq(purchaseReturns.docNumber, allocated.docNumber)));
      if (!headerRow) throw new Error("purchase_return insert did not land"); // unreachable; defensive
      const purchaseReturnId = headerRow.purchaseReturnId;

      // ---- Per line: outbound stock movement -> insert line ----------------------------------
      let grossTotal = Money.zero();
      let netTotal = Money.zero();
      let totalQty = Quantity.zero();

      for (const line of computed) {
        // Mirrors purchase-invoice.service.ts's own ordering (movement before the line insert,
        // no sourceLineId -- the line's own id doesn't exist yet at this point either there).
        // StockService's own FOR UPDATE + non-negativity guard is the "doesn't exceed what's
        // actually in the lot" check (see header comment): it fires 422
        // INVENTORY.INSUFFICIENT_STOCK, not a silent clamp, exactly like every other document.
        await this.stock.applyMovement(tx, {
          tenantId,
          branchId,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          qtyDelta: Quantity.zero().sub(line.returnQty).toDb(),
          unitCost: line.unitCost,
          documentTypeId: allocated.documentTypeId,
          sourceDocumentId: purchaseReturnId,
          fiscalPeriodId,
          postingDate,
          actorId,
        });

        await tx.insert(purchaseReturnLines).values({
          tenantId,
          purchaseReturnId,
          purchaseInvoiceLineId: line.referenceLineId,
          lineNo: line.lineNo,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          qtyPack: "0.0000",
          qtyLoose: line.returnQty.toDb(),
          qtyBonus: "0.0000",
          packUnitsAtTxn: line.packUnitsAtTxn,
          qtyBase: line.returnQty.toDb(),
          unitPurchasePrice: line.unitPurchasePrice,
          netRate: line.netRate,
          unitCostIn: line.unitCost,
          discountPercent: "0.0000",
          lineGrossAmount: line.lineGross.toDb(),
          lineDiscountAmount: "0.0000",
          lineNetAmount: line.lineNet.toDb(),
          // Costing is never reversed (header comment) -- before/after are stamped equal to the
          // item's current average, honestly recording "this document did not move it" rather
          // than a misleading 0.00000 default.
          avgCostBefore: line.avgCostSnapshot,
          avgCostAfter: line.avgCostSnapshot,
          expiryDateCaptured: null, // nothing was captured -- the lot (and its batch/expiry) was selected, not scanned
          batchNoCaptured: null,
          captureMethod: "manual",
          createdBy: actorId,
          createdSource: "api",
        });

        grossTotal = grossTotal.add(line.lineGross);
        netTotal = netTotal.add(line.lineNet);
        totalQty = totalQty.add(line.returnQty);
      }

      // ---- GL ----------------------------------------------------------------------------------
      // No tax schedules exist yet (same TODO as purchase-invoice.service.ts) -- salesTaxAmount
      // is always "0.00" this increment.
      const salesTax = Money.zero();
      const returnTotal = netTotal.add(salesTax);

      const inventoryAccountId = await this.resolveGlAccount(tx, tenantId, "1200");
      const legs: JournalLegInput[] = [
        // Reverses purchase-invoice.service.ts's own supplier leg: that leg CREDITS the
        // supplier's AP account (increasing what's owed); a return DEBITS it (reducing what's
        // owed) -- AP is credit-normal, so this is the correct reversal, not an arbitrary swap.
        { glAccountId: supplier.glAccountId, debit: returnTotal.toDb(), legRole: "primary_debit", supplierId: input.supplierId },
        { glAccountId: inventoryAccountId, credit: netTotal.toDb(), legRole: "primary_credit" },
      ];

      const journalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: allocated.docNumber,
        entryDate: postingDate,
        documentTypeCode: "PR",
        sourceDocumentId: purchaseReturnId,
        description: `Purchase return ${allocated.docNumber} -- ${supplier.name} (against ${invoice.docNumber})`,
        legs,
        postedBy: actorId,
      });

      // ---- Close out the header -----------------------------------------------------------------
      const now = new Date();
      await tx
        .update(purchaseReturns)
        .set({
          grossAmount: grossTotal.toDb(),
          lineDiscountAmount: "0.00",
          netAmount: netTotal.toDb(),
          salesTaxAmount: salesTax.toDb(),
          returnTotal: returnTotal.toDb(),
          totalQty: totalQty.toDb(),
          journalEntryId,
          status: "posted",
          postedAt: now,
          postedBy: actorId,
          updatedBy: actorId,
        })
        .where(eq(purchaseReturns.purchaseReturnId, purchaseReturnId));

      const [finalHeader] = await tx
        .select()
        .from(purchaseReturns)
        .where(eq(purchaseReturns.purchaseReturnId, purchaseReturnId));
      const finalLines = await tx
        .select()
        .from(purchaseReturnLines)
        .where(eq(purchaseReturnLines.purchaseReturnId, purchaseReturnId))
        .orderBy(purchaseReturnLines.lineNo);

      return { purchaseReturn: finalHeader, lines: finalLines, journalEntryId };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async assertItemExists(tx: Tx, tenantId: number, itemId: number, index: number): Promise<void> {
    const [item] = await tx.select({ itemId: items.itemId }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId)));
    if (!item) {
      throw new BusinessRuleException(
        "CATALOG.ITEM_MISSING",
        "Unknown item",
        `Line ${index + 1}: item ${itemId} does not exist.`,
        [{ path: `lines.${index}.itemId`, code: "PURCHASE_RETURN.UNKNOWN_ITEM", message: "Unknown item" }],
      );
    }
  }

  /** Parse + validate one requested line against its locked original invoice line(s) and the
   *  request-local over-return pool. Pure computation plus the one item.avg_unit_cost read
   *  (unlocked -- purely informational, see the header comment on why costing never moves). */
  private async computeLine(
    tx: Tx,
    tenantId: number,
    index: number,
    line: PurchaseReturnLineInput,
    matches: PurchaseInvoiceLineRow[],
    pool: Map<string, Quantity>,
    poolKeyFor: (ids: readonly number[]) => string,
  ): Promise<ComputedReturnLine> {
    const lineNo = index + 1;
    const returnQty = parseQty(line.returnQty, `lines.${index}.returnQty`);
    if (returnQty.isZero()) {
      throw new BusinessRuleException(
        "PURCHASE_RETURN.EMPTY_LINE",
        "Empty line",
        `Line ${lineNo}: returnQty must be greater than zero.`,
        [{ path: `lines.${index}.returnQty`, code: "PURCHASE_RETURN.EMPTY_LINE", message: "Quantity must be > 0" }],
      );
    }

    const referenceLine = matches[0]!; // lowest purchaseInvoiceLineId -- deterministic (sorted above)
    const matchedIds = matches.map((m) => m.purchaseInvoiceLineId);

    let receivedQty = Quantity.zero();
    for (const m of matches) receivedQty = receivedQty.add(Quantity.fromDb(m.qtyBase));

    const key = poolKeyFor(matchedIds);
    let alreadyReturned = pool.get(key);
    if (alreadyReturned === undefined) {
      // Locking read (see the phase-2 comment above): guarantees this sees every prior return
      // already committed against these original line(s), even one that landed after this
      // transaction's snapshot was taken but before it acquired the purchase_invoice_line lock.
      const priorRows = await tx
        .select({ qtyBase: purchaseReturnLines.qtyBase })
        .from(purchaseReturnLines)
        .where(and(eq(purchaseReturnLines.tenantId, tenantId), inArray(purchaseReturnLines.purchaseInvoiceLineId, matchedIds)))
        .for("update");
      alreadyReturned = Quantity.zero();
      for (const row of priorRows) alreadyReturned = alreadyReturned.add(Quantity.fromDb(row.qtyBase));
    }

    const remaining = receivedQty.sub(alreadyReturned);
    if (returnQty.compare(remaining) > 0) {
      throw new BusinessRuleException(
        "PURCHASE_RETURN.QTY_EXCEEDS_RECEIVED",
        "Return quantity exceeds what was received",
        `Line ${lineNo}: item ${line.itemId} / lot ${line.stockLotId} received ${receivedQty.toDb()}, already returned ${alreadyReturned.toDb()} -- only ${remaining.isNegative() ? "0.0000" : remaining.toDb()} remains returnable, cannot return ${returnQty.toDb()}.`,
        [{ path: `lines.${index}.returnQty`, code: "PURCHASE_RETURN.QTY_EXCEEDS_RECEIVED", message: "Exceeds returnable quantity" }],
      );
    }
    pool.set(key, alreadyReturned.add(returnQty));

    const [item] = await tx
      .select({ itemId: items.itemId, avgUnitCost: items.avgUnitCost })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, line.itemId)));
    if (!item) throw new Error(`item ${line.itemId} vanished mid-transaction`); // unreachable; assertItemExists already checked

    // Never re-average (header comment) -- default to the ORIGINAL line's own cost, not a fresh
    // computation. An explicit override still goes straight through as a validated string
    // (Rule M: never parsed to a JS number).
    const unitCost = line.unitCost ?? referenceLine.unitCostIn;
    const lineGross = Money.fromDb(costAmount(returnQty.toDb(), unitCost));
    const lineNet = lineGross; // no return discounts this increment (documented simplification)

    return {
      lineNo,
      itemId: line.itemId,
      stockLotId: line.stockLotId,
      returnQty,
      unitCost,
      lineGross,
      lineNet,
      referenceLineId: referenceLine.purchaseInvoiceLineId,
      unitPurchasePrice: referenceLine.unitPurchasePrice,
      netRate: referenceLine.netRate,
      packUnitsAtTxn: referenceLine.packUnitsAtTxn,
      avgCostSnapshot: item.avgUnitCost,
    };
  }

  private async resolveCategory(tx: Tx, tenantId: number, purchaseCategoryId: number | undefined): Promise<number> {
    if (purchaseCategoryId !== undefined) {
      const [row] = await tx
        .select({
          purchaseCategoryId: purchaseCategories.purchaseCategoryId,
          isEnabled: purchaseCategories.isEnabled,
          isReturn: purchaseCategories.isReturn,
        })
        .from(purchaseCategories)
        .where(and(eq(purchaseCategories.tenantId, tenantId), eq(purchaseCategories.purchaseCategoryId, purchaseCategoryId)));
      if (!row || !row.isEnabled) {
        throw new BusinessRuleException(
          "PURCHASE_RETURN.CATEGORY_INVALID",
          "Unknown purchase category",
          `Purchase category ${purchaseCategoryId} does not exist or is disabled.`,
        );
      }
      if (!row.isReturn) {
        throw new BusinessRuleException(
          "PURCHASE_RETURN.CATEGORY_NOT_RETURN",
          "Not a return category",
          `Purchase category ${purchaseCategoryId} is not flagged as a return category.`,
        );
      }
      return row.purchaseCategoryId;
    }
    // Default: the tenant's default RETURN-flagged category (seed has none marked default this
    // increment -- RETURN_CASH/RETURN_CREDIT are both isDefault=false -- so this is expected to
    // 422 until an owner configures one, same honest-422-over-silent-guess shape as
    // purchase-invoice.service.ts's own PURCHASE.NO_DEFAULT_CATEGORY.)
    const [dflt] = await tx
      .select({ purchaseCategoryId: purchaseCategories.purchaseCategoryId })
      .from(purchaseCategories)
      .where(and(eq(purchaseCategories.tenantId, tenantId), eq(purchaseCategories.isReturn, true), eq(purchaseCategories.isDefault, true)));
    if (!dflt) {
      throw new BusinessRuleException(
        "PURCHASE_RETURN.NO_DEFAULT_CATEGORY",
        "No default return category",
        "No purchase-return category is marked as default; pass purchaseCategoryId explicitly or configure a default.",
      );
    }
    return dflt.purchaseCategoryId;
  }

  private async resolveGlAccount(tx: Tx, tenantId: number, code: string): Promise<number> {
    const [row] = await tx
      .select({ glAccountId: glAccounts.glAccountId })
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, code)));
    if (!row) {
      throw new BusinessRuleException(
        "LEDGER.ACCOUNT_MISSING",
        "GL account missing",
        `GL account ${code} is not configured; run the seed / set up the chart of accounts.`,
      );
    }
    return row.glAccountId;
  }
}

interface ComputedReturnLine {
  readonly lineNo: number;
  readonly itemId: number;
  readonly stockLotId: number;
  readonly returnQty: Quantity;
  readonly unitCost: string;
  readonly lineGross: Money;
  readonly lineNet: Money;
  readonly referenceLineId: number;
  readonly unitPurchasePrice: string;
  readonly netRate: string;
  readonly packUnitsAtTxn: number;
  readonly avgCostSnapshot: string;
}

function parseQty(raw: string, path: string): Quantity {
  const parsed = Quantity.fromInput(raw);
  if (!parsed.ok) {
    throw new BusinessRuleException("PURCHASE_RETURN.INVALID_QUANTITY", "Invalid quantity", `${path} is not a valid quantity.`, [
      { path, code: "PURCHASE_RETURN.INVALID_QUANTITY", message: "Invalid quantity" },
    ]);
  }
  return parsed.value;
}
