// Blueprint: docs/system-analysis/05b-workflows-purchase.md (purchase entry = goods receipt),
// 08-inventory-logic.md §4/§8, 17-technical-blueprint.md §7 (TX rules).
//
// P-1: the purchase invoice IS the goods receipt -- ONE document receives stock, recomputes the
// moving-average cost, and writes the GL, all inside one db.transaction (create-and-post
// immediately; drafts are deferred).
//
// Costing (C-2..C-5):
//   qtyBase   = qtyPack x packUnitsAtTxn + qtyLoose + qtyBonus x packUnitsAtTxn  (C-3: bonus
//               units enter the quantity but not the line value, which is what dilutes cost)
//   unitCostIn = unitCostIn(costBasisPrice net-of-discountPercent, packUnits) where
//               costBasisPrice = netRate when the header's cost_basis = 'net_rate', else
//               unitPurchasePrice (per-document switch, C-4 -- the replacement for legacy
//               UpdateAvgPriceWithNetRate). discountPercent is applied to costBasisPrice via
//               Money BEFORE the divide, for both cost_basis modes -- otherwise unit_cost_in
//               stays gross while the GL Dr-Inventory leg (lineNet, below) is net, permanently
//               inflating the moving average whenever a line carries a discount.
//   C-5: purchase ALWAYS moves the average -- CostingService.applyInbound per line BEFORE that
//               line's stock movement (costing reads pre-receipt balances, see its comment);
//               avg_cost_before/after are stamped on the line (§T78).
//
// GL (S-5, perpetual inventory -- a BINDING change from the legacy periodic scheme):
//   Dr 1200 Inventory            net goods amount
//   Dr 1300 Sales Tax Receivable sales tax (skipped this increment -- always 0, see TODO)
//   Cr supplier.glAccountId      invoice total, supplierId stamped on the leg
//
// TX-6 lock order: doc number counter FIRST, then item (costing's FOR UPDATE), then stock
// balances, then GL inserts.
//
// Amount arithmetic (Rule M): documented simplification for this increment -- unit prices are
// per PACK (§T78/§T31, 08 §5.2); everything is converted to loose units and a per-loose-unit
// price (unitCostIn(price, packUnits), 5dp), then extended with costAmount(qtyLoose, perLoose)
// at 2dp. All arithmetic goes through @pharmacy/money -- never JS number math on money.
import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import {
  getDb,
  glAccounts,
  items,
  purchaseCategories,
  purchaseInvoiceLines,
  purchaseInvoices,
  stockLots,
  suppliers,
} from "@pharmacy/db";
import { costAmount, Money, Percent, Quantity, unitCostIn } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { CostingService } from "../../inventory/infrastructure/costing.service.js";
import { StockService } from "../../inventory/infrastructure/stock.service.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreatePurchaseInvoiceInput, PurchaseInvoiceLineInput } from "../api/dto/purchase-invoice.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Sentinels the stock_lot identity's generated columns coalesce NULLs to (§T56, catalog.ts). */
const BATCH_KEY_NONE = "~none~";
const EXPIRY_KEY_NONE = "9999-12-31";

export interface NewAvgCost {
  readonly itemId: number;
  readonly avgCostBefore: string;
  readonly avgCostAfter: string;
}

