// Blueprint: docs/system-analysis/05a-workflows-sales.md (cash sale, canonical commit sequence
// S-1) and 17-technical-blueprint.md §7.2 -- ONE db.transaction():
//
//   validate -> FEFO-allocate lots (StockService.allocateFefo, FOR UPDATE) -> compute totals ->
//   allocate invoice number (N-1: as late as possible, before the header insert) -> insert
//   header + lines (+ payment rows) -> apply stock movements -> JournalService.post -> done.
//
// Sequencing note vs the S-1 prose: `applyMovement` rows carry source_document_id/
// source_line_id, so the movement writes happen AFTER the header + line inserts produce those
// ids -- the FEFO step has already locked every touched stock_balance row FOR UPDATE, so no
// other writer can interleave between allocation and movement application.
//
// External I/O (FBR fiscalization) is deferred entirely -- no tax/FBR legs this increment.
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { costAmount, Money, Quantity } from "@pharmacy/money";
import {
  cashBankAccounts,
  customers,
  getDb,
  glAccounts,
  items,
  paymentMethods,
  saleCategories,
  saleInvoiceLines,
  saleInvoicePayments,
  saleInvoices,
} from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { JournalService, type JournalLegInput } from "../../../common/ledger/journal.service.js";
import { StockService, type FefoAllocation } from "../../inventory/infrastructure/stock.service.js";
import type { CreateSaleInvoiceDto, ListSaleInvoicesQueryDto } from "../api/dto/sale-invoice.dto.js";

// TODO(real tenancy): single-tenant dev resolution -- tenant/branch come from the session once
// real multi-tenant auth is wired (17 §9.1). Seeded dev tenant/branch are both id 1.
const DEV_TENANT_ID = 1;
const DEV_BRANCH_ID = 1;

export type SaleInvoiceRow = typeof saleInvoices.$inferSelect;
export type SaleInvoiceLineRow = typeof saleInvoiceLines.$inferSelect;
export type SaleInvoicePaymentRow = typeof saleInvoicePayments.$inferSelect;

export interface CreateSaleInvoiceResult {
  readonly saleInvoice: SaleInvoiceRow;
  readonly lines: SaleInvoiceLineRow[];
  readonly allocations: readonly (FefoAllocation & { readonly itemId: number })[];
  readonly changeAmount: string;
  readonly journalEntryId: number;
}

/** True when a wire decimal string is exactly zero ("0", "0.00", "-0.0", ...). */
function isZeroDecimal(raw: string | undefined): boolean {
  return raw === undefined || /^-?0+(\.0+)?$/.test(raw);
}

@Injectable()
export class SaleInvoicesService {
  constructor(
    private readonly stock: StockService,
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
  ) {}

