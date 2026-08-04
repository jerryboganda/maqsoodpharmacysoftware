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
import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import {
  cashBankAccounts,
  customers,
  getDb,
  glAccounts,
  journalEntries,
  journalLines,
  saleCategories,
  saleInvoiceLines,
  saleInvoicePayments,
  saleInvoices,
  saleReturnLines,
  saleReturns,
  stockBalances,
  stockMovements,
} from "@pharmacy/db";
import { costAmount, Money, Quantity } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { localToday } from "../../../common/dates/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { StockService } from "../../inventory/infrastructure/stock.service.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type {
  CancelSaleReturnInput,
  CreateSaleReturnInput,
  LookupInvoiceInput,
  ReverseSaleReturnInput,
} from "../api/dto/sale-return.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export type SaleReturnRow = typeof saleReturns.$inferSelect;
export type SaleReturnLineRow = typeof saleReturnLines.$inferSelect;
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

  /**
   * POST /sale-returns/lookup-invoice -- read-only search (18-api-plan.md's "Sale returns" row:
   * `POST /api/v1/sale-returns/lookup-invoice`, "n/a (read-only POST)", `E-READ`) for the posted
   * sale invoice a return will be built against. Deliberately unlocked, no transaction -- mirrors
   * sale-invoices.service.ts's own `preview()` ("a dry run that deliberately never opens a write
   * transaction"): this reports remaining-returnable quantity as of right now, on a best-effort
   * basis; `createAndPost`'s own `FOR UPDATE` re-check (its phase-2 lock + `remainingFor`) is what
   * is actually authoritative at write time, exactly like `preview`'s relationship to
   * `createCashSale`.
   *
   * `docNumber`, exact match only -- see the DTO's own comment for why (no partial/LIKE, no
   * fiscalInvoiceNo/barcode columns on `sale_invoice` in this codebase today).
   *
   * Remaining-returnable per line: original `qty_base` on `sale_invoice_line`, minus every
   * `sale_return_line.qty_base` already posted against it -- counted across every `sale_return`
   * row regardless of ITS OWN status (not filtered to "posted"). This deliberately matches
   * `createAndPost`'s own `remainingFor` helper, which likewise counts every existing
   * `sale_return_line` row unconditionally: `cancel`/`reverse` (below) never delete or renumber a
   * return's lines, they only flip the header's status and reverse the stock/GL, so a
   * cancelled/reversed return's lines are still real historical qty that was, at some point,
   * validated against and posted. Filtering this preview to "posted only" would silently diverge
   * from what the real `createAndPost` call will enforce a moment later.
   */
  async lookupInvoice(input: LookupInvoiceInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);

    const [invoice] = await db
      .select()
      .from(saleInvoices)
      .where(and(eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.docNumber, input.docNumber)));
    if (!invoice) {
      throw new AppException({
        status: 404,
        code: "SALE_RETURN.INVOICE_NOT_FOUND",
        title: "Sale invoice not found",
        detail: `No sale invoice with doc number "${input.docNumber}" exists.`,
      });
    }
    if (invoice.status !== "posted") {
      throw new BusinessRuleException(
        "SALE_RETURN.INVOICE_NOT_POSTED",
        "Invoice not posted",
        `Sale invoice ${invoice.docNumber} is ${invoice.status}; only a posted invoice can be returned against.`,
      );
    }

    const invoiceLines = await db
      .select()
      .from(saleInvoiceLines)
      .where(eq(saleInvoiceLines.saleInvoiceId, invoice.saleInvoiceId))
      .orderBy(asc(saleInvoiceLines.lineNo));

    const returnedByLineId = new Map<number, Quantity>();
    if (invoiceLines.length > 0) {
      const priorRows = await db
        .select({ saleInvoiceLineId: saleReturnLines.saleInvoiceLineId, qtyBase: saleReturnLines.qtyBase })
        .from(saleReturnLines)
        .where(
          inArray(
            saleReturnLines.saleInvoiceLineId,
            invoiceLines.map((l) => l.saleInvoiceLineId),
          ),
        );
      for (const row of priorRows) {
        if (row.saleInvoiceLineId === null) continue;
        const existing = returnedByLineId.get(row.saleInvoiceLineId) ?? Quantity.zero();
        returnedByLineId.set(row.saleInvoiceLineId, existing.add(Quantity.fromDb(row.qtyBase)));
      }
    }

    const lines = invoiceLines.map((line) => {
      const soldQty = Quantity.fromDb(line.qtyBase);
      const alreadyReturned = returnedByLineId.get(line.saleInvoiceLineId) ?? Quantity.zero();
      const remaining = soldQty.sub(alreadyReturned);
      return {
        ...line,
        qtyAlreadyReturned: alreadyReturned.toDb(),
        qtyReturnable: remaining.isNegative() ? Quantity.zero().toDb() : remaining.toDb(),
      };
    });

    return { invoice, lines };
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

  /**
   * POST /sale-returns/:id/cancel -- void an already-posted return. Structural mirror of
   * sale-invoices.service.ts's `cancel()`/`voidPostedInvoice()`: same header `FOR UPDATE` lock,
   * same `JournalService` reversal technique (read back the original journal_line rows, swap
   * debit<->credit, post as a new reversing entry), same stock-movement reversal via
   * `StockService.applyMovement`. The GUARD, though, is different IN KIND, not just detail --
   * see the long comment below.
   *
   * -- Guard reasoning (the task's own framing: "what downstream state would block a clean
   * cancel") --
   * sale-invoices.service.ts's cancel guard is about a DIFFERENT DOCUMENT existing: an active
   * `sale_return` referencing the invoice. That works there because voiding an invoice always
   * means posting the dispensed stock BACK IN -- an inbound movement, which has no non-negativity
   * ceiling and can never fail on quantity grounds, so the only thing that CAN make an invoice
   * void "unsafe" is something external (a return already built on top of it).
   *
   * A sale return's void is the mirror image. It must post the returned stock BACK OUT of the
   * exact lot(s) the return put it into -- an OUTBOUND movement, which CAN fail if that stock is
   * no longer there. So the relevant "downstream state" here is not another document, it's the
   * LOT ITSELF having been touched since this return posted (re-sold on a later sale invoice,
   * pulled by a stock adjustment, etc. -- exactly the task's own phrasing, "re-sold or adjusted
   * away").
   *
   * The checkable condition this lands on: for every distinct (branch, item, stock lot) this
   * return posted a movement against, ask the append-only `stock_movement` ledger itself -- does
   * any OTHER movement row exist for that exact lot with a `stock_movement_id` greater than this
   * return's own (i.e. did anything happen to this lot AFTER this return posted, in either
   * direction)? `FOR UPDATE` on the `stock_balance` row first, ascending `stock_lot_id` (TX-6
   * deterministic lock order, the same discipline purchase-return.service.ts/sale-
   * invoices.service.ts document for their own multi-row locks), so no concurrent writer can slip
   * a new movement in between this check and the reversal that follows it. See
   * `assertStockUntouchedSinceReturn` below for the implementation and why this ledger-order check
   * -- not a `qty_on_hand` comparison -- is the right one.
   */
  async cancel(saleReturnId: number, input: CancelSaleReturnInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [saleReturn] = await tx
        .select()
        .from(saleReturns)
        .where(and(eq(saleReturns.tenantId, tenantId), eq(saleReturns.saleReturnId, saleReturnId)))
        .for("update");
      if (!saleReturn) {
        throw new AppException({
          status: 404,
          code: "SALE_RETURN.NOT_FOUND",
          title: "Sale return not found",
          detail: `No sale return with id ${saleReturnId} exists.`,
        });
      }
      this.assertVoidable(saleReturn);

      const lines = await tx
        .select()
        .from(saleReturnLines)
        .where(eq(saleReturnLines.saleReturnId, saleReturnId))
        .orderBy(asc(saleReturnLines.lineNo));
      await this.assertStockUntouchedSinceReturn(tx, saleReturn, lines);

      return this.voidPostedReturn(tx, {
        saleReturn,
        lines,
        tenantId,
        branchId,
        actorId,
        outcome: "cancelled",
        reason: input.reason ?? "Sale return cancelled",
        cancelReasonId: input.cancelReasonId ?? null,
      });
    });
  }

  /**
   * POST /sale-returns/:id/reverse -- an unconditional compensating entry: same stock/GL reversal
   * mechanics as `cancel` (both funnel through `voidPostedReturn`), but skips the stock-untouched
   * guard `cancel` enforces (see `cancel`'s own comment). "Unconditional" here means unconditional
   * with respect to THAT guard only -- the outbound stock movement below is still subject to
   * `StockService.applyMovement`'s own hard `FOR UPDATE` + non-negativity invariant, which no
   * document type in this codebase (this one included) can ever bypass, so a `reverse` attempted
   * when the returned stock has genuinely, entirely been consumed elsewhere still fails with `422
   * INVENTORY.INSUFFICIENT_STOCK` -- a real physical impossibility neither endpoint can paper
   * over. The practical difference from `cancel`: `reverse` succeeds in the common case `cancel`
   * would refuse -- some unrelated activity touched the lot since this return posted, but enough
   * quantity remains on hand to take this return's own contribution back out.
   */
  async reverse(saleReturnId: number, input: ReverseSaleReturnInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [saleReturn] = await tx
        .select()
        .from(saleReturns)
        .where(and(eq(saleReturns.tenantId, tenantId), eq(saleReturns.saleReturnId, saleReturnId)))
        .for("update");
      if (!saleReturn) {
        throw new AppException({
          status: 404,
          code: "SALE_RETURN.NOT_FOUND",
          title: "Sale return not found",
          detail: `No sale return with id ${saleReturnId} exists.`,
        });
      }
      this.assertVoidable(saleReturn);

      const lines = await tx
        .select()
        .from(saleReturnLines)
        .where(eq(saleReturnLines.saleReturnId, saleReturnId))
        .orderBy(asc(saleReturnLines.lineNo));

      return this.voidPostedReturn(tx, {
        saleReturn,
        lines,
        tenantId,
        branchId,
        actorId,
        outcome: "reversed",
        reason: input.reason ?? "Sale return reversed",
        cancelReasonId: null,
      });
    });
  }

  /** Shared by `cancel`/`reverse` -- same status guard as sale-invoices.service.ts's own
   *  `assertVoidable`, verbatim shape (only a `posted` return can be voided; neither verb can run
   *  twice). `422 SALE_RETURN.ALREADY_CANCELLED`/`ALREADY_REVERSED`/`NOT_POSTED`. */
  private assertVoidable(saleReturn: SaleReturnRow): void {
    if (saleReturn.status === "cancelled") {
      throw new BusinessRuleException(
        "SALE_RETURN.ALREADY_CANCELLED",
        "Already cancelled",
        `Sale return ${saleReturn.docNumber} was already cancelled.`,
      );
    }
    if (saleReturn.status === "reversed") {
      throw new BusinessRuleException(
        "SALE_RETURN.ALREADY_REVERSED",
        "Already reversed",
        `Sale return ${saleReturn.docNumber} was already reversed.`,
      );
    }
    if (saleReturn.status !== "posted") {
      throw new BusinessRuleException(
        "SALE_RETURN.NOT_POSTED",
        "Return not posted",
        `Sale return ${saleReturn.docNumber} is "${saleReturn.status}"; only a posted return can be cancelled or reversed.`,
      );
    }
  }

  /**
   * `cancel`'s own guard -- see that method's header comment for the full reasoning on WHY this
   * check exists and what it is standing in for.
   *
   * Implementation: for every distinct (branch, item, stock lot) this return's own lines touched,
   * find this return's own highest `stock_movement_id` against that exact lot (there can be more
   * than one, if two of this return's lines happened to slice from the same lot), then -- after
   * taking the `stock_balance` row's `FOR UPDATE` lock, ascending `stock_lot_id` (TX-6
   * deterministic order) -- count how many OTHER `stock_movement` rows exist for that lot with a
   * strictly higher id. `stock_movement` is append-only and its surrogate id is a strictly
   * increasing sequence (schema comment: "Corrections are compensating rows ... never edits"), so
   * "a row with a higher id exists" is an exact, race-free answer to "has anything touched this
   * lot since this return posted" -- no separate timestamp comparison or snapshot column needed.
   * Any count > 0 throws `422 SALE_RETURN.STOCK_ALREADY_MOVED`, directing the caller at `reverse`.
   *
   * Why THIS check and not a `qty_on_hand` comparison ("does the lot still have at least what this
   * return added"): a pure quantity check is strictly WEAKER than what `StockService.applyMovement`
   * itself already guarantees for free the moment the reversal actually runs (its own `FOR UPDATE`
   * + non-negativity guard rejects an impossible reversal regardless of which endpoint attempted
   * it) -- so a quantity-only pre-check here would just duplicate that guard under a friendlier
   * error code, WITHOUT giving `cancel` any behaviour genuinely distinct from `reverse`. This
   * ledger-order check is what actually earns "reverse when cancel refuses" as a real, observable
   * difference (verified live, not just typechecked): if, say, a stock adjustment lands on the
   * same lot afterwards and then gets reversed itself, netting `qty_on_hand` back to unchanged, a
   * quantity check would wave `cancel` through even though something DID happen to this lot in the
   * interim -- exactly the ambiguity "a clean cancel" is supposed to rule out. `reverse` is not
   * held to this stricter bar (by design -- see `reverse`'s own comment): it only needs the lot to
   * physically have enough on hand right now, which `applyMovement`'s own guard already enforces.
   *
   * (`stock_balance.last_movement_id` would answer a similar question directly off the balance
   * projection, but is declared in the schema and never actually populated by
   * `StockService.applyMovement` anywhere in this codebase today -- verified by reading
   * `applyMovement`, whose balance-row update only ever sets `qty_on_hand`/`last_movement_at` --
   * so this reads the ledger table itself instead of relying on that column.)
   */
  private async assertStockUntouchedSinceReturn(tx: Tx, saleReturn: SaleReturnRow, lines: SaleReturnLineRow[]): Promise<void> {
    const lotKeyOf = (branchId: number, itemId: number, stockLotId: number) => `${branchId}:${itemId}:${stockLotId}`;
    const distinctLots = new Map<string, { branchId: number; itemId: number; stockLotId: number }>();
    for (const line of lines) {
      const key = lotKeyOf(line.branchId, line.itemId, line.stockLotId);
      if (!distinctLots.has(key)) distinctLots.set(key, { branchId: line.branchId, itemId: line.itemId, stockLotId: line.stockLotId });
    }

    const sortedLots = [...distinctLots.values()].sort((a, b) => a.stockLotId - b.stockLotId);
    for (const lot of sortedLots) {
      // Lock the balance row FIRST -- from here until the transaction commits (either this guard
      // throwing and rolling back, or `voidPostedReturn`'s own `applyMovement` call later in the
      // same transaction), no concurrent writer can insert a new movement against this lot, so the
      // "any newer movement?" read below cannot be raced.
      await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.branchId, lot.branchId),
            eq(stockBalances.itemId, lot.itemId),
            eq(stockBalances.stockLotId, lot.stockLotId),
          ),
        )
        .for("update");

      const [ownMovement] = await tx
        .select({ maxId: sql<number | null>`max(${stockMovements.stockMovementId})` })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.tenantId, saleReturn.tenantId),
            eq(stockMovements.documentTypeId, saleReturn.documentTypeId),
            eq(stockMovements.sourceDocumentId, saleReturn.saleReturnId),
            eq(stockMovements.branchId, lot.branchId),
            eq(stockMovements.itemId, lot.itemId),
            eq(stockMovements.stockLotId, lot.stockLotId),
          ),
        );
      const ownMaxId = ownMovement?.maxId;
      if (ownMaxId === null || ownMaxId === undefined) {
        // Unreachable -- createAndPost always posts exactly one stock_movement per line before a
        // sale_return can ever reach "posted" (assertVoidable already required that to get here).
        throw new Error(`sale return ${saleReturn.saleReturnId} has no recorded movement for lot ${lot.stockLotId}`);
      }

      const [later] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.tenantId, saleReturn.tenantId),
            eq(stockMovements.branchId, lot.branchId),
            eq(stockMovements.itemId, lot.itemId),
            eq(stockMovements.stockLotId, lot.stockLotId),
            gt(stockMovements.stockMovementId, ownMaxId),
          ),
        );
      if ((later?.n ?? 0) > 0) {
        throw new BusinessRuleException(
          "SALE_RETURN.STOCK_ALREADY_MOVED",
          "Stock already moved -- cannot cleanly cancel",
          `Lot ${lot.stockLotId} has had other stock activity since this return posted (${later?.n ?? 0} later movement(s)) -- this return's own contribution can no longer be cleanly undone. Reverse this return instead of cancelling it.`,
        );
      }
    }
  }

  /**
   * Shared voiding mechanics for `cancel`/`reverse` -- structural mirror of sale-
   * invoices.service.ts's `voidPostedInvoice`. Once the caller's own guard has passed
   * (`assertVoidable`, and `cancel`'s own `assertStockUntouchedSinceReturn`), both verbs do
   * exactly the same thing: reverse every stock movement this return posted, reverse its GL
   * journal entry, flip status. They differ only in the resulting status, whether
   * `cancelledAt`/`cancelledBy`/`cancelReasonId` get stamped, and the journal entry-number
   * suffix/description/default reason text -- same reasoning sale-invoices.service.ts's own
   * `voidPostedInvoice` documents for why there was nothing left for the two verbs to differ on.
   *
   * Stock: for every `sale_return_line`, post a movement with the SAME lot/unit-cost the return
   * used, `-qtyBase` instead of the original `+qtyBase` -- taking the exact goods back OUT. This
   * is the mirror image of sale-invoices.service.ts's own void (which posts `+qtyBase`, INBOUND,
   * because a sale invoice's original movement was outbound) -- consistent with this file's own
   * header comment describing a sale return as "the reverse-direction sibling" of a cash sale.
   * Goes through `StockService.applyMovement`'s ordinary `FOR UPDATE` + non-negativity guard
   * exactly like any other outbound movement in this codebase; `cancel`'s own pre-check makes that
   * guard a formality in the common case, `reverse` has no pre-check so it can still legitimately
   * trip here (see `reverse`'s own comment). `sourceLineId` IS set here (unlike `createAndPost`'s
   * own inbound movement, whose own comment explains the line doesn't exist yet at that point) --
   * the line already exists by the time cancel/reverse run, exactly like sale-
   * invoices.service.ts's own void does for its lines.
   *
   * GL: reads back the ORIGINAL journal_line rows for `saleReturn.journalEntryId` and swaps
   * debit<->credit on each verbatim -- same technique and reasoning as sale-invoices.service.ts's
   * `voidPostedInvoice` (trivially balances, provably faithful to whatever `createAndPost`
   * actually posted -- including the return's conditional COGS legs -- with no separate formula to
   * keep in sync).
   */
  private async voidPostedReturn(
    tx: Tx,
    params: {
      saleReturn: SaleReturnRow;
      lines: SaleReturnLineRow[];
      tenantId: number;
      branchId: number;
      actorId: number;
      outcome: "cancelled" | "reversed";
      reason: string;
      cancelReasonId: number | null;
    },
  ): Promise<{ saleReturn: SaleReturnRow; lines: SaleReturnLineRow[] }> {
    const { saleReturn, lines, tenantId, branchId, actorId, outcome, reason, cancelReasonId } = params;

    // "Today", not the original return's own postingDate -- this is when the void actually
    // happens and needs its own OPEN fiscal period (the original period may have since closed),
    // same reasoning sale-invoices.service.ts's own voidPostedInvoice documents.
    const voidDate = localToday();
    const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, voidDate);

    // -- reverse stock: pull every returned line's quantity back OUT of its own original lot ----
    for (const line of lines) {
      await this.stock.applyMovement(tx, {
        tenantId,
        branchId: line.branchId,
        itemId: line.itemId,
        stockLotId: line.stockLotId,
        qtyDelta: Quantity.zero().sub(Quantity.fromDb(line.qtyBase)).toDb(), // negative -- mirror image of the return's own inbound movement
        unitCost: line.unitCost, // the line's own frozen cost, never the item's current avg
        documentTypeId: saleReturn.documentTypeId,
        sourceDocumentId: saleReturn.saleReturnId,
        sourceLineId: line.saleReturnLineId,
        fiscalPeriodId,
        postingDate: voidDate,
        actorId,
      });
    }

    // -- reverse the GL: swap every original leg's debit/credit side, post as a new entry -------
    if (saleReturn.journalEntryId === null) {
      // Unreachable -- createAndPost always posts a journal entry and binds journalEntryId before
      // the header's status can ever become "posted" (assertVoidable already required status ===
      // "posted" to get here).
      throw new Error(`posted sale return ${saleReturn.saleReturnId} has no journal entry`);
    }
    const originalLines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, saleReturn.journalEntryId))
      .orderBy(asc(journalLines.lineNo));
    const legs: JournalLegInput[] = originalLines.map((l) => {
      const wasDebit = !Money.fromDb(l.debitAmount).isZero();
      return {
        glAccountId: l.glAccountId,
        ...(wasDebit ? { credit: l.debitAmount } : { debit: l.creditAmount }),
        legRole: l.legRole,
        ...(l.supplierId !== null ? { supplierId: l.supplierId } : {}),
        ...(l.customerId !== null ? { customerId: l.customerId } : {}),
        ...(l.analysisAccountId !== null ? { analysisAccountId: l.analysisAccountId } : {}),
        ...(l.memo !== null ? { memo: l.memo } : {}),
      };
    });

    const [priorSeq] = await tx
      .select({ maxSeq: sql<number>`coalesce(max(${journalEntries.reversalSeq}), 0)` })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.documentTypeCode, "SR"),
          eq(journalEntries.sourceDocumentId, saleReturn.saleReturnId),
        ),
      );
    const reversalSeq = (priorSeq?.maxSeq ?? 0) + 1;

    const suffix = outcome === "cancelled" ? "CANCEL" : "REVERSE";
    await this.journal.post(tx, {
      tenantId,
      branchId,
      entryNo: `${saleReturn.docNumber}-${suffix}`,
      entryDate: voidDate,
      documentTypeCode: "SR",
      sourceDocumentId: saleReturn.saleReturnId,
      description: `${outcome === "cancelled" ? "Cancellation" : "Reversal"} of sale return ${saleReturn.docNumber}`,
      legs,
      postedBy: actorId,
      reversalSeq,
      reversalOfJournalId: saleReturn.journalEntryId,
      reversalReason: reason,
    });
    await tx
      .update(journalEntries)
      .set({ status: "reversed", updatedBy: actorId })
      .where(eq(journalEntries.journalEntryId, saleReturn.journalEntryId));

    // -- flip the header's own status -------------------------------------------------------------
    await tx
      .update(saleReturns)
      .set(
        outcome === "cancelled"
          ? { status: "cancelled", cancelledAt: new Date(), cancelledBy: actorId, cancelReasonId, updatedBy: actorId }
          : { status: "reversed", updatedBy: actorId },
      )
      .where(eq(saleReturns.saleReturnId, saleReturn.saleReturnId));

    const [updated] = await tx.select().from(saleReturns).where(eq(saleReturns.saleReturnId, saleReturn.saleReturnId));
    if (!updated) throw new Error("sale return vanished mid-transaction"); // unreachable; defensive
    return { saleReturn: updated, lines };
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
