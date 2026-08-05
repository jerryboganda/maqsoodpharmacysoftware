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
//
// Wave 7 lifecycle actions (preview/cancel/reverse/print) -- task instruction's own scope note,
// preserved here since it explains a deliberate omission a reader might otherwise flag as a gap:
// sale-invoice creation (`POST /sale-invoices`, `createCashSale` below) is ALREADY atomic
// create-and-post in one transaction -- there is no persisted draft state to separately "post"
// later, so a standalone "post" endpoint/permission is NOT part of this module (no `sale.cash:
// post` permission row exists either, by the same design -- see packages/db/scripts/seed.ts's
// own comment on that omission). The four real gaps this wave fills:
//   - `preview` -- a DRY RUN of `createCashSale`'s own validation/pricing/FEFO logic, reusing it
//     via `computeSale` (below) rather than re-implementing it, but never opening a write
//     transaction: no doc number allocated, no row inserted.
//   - `cancel` -- void an already-posted invoice, guarded by whether a `sale_return` already
//     depends on it (mirrors payments/application/payment.service.ts's `cancel()` -- see that
//     method's own "zero active allocations" guard and its `FOR UPDATE`/AppException-code
//     conventions, followed here).
//   - `reverse` -- the same compensating entry as `cancel`, unconditionally (works even when a
//     sale_return exists) -- see `voidPostedInvoice` below for the shared mechanics and where
//     `cancel`/`reverse` actually differ.
//   - `print`/`reprint` -- a structured JSON receipt payload (not a PDF/ESC-POS render -- this
//     codebase's own established precedent for "first version", e.g. reporting/application/
//     report-registry.ts's header comment, is "simplest correct choice for a first version", and
//     there is zero receipt-rendering code anywhere in this codebase today to build on).
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import { costAmount, Money, Quantity } from "@pharmacy/money";
import {
  branches,
  cashBankAccounts,
  customers,
  getDb,
  glAccounts,
  items,
  journalEntries,
  journalLines,
  paymentMethods,
  saleCategories,
  saleInvoiceLines,
  saleInvoicePayments,
  saleInvoices,
  saleReturns,
  tenants,
} from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import type { DbOrTx, Tx } from "../../../common/db/index.js";
import { localToday } from "../../../common/dates/index.js";
import { DocNumberService, FiscalPeriodService } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { LimitsService } from "../../../common/authz/limits.service.js";
import { ScopeService } from "../../../common/authz/scope.service.js";
import { JournalService, type JournalLegInput } from "../../../common/ledger/journal.service.js";
import { StockService, type FefoAllocation } from "../../inventory/infrastructure/stock.service.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type {
  CancelSaleInvoiceInput,
  CreateSaleInvoiceDto,
  ListSaleInvoicesQueryDto,
  ReverseSaleInvoiceInput,
} from "../api/dto/sale-invoice.dto.js";

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

/** One requested line's FEFO-sliced allocation, priced -- the unit both `computeSale`'s internal
 *  planning array and `preview`'s response reuse (see `ComputedSale`/`SaleInvoicePreviewLine`
 *  below). Fields mirror exactly what `createCashSale` needs to insert `sale_invoice_line` rows;
 *  `itemName`/`requestedLineIndex` are the two additions beyond that (no column on the line table
 *  needs them, but `preview`'s response does, and reading/tracking them once here avoids preview
 *  re-querying `items` or losing the "which original request line" grouping). */
interface PlannedLine {
  readonly itemId: number;
  readonly itemName: string;
  readonly requestedLineIndex: number; // the ORIGINAL request-line this slice belongs to (0-based)
  readonly packUnitsAtTxn: number;
  readonly packSalePrice: string;
  readonly unitSalePrice: string; // per LOOSE unit -- shared by every slice of the request
  readonly unitCost: string; // C-6: the item's CURRENT avg cost, stamped, never moved
  readonly qty: string; // this slice's loose units
  readonly stockLotId: number;
  readonly expiryAtSale: Date | null;
  readonly lineGrossAmount: string;
  readonly lineCostAmount: string;
  /** U-062/D18/R7: verbatim from the requested line's own `dispensingNote` (DTO), null when
   *  omitted. Every FEFO slice of one requested line carries the SAME note -- it describes the
   *  dispensing event for that item, not a specific lot. */
  readonly dispensingNote: string | null;
}

interface PlannedPayment {
  readonly paymentMethodId: number;
  readonly cashBankAccountId: number;
  readonly glAccountId: number;
  readonly amount: string;
  readonly referenceNo: string | null;
  /** P1.5 `payment_method.is_counter_method` -- only a counter (cash-drawer) method may absorb
   *  change (Bug 1 fix: change can't be "returned" against a card/bank leg). */
  readonly isCounterMethod: boolean;
}