@Injectable()
export class PurchaseInvoiceService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
    private readonly costing: CostingService,
    private readonly stock: StockService,
    // TODO(real tenancy): shared dev-mode tenant/branch resolution (see its header comment).
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(params: {
    supplierId?: number | undefined;
    status?: "draft" | "confirmed" | "posted" | "cancelled" | "reversed" | undefined;
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    offset?: number | undefined;
    limit?: number | undefined;
  }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(purchaseInvoices.tenantId, tenantId)];
    if (params.supplierId !== undefined) conditions.push(eq(purchaseInvoices.supplierId, params.supplierId));
    if (params.status !== undefined) conditions.push(eq(purchaseInvoices.status, params.status));
    if (params.dateFrom !== undefined) conditions.push(gte(purchaseInvoices.postingDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(purchaseInvoices.postingDate, new Date(`${params.dateTo}T00:00:00`)));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(purchaseInvoices)
      .where(and(...conditions))
      .orderBy(desc(purchaseInvoices.postingDate), desc(purchaseInvoices.purchaseInvoiceId))
      .limit(limit)
      .offset(offset);
    return { purchaseInvoices: rows, offset, limit };
  }

  async getById(purchaseInvoiceId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [header] = await db
      .select()
      .from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.purchaseInvoiceId, purchaseInvoiceId)));
    if (!header) {
      throw new AppException({
        status: 404,
        code: "PURCHASE.INVOICE_NOT_FOUND",
        title: "Purchase invoice not found",
        detail: `No purchase invoice with id ${purchaseInvoiceId} exists.`,
      });
    }
    const lines = await db
      .select()
      .from(purchaseInvoiceLines)
      .where(eq(purchaseInvoiceLines.purchaseInvoiceId, purchaseInvoiceId))
      .orderBy(purchaseInvoiceLines.lineNo);
    return { purchaseInvoice: header, lines };
  }

  /** Create AND post a purchase invoice in one transaction (P-1). */
  async createAndPost(input: CreatePurchaseInvoiceInput, actor: Actor) {
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
          code: "PURCHASE.SUPPLIER_NOT_FOUND",
          title: "Supplier not found",
          detail: `No supplier with id ${input.supplierId} exists.`,
        });
      }
      if (!supplier.isActive) {
        throw new BusinessRuleException(
          "PURCHASE.SUPPLIER_INACTIVE",
          "Supplier is inactive",
          `Supplier "${supplier.name}" is inactive; reactivate it before receiving stock against it.`,
        );
      }

      if (input.supplierInvoiceNo !== undefined) {
        const [dupe] = await tx
          .select({ purchaseInvoiceId: purchaseInvoices.purchaseInvoiceId, docNumber: purchaseInvoices.docNumber })
          .from(purchaseInvoices)
          .where(
            and(
              eq(purchaseInvoices.supplierId, input.supplierId),
              eq(purchaseInvoices.supplierInvoiceNo, input.supplierInvoiceNo),
            ),
          );
        if (dupe) {
          throw new AppException({
            status: 409,
            code: "PURCHASE.DUPLICATE_SUPPLIER_INVOICE",
            title: "Supplier invoice already entered",
            detail: `Supplier invoice "${input.supplierInvoiceNo}" was already entered as ${dupe.docNumber}.`,
          });
        }
      }

      const purchaseCategoryId = await this.resolveCategory(tx, tenantId, input.purchaseCategoryId);
      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, postingDate);

      // Parse + pre-compute every line BEFORE the doc-counter lock (N-1: allocate as late as
      // possible; nothing below the allocate should be able to fail on bad input).
      const computed: ComputedLine[] = [];
      for (const [index, line] of input.lines.entries()) {
        computed.push(await this.computeLine(tx, tenantId, index, line, input.costBasis));
      }

      // ---- TX-6 lock 1: the document counter ------------------------------------------------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "PV");

      // Header first (zero totals) so lines/lots/movements can reference its id; totals and the
      // journal link are stamped in the closing update below.
      //
      // Bug fix (race safety): the pre-check above is TOCTOU -- SELECT-then-INSERT with nothing
      // backing it at the DB layer, so two concurrent requests for the same supplier +
      // supplierInvoiceNo could both pass the pre-check and both reach this insert. The pre-check
      // stays (fast path / clear error message in the common, non-racing case); the real
      // guarantee is uk_purchase_supp_inv (purchasing.ts), and this catch is what makes that
      // guarantee race-safe instead of a raw SQL error escaping the transaction.
      try {
        await tx.insert(purchaseInvoices).values({
          tenantId,
          branchId,
          docNumber: allocated.docNumber,
          docSeriesId: allocated.docSeriesId,
          documentTypeId: allocated.documentTypeId,
          documentDate: new Date(`${input.documentDate}T00:00:00`),
          postingDate: new Date(`${postingDate}T00:00:00`),
          fiscalPeriodId,
          status: "draft",
          supplierId: input.supplierId,
          purchaseCategoryId,
          supplierInvoiceNo: input.supplierInvoiceNo ?? null,
          costBasis: input.costBasis,
          notes: input.notes ?? null,
          createdBy: actorId,
          createdSource: "api",
        });
      } catch (error) {
        if (!isDuplicateKeyError(error, "uk_purchase_supp_inv")) throw error;
        throw new AppException({
          status: 409,
          code: "PURCHASE.DUPLICATE_SUPPLIER_INVOICE",
          title: "Supplier invoice already entered",
          detail: `Supplier invoice "${input.supplierInvoiceNo}" was already entered for this supplier.`,
        });
      }
      const [headerRow] = await tx
        .select({ purchaseInvoiceId: purchaseInvoices.purchaseInvoiceId })
        .from(purchaseInvoices)
        .where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.docNumber, allocated.docNumber)));
      if (!headerRow) throw new Error("purchase_invoice insert did not land"); // unreachable; defensive
      const purchaseInvoiceId = headerRow.purchaseInvoiceId;

      // ---- Per line: lot create/find -> costing (TX-6 lock 2: item) -> stock movement -------
      const newAvgCosts: NewAvgCost[] = [];
      let grossTotal = Money.zero();
      let discountTotal = Money.zero();
      let netTotal = Money.zero();
      let totalQty = Quantity.zero();

      for (const line of computed) {
        const stockLotId = await this.findOrCreateLot(tx, {
          tenantId,
          branchId,
          line,
          supplierId: input.supplierId,
          documentTypeId: allocated.documentTypeId,
          purchaseInvoiceId,
          receivedOn: postingDate,
        });

        // C-5: costing BEFORE the movement -- applyInbound reads the item's pre-receipt total
        // on-hand as StockBefore (see CostingService's C-2 comment).
        const { avgBefore, avgAfter } = await this.costing.applyInbound(tx, {
          tenantId,
          itemId: line.itemId,
          qtyIn: line.qtyBase.toDb(),
          unitCostIn: line.unitCostIn,
          costBasis: input.costBasis,
          documentTypeId: allocated.documentTypeId,
          sourceDocumentId: purchaseInvoiceId,
          postingDate,
          actorId,
        });

        // TX-6 lock 3: stock balance (+qtyBase at the frozen inbound unit cost).
        await this.stock.applyMovement(tx, {
          tenantId,
          branchId,
          itemId: line.itemId,
          stockLotId,
          qtyDelta: line.qtyBase.toDb(),
          unitCost: line.unitCostIn,
          documentTypeId: allocated.documentTypeId,
          sourceDocumentId: purchaseInvoiceId,
          fiscalPeriodId,
          postingDate,
          actorId,
        });

        await tx.insert(purchaseInvoiceLines).values({
          tenantId,
          purchaseInvoiceId,
          lineNo: line.lineNo,
          itemId: line.itemId,
          stockLotId,
          qtyPack: line.qtyPack.toDb(),
          qtyLoose: line.qtyLoose.toDb(),
          qtyBonus: line.qtyBonus.toDb(),
          packUnitsAtTxn: line.packUnits,
          qtyBase: line.qtyBase.toDb(),
          unitPurchasePrice: line.unitPurchasePrice,
          netRate: line.netRate,
          unitCostIn: line.unitCostIn,
          unitSalePrice: line.unitSalePrice,
          discountPercent: line.discountPercent.toDb(),
          lineGrossAmount: line.lineGross.toDb(),
          lineDiscountAmount: line.lineDiscount.toDb(),
          lineNetAmount: line.lineNet.toDb(),
          avgCostBefore: avgBefore, // §T78 costing-chain snapshot
          avgCostAfter: avgAfter,
          expiryDateCaptured: line.expiryDate,
          batchNoCaptured: line.batchNo,
          captureMethod: "manual",
          createdBy: actorId,
          createdSource: "api",
        });

        newAvgCosts.push({ itemId: line.itemId, avgCostBefore: avgBefore, avgCostAfter: avgAfter });
        grossTotal = grossTotal.add(line.lineGross);
        discountTotal = discountTotal.add(line.lineDiscount);
        netTotal = netTotal.add(line.lineNet);
        totalQty = totalQty.add(line.qtyBase);
      }

      // ---- TX-6 lock 4: GL --------------------------------------------------------------------
      // TODO(tax schedules): no tax schedules exist yet, so salesTaxAmount is always "0.00"
      // this increment and the Dr 1300 leg is skipped (JournalService requires one-sided,
      // non-degenerate legs). When tax lands: Dr 1300 Sales Tax Receivable for salesTaxAmount.
      const salesTax = Money.zero();
      const invoiceTotal = netTotal.add(salesTax);

      const inventoryAccountId = await this.resolveGlAccount(tx, tenantId, "1200");
      const legs: JournalLegInput[] = [
        // S-5 perpetual: goods go straight to the Inventory asset, not a Purchases expense.
        { glAccountId: inventoryAccountId, debit: netTotal.toDb(), legRole: "primary_debit" },
        {
          glAccountId: supplier.glAccountId,
          credit: invoiceTotal.toDb(),
          legRole: "primary_credit",
          supplierId: input.supplierId,
        },
      ];
      if (!salesTax.isZero()) {
        const taxAccountId = await this.resolveGlAccount(tx, tenantId, "1300");
        legs.splice(1, 0, { glAccountId: taxAccountId, debit: salesTax.toDb(), legRole: "sales_tax" });
      }

      const journalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: allocated.docNumber,
        entryDate: postingDate,
        documentTypeCode: "PV",
        sourceDocumentId: purchaseInvoiceId,
        description: `Purchase ${allocated.docNumber} -- ${supplier.name}${input.supplierInvoiceNo ? ` (inv ${input.supplierInvoiceNo})` : ""}`,
        legs,
        postedBy: actorId,
      });

      // ---- Close out the header ---------------------------------------------------------------
      const now = new Date();
      await tx
        .update(purchaseInvoices)
        .set({
          grossAmount: grossTotal.toDb(),
          lineDiscountAmount: discountTotal.toDb(),
          netAmount: netTotal.toDb(),
          salesTaxAmount: salesTax.toDb(),
          invoiceTotal: invoiceTotal.toDb(),
          totalQty: totalQty.toDb(),
          paidAmount: "0.00",
          journalEntryId,
          status: "posted",
          postedAt: now,
          postedBy: actorId,
          updatedBy: actorId,
        })
        .where(eq(purchaseInvoices.purchaseInvoiceId, purchaseInvoiceId));

      const [finalHeader] = await tx
        .select()
        .from(purchaseInvoices)
        .where(eq(purchaseInvoices.purchaseInvoiceId, purchaseInvoiceId));
      const finalLines = await tx
        .select()
        .from(purchaseInvoiceLines)
        .where(eq(purchaseInvoiceLines.purchaseInvoiceId, purchaseInvoiceId))
        .orderBy(purchaseInvoiceLines.lineNo);

      return { purchaseInvoice: finalHeader, lines: finalLines, journalEntryId, newAvgCosts };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async resolveCategory(tx: Tx, tenantId: number, purchaseCategoryId: number | undefined): Promise<number> {
    if (purchaseCategoryId !== undefined) {
      const [row] = await tx
        .select({ purchaseCategoryId: purchaseCategories.purchaseCategoryId, isEnabled: purchaseCategories.isEnabled })
        .from(purchaseCategories)
        .where(and(eq(purchaseCategories.tenantId, tenantId), eq(purchaseCategories.purchaseCategoryId, purchaseCategoryId)));
      if (!row || !row.isEnabled) {
        throw new BusinessRuleException(
          "PURCHASE.CATEGORY_INVALID",
          "Unknown purchase category",
          `Purchase category ${purchaseCategoryId} does not exist or is disabled.`,
        );
      }
      return row.purchaseCategoryId;
    }
    // Default category (seed: NORMAL_CASH isDefault=true).
    const [dflt] = await tx
      .select({ purchaseCategoryId: purchaseCategories.purchaseCategoryId })
      .from(purchaseCategories)
      .where(and(eq(purchaseCategories.tenantId, tenantId), eq(purchaseCategories.isDefault, true)));
    if (!dflt) {
      throw new BusinessRuleException(
        "PURCHASE.NO_DEFAULT_CATEGORY",
        "No default purchase category",
        "No purchase category is marked as default; pass purchaseCategoryId explicitly or configure a default.",
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

  /** Parse one input line and compute quantities/amounts -- pure computation, no locks. */
  private async computeLine(
    tx: Tx,
    tenantId: number,
    index: number,
    line: PurchaseInvoiceLineInput,
    costBasis: "net_rate" | "gross_price",
  ): Promise<ComputedLine> {
    const lineNo = index + 1;
    const [item] = await tx
      .select({ itemId: items.itemId, packUnits: items.packUnits, salePrice: items.salePrice })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, line.itemId)));
    if (!item) {
      throw new BusinessRuleException(
        "CATALOG.ITEM_MISSING",
        "Unknown item",
        `Line ${lineNo}: item ${line.itemId} does not exist.`,
        [{ path: `lines.${index}.itemId`, code: "PURCHASE.UNKNOWN_ITEM", message: "Unknown item" }],
      );
    }
    const packUnits = item.packUnits;

    const qtyPack = parseQty(line.qtyPack, `lines.${index}.qtyPack`);
    const qtyLoose = parseQty(line.qtyLoose ?? "0", `lines.${index}.qtyLoose`);
    const qtyBonus = parseQty(line.qtyBonus ?? "0", `lines.${index}.qtyBonus`);

    // qtyBase = qtyPack x packUnits + qtyLoose + qtyBonus x packUnits (C-2/C-3, §T78) --
    // multiplication by the integer packUnits via exact repeated doubling (Rule M: quantity
    // arithmetic only through @pharmacy/money value objects).
    const qtyBase = mulQtyByInt(qtyPack, packUnits).add(qtyLoose).add(mulQtyByInt(qtyBonus, packUnits));
    if (qtyBase.isZero()) {
      throw new BusinessRuleException(
        "PURCHASE.EMPTY_LINE",
        "Empty line",
        `Line ${lineNo}: the received quantity must be greater than zero.`,
        [{ path: `lines.${index}.qtyPack`, code: "PURCHASE.EMPTY_LINE", message: "Quantity must be > 0" }],
      );
    }

    const netRate = line.netRate ?? line.unitPurchasePrice; // per pack; defaults to gross price
    const costBasisPrice = costBasis === "net_rate" ? netRate : line.unitPurchasePrice; // C-4
    const discountPercent = parsePercent(line.discountPercent ?? "0", `lines.${index}.discountPercent`);

    // Bug fix (perpetual-inventory invariant, 08 §8.2/§8.3): costBasisPrice must be net of the
    // line discount BEFORE it's divided down to a per-loose-unit cost, or unit_cost_in (which
    // feeds CostingService.applyInbound / StockService.applyMovement / the moving average)
    // stays permanently inflated relative to what the GL actually debits to Inventory (lineNet,
    // below) whenever a line carries a discount. Applies identically for both cost_basis modes
    // -- costBasisPrice already picked netRate vs unitPurchasePrice above; the discount then
    // reduces whichever one was chosen.
    const costBasisMoney = Money.fromDb(costBasisPrice);
    const costBasisDiscount = costBasisMoney.applyPercent(discountPercent, { scale: 2 });
    const costBasisNet = costBasisMoney.sub(costBasisDiscount);
    const lineUnitCostIn = unitCostIn(costBasisNet.toDb(), packUnits); // per loose unit, 5dp, net-of-discount (08 §8.2)

    // PAID loose units (bonus excluded from value -- C-3: free goods carry qty, not amount).
    const qtyPaid = mulQtyByInt(qtyPack, packUnits).add(qtyLoose);
    // Per-loose-unit GROSS price (5dp) -- documented simplification: lineGross =
    // qtyPaid x (unitPurchasePrice / packUnits), all through @pharmacy/money.
    const perLooseGross = unitCostIn(line.unitPurchasePrice, packUnits);
    const lineGross = Money.fromDb(costAmount(qtyPaid.toDb(), perLooseGross));

    const lineDiscount = lineGross.applyPercent(discountPercent, { scale: 2 });
    const lineNet = lineGross.sub(lineDiscount);

    return {
      lineNo,
      itemId: item.itemId,
      packUnits,
      qtyPack,
      qtyLoose,
      qtyBonus,
      qtyBase,
      unitPurchasePrice: line.unitPurchasePrice,
      netRate,
      unitCostIn: lineUnitCostIn,
      unitSalePrice: line.unitSalePrice ?? item.salePrice,
      discountPercent,
      lineGross,
      lineDiscount,
      lineNet,
      batchNo: line.batchNo ?? null,
      expiryDate: line.expiryDate ? new Date(`${line.expiryDate}T00:00:00`) : null,
      expiryStatus: line.expiryStatus ?? (line.expiryDate ? "known" : "unknown"),
    };
  }

  /**
   * Create-or-find the receiving stock_lot. Lot identity is (item, batchKey, expiryKey) --
   * the §T56 generated-column sentinels make "unknown batch/expiry" a single reusable lot
   * instead of unlimited NULL-duplicates.
   */
  private async findOrCreateLot(
    tx: Tx,
    params: {
      tenantId: number;
      branchId: number;
      line: ComputedLine;
      supplierId: number;
      documentTypeId: number;
      purchaseInvoiceId: number;
      receivedOn: string;
    },
  ): Promise<number> {
    const { line } = params;
    const batchKey = line.batchNo ?? BATCH_KEY_NONE;
    const expiryKey = line.expiryDate ?? new Date(`${EXPIRY_KEY_NONE}T00:00:00`);

    const [existing] = await tx
      .select({ stockLotId: stockLots.stockLotId })
      .from(stockLots)
      .where(and(eq(stockLots.itemId, line.itemId), eq(stockLots.batchKey, batchKey), eq(stockLots.expiryKey, expiryKey)));
    if (existing) return existing.stockLotId;

    // Bug fix (race safety): this SELECT-then-INSERT is unlocked, so two concurrent purchases of
    // the same new item+batch+expiry can both miss the `existing` check above and both attempt
    // this insert -- uk_stock_lot_identity (catalog.ts) then throws a raw ER_DUP_ENTRY. Treat
    // that as "the other transaction won the race" rather than an unhandled error: re-select
    // (locked, since the other side's insert may have only just committed) and return its row.
    //
    // Bug fix (found live in CI only, unreproducible locally against MANY variants -- a
    // long-lived local dev DB, a freshly migrated+seeded DB, direct `vitest run`, and CI's own
    // `pnpm turbo run test` invocation, all on Windows): the ORIGINAL version of this method
    // inserted, then re-SELECTed the new row by its business key (itemId/batchKey/expiryKey,
    // the latter two being generated columns) to learn the new stockLotId, on the assumption a
    // same-transaction SELECT always sees its own just-inserted row. On GitHub Actions'
    // ubuntu-latest runner against the ephemeral MySQL 8.4 service container specifically, that
    // re-select came back empty on every single purchase-invoice creation (a "should be
    // unreachable" defensive throw was reached every time) -- environment-specific enough
    // (Docker service container network path, connection pool timing under that setup, or some
    // other CI-only factor) that root-causing the exact trigger further wasn't worth chasing
    // when there's a strictly more robust fix available regardless of the cause: mysql2's own
    // INSERT result already returns the new row's real auto-increment id directly (`result.
    // insertId`, the exact same
    // pattern accounting/application/journal-entry.service.ts's own manual-voucher insert already
    // relies on), reading that instead of re-querying eliminates the entire class of "does a
    // same-transaction read see this transaction's own write" risk -- there is no query to
    // mis-match, no generated-column timing to depend on, no connection-routing assumption at
    // all: the id comes back as part of the INSERT statement's own atomic response.
    try {
      const [result] = await tx.insert(stockLots).values({
        tenantId: params.tenantId,
        branchId: params.branchId,
        itemId: line.itemId,
        batchNo: line.batchNo,
        expiryDate: line.expiryDate,
        expiryStatus: line.expiryStatus,
        supplierId: params.supplierId, // §T56 recall traceability (R4.5)
        sourceDocumentTypeId: params.documentTypeId,
        sourceDocumentId: params.purchaseInvoiceId,
        receivedOn: new Date(`${params.receivedOn}T00:00:00`),
        // Informational (costing stays at item level, R4.5). NOTE: column is UNIT_PRICE (15,4);
        // the 5dp unitCostIn is rounded to 4dp by the DDL on insert -- acceptable for an
        // informational snapshot (the authoritative 5dp value is on the invoice line).
        receiptUnitCost: line.unitCostIn,
        createdSource: "api",
      });
      return Number(result.insertId);
    } catch (error) {
      if (!isDuplicateKeyError(error, "uk_stock_lot_identity")) throw error;
      const [raced] = await tx
        .select({ stockLotId: stockLots.stockLotId })
        .from(stockLots)
        .where(and(eq(stockLots.itemId, line.itemId), eq(stockLots.batchKey, batchKey), eq(stockLots.expiryKey, expiryKey)))
        .for("update");
      if (!raced) throw error; // unreachable -- the duplicate-key error proves a row exists
      return raced.stockLotId;
    }
  }
}

