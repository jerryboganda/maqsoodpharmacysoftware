// Blueprint: docs/system-analysis/05a-workflows-sales.md (retail sale return), 19-mysql-schema-
// blueprint.md §T72/§T73, 17-technical-blueprint.md §7 (TX rules). Structural mirror of
// purchase-return.service.ts's createAndPost -- a sale return is the SAME seriousness of
// financial/inventory event as a cash sale, just the reverse direction, so it gets the same
// create-and-post-in-one-transaction shape (no separate draft/approve/post workflow), and reuses
// purchase-return.service.ts's own phase-1(unlocked match)/phase-2(locked, ascending-id) pattern
// for tying return lines back to the original document's lines and guarding against over-return.
//
// Lot selection (the task's explicit "which lot does it go back into" question): a sale return
// never picks a NEW lot -- FEFO already recorded, on sale_invoice_line, exactly which lot(s) each
// unit was dispensed from. A requested return line (itemId + returnQty) is resolved against every
// sale_invoice_line the item appears on for this invoice (ascending line id -- the same order
// those lines were created in, which for one item's own slices is FEFO/expiry order), and sliced
// across them greedily in that order until returnQty is satisfied -- "just in reverse" of FEFO:
// no new-lot creation, no fresh expiry sort, simply de-allocating from the lots the sale itself
// already chose, oldest-created-first. Which specific lot absorbs a partial return among several
// equally-valid candidates is not a business-significant choice this increment (documented, not
// silently arbitrary).
//
// Costing (mirrors purchase-return.service.ts's explicit scope decision): moving average is a
// one-way aggregation and is not cleanly invertible, so a return never re-runs the costing
// formula. Each slice posts COGS at that ORIGINAL sale_invoice_line's own frozen unit_cost
// (C-6's stamped avg-at-sale-time), and item.avg_unit_cost is left completely untouched.
// sale_return_line.cost_basis is stamped "original_cost" (the schema's own documented default,
// §T73) -- an honest label, not a re-derived number.
//
// Refund destination (Dr Sales Revenue / Cr Accounts Receivable-or-Cash, per the task): resolved
// from the ORIGINAL invoice's own data, not re-asked of the caller. sale_invoice's
// sale_category.counterparty is the same "AS DATA" switch sale-invoices.service.ts's
// createCashSale already gates on (cash vs customer_account) -- only cash-counterparty invoices
// can ever reach 'posted' today (createCashSale 422s any other counterparty before it gets that
// far), so every saleInvoiceId this service can validate is, today, always a cash sale; the
// customer_account branch below is a defensive, forward-compatible gate (SALE_RETURN.
// NOT_IMPLEMENTED), not dead speculative code -- it mirrors createCashSale's own gate verbatim
// and will start firing the moment credit sales ship. For the reachable cash path, the refund leg
// reuses the ORIGINAL invoice's own first sale_invoice_payment row (ascending sequence_no) -- the
// SAME cash_bank_account -> gl_account resolution sale-invoices.service.ts's payment-leg handling
// already does, just read back instead of re-collected from the caller. The return's OWN
// sale_category is resolved separately (§T74 CASH_RETURN: isReturn=true, counterparty=cash) --
// independent of the referenced invoice's category, exactly as purchase-return.service.ts's own
// purchaseCategoryId is independent of the referenced invoice's category.
//
// GL (mirrors sale-invoices.service.ts's S-5 perpetual-inventory posting, reversed):
//   Dr 4000 Sales             netAmount   (reduces recognized revenue)
//   Dr 1200 Inventory         cogsAmount  (cost comes back onto the books)
//   Cr 5200 COGS              cogsAmount  (reverses the expense)
//   Cr <refund account>       returnTotal (refunding / crediting the customer)
// No tax schedules exist yet (same TODO as sale-invoices.service.ts / purchase-return.service.ts)
// -- salesTaxAmount is always "0.00" this increment, so netAmount === returnTotal and the journal
// balances without a separate tax leg.
//
// Quantity invariant (the task's explicit ask): returnQty must not exceed what was actually sold
// on the referenced invoice's line(s) for that item, net of any prior returns already posted
// against those same line(s) -- enforced by this service's own over-return check (soldQty minus a
// LOCKED read of alreadyReturned) BEFORE StockService.applyMovement ever runs. Unlike an outbound
// movement, an inbound one has no non-negativity guard of its own to lean on for free, so this
// check is the only guard against over-return.
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  cashBankAccounts,
  customers,
  getDb,
  glAccounts,
  saleCategories,
  saleInvoiceLines,
  saleInvoicePayments,
  saleInvoices,
  saleReturnLines,
  saleReturns,
} from "@pharmacy/db";
import { costAmount, Money, Quantity } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { StockService } from "../../inventory/infrastructure/stock.service.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateSaleReturnInput } from "../api/dto/sale-return.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type SaleInvoiceLineRow = typeof saleInvoiceLines.$inferSelect;