  async createCashSale(dto: CreateSaleInvoiceDto, actor: Actor): Promise<CreateSaleInvoiceResult> {
    const db = getDb();
    const actorId = Number(actor.userId);

    // Discounts are a later increment -- the M-5 rounding ladder is not built, so any non-zero
    // discount input is an honest 422 rather than silently ignored math. TODO(discounts).
    const discountInputs = [
      dto.invoiceDiscountPercent,
      dto.invoiceDiscountAmount,
      ...dto.lines.flatMap((l) => [l.discountPercent, l.itemFlatDiscount]),
    ];
    if (discountInputs.some((v) => !isZeroDecimal(v))) {
      throw new BusinessRuleException(
        "SALES.NOT_IMPLEMENTED",
        "Discounts not available yet",
        "Discounts are not implemented in this increment; send zero or omit discount fields.",
      );
    }

    return db.transaction(async (tx: Tx) => {
      // -- validate: customer (default walk-in, 00b D5) -------------------------------------
      const customerWhere =
        dto.customerId !== undefined
          ? and(eq(customers.tenantId, DEV_TENANT_ID), eq(customers.customerId, dto.customerId))
          : and(eq(customers.tenantId, DEV_TENANT_ID), eq(customers.isWalkIn, true));
      const [customer] = await tx.select().from(customers).where(customerWhere).limit(1);
      if (!customer || !customer.isActive) {
        throw new BusinessRuleException(
          "SALES.CUSTOMER_INVALID",
          "Customer unavailable",
          dto.customerId !== undefined
            ? `Customer ${dto.customerId} does not exist or is inactive.`
            : "No walk-in customer is seeded for this tenant.",
        );
      }

      // -- validate: sale category (default CASH_SALE; cash counterparty only this increment) --
      const categoryWhere =
        dto.saleCategoryId !== undefined
          ? and(eq(saleCategories.tenantId, DEV_TENANT_ID), eq(saleCategories.saleCategoryId, dto.saleCategoryId))
          : and(eq(saleCategories.tenantId, DEV_TENANT_ID), eq(saleCategories.isDefault, true), eq(saleCategories.isReturn, false));
      const [category] = await tx.select().from(saleCategories).where(categoryWhere).limit(1);
      if (!category || !category.isEnabled || category.isReturn) {
        throw new BusinessRuleException(
          "SALES.CATEGORY_INVALID",
          "Sale category unavailable",
          "The requested sale category does not exist, is disabled, or is a return category.",
        );
      }
      if (category.counterparty !== "cash") {
        // Credit sales (Dr customer control account) are a later increment (07 §4.1 rule-as-data).
        throw new BusinessRuleException(
          "SALES.NOT_IMPLEMENTED",
          "Credit sales not available yet",
          `Sale category "${category.code}" posts to a customer account; only cash-counterparty sales are implemented.`,
        );
      }

      // -- validate: fiscal period from the business date (17 §7.8) -------------------------
      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, DEV_TENANT_ID, dto.documentDate);

      // -- validate + price + FEFO-allocate each requested line -----------------------------
      interface PlannedLine {
        readonly itemId: number;
        readonly packUnitsAtTxn: number;
        readonly packSalePrice: string;
        readonly unitSalePrice: string; // per LOOSE unit -- shared by every slice of the request
        readonly unitCost: string; // C-6: the item's CURRENT avg cost, stamped, never moved
        readonly qty: string; // this slice's loose units
        readonly stockLotId: number;
        readonly expiryAtSale: Date | null;
        readonly lineGrossAmount: string;
        readonly lineCostAmount: string;
      }
      const plannedByLine: PlannedLine[][] = new Array(dto.lines.length);
      const allocationsByLine: (FefoAllocation & { itemId: number })[][] = new Array(dto.lines.length);

      // TX-6 (extended cross-item/cross-invoice): allocateFefo locks that item's stock_balance
      // rows FOR UPDATE. Allocating in client-supplied array order means two concurrent invoices
      // requesting the same items in different orders (invoice A: item 10 then item 20; invoice
      // B: item 20 then item 10) can lock-order-invert and deadlock under InnoDB (error 1213),
      // with nothing to retry the transaction and recover. Processing lines sorted by itemId
      // ascending -- NOT the client-supplied order -- gives every concurrent sale the SAME
      // cross-item lock order, extending the same deterministic-lock-order discipline
      // `StockService.allocateFefo`'s own header comment already documents for its within-item
      // lot ordering. `plannedByLine`/`allocationsByLine` stay indexed by the ORIGINAL line
      // position so line_no and the response are restored to submission order below.
      const processingOrder = dto.lines
        .map((line, index) => ({ line, index }))
        .sort((a, b) => a.line.itemId - b.line.itemId); // stable sort (ES2019+): itemId ties keep original order

      for (const { line, index } of processingOrder) {
        const qty = Quantity.fromDb(line.qty);
        if (qty.isZero() || qty.isNegative()) {
          throw new BusinessRuleException(
            "SALES.LINE_QTY_INVALID",
            "Invalid quantity",
            `Line ${index + 1}: quantity must be a positive number of loose units.`,
          );
        }

        // C-6: read the item INSIDE the transaction -- sales stamp the current moving-average
        // cost, they never move the average.
        const [item] = await tx
          .select({
            itemId: items.itemId,
            name: items.name,
            packUnits: items.packUnits,
            salePrice: items.salePrice,
            avgUnitCost: items.avgUnitCost,
            isActive: items.isActive,
          })
          .from(items)
          .where(and(eq(items.tenantId, DEV_TENANT_ID), eq(items.itemId, line.itemId)));
        if (!item || !item.isActive) {
          throw new BusinessRuleException(
            "SALES.ITEM_INVALID",
            "Item unavailable",
            `Line ${index + 1}: item ${line.itemId} does not exist or is inactive.`,
          );
        }

        // Price resolution: unit_sale_price is per LOOSE unit (08 §5.2). item.salePrice is per
        // PACK; deriving a per-loose price needs a rounding policy this increment does not
        // define -- TODO(price resolution): a 5dp helper exists only for COST (unitCostIn), and
        // inventing a price-rounding rule here would be dishonest. So: default from salePrice
        // only when packUnits === 1 (pack price IS the loose price); otherwise the client must
        // send unitSalePrice.
        let unitSalePrice: string;
        if (line.unitSalePrice !== undefined) {
          const price = Money.fromDb(line.unitSalePrice);
          if (price.isNegative()) {
            throw new BusinessRuleException(
              "SALES.PRICE_INVALID",
              "Invalid price",
              `Line ${index + 1}: unitSalePrice cannot be negative.`,
            );
          }
          unitSalePrice = line.unitSalePrice;
        } else if (item.packUnits === 1) {
          unitSalePrice = item.salePrice;
        } else {
          throw new BusinessRuleException(
            "SALES.PRICE_REQUIRED",
            "Unit price required",
            `Line ${index + 1}: item "${item.name}" has ${item.packUnits} loose units per pack; send unitSalePrice (per loose unit) explicitly.`,
          );
        }

        // FEFO allocation locks every candidate stock_balance FOR UPDATE (B-2/TX-6) and throws
        // 422 INVENTORY.INSUFFICIENT_STOCK on shortfall.
        const allocations = await this.stock.allocateFefo(tx, {
          tenantId: DEV_TENANT_ID,
          branchId: DEV_BRANCH_ID,
          itemId: item.itemId,
          qtyRequired: qty.toDb(),
        });

        // B-6 RowGroup: a requested line spanning multiple lots becomes multiple DB lines with
        // sequential line_no (uk_sale_line is (invoice, line_no)), every slice stamped with the
        // SAME requested unit price. (No row_group column exists yet -- the shared price + item
        // adjacency is the grouping this increment records.)
        const lineSlices: PlannedLine[] = [];
        const lineAllocations: (FefoAllocation & { itemId: number })[] = [];
        for (const allocation of allocations) {
          lineSlices.push({
            itemId: item.itemId,
            packUnitsAtTxn: item.packUnits,
            packSalePrice: item.salePrice,
            unitSalePrice,
            unitCost: item.avgUnitCost,
            qty: allocation.qty,
            stockLotId: allocation.stockLotId,
            expiryAtSale: allocation.expiryDate,
            lineGrossAmount: costAmount(allocation.qty, unitSalePrice),
            lineCostAmount: costAmount(allocation.qty, item.avgUnitCost), // COGS at current avg (C-6)
          });
          lineAllocations.push({ ...allocation, itemId: item.itemId });
        }
        plannedByLine[index] = lineSlices;
        allocationsByLine[index] = lineAllocations;
      }

      // Restore original request order (map back by original index, per line) so line_no and
      // the response order match what the client submitted, independent of the itemId-sorted
      // lock-acquisition pass above.
      const planned: PlannedLine[] = plannedByLine.flat();
      const allAllocations: (FefoAllocation & { itemId: number })[] = allocationsByLine.flat();

      // -- compute totals (no discounts, no tax, roundingAmount "0.00" this increment) -------
      let grossAmount = Money.zero();
      let cogsAmount = Money.zero();
      let totalQty = Quantity.zero();
      for (const line of planned) {
        grossAmount = grossAmount.add(Money.fromDb(line.lineGrossAmount));
        cogsAmount = cogsAmount.add(Money.fromDb(line.lineCostAmount));
        totalQty = totalQty.add(Quantity.fromDb(line.qty));
      }
      const netAmount = grossAmount; // no discounts
      const invoiceTotal = netAmount; // no tax, no FBR fee, rounding 0.00 (M-5 ladder deferred)

      // -- validate payments: resolve methods + settlement accounts, Σ must cover the total ---
      interface PlannedPayment {
        readonly paymentMethodId: number;
        readonly cashBankAccountId: number;
        readonly glAccountId: number;
        readonly amount: string;
        readonly referenceNo: string | null;
        /** P1.5 `payment_method.is_counter_method` -- only a counter (cash-drawer) method may
         *  absorb change (Bug 1 fix below: change can't be "returned" against a card/bank leg). */
        readonly isCounterMethod: boolean;
      }
      const plannedPayments: PlannedPayment[] = [];
      let paidTotal = Money.zero();
      for (const [index, payment] of dto.payments.entries()) {
        const amount = Money.fromDb(payment.amount);
        if (amount.isZero() || amount.isNegative()) {
          throw new BusinessRuleException(
            "SALES.PAYMENT_INVALID",
            "Invalid payment",
            `Payment ${index + 1}: amount must be positive (ck_sale_payment_amount).`,
          );
        }
        const [method] = await tx
          .select()
          .from(paymentMethods)
          .where(and(eq(paymentMethods.tenantId, DEV_TENANT_ID), eq(paymentMethods.paymentMethodId, payment.paymentMethodId)));
        if (!method || !method.isEnabled) {
          throw new BusinessRuleException(
            "SALES.PAYMENT_METHOD_INVALID",
            "Payment method unavailable",
            `Payment ${index + 1}: payment method ${payment.paymentMethodId} does not exist or is disabled.`,
          );
        }
        // Settlement account: the method's default, else the sale category's default cash
        // account, else the seeded default-for-sales cash drawer (seed: MAIN_CASH on GL 1000).
        let cashBankAccountId: number | undefined =
          method.defaultCashBankAccountId ?? category.defaultCashAccountId ?? undefined;
        if (cashBankAccountId === undefined) {
          const [fallback] = await tx
            .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
            .from(cashBankAccounts)
            .where(and(eq(cashBankAccounts.tenantId, DEV_TENANT_ID), eq(cashBankAccounts.isDefaultForSales, true)))
            .limit(1);
          cashBankAccountId = fallback?.cashBankAccountId;
        }
        if (cashBankAccountId === undefined) {
          throw new BusinessRuleException(
            "SALES.CASH_ACCOUNT_MISSING",
            "No settlement account",
            `Payment ${index + 1}: no cash/bank account is configured for method "${method.code}".`,
          );
        }
        const [cba] = await tx
          .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId, glAccountId: cashBankAccounts.glAccountId })
          .from(cashBankAccounts)
          .where(and(eq(cashBankAccounts.tenantId, DEV_TENANT_ID), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
        if (!cba) {
          throw new BusinessRuleException(
            "SALES.CASH_ACCOUNT_MISSING",
            "No settlement account",
            `Payment ${index + 1}: cash/bank account ${cashBankAccountId} does not exist.`,
          );
        }
        plannedPayments.push({
          paymentMethodId: method.paymentMethodId,
          cashBankAccountId: cba.cashBankAccountId,
          glAccountId: cba.glAccountId,
          amount: amount.toDb(),
          referenceNo: payment.referenceNo ?? null,
          isCounterMethod: method.isCounterMethod,
        });
        paidTotal = paidTotal.add(amount);
      }
      if (paidTotal.compare(invoiceTotal) < 0) {
        throw new BusinessRuleException(
          "SALES.PAYMENT_SHORT",
          "Payment does not cover the invoice",
          `Tendered ${paidTotal.toDb()} is less than the invoice total ${invoiceTotal.toDb()}.`,
        );
      }
      const changeAmount = paidTotal.sub(invoiceTotal);

      // -- allocate the invoice number (N-1: as late as possible, right before the header) ---
      const allocatedNumber = await this.docNumbers.allocate(tx, DEV_TENANT_ID, "SV");

      // -- insert header ---------------------------------------------------------------------
      const now = new Date();
      const businessDate = new Date(`${dto.documentDate}T00:00:00`);
      await tx.insert(saleInvoices).values({
        tenantId: DEV_TENANT_ID,
        branchId: DEV_BRANCH_ID,
        docNumber: allocatedNumber.docNumber,
        docSeriesId: allocatedNumber.docSeriesId,
        documentTypeId: allocatedNumber.documentTypeId,
        documentDate: businessDate,
        postingDate: businessDate,
        fiscalPeriodId,
        status: "posted",
        postedAt: now,
        postedBy: actorId,
        customerId: customer.customerId,
        saleCategoryId: category.saleCategoryId,
        grossAmount: grossAmount.toDb(),
        netAmount: netAmount.toDb(),
        roundingAmount: "0.00", // 2dp exact; M-5 rounding ladder is a later increment
        invoiceTotal: invoiceTotal.toDb(),
        // paidAmount records what settled the invoice (= total); the excess tender is
        // change_amount, so the generated balance_amount stays 0 for cash sales (D5).
        paidAmount: invoiceTotal.toDb(),
        changeAmount: changeAmount.toDb(),
        totalQty: totalQty.toDb(),
        lineCount: planned.length,
        cogsAmount: cogsAmount.toDb(),
        notes: dto.notes ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [header] = await tx
        .select()
        .from(saleInvoices)
        .where(and(eq(saleInvoices.docSeriesId, allocatedNumber.docSeriesId), eq(saleInvoices.docNumber, allocatedNumber.docNumber)));
      if (!header) throw new Error("sale_invoice insert did not land"); // unreachable; defensive

      // -- insert lines (one DB line per FEFO slice, sequential line_no) ---------------------
      await tx.insert(saleInvoiceLines).values(
        planned.map((line, i) => ({
          tenantId: DEV_TENANT_ID,
          saleInvoiceId: header.saleInvoiceId,
          lineNo: i + 1,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          branchId: DEV_BRANCH_ID,
          qtyPack: "0.0000",
          qtyLoose: line.qty, // requested in loose units
          qtyBonus: "0.0000",
          packUnitsAtTxn: line.packUnitsAtTxn,
          qtyBase: line.qty,
          unitSalePrice: line.unitSalePrice,
          packSalePrice: line.packSalePrice,
          lineGrossAmount: line.lineGrossAmount,
          lineNetAmount: line.lineGrossAmount, // no discounts this increment
          unitCost: line.unitCost,
          lineCostAmount: line.lineCostAmount,
          expiryAtSale: line.expiryAtSale,
          createdBy: actorId,
          createdSource: "api" as const,
        })),
      );
      const lineRows = await tx
        .select()
        .from(saleInvoiceLines)
        .where(eq(saleInvoiceLines.saleInvoiceId, header.saleInvoiceId))
        .orderBy(asc(saleInvoiceLines.lineNo));

      // -- insert payment rows ---------------------------------------------------------------
      await tx.insert(saleInvoicePayments).values(
        plannedPayments.map((payment, i) => ({
          tenantId: DEV_TENANT_ID,
          saleInvoiceId: header.saleInvoiceId,
          paymentMethodId: payment.paymentMethodId,
          cashBankAccountId: payment.cashBankAccountId,
          amount: payment.amount,
          referenceNo: payment.referenceNo,
          sequenceNo: i + 1,
          createdBy: actorId,
          createdSource: "api" as const,
        })),
      );

      // -- apply stock movements: one per line/slice, negative delta, avg cost stamped (C-6) --
      // The balances were locked FOR UPDATE by allocateFefo above, so nothing can have consumed
      // the allocated quantity in between; applyMovement re-checks non-negativity regardless.
      for (const [i, line] of planned.entries()) {
        const lineRow = lineRows[i];
        await this.stock.applyMovement(tx, {
          tenantId: DEV_TENANT_ID,
          branchId: DEV_BRANCH_ID,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          qtyDelta: Quantity.zero().sub(Quantity.fromDb(line.qty)).toDb(),
          unitCost: line.unitCost, // C-6: current avg cost, never the lot receipt cost
          documentTypeId: allocatedNumber.documentTypeId,
          sourceDocumentId: header.saleInvoiceId,
          ...(lineRow ? { sourceLineId: lineRow.saleInvoiceLineId } : {}),
          fiscalPeriodId,
          postingDate: dto.documentDate,
          actorId,
        });
      }

      // -- post the journal (S-4 adapted to perpetual inventory per S-5) ---------------------
      //   Dr Cash (1000-family, per settlement account)  invoiceTotal   [payment]
      //   Cr Sales 4000                                  netAmount      [primary_credit]
      //   Dr COGS 5200                                   cogsAmount     [cogs]
      //   Cr Inventory 1200                              cogsAmount     [cogs]
      // No tax/FBR legs this increment (amounts "0.00" on the header) -- TODO(FBR/tax legs).
      const glCodeIds = new Map<string, number>();
      for (const code of ["4000", "5200", "1200"]) {
        const [row] = await tx
          .select({ glAccountId: glAccounts.glAccountId })
          .from(glAccounts)
          .where(and(eq(glAccounts.tenantId, DEV_TENANT_ID), eq(glAccounts.code, code)));
        if (!row) {
          throw new BusinessRuleException(
            "SALES.GL_ACCOUNT_MISSING",
            "Chart of accounts incomplete",
            `GL account ${code} is not configured; run the GL seed first.`,
          );
        }
        glCodeIds.set(code, row.glAccountId);
      }
      const mustGl = (code: string): number => glCodeIds.get(code) as number;

      // Dr the settlement account for EVERY tendered payment (Bug 1 fix): each payment row
      // already landed in sale_invoice_payments with its full tendered amount, so each one gets
      // its own GL leg for that same amount -- no early `break`, nothing silently dropped from
      // the ledger. The only adjustment is change: the single payment that absorbs it is debited
      // `amount - changeAmount` instead of the full amount, so total payment-leg debits still
      // equal `paidTotal - changeAmount === invoiceTotal`, balancing the Sales/COGS credit legs
      // below exactly as before.
      //
      // Change can only be handed back from a cash drawer (a business rule, not a UX nicety) --
      // returning it against a card/bank-transfer leg would debit that settlement account for
      // less than what the rail actually recorded moving. So the absorbing payment must be a
      // counter (cash) method whose own amount covers the change; if none qualifies, this is a
      // 422, not a silent "somebody eats the rounding" fallback.
      let changeAbsorbingIndex = -1;
      if (!changeAmount.isZero()) {
        changeAbsorbingIndex = plannedPayments.findIndex(
          (payment) => payment.isCounterMethod && Money.fromDb(payment.amount).compare(changeAmount) >= 0,
        );
        if (changeAbsorbingIndex === -1) {
          throw new BusinessRuleException(
            "SALES.OVERPAYMENT_REQUIRES_CASH",
            "Change requires a cash payment",
            `Change of ${changeAmount.toDb()} cannot be returned: no single cash-type payment tendered at least that much.`,
          );
        }
      }

      const legs: JournalLegInput[] = [];
      plannedPayments.forEach((payment, i) => {
        const tendered = Money.fromDb(payment.amount);
        const legAmount = i === changeAbsorbingIndex ? tendered.sub(changeAmount) : tendered;
        // A payment whose entire tender became change (legAmount === 0) contributes nothing to
        // the ledger -- ck_journal_line_nonzero (ledger.ts) forbids a zero-both-sides leg, so it
        // is skipped here exactly like the cogsAmount-zero COGS legs below. The balance identity
        // (Σ payment legs === invoiceTotal) is unaffected: a zero addend changes nothing.
        if (legAmount.isZero()) return;
        legs.push({
          glAccountId: payment.glAccountId,
          debit: legAmount.toDb(),
          legRole: "payment",
          customerId: customer.customerId, // analysis dimension on the money leg (S-4)
        });
      });
      legs.push({ glAccountId: mustGl("4000"), credit: netAmount.toDb(), legRole: "primary_credit" });
      if (!cogsAmount.isZero()) {
        // Perpetual COGS legs (S-5 binding). Skipped only when COGS is exactly zero (items with
        // no cost history) -- a zero-amount leg would be noise, not information.
        legs.push({ glAccountId: mustGl("5200"), debit: cogsAmount.toDb(), legRole: "cogs" });
        legs.push({ glAccountId: mustGl("1200"), credit: cogsAmount.toDb(), legRole: "cogs" });
      }
      const journalEntryId = await this.journal.post(tx, {
        tenantId: DEV_TENANT_ID,
        branchId: DEV_BRANCH_ID,
        entryNo: allocatedNumber.docNumber,
        entryDate: dto.documentDate,
        documentTypeCode: "SV",
        sourceDocumentId: header.saleInvoiceId,
        description: `Cash sale ${allocatedNumber.docNumber} to ${customer.name}`,
        legs,
        postedBy: actorId,
      });

      // Bind the posting to the header (uk_sale_invoice_journal: one posting per document).
      await tx
        .update(saleInvoices)
        .set({ journalEntryId })
        .where(eq(saleInvoices.saleInvoiceId, header.saleInvoiceId));

      return {
        saleInvoice: { ...header, journalEntryId },
        lines: lineRows,
        allocations: allAllocations,
        changeAmount: changeAmount.toDb(),
        journalEntryId,
      };
    });
  }

  async list(query: ListSaleInvoicesQueryDto): Promise<{ saleInvoices: SaleInvoiceRow[]; limit: number; offset: number }> {
    const db = getDb();
    const conditions = [eq(saleInvoices.tenantId, DEV_TENANT_ID)];
    if (query.customerId !== undefined) conditions.push(eq(saleInvoices.customerId, query.customerId));
    if (query.status !== undefined) conditions.push(eq(saleInvoices.status, query.status));
    if (query.dateFrom !== undefined) conditions.push(gte(saleInvoices.postingDate, new Date(`${query.dateFrom}T00:00:00`)));
    if (query.dateTo !== undefined) conditions.push(lte(saleInvoices.postingDate, new Date(`${query.dateTo}T00:00:00`)));
    const rows = await db
      .select()
      .from(saleInvoices)
      .where(and(...conditions))
      .orderBy(desc(saleInvoices.saleInvoiceId)) // newest first
      .limit(query.limit)
      .offset(query.offset);
    return { saleInvoices: rows, limit: query.limit, offset: query.offset };
  }

  async getById(saleInvoiceId: number): Promise<{
    saleInvoice: SaleInvoiceRow;
    lines: SaleInvoiceLineRow[];
    payments: SaleInvoicePaymentRow[];
  }> {
    const db = getDb();
    const [header] = await db
      .select()
      .from(saleInvoices)
      .where(and(eq(saleInvoices.tenantId, DEV_TENANT_ID), eq(saleInvoices.saleInvoiceId, saleInvoiceId)));
    if (!header) {
      throw new AppException({
        status: 404,
        code: "SALES.INVOICE_NOT_FOUND",
        title: "Sale invoice not found",
        detail: `No sale invoice with id ${saleInvoiceId} exists.`,
      });
    }
    const lines = await db
      .select()
      .from(saleInvoiceLines)
      .where(eq(saleInvoiceLines.saleInvoiceId, saleInvoiceId))
      .orderBy(asc(saleInvoiceLines.lineNo));
    const payments = await db
      .select()
      .from(saleInvoicePayments)
      .where(eq(saleInvoicePayments.saleInvoiceId, saleInvoiceId))
      .orderBy(asc(saleInvoicePayments.sequenceNo));
    return { saleInvoice: header, lines, payments };
  }
}