interface ComputedLine {
  readonly lineNo: number;
  readonly itemId: number;
  readonly packUnits: number;
  readonly qtyPack: Quantity;
  readonly qtyLoose: Quantity;
  readonly qtyBonus: Quantity;
  readonly qtyBase: Quantity;
  readonly unitPurchasePrice: string;
  readonly netRate: string;
  readonly unitCostIn: string;
  readonly unitSalePrice: string;
  readonly discountPercent: Percent;
  readonly lineGross: Money;
  readonly lineDiscount: Money;
  readonly lineNet: Money;
  readonly batchNo: string | null;
  readonly expiryDate: Date | null;
  readonly expiryStatus: "known" | "unknown" | "not_applicable";
}

function parseQty(raw: string, path: string): Quantity {
  const parsed = Quantity.fromInput(raw);
  if (!parsed.ok) {
    throw new BusinessRuleException("PURCHASE.INVALID_QUANTITY", "Invalid quantity", `${path} is not a valid quantity.`, [
      { path, code: "PURCHASE.INVALID_QUANTITY", message: "Invalid quantity" },
    ]);
  }
  return parsed.value;
}

/**
 * True when `error` is a MySQL duplicate-key error (ER_DUP_ENTRY / errno 1062) against the
 * named unique key. mysql2 surfaces both `.code` and `.errno` on the thrown error, plus the
 * violated key's name inside `.sqlMessage` (e.g. `Duplicate entry '...' for key 'uk_...'`) --
 * checking the key name (not just ER_DUP_ENTRY) keeps this from misreporting an unrelated
 * unique-key collision on the same insert as the one the caller is handling.
 */