@Injectable()
export class SaleReturnsService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
    private readonly stock: StockService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(params: {
    customerId?: number | undefined;
    saleInvoiceId?: number | undefined;
    status?: "draft" | "confirmed" | "posted" | "cancelled" | "reversed" | undefined;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(saleReturns.tenantId, tenantId)];
    if (params.customerId !== undefined) conditions.push(eq(saleReturns.customerId, params.customerId));
    if (params.saleInvoiceId !== undefined) conditions.push(eq(saleReturns.saleInvoiceId, params.saleInvoiceId));
    if (params.status !== undefined) conditions.push(eq(saleReturns.status, params.status));
    if (params.dateFrom !== undefined) conditions.push(gte(saleReturns.postingDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(saleReturns.postingDate, new Date(`${params.dateTo}T00:00:00`)));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(saleReturns)
      .where(and(...conditions))
      .orderBy(desc(saleReturns.postingDate), desc(saleReturns.saleReturnId))
      .limit(limit)
      .offset(offset);
    return { saleReturns: rows, offset, limit };
  }

  async getById(saleReturnId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [header] = await db
      .select()
      .from(saleReturns)
      .where(and(eq(saleReturns.tenantId, tenantId), eq(saleReturns.saleReturnId, saleReturnId)));
    if (!header) {
      throw new AppException({
        status: 404,
        code: "SALE_RETURN.NOT_FOUND",
        title: "Sale return not found",
        detail: `No sale return with id ${saleReturnId} exists.`,
      });
    }
    const lines = await db
      .select()
      .from(saleReturnLines)
      .where(eq(saleReturnLines.saleReturnId, saleReturnId))
      .orderBy(saleReturnLines.lineNo);
    return { saleReturn: header, lines };
  }

  /** Create AND post a sale return in one transaction -- S-1's pattern, mirrored (see header). */
  async createAndPost(input: CreateSaleReturnInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const postingDate = input.documentDate;

    return db.transaction(async (tx) => {
      // ---- Validation (before any lock is taken) --------------------------------------------
      const [customer] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, input.customerId)));
      if (!customer) {
        throw new AppException({
          status: 404,
          code: "SALE_RETURN.CUSTOMER_NOT_FOUND",
          title: "Customer not found",
          detail: `No customer with id ${input.customerId} exists.`,
        });
      }
      if (!customer.isActive) {
        throw new BusinessRuleException(
          "SALE_RETURN.CUSTOMER_INACTIVE",
          "Customer is inactive",
          `Customer "${customer.name}" is inactive; reactivate it before recording a return against it.`,
        );
      }

      const [invoice] = await tx
        .select()
        .from(saleInvoices)
        .where(and(eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.saleInvoiceId, input.saleInvoiceId)));
      if (!invoice) {
        throw new AppException({
          status: 404,
          code: "SALE_RETURN.INVOICE_NOT_FOUND",
          title: "Sale invoice not found",
          detail: `No sale invoice with id ${input.saleInvoiceId} exists.`,
        });
      }
      if (invoice.customerId !== input.customerId) {
        throw new BusinessRuleException(
          "SALE_RETURN.INVOICE_CUSTOMER_MISMATCH",
          "Invoice belongs to a different customer",
          `Sale invoice ${invoice.docNumber} was not issued to customer ${input.customerId}.`,
        );
      }
      if (invoice.status !== "posted") {
        throw new BusinessRuleException(
          "SALE_RETURN.INVOICE_NOT_POSTED",
          "Invoice not posted",
          `Sale invoice ${invoice.docNumber} is ${invoice.status}; only a posted invoice can be returned against.`,
        );
      }

      const [originalCategory] = await tx
        .select({ counterparty: saleCategories.counterparty })
        .from(saleCategories)
        .where(and(eq(saleCategories.tenantId, tenantId), eq(saleCategories.saleCategoryId, invoice.saleCategoryId)));
      if (!originalCategory) throw new Error(`sale category ${invoice.saleCategoryId} vanished`); // unreachable; FK-enforced
      if (originalCategory.counterparty !== "cash") {
        // Mirrors sale-invoices.service.ts's own credit-sale gate (SALES.NOT_IMPLEMENTED).
        // Unreachable today -- createCashSale rejects any non-cash category before an invoice can
        // ever reach 'posted', so no saleInvoiceId validated above can resolve to anything else --
        // kept explicit (422, not a silent guess) for when credit sales land (see header comment).
        throw new BusinessRuleException(
          "SALE_RETURN.NOT_IMPLEMENTED",
          "Credit refunds not available yet",
          `Sale invoice ${invoice.docNumber} posts to the customer account; only cash-counterparty returns are implemented.`,
        );
      }

      const returnCategoryId = await this.resolveReturnCategory(tx, tenantId, "cash");
      const refund = await this.resolveRefundLeg(tx, tenantId, invoice.saleInvoiceId);
      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, postingDate);

      // ---- Resolve + lock every original sale_invoice_line each requested line returns against
      // Phase 1 (unlocked): for every requested line, find every sale_invoice_line matching
      // (this invoice, this item), ascending id. A line's request shape only carries itemId (not
      // a lineId or lot), so this join IS the "was this item actually sold on this invoice" check
      // the task asks for -- no match means a 422, not a guess.
      const candidatesByLine: SaleInvoiceLineRow[][] = [];
      const allMatchedIds = new Set<number>();
      for (const [index, line] of input.lines.entries()) {
        const matches = await tx
          .select()
          .from(saleInvoiceLines)
          .where(and(eq(saleInvoiceLines.saleInvoiceId, input.saleInvoiceId), eq(saleInvoiceLines.itemId, line.itemId)))
          .orderBy(asc(saleInvoiceLines.saleInvoiceLineId));
        if (matches.length === 0) {
          throw new BusinessRuleException(
            "SALE_RETURN.ITEM_NOT_SOLD",
            "Nothing sold to return",
            `Line ${index + 1}: item ${line.itemId} was not sold on invoice ${invoice.docNumber}.`,
            [{ path: `lines.${index}.itemId`, code: "SALE_RETURN.ITEM_NOT_SOLD", message: "Not sold on this invoice" }],
          );
        }
        candidatesByLine.push(matches);
        for (const m of matches) allMatchedIds.add(m.saleInvoiceLineId);
      }

      // Phase 2 (locked, deterministic order): lock every implicated original line FOR UPDATE in
      // ascending id order -- TX-6 discipline, the same cross-line-set race safety
      // purchase-return.service.ts documents for its own equivalent lock. This is also what makes
      // the "already returned" read below safe: a locking read always sees the latest committed
      // data, so a second return transaction that had to wait on this lock correctly sees the
      // first one's committed insert once it proceeds.
      const sortedIds = [...allMatchedIds].sort((a, b) => a - b);
      const lockedRows = await tx
        .select()
        .from(saleInvoiceLines)
        .where(inArray(saleInvoiceLines.saleInvoiceLineId, sortedIds))
        .orderBy(asc(saleInvoiceLines.saleInvoiceLineId))
        .for("update");
      const lockedById = new Map(lockedRows.map((row) => [row.saleInvoiceLineId, row]));

      // Remaining-returnable-quantity pool, per original line id -- lazily populated with a
      // locked read of every sale_return_line already posted against that line. Shared across
      // every requested line touching it (guards a within-request double-return exactly like
      // purchase-return.service.ts's own pool), at per-original-line granularity since one
      // requested item can slice across several original lines/lots here.
      const remainingByLineId = new Map<number, Quantity>();
      const remainingFor = async (lineId: number): Promise<Quantity> => {
        const cached = remainingByLineId.get(lineId);
        if (cached !== undefined) return cached;
        const original = lockedById.get(lineId)!;
        const priorRows = await tx
          .select({ qtyBase: saleReturnLines.qtyBase })
          .from(saleReturnLines)
          .where(eq(saleReturnLines.saleInvoiceLineId, lineId))
          .for("update");
        let alreadyReturned = Quantity.zero();
        for (const row of priorRows) alreadyReturned = alreadyReturned.add(Quantity.fromDb(row.qtyBase));
        const remaining = Quantity.fromDb(original.qtyBase).sub(alreadyReturned);
        remainingByLineId.set(lineId, remaining);
        return remaining;
      };

      const computed: ComputedReturnLine[] = [];
      let nextLineNo = 1;
      for (const [index, line] of input.lines.entries()) {
        const returnQty = parseQty(line.returnQty, `lines.${index}.returnQty`);
        if (returnQty.isZero()) {
          throw new BusinessRuleException(
            "SALE_RETURN.EMPTY_LINE",
            "Empty line",
            `Line ${index + 1}: returnQty must be greater than zero.`,
            [{ path: `lines.${index}.returnQty`, code: "SALE_RETURN.EMPTY_LINE", message: "Quantity must be > 0" }],
          );
        }

        const matches = candidatesByLine[index]!;
        let soldQty = Quantity.zero();
        let totalRemaining = Quantity.zero();
        for (const m of matches) {
          soldQty = soldQty.add(Quantity.fromDb(m.qtyBase));
          totalRemaining = totalRemaining.add(await remainingFor(m.saleInvoiceLineId));
        }
        if (returnQty.compare(totalRemaining) > 0) {
          const alreadyReturned = soldQty.sub(totalRemaining);
          throw new BusinessRuleException(
            "SALE_RETURN.QTY_EXCEEDS_SOLD",
            "Return quantity exceeds what was sold",
            `Line ${index + 1}: item ${line.itemId} sold ${soldQty.toDb()}, already returned ${alreadyReturned.toDb()} -- only ${totalRemaining.isNegative() ? "0.0000" : totalRemaining.toDb()} remains returnable, cannot return ${returnQty.toDb()}.`,
            [{ path: `lines.${index}.returnQty`, code: "SALE_RETURN.QTY_EXCEEDS_SOLD", message: "Exceeds returnable quantity" }],
          );
        }

        // Slice greedily across the matched original lines in ascending id order -- "just in
        // reverse" of FEFO (header comment): no new lot, no fresh expiry sort, simply
        // de-allocating from the same lots the sale itself already chose, oldest-created-first.
        let stillNeeded = returnQty;
        for (const original of matches) {
          if (stillNeeded.isZero()) break;
          const remaining = remainingByLineId.get(original.saleInvoiceLineId)!;
          if (remaining.isZero() || remaining.isNegative()) continue;
          const take = remaining.compare(stillNeeded) <= 0 ? remaining : stillNeeded;
          remainingByLineId.set(original.saleInvoiceLineId, remaining.sub(take));
          stillNeeded = stillNeeded.sub(take);
          computed.push({
            lineNo: nextLineNo++,
            itemId: line.itemId,
            stockLotId: original.stockLotId,
            branchId: original.branchId,
            returnQty: take,
            unitCost: original.unitCost,
            unitSalePrice: original.unitSalePrice,
            packSalePrice: original.packSalePrice,
            packUnitsAtTxn: original.packUnitsAtTxn,
            // UNIT_PRICE-scale (4dp) line amounts -- matches sale_invoice_line's own
            // costAmount() usage in sale-invoices.service.ts; NOT wrapped in Money (2dp) at the
            // line level, only when accumulated into the header totals below.
            lineGrossAmount: costAmount(take.toDb(), original.unitSalePrice),
            lineCostAmount: costAmount(take.toDb(), original.unitCost),
            referenceLineId: original.saleInvoiceLineId,
            expiryAtSale: original.expiryAtSale,
          });
        }
        // Unreachable: the aggregate check above already guarantees totalRemaining >= returnQty,
        // so the greedy slice can never leave stillNeeded > 0 -- defensive, not a live branch.
        if (!stillNeeded.isZero()) {
          throw new Error(`sale return line ${index + 1}: allocation left ${stillNeeded.toDb()} unslotted`);
        }
      }

      // ---- TX-6 lock: the document counter ---------------------------------------------------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "SR");

      await tx.insert(saleReturns).values({
        tenantId,
        branchId,
        docNumber: allocated.docNumber,
        docSeriesId: allocated.docSeriesId,
        documentTypeId: allocated.documentTypeId,
        documentDate: new Date(`${input.documentDate}T00:00:00`),
        postingDate: new Date(`${postingDate}T00:00:00`),
        fiscalPeriodId,
        status: "draft",
        saleInvoiceId: invoice.saleInvoiceId,
        customerId: input.customerId,
        saleCategoryId: returnCategoryId,
        refundMethodId: refund.paymentMethodId,
        cashBankAccountId: refund.cashBankAccountId,
        notes: input.notes ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [headerRow] = await tx
        .select({ saleReturnId: saleReturns.saleReturnId })
        .from(saleReturns)
        .where(and(eq(saleReturns.tenantId, tenantId), eq(saleReturns.docNumber, allocated.docNumber)));
      if (!headerRow) throw new Error("sale_return insert did not land"); // unreachable; defensive
      const saleReturnId = headerRow.saleReturnId;

      // ---- Per slice: inbound stock movement -> insert line ----------------------------------
      let grossTotal = Money.zero();
      let cogsTotal = Money.zero();

      for (const line of computed) {
        // Mirrors purchase-return.service.ts's own ordering (movement before the line insert, no
        // sourceLineId -- the line's own id doesn't exist yet at this point either there). Mirror
        // image of purchase-return's outbound movement: positive qtyDelta, goods coming back IN,
        // into the SAME branch/lot the original sale line recorded (not necessarily the actor's
        // current default branch).
        await this.stock.applyMovement(tx, {
          tenantId,
          branchId: line.branchId,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          qtyDelta: line.returnQty.toDb(),
          unitCost: line.unitCost,
          documentTypeId: allocated.documentTypeId,
          sourceDocumentId: saleReturnId,
          fiscalPeriodId,
          postingDate,
          actorId,
        });

        await tx.insert(saleReturnLines).values({
          tenantId,
          saleReturnId,
          lineNo: line.lineNo,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          branchId: line.branchId,
          saleInvoiceLineId: line.referenceLineId,
          costBasis: "original_cost", // never re-derived -- see header comment
          qtyPack: "0.0000",
          qtyLoose: line.returnQty.toDb(),
          qtyBonus: "0.0000",
          packUnitsAtTxn: line.packUnitsAtTxn,
          qtyBase: line.returnQty.toDb(),
          unitSalePrice: line.unitSalePrice,
          packSalePrice: line.packSalePrice,
          itemFlatDiscount: "0.0000",
          discountPercent: "0.0000",
          lineGrossAmount: line.lineGrossAmount,
          lineDiscountAmount: "0.0000",
          invoiceDiscountAllocated: "0.0000",
          lineNetAmount: line.lineGrossAmount, // no discounts this increment
          unitSalesTax: "0.0000",
          taxPercent: "0.0000",
          lineTaxAmount: "0.0000",
          unitCost: line.unitCost,
          lineCostAmount: line.lineCostAmount,
          expiryAtSale: line.expiryAtSale,
          fefoOverridden: false,
          createdBy: actorId,
          createdSource: "api",
        });

        grossTotal = grossTotal.add(Money.fromDb(line.lineGrossAmount));
        cogsTotal = cogsTotal.add(Money.fromDb(line.lineCostAmount));
      }
      const netTotal = grossTotal; // no discounts this increment

      // ---- GL ----------------------------------------------------------------------------------
      // TODO(tax schedules): no tax schedules exist yet, same TODO as sale-invoices.service.ts /
      // purchase-return.service.ts -- salesTaxAmount is always "0.00" this increment.
      const salesTax = Money.zero();
      const returnTotal = netTotal.add(salesTax);

      const salesAccountId = await this.resolveGlAccount(tx, tenantId, "4000");
      const cogsAccountId = await this.resolveGlAccount(tx, tenantId, "5200");
      const inventoryAccountId = await this.resolveGlAccount(tx, tenantId, "1200");

      const legs: JournalLegInput[] = [
        // Reverses sale-invoices.service.ts's own Sales credit leg: that leg CREDITS 4000
        // (recognizing revenue); a return DEBITS it (reducing recognized revenue) -- Sales is
        // credit-normal, so this is the correct reversal, not an arbitrary swap.
        { glAccountId: salesAccountId, debit: netTotal.toDb(), legRole: "primary_debit", customerId: input.customerId },
        // Refunding cash out (or, once credit sales land, reducing what the customer owes) --
        // customerId stamped as the analysis dimension, mirroring sale-invoices.service.ts's own
        // "payment" legs (S-4).
        { glAccountId: refund.glAccountId, credit: returnTotal.toDb(), legRole: "payment", customerId: input.customerId },
      ];
      if (!cogsTotal.isZero()) {
        // Perpetual COGS reversal (S-5 binding, mirrors sale-invoices.service.ts's own COGS
        // legs): Dr Inventory puts the cost back on the books, Cr COGS reverses the expense.
        // Skipped only when COGS is exactly zero -- a zero-amount leg would be noise.
        legs.push({ glAccountId: inventoryAccountId, debit: cogsTotal.toDb(), legRole: "cogs" });
        legs.push({ glAccountId: cogsAccountId, credit: cogsTotal.toDb(), legRole: "cogs" });
      }

      const journalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: allocated.docNumber,
        entryDate: postingDate,
        documentTypeCode: "SR",
        sourceDocumentId: saleReturnId,
        description: `Sale return ${allocated.docNumber} -- ${customer.name} (against ${invoice.docNumber})`,
        legs,
        postedBy: actorId,
      });

      // ---- Close out the header -----------------------------------------------------------------
      const now = new Date();
      await tx
        .update(saleReturns)
        .set({
          grossAmount: grossTotal.toDb(),
          netAmount: netTotal.toDb(),
          salesTaxAmount: salesTax.toDb(),
          returnTotal: returnTotal.toDb(),
          cogsAmount: cogsTotal.toDb(),
          journalEntryId,
          status: "posted",
          postedAt: now,
          postedBy: actorId,
          updatedBy: actorId,
        })
        .where(eq(saleReturns.saleReturnId, saleReturnId));

      const [finalHeader] = await tx.select().from(saleReturns).where(eq(saleReturns.saleReturnId, saleReturnId));
      const finalLines = await tx
        .select()
        .from(saleReturnLines)
        .where(eq(saleReturnLines.saleReturnId, saleReturnId))
        .orderBy(saleReturnLines.lineNo);

      return { saleReturn: finalHeader, lines: finalLines, journalEntryId };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async resolveReturnCategory(tx: Tx, tenantId: number, counterparty: "cash" | "customer_account"): Promise<number> {
    const [row] = await tx
      .select({ saleCategoryId: saleCategories.saleCategoryId, isEnabled: saleCategories.isEnabled })
      .from(saleCategories)
      .where(
        and(
          eq(saleCategories.tenantId, tenantId),
          eq(saleCategories.isReturn, true),
          eq(saleCategories.counterparty, counterparty),
        ),
      );
    if (!row || !row.isEnabled) {
      throw new BusinessRuleException(
        "SALE_RETURN.NO_RETURN_CATEGORY",
        "No return category configured",
        `No enabled sale-return category with counterparty "${counterparty}" is configured for this tenant.`,
      );
    }
    return row.saleCategoryId;
  }

  /** Resolve the refund leg from the ORIGINAL invoice's own first payment row (ascending
   *  sequence_no) -- the same cash_bank_account -> gl_account lookup sale-invoices.service.ts's
   *  payment-leg handling already does, just read back rather than re-collected (see header
   *  comment). */
  private async resolveRefundLeg(
    tx: Tx,
    tenantId: number,
    saleInvoiceId: number,
  ): Promise<{ paymentMethodId: number; cashBankAccountId: number; glAccountId: number }> {
    const [payment] = await tx
      .select()
      .from(saleInvoicePayments)
      .where(and(eq(saleInvoicePayments.tenantId, tenantId), eq(saleInvoicePayments.saleInvoiceId, saleInvoiceId)))
      .orderBy(asc(saleInvoicePayments.sequenceNo))
      .limit(1);
    if (!payment) {
      // Unreachable -- createCashSale requires >=1 payment row covering the full total before an
      // invoice can ever reach 'posted' (see header comment).
      throw new Error(`posted sale invoice ${saleInvoiceId} has no payment rows`);
    }
    const [cba] = await tx
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId, glAccountId: cashBankAccounts.glAccountId })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, payment.cashBankAccountId)));
    if (!cba) throw new Error(`cash/bank account ${payment.cashBankAccountId} vanished`); // unreachable; FK-enforced
    return { paymentMethodId: payment.paymentMethodId, cashBankAccountId: cba.cashBankAccountId, glAccountId: cba.glAccountId };
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
  readonly branchId: number;
  readonly returnQty: Quantity;
  readonly unitCost: string;
  readonly unitSalePrice: string;
  readonly packSalePrice: string;
  readonly packUnitsAtTxn: number;
  readonly lineGrossAmount: string;
  readonly lineCostAmount: string;
  readonly referenceLineId: number;
  readonly expiryAtSale: Date | null;
}

function parseQty(raw: string, path: string): Quantity {
  const parsed = Quantity.fromInput(raw);
  if (!parsed.ok) {
    throw new BusinessRuleException("SALE_RETURN.INVALID_QUANTITY", "Invalid quantity", `${path} is not a valid quantity.`, [
      { path, code: "SALE_RETURN.INVALID_QUANTITY", message: "Invalid quantity" },
    ]);
  }
  return parsed.value;
}