/** Everything `createCashSale` and `preview` both need: every validation/pricing/FEFO/payment
 *  check `createCashSale` already ran, computed but NOT YET WRITTEN anywhere -- no doc number
 *  allocated, no row inserted. `createCashSale` calls this once inside its own `db.transaction()`
 *  and continues on to insert; `preview` calls it directly against a plain (non-tx) `Db` and
 *  returns straight from it. This is the one extraction point the task asked for ("extract a
 *  shared private method both createCashSale and preview call, don't duplicate the pricing
 *  math"). */
interface ComputedSale {
  readonly customer: typeof customers.$inferSelect;
  readonly category: typeof saleCategories.$inferSelect;
  readonly fiscalPeriodId: number;
  readonly planned: readonly PlannedLine[];
  readonly allAllocations: readonly (FefoAllocation & { readonly itemId: number })[];
  readonly grossAmount: Money;
  readonly cogsAmount: Money;
  readonly totalQty: Quantity;
  readonly netAmount: Money;
  readonly invoiceTotal: Money;
  readonly plannedPayments: readonly PlannedPayment[];
  readonly paidTotal: Money;
  readonly changeAmount: Money;
  /** Index into `plannedPayments` of the payment absorbing change, or -1 when changeAmount is
   *  zero. Computed here (not re-derived by each caller) so `preview` and `createCashSale` report
   *  the identical answer to "can this even be tendered". */
  readonly changeAbsorbingIndex: number;
}

export interface SaleInvoicePreviewLine {
  readonly lineNo: number; // 1-based, original request-line order (NOT FEFO-slice order)
  readonly itemId: number;
  readonly itemName: string;
  readonly qty: string; // requested loose qty for this line
  readonly unitSalePrice: string;
  readonly lineGrossAmount: string; // Σ across this line's FEFO slices
  readonly lineCostAmount: string;
  /** Per-lot FEFO breakdown -- "line-level availability" the task asked preview to report. */
  readonly allocations: readonly {
    readonly stockLotId: number;
    readonly qty: string;
    readonly batchNo: string | null;
    readonly expiryDate: Date | null;
  }[];
}

export interface SaleInvoicePreviewResult {
  readonly customerId: number;
  readonly customerName: string;
  readonly saleCategoryId: number;
  readonly lines: readonly SaleInvoicePreviewLine[];
  readonly grossAmount: string;
  readonly netAmount: string;
  readonly cogsAmount: string;
  readonly invoiceTotal: string;
  readonly totalQty: string;
  readonly paidTotal: string;
  readonly changeAmount: string;
}

export interface SaleInvoicePrintResult {
  readonly printFormat: "standard_receipt";
  readonly header: {
    readonly saleInvoiceId: number;
    readonly docNumber: string;
    readonly documentDate: Date;
    readonly postingDate: Date;
    readonly status: string;
    readonly tenantName: string | null;
    readonly branchName: string | null;
    readonly customer: { readonly customerId: number; readonly name: string | null };
  };
  readonly lines: readonly {
    readonly lineNo: number;
    readonly itemId: number;
    readonly itemName: string;
    readonly itemCode: string;
    readonly qty: string;
    readonly unitSalePrice: string;
    readonly itemFlatDiscount: string;
    readonly discountPercent: string;
    readonly lineDiscountAmount: string;
    readonly lineGrossAmount: string;
    readonly lineNetAmount: string;
    readonly lineTaxAmount: string;
  }[];
  readonly taxBreakdown: {
    readonly salesTaxAmount: string;
    readonly advanceIncomeTaxAmount: string;
    readonly fbrPosFeeAmount: string;
  };
  readonly grossAmount: string;
  readonly lineDiscountAmount: string;
  readonly invoiceDiscountAmount: string;
  readonly netAmount: string;
  readonly roundingAmount: string;
  readonly invoiceTotal: string;
  readonly payments: readonly {
    readonly sequenceNo: number;
    readonly paymentMethodId: number;
    readonly methodName: string;
    readonly amount: string;
    readonly referenceNo: string | null;
    readonly cardLast4: string | null;
  }[];
  readonly changeAmount: string;
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
    private readonly tenantContext: TenantContextService,
    private readonly limits: LimitsService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * Every check `createCashSale` runs before it ever inserts a row -- customer/category/period
   * validation, per-line pricing + FEFO allocation, total computation, payment resolution + the
   * change-absorbing-payment rule -- lives here, taking `DbOrTx` instead of `Tx` so `preview` can
   * call it against a plain `Db` with no transaction open at all (no doc number allocated,
   * nothing inserted, matching that method's own "WITHOUT opening a write transaction"
   * instruction). `createCashSale` calls this once, inside its own `db.transaction()`, then
   * continues on to the insert/movement/journal steps that only it performs; `preview` calls it
   * directly and returns straight from the result. This is the ONE extraction point the task
   * asked for -- neither caller re-implements any pricing/FEFO/payment math of its own.
   */
  private async computeSale(tx: DbOrTx, dto: CreateSaleInvoiceDto, tenantId: number, branchId: number): Promise<ComputedSale> {
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

    // -- validate: customer (default walk-in, 00b D5) -------------------------------------
    const customerWhere =
      dto.customerId !== undefined
        ? and(eq(customers.tenantId, tenantId), eq(customers.customerId, dto.customerId))
        : and(eq(customers.tenantId, tenantId), eq(customers.isWalkIn, true));
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
        ? and(eq(saleCategories.tenantId, tenantId), eq(saleCategories.saleCategoryId, dto.saleCategoryId))
        : and(eq(saleCategories.tenantId, tenantId), eq(saleCategories.isDefault, true), eq(saleCategories.isReturn, false));
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
    const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, dto.documentDate);