function isDuplicateKeyError(error: unknown, keyName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const mysqlError = error as { code?: unknown; errno?: unknown; sqlMessage?: unknown };
  const isDupEntry = mysqlError.code === "ER_DUP_ENTRY" || mysqlError.errno === 1062;
  if (!isDupEntry) return false;
  return typeof mysqlError.sqlMessage === "string" && mysqlError.sqlMessage.includes(keyName);
}

function parsePercent(raw: string, path: string): Percent {
  const parsed = Percent.fromInput(raw);
  if (!parsed.ok) {
    throw new BusinessRuleException("PURCHASE.INVALID_PERCENT", "Invalid percentage", `${path} is not a valid percentage.`, [
      { path, code: "PURCHASE.INVALID_PERCENT", message: "Invalid percentage" },
    ]);
  }
  return parsed.value;
}

/**
 * Exact `qty x n` for a non-negative integer n using only Quantity.add (binary
 * double-and-add) -- Quantity deliberately has no multiply, and Rule M bans converting it to a
 * JS number to do the math outside @pharmacy/money.
 */
function mulQtyByInt(qty: Quantity, n: number): Quantity {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`multiplier must be a non-negative integer, got ${n}`);
  let result = Quantity.zero();
  let addend = qty;
  let remaining = n;
  while (remaining > 0) {
    if (remaining % 2 === 1) result = result.add(addend);
    addend = addend.add(addend);
    remaining = Math.floor(remaining / 2);
  }
  return result;
}