    // -- validate + price + FEFO-allocate each requested line -----------------------------
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
        .where(and(eq(items.tenantId, tenantId), eq(items.itemId, line.itemId)));
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
        tenantId: tenantId,
        branchId: branchId,
        itemId: item.itemId,
        qtyRequired: qty.toDb(),
        asOfDate: dto.documentDate,
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
          itemName: item.name,
          requestedLineIndex: index,
          packUnitsAtTxn: item.packUnits,
          packSalePrice: item.salePrice,
          unitSalePrice,
          unitCost: item.avgUnitCost,
          qty: allocation.qty,
          stockLotId: allocation.stockLotId,
          expiryAtSale: allocation.expiryDate,
          lineGrossAmount: costAmount(allocation.qty, unitSalePrice),
          lineCostAmount: costAmount(allocation.qty, item.avgUnitCost), // COGS at current avg (C-6)
          dispensingNote: line.dispensingNote ?? null,
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
        .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.paymentMethodId, payment.paymentMethodId)));
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
          .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.isDefaultForSales, true)))
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
        .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
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

    // Change can only be handed back from a cash drawer (a business rule, not a UX nicety) --
    // returning it against a card/bank-transfer leg would debit that settlement account for
    // less than what the rail actually recorded moving. So the absorbing payment must be a
    // counter (cash) method whose own amount covers the change; if none qualifies, this is a
    // 422, not a silent "somebody eats the rounding" fallback. Computed here (not just inside
    // createCashSale's own journal-building step) so `preview` reports the identical answer to
    // "can this even be tendered" without re-deriving the rule.
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

    return {
      customer,
      category,
      fiscalPeriodId,
      planned,
      allAllocations,
      grossAmount,
      cogsAmount,
      totalQty,
      netAmount,
      invoiceTotal,
      plannedPayments,
      paidTotal,
      changeAmount,
      changeAbsorbingIndex,
    };
  }

  /** The atomic cash-sale transaction (S-1). Calls `computeSale` for every validation/pricing/
   *  FEFO/payment check, then does the actual writing: allocate the doc number, insert header +
   *  lines + payment rows, apply stock movements, post the journal. */
  async createCashSale(dto: CreateSaleInvoiceDto, actor: Actor): Promise<CreateSaleInvoiceResult> {
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const actorId = Number(actor.userId);

    return db.transaction(async (tx: Tx) => {
      const computed = await this.computeSale(tx, dto, tenantId, branchId);
      const { customer, category, fiscalPeriodId, planned, allAllocations, grossAmount, cogsAmount, totalQty, netAmount, invoiceTotal } =
        computed;
      const { plannedPayments, changeAmount, changeAbsorbingIndex } = computed;

      // Wave 10e (R-007 CRITICAL): role_limit checks, evaluated INSIDE this transaction and
      // BEFORE the doc-number allocation below (a limit failure must not even burn a document
      // number -- 18-api-plan.md's own "no database side effect" requirement). A no-op for every
      // actor until an owner/sys_admin actually configures a role_limit row -- see
      // limits.service.ts's own header comment for the multi-role semantics.
      await this.limits.check(actor, "max_txn_value", invoiceTotal.toDb());
      await this.limits.check(actor, "max_qty", totalQty.toDb());

      // Wave 10f: cash_bank_account write-scope check -- doc's own "SLS ◐ own till" note
      // (18-api-plan.md §0.13.1) means a scoped sales_officer can only settle a cash sale into
      // their own till/account, never an arbitrary one resolved from the payment method's
      // default. Same "no side effect on denial" placement as the limit checks above.
      for (const [i, plannedPayment] of plannedPayments.entries()) {
        await this.scope.assertAllowed(actor, "cash_bank_account", plannedPayment.cashBankAccountId, `payments.${i}.cashBankAccountId`);
      }

      // -- allocate the invoice number (N-1: as late as possible, right before the header) ---
      const allocatedNumber = await this.docNumbers.allocate(tx, tenantId, "SV");

      // -- insert header ---------------------------------------------------------------------
      const now = new Date();
      const businessDate = new Date(`${dto.documentDate}T00:00:00`);
      await tx.insert(saleInvoices).values({
        tenantId: tenantId,
        branchId: branchId,
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
          tenantId: tenantId,
          saleInvoiceId: header.saleInvoiceId,
          lineNo: i + 1,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          branchId: branchId,
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
          dispensingNote: line.dispensingNote,
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
          tenantId: tenantId,
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
          tenantId: tenantId,
          branchId: branchId,
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
          .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, code)));
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
      // below exactly as before. `changeAbsorbingIndex` was already validated inside
      // `computeSale` (422 if no qualifying cash payment exists) -- nothing to re-check here.
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
        tenantId: tenantId,
        branchId: branchId,
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

  /**
   * POST /sale-invoices/preview -- a DRY RUN of `createCashSale`, reusing `computeSale` directly
   * against a plain `Db` (no `db.transaction()` -- per this method's own instruction, "WITHOUT
   * opening a write transaction"). No doc number is allocated and nothing is inserted; every
   * check `createCashSale` would run (customer/category/period/price/FEFO/payment) still runs,
   * and still throws the identical 422s on failure -- a preview that silently reported "ok" for a
   * request `createCashSale` would reject is worse than useless. On success, returns the computed
   * totals and per-line FEFO availability instead of a posted document.
   */
  async preview(dto: CreateSaleInvoiceDto, actor: Actor): Promise<SaleInvoicePreviewResult> {
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const computed = await this.computeSale(db, dto, tenantId, branchId);

    const lines: SaleInvoicePreviewLine[] = dto.lines.map((requested, requestedLineIndex) => {
      const slices = computed.planned.filter((p) => p.requestedLineIndex === requestedLineIndex);
      let lineGross = Money.zero();
      let lineCost = Money.zero();
      for (const slice of slices) {
        lineGross = lineGross.add(Money.fromDb(slice.lineGrossAmount));
        lineCost = lineCost.add(Money.fromDb(slice.lineCostAmount));
      }
      return {
        lineNo: requestedLineIndex + 1,
        itemId: requested.itemId,
        itemName: slices[0]?.itemName ?? "",
        qty: requested.qty,
        unitSalePrice: slices[0]?.unitSalePrice ?? "0.0000",
        lineGrossAmount: lineGross.toDb(),
        lineCostAmount: lineCost.toDb(),
        allocations: slices.map((s) => ({
          stockLotId: s.stockLotId,
          qty: s.qty,
          batchNo: computed.allAllocations.find((a) => a.stockLotId === s.stockLotId)?.batchNo ?? null,
          expiryDate: s.expiryAtSale,
        })),
      };
    });

    return {
      customerId: computed.customer.customerId,
      customerName: computed.customer.name,
      saleCategoryId: computed.category.saleCategoryId,
      lines,
      grossAmount: computed.grossAmount.toDb(),
      netAmount: computed.netAmount.toDb(),
      cogsAmount: computed.cogsAmount.toDb(),
      invoiceTotal: computed.invoiceTotal.toDb(),
      totalQty: computed.totalQty.toDb(),
      paidTotal: computed.paidTotal.toDb(),
      changeAmount: computed.changeAmount.toDb(),
    };
  }

  async list(
    query: ListSaleInvoicesQueryDto,
    actor: Actor,
  ): Promise<{ saleInvoices: SaleInvoiceRow[]; limit: number; offset: number }> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const conditions = [eq(saleInvoices.tenantId, tenantId)];
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

  async getById(
    saleInvoiceId: number,
    actor: Actor,
  ): Promise<{
    saleInvoice: SaleInvoiceRow;
    lines: SaleInvoiceLineRow[];
    payments: SaleInvoicePaymentRow[];
  }> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const [header] = await db
      .select()
      .from(saleInvoices)
      .where(and(eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.saleInvoiceId, saleInvoiceId)));
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

  /**
   * POST /sale-invoices/:id/cancel -- void an already-posted invoice. Structural mirror of
   * payments/application/payment.service.ts's `cancel()`: `FOR UPDATE` lock the header first,
   * guard on downstream dependents, then void. The guard here is a `sale_return` already
   * referencing this invoice (there IS a `saleInvoiceId` FK on `sale_return`, §T72) -- filtered
   * to non-cancelled/non-reversed rows, the same "zero ACTIVE dependents" shape
   * `cancelPayment`'s own "zero active allocations" guard uses (`isNull(reversedAt)` there;
   * `notInArray(status, [cancelled, reversed])` here). `422 SALES.HAS_ACTIVE_RETURNS` when the
   * guard trips -- see `assertNoActiveReturns`'s own comment for why `reverse` enforces the SAME
   * guard (this was originally cancel-only; tightened after a live bug was found, see below).
   */
  async cancel(saleInvoiceId: number, input: CancelSaleInvoiceInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(saleInvoices)
        .where(and(eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.saleInvoiceId, saleInvoiceId)))
        .for("update");
      if (!invoice) {
        throw new AppException({
          status: 404,
          code: "SALES.INVOICE_NOT_FOUND",
          title: "Sale invoice not found",
          detail: `No sale invoice with id ${saleInvoiceId} exists.`,
        });
      }
      this.assertVoidable(invoice);
      await this.assertNoActiveReturns(tx, tenantId, invoice);

      const { saleInvoice, lines } = await this.voidPostedInvoice(tx, {
        invoice,
        tenantId,
        branchId,
        actorId,
        outcome: "cancelled",
        reason: input.reason ?? "Sale invoice cancelled",
        cancelReasonId: input.cancelReasonId ?? null,
      });
      const payments = await tx
        .select()
        .from(saleInvoicePayments)
        .where(eq(saleInvoicePayments.saleInvoiceId, saleInvoiceId))
        .orderBy(asc(saleInvoicePayments.sequenceNo));
      return { saleInvoice, lines, payments };
    });
  }

  /**
   * POST /sale-invoices/:id/reverse -- a compensating entry for a posted invoice: same stock/GL
   * reversal mechanics as `cancel` (both funnel through `voidPostedInvoice`).
   *
   * BUG FOUND LIVE AND FIXED (not left as a documented limitation -- this is a stock/GL
   * correctness question with a safe, judgement-free answer, not a business-policy question):
   * `voidPostedInvoice` reverses the ORIGINAL invoice's own lines/journal in full. If a
   * `sale_return` already sent some of that quantity back, reversing the invoice on top of an
   * unreversed return double-credits stock for the returned units (once via the return's own
   * posting, once via this reversal undoing the full original sale) -- verified live: sell qty 4,
   * return qty 1 (stock +1), reverse the invoice (stock +4 more) left stock one unit higher than
   * correct. `reverse` now enforces the SAME `assertNoActiveReturns` guard `cancel` already had
   * (previously reverse was deliberately left unguarded as cancel's "escape valve" -- that
   * intent predates this bug being found). The correct sequencing this now requires: reverse (or
   * cancel) the sale_return(s) FIRST -- which undoes exactly the quantity/GL the return itself
   * added -- THEN reverse the original invoice once no active return remains; at that point the
   * full original quantity is once again exactly what's outstanding, so reversing it in full is
   * correct. No business-policy call needed (unlike the tax/FBR items this codebase genuinely
   * defers to accountant sign-off, docs/system-analysis/23-accountant-tax-adviser-handoff.md) --
   * this is a pure sequencing fix.
   */
  async reverse(saleInvoiceId: number, input: ReverseSaleInvoiceInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(saleInvoices)
        .where(and(eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.saleInvoiceId, saleInvoiceId)))
        .for("update");
      if (!invoice) {
        throw new AppException({
          status: 404,
          code: "SALES.INVOICE_NOT_FOUND",
          title: "Sale invoice not found",
          detail: `No sale invoice with id ${saleInvoiceId} exists.`,
        });
      }
      this.assertVoidable(invoice);
      await this.assertNoActiveReturns(tx, tenantId, invoice);

      const { saleInvoice, lines } = await this.voidPostedInvoice(tx, {
        invoice,
        tenantId,
        branchId,
        actorId,
        outcome: "reversed",
        reason: input.reason ?? "Sale invoice reversed",
        cancelReasonId: null,
      });
      const payments = await tx
        .select()
        .from(saleInvoicePayments)
        .where(eq(saleInvoicePayments.saleInvoiceId, saleInvoiceId))
        .orderBy(asc(saleInvoicePayments.sequenceNo));
      return { saleInvoice, lines, payments };
    });
  }

  /** Shared by `cancel`/`reverse`: both need the SAME status guard (only a `posted` invoice can
   *  be voided; neither can run twice) before their own extra guard (cancel's sale_return check)
   *  runs. `422 SALES.ALREADY_CANCELLED`/`SALES.ALREADY_REVERSED`/`SALES.NOT_POSTED`, mirroring
   *  `cancelPayment`'s own already-cancelled/not-posted 422 codes. */
  private assertVoidable(invoice: SaleInvoiceRow): void {
    if (invoice.status === "cancelled") {
      throw new BusinessRuleException("SALES.ALREADY_CANCELLED", "Already cancelled", `Sale invoice ${invoice.docNumber} was already cancelled.`);
    }
    if (invoice.status === "reversed") {
      throw new BusinessRuleException("SALES.ALREADY_REVERSED", "Already reversed", `Sale invoice ${invoice.docNumber} was already reversed.`);
    }
    if (invoice.status !== "posted") {
      throw new BusinessRuleException(
        "SALES.NOT_POSTED",
        "Invoice not posted",
        `Sale invoice ${invoice.docNumber} is "${invoice.status}"; only a posted invoice can be cancelled or reversed.`,
      );
    }
  }

  /**
   * Shared by `cancel` AND `reverse` (see `reverse`'s own doc comment for why this used to be
   * cancel-only and no longer is). "Active" mirrors `cancelPayment`'s own "zero active
   * allocations" shape (`isNull(reversedAt)` there; `notInArray(status, [cancelled, reversed])`
   * here, since `sale_return` has no separate "voided" flag of its own -- its own status enum IS
   * the signal). `422 SALES.HAS_ACTIVE_RETURNS` either way; the caller must reverse/cancel the
   * sale_return(s) first, then retry cancel/reverse on the invoice itself.
   */
  private async assertNoActiveReturns(tx: Tx, tenantId: number, invoice: SaleInvoiceRow): Promise<void> {
    const [activeReturns] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(saleReturns)
      .where(
        and(
          eq(saleReturns.tenantId, tenantId),
          eq(saleReturns.saleInvoiceId, invoice.saleInvoiceId),
          notInArray(saleReturns.status, ["cancelled", "reversed"]),
        ),
      );
    if (Number(activeReturns?.n ?? 0) > 0) {
      throw new BusinessRuleException(
        "SALES.HAS_ACTIVE_RETURNS",
        "Cannot cancel or reverse -- returns exist",
        `Sale invoice ${invoice.docNumber} has ${Number(activeReturns?.n ?? 0)} active sale return(s) referencing it; reverse or cancel the sale return(s) first, then retry.`,
      );
    }
  }

  /**
   * Shared voiding mechanics for `cancel` and `reverse` -- once `assertVoidable` (and the shared
   * `assertNoActiveReturns` guard) has passed, the two verbs do EXACTLY the same thing: reverse
   * every stock movement the sale posted, reverse its GL journal entry, and flip status. They
   * differ only in the resulting status (`cancelled` vs `reversed`), whether `cancelledAt`/
   * `cancelledBy`/`cancelReasonId` get stamped (semantically these name a cancellation, not a
   * reversal -- a reversed invoice was never "cancelled"), and the journal entry-number suffix/
   * description/default reason text. Per the task's own instruction ("if cancel and reverse end
   * up sharing almost all their logic ... factor the shared part into one private method and have
   * the two public methods differ only in the guard + resulting status") -- that is exactly what
   * happened once the schema was read closely: `sale_invoice` has no separate `reversedAt`/
   * `reversedBy` pair (only pack DOC's cancel-shaped columns), so there was nothing left for the
   * two to differ on beyond the guard and the enum value itself.
   *
   * Stock: for every `sale_invoice_line`, post a movement with the SAME lot/unit-cost the
   * original sale used, `+qtyBase` instead of the original `-qtyBase` -- putting the exact goods
   * back, mirroring sale-returns.service.ts's own "goods coming back in" movement shape (no
   * `reversalOfId` threaded through -- that column is unused by every other write path in this
   * codebase today, sale_return's inbound movement included; see stock.service.ts's
   * `MovementInput` -- so leaving it null here matches, rather than invents, the established
   * convention).
   *
   * GL: rather than re-deriving the original posting's leg formula (this sale posts N payment
   * legs plus a primary_credit and up to two cogs legs, with one payment leg carrying a
   * change-adjustment that is not reconstructible from `sale_invoice_payment` alone), this reads
   * back the ORIGINAL journal_line rows for `invoice.journalEntryId` and swaps debit<->credit on
   * each verbatim. That trivially balances (Σ new debits = Σ old credits = Σ old debits = Σ new
   * credits) and is provably faithful to whatever `createCashSale` actually posted, including the
   * change adjustment, with no separate formula to keep in sync. `JournalService.post()` already
   * accepts `reversalSeq`/`reversalOfJournalId`/`reversalReason` directly (added after
   * payment.service.ts's own `cancel()` was written, per that file's header comment on why IT
   * had to hand-roll `postReversingJournal` -- the gap it documented has since closed), so this
   * calls the shared poster directly instead of a private mirror.
   */
  private async voidPostedInvoice(
    tx: Tx,
    params: {
      invoice: SaleInvoiceRow;
      tenantId: number;
      branchId: number;
      actorId: number;
      outcome: "cancelled" | "reversed";
      reason: string;
      cancelReasonId: number | null;
    },
  ): Promise<{ saleInvoice: SaleInvoiceRow; lines: SaleInvoiceLineRow[] }> {
    const { invoice, tenantId, branchId, actorId, outcome, reason, cancelReasonId } = params;

    const lines = await tx
      .select()
      .from(saleInvoiceLines)
      .where(eq(saleInvoiceLines.saleInvoiceId, invoice.saleInvoiceId))
      .orderBy(asc(saleInvoiceLines.lineNo));

    // "Today", not the original invoice's own postingDate -- this is when the void actually
    // happens, and it needs its own OPEN fiscal period (the original period may have since
    // closed; resolving fresh here is what every other posting flow in this codebase does at
    // write time, not a re-use of a possibly-stale value).
    const voidDate = localToday();
    const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, voidDate);

    // -- reverse stock: put every dispensed line's quantity back into its own original lot -----
    for (const line of lines) {
      await this.stock.applyMovement(tx, {
        tenantId,
        branchId: line.branchId,
        itemId: line.itemId,
        stockLotId: line.stockLotId,
        qtyDelta: line.qtyBase, // positive -- the mirror image of the original outbound movement
        unitCost: line.unitCost, // the line's own frozen cost, never the item's current avg
        documentTypeId: invoice.documentTypeId,
        sourceDocumentId: invoice.saleInvoiceId,
        sourceLineId: line.saleInvoiceLineId,
        fiscalPeriodId,
        postingDate: voidDate,
        actorId,
      });
    }

    // -- reverse the GL: swap every original leg's debit/credit side, post as a new entry -------
    if (invoice.journalEntryId === null) {
      // Unreachable -- createCashSale always posts a journal entry and binds journalEntryId
      // before the header's status can ever become "posted" (assertVoidable already required
      // status === "posted" to get here).
      throw new Error(`posted sale invoice ${invoice.saleInvoiceId} has no journal entry`);
    }
    const originalLines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, invoice.journalEntryId))
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
      .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.documentTypeCode, "SV"), eq(journalEntries.sourceDocumentId, invoice.saleInvoiceId)));
    const reversalSeq = (priorSeq?.maxSeq ?? 0) + 1;

    const suffix = outcome === "cancelled" ? "CANCEL" : "REVERSE";
    await this.journal.post(tx, {
      tenantId,
      branchId,
      entryNo: `${invoice.docNumber}-${suffix}`,
      entryDate: voidDate,
      documentTypeCode: "SV",
      sourceDocumentId: invoice.saleInvoiceId,
      description: `${outcome === "cancelled" ? "Cancellation" : "Reversal"} of sale invoice ${invoice.docNumber}`,
      legs,
      postedBy: actorId,
      reversalSeq,
      reversalOfJournalId: invoice.journalEntryId,
      reversalReason: reason,
    });
    await tx.update(journalEntries).set({ status: "reversed", updatedBy: actorId }).where(eq(journalEntries.journalEntryId, invoice.journalEntryId));

    // -- flip the header's own status -----------------------------------------------------------
    await tx
      .update(saleInvoices)
      .set(
        outcome === "cancelled"
          ? { status: "cancelled", cancelledAt: new Date(), cancelledBy: actorId, cancelReasonId, updatedBy: actorId }
          : { status: "reversed", updatedBy: actorId },
      )
      .where(eq(saleInvoices.saleInvoiceId, invoice.saleInvoiceId));

    const [updated] = await tx.select().from(saleInvoices).where(eq(saleInvoices.saleInvoiceId, invoice.saleInvoiceId));
    if (!updated) throw new Error("sale invoice vanished mid-transaction"); // unreachable; defensive
    return { saleInvoice: updated, lines };
  }

  /**
   * GET /sale-invoices/:id/print (and its POST /sale-invoices/:id/reprint alias, same rendering,
   * see the controller) -- a structured JSON receipt payload, `printFormat: "standard_receipt"`
   * (the one format `packages/db/scripts/seed.ts`'s `sales.doc_print_format` option list seeds
   * this wave; hardcoded rather than read back through OptionsRepository -- this module has no
   * existing dependency on the settings module, and the task's own instruction explicitly allowed
   * either choice for "the one format this wave ships"). NOT a PDF/ESC-POS render -- deliberately
   * out of scope this wave (see this file's header comment).
   */
  async print(saleInvoiceId: number, actor: Actor): Promise<SaleInvoicePrintResult> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();

    const [header] = await db
      .select()
      .from(saleInvoices)
      .where(and(eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.saleInvoiceId, saleInvoiceId)));
    if (!header) {
      throw new AppException({
        status: 404,
        code: "SALES.INVOICE_NOT_FOUND",
        title: "Sale invoice not found",
        detail: `No sale invoice with id ${saleInvoiceId} exists.`,
      });
    }

    const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.tenantId, tenantId));
    const [branch] = await db.select({ name: branches.name }).from(branches).where(eq(branches.branchId, header.branchId));
    const [customer] = await db
      .select({ customerId: customers.customerId, name: customers.name })
      .from(customers)
      .where(eq(customers.customerId, header.customerId));

    const lineRows = await db
      .select({
        lineNo: saleInvoiceLines.lineNo,
        itemId: saleInvoiceLines.itemId,
        itemName: items.name,
        itemCode: items.customCode,
        qty: saleInvoiceLines.qtyBase,
        unitSalePrice: saleInvoiceLines.unitSalePrice,
        itemFlatDiscount: saleInvoiceLines.itemFlatDiscount,
        discountPercent: saleInvoiceLines.discountPercent,
        lineDiscountAmount: saleInvoiceLines.lineDiscountAmount,
        lineGrossAmount: saleInvoiceLines.lineGrossAmount,
        lineNetAmount: saleInvoiceLines.lineNetAmount,
        lineTaxAmount: saleInvoiceLines.lineTaxAmount,
      })
      .from(saleInvoiceLines)
      .innerJoin(items, eq(items.itemId, saleInvoiceLines.itemId))
      .where(eq(saleInvoiceLines.saleInvoiceId, saleInvoiceId))
      .orderBy(asc(saleInvoiceLines.lineNo));

    const paymentRows = await db
      .select({
        sequenceNo: saleInvoicePayments.sequenceNo,
        paymentMethodId: saleInvoicePayments.paymentMethodId,
        methodName: paymentMethods.name,
        amount: saleInvoicePayments.amount,
        referenceNo: saleInvoicePayments.referenceNo,
        cardLast4: saleInvoicePayments.cardLast4,
      })
      .from(saleInvoicePayments)
      .innerJoin(paymentMethods, eq(paymentMethods.paymentMethodId, saleInvoicePayments.paymentMethodId))
      .where(eq(saleInvoicePayments.saleInvoiceId, saleInvoiceId))
      .orderBy(asc(saleInvoicePayments.sequenceNo));

    return {
      printFormat: "standard_receipt",
      header: {
        saleInvoiceId: header.saleInvoiceId,
        docNumber: header.docNumber,
        documentDate: header.documentDate,
        postingDate: header.postingDate,
        status: header.status,
        tenantName: tenant?.name ?? null,
        branchName: branch?.name ?? null,
        customer: { customerId: header.customerId, name: customer?.name ?? null },
      },
      lines: lineRows,
      taxBreakdown: {
        salesTaxAmount: header.salesTaxAmount,
        advanceIncomeTaxAmount: header.advanceIncomeTaxAmount,
        fbrPosFeeAmount: header.fbrPosFeeAmount,
      },
      grossAmount: header.grossAmount,
      lineDiscountAmount: header.lineDiscountAmount,
      invoiceDiscountAmount: header.invoiceDiscountAmount,
      netAmount: header.netAmount,
      roundingAmount: header.roundingAmount,
      invoiceTotal: header.invoiceTotal,
      payments: paymentRows,
      changeAmount: header.changeAmount,
    };
  }
}
