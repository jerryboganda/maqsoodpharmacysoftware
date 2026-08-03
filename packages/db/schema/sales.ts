// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md Module H -- §T74 `sale_category`,
// §T67 `sale_invoice`, §T68 `sale_invoice_line`, §T70 `sale_invoice_payment`, §T72 `sale_return`,
// §T73 `sale_return_line`; docs/system-analysis/05a-workflows-sales.md (the POS sale/return
// workflows these tables persist); docs/system-analysis/17-technical-blueprint.md §6.2 precision
// archetypes via schema/_shared.ts.
//
// Deferred (deliberately NOT in this file):
//   - §T69 `sale_invoice_fbr`  -- fiscalization 1:1 extension, belongs with the FBR submission
//     module (`fbr_submission` does not exist yet).
//   - §T71 `sale_line_removed` -- removed-line audit; same line shape, deferred with the audit
//     tooling that will query it.
//   - §T75/§T76 `sale_template`/`sale_template_line` -- repeat-prescription templates, deferred.
//
// Precision deviation from §19's literal DDL (DECIMAL(18,x) family): this package standardises on
// 17-technical-blueprint.md §6.2's archetypes via schema/_shared.ts (see its header for the full
// reconciliation) -- DOCUMENT_AMOUNT (15,2) for header/GL amounts, UNIT_PRICE (15,4) for unit
// prices and line amounts, AVG_COST (15,5) for the frozen moving-average cost, QUANTITY (15,4)
// for quantities, PERCENT (9,4) for percentages. These are the scales packages/money's
// Money/Quantity/Percent value objects actually emit; §19's wider columns would store digits the
// application can never produce.
//
// PKR-only (00b D4): §T67's `currency_id`/`exchange_rate` columns are omitted outright -- single
// currency, no FX on sales. Reintroduce with the FX_RATE archetype if multi-currency ever lands.
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  decimal,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  smallint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  AVG_COST,
  auditColumns,
  DOCUMENT_AMOUNT,
  docColumns,
  fkBigInt,
  fkBigIntNotNull,
  idPk,
  lkColumns,
  PERCENT,
  QUANTITY,
  UNIT_PRICE,
} from "./_shared";
import { items, stockLots } from "./catalog";
import { docSeries, documentTypes, fiscalPeriods } from "./docflow";
import { journalEntries } from "./ledger";
import { branches, tenants } from "./tenant";

// FK naming note (applies to every table below): every FK is declared via a table-level
// foreignKey({ name: "fk_..." }) instead of an inline .references() -- Drizzle's auto-generated
// constraint names for these tables (e.g. `sale_invoice_line_sale_invoice_id_sale_invoice_
// sale_invoice_id_fk`, 66 chars) exceed MySQL's 64-character identifier limit
// (ER_TOO_LONG_IDENT -- a real failure hit on ledger.ts, see its matching comments). Short
// tenant/branch FKs get the same treatment for uniformity.

/**
 * §T74 `sale_category` -- pack LK plus the behavioural columns. `counterparty` encodes, AS DATA,
 * the legacy rule "`SaleCatCode` 1 or 3 -> debit `CashAccCode`; else debit `CustCode`"
 * (07 §4.1, Verified) -- a rule the legacy expresses as literal integers inside a stored
 * procedure. Legacy `SaleCategory` has 15 rows.
 */
export const saleCategories = mysqlTable(
  "sale_category",
  {
    saleCategoryId: idPk("sale_category_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    ...lkColumns(),
    counterparty: mysqlEnum("counterparty", ["cash", "customer_account"]).notNull().default("cash"),
    // Which cash account a 'cash' counterparty debits by default.
    defaultCashAccountId: fkBigInt("default_cash_account_id"), // soft ref -> cash_bank_account (payments.ts, written in parallel)
    isReturn: boolean("is_return").notNull().default(false),
    affectsStock: boolean("affects_stock").notNull().default(true),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_sale_category_tenant_code").on(table.tenantId, table.code),
    tenantFk: foreignKey({
      name: "fk_sale_category_tenant",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    }),
  }),
);

/**
 * §T67 `sale_invoice` -- the POS sale header. Legacy `SaleLedger` has 148 columns for 291,361
 * rows, ~55 of which belong to abandoned hospital/hotel/school/vehicle verticals (06 §6.8 L2,
 * Verified) -- this header keeps the ~40 that matter. Fiscalization moves to the deferred §T69
 * extension; tendering to `sale_invoice_payment` below.
 *
 * Volume sanity (§T67, Verified): ~540 invoices/day, avg ≈ 803 PKR, ≈ 2.1 lines each -- modest
 * for MySQL 8, but it mandates the indexes declared below.
 *
 * Omissions vs §T67's literal column list, each deliberate:
 *   - `currency_id`/`exchange_rate` -- PKR-only, D4 (see file header).
 *   - TODO(blueprint): `cashier_shift_id` FK -> cashier_shift (R2.4) deferred until the
 *     till/shift module (§T60-ish) exists; add the column + `ix_sale_invoice_shift` then.
 *   - §4.4's `warehouse_id` is `branchId` here (this package has branches, not warehouses --
 *     see tenant.ts branches TODO and catalog.ts stockLots).
 */
export const saleInvoices = mysqlTable(
  "sale_invoice",
  {
    saleInvoiceId: idPk("sale_invoice_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    branchId: fkBigIntNotNull("branch_id"),
    ...docColumns(),
    customerId: fkBigIntNotNull("customer_id"), // soft ref -> customer (parties.ts, written in parallel)
    saleCategoryId: fkBigIntNotNull("sale_category_id"),
    salesmanId: fkBigInt("salesman_id"), // soft ref -> salesman (parties.ts, written in parallel)
    grossAmount: decimal("gross_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // Σ line gross before any discount
    lineDiscountAmount: decimal("line_discount_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // Σ line-level discount
    invoiceDiscountPercent: decimal("invoice_discount_percent", PERCENT).notNull().default("0.0000"), // legacy SaleLedger.DiscPerc
    invoiceDiscountAmount: decimal("invoice_discount_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // legacy SaleLedger.FlatDisc
    netAmount: decimal("net_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // after all discounts, before tax
    salesTaxAmount: decimal("sales_tax_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // Σ line tax; reference formula fn_getTaxOnSaleInv (11 §2.3, Verified)
    // Live value is 0 on all sales -- ApplyAdvanceIncomeTaxInSale='N', AdvanceTax='Y' on 0 rows
    // (11 §2.1, Verified). Kept because the tax regime, not the schema, decides when it wakes up.
    advanceIncomeTaxAmount: decimal("advance_income_tax_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    // PKR 1.00 per invoice × 291,361 invoices, exactly (00b F1, Verified). The amount is an
    // app_setting, never a constant.
    fbrPosFeeAmount: decimal("fbr_pos_fee_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    otherChargesAmount: decimal("other_charges_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // replaces the five unlabelled MiscCharges1..5 slots (Unclear, 06 §6.8 L4)
    roundingAmount: decimal("rounding_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // explicit rounding leg (11 §2.4)
    invoiceTotal: decimal("invoice_total", DOCUMENT_AMOUNT).notNull().default("0.00"), // the number the customer pays
    paidAmount: decimal("paid_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // Σ sale_invoice_payment
    changeAmount: decimal("change_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    // §T67: GENERATED ALWAYS AS ... STORED; 0 for cash sales (D5). Same pattern as catalog.ts
    // stockLots.batchKey.
    balanceAmount: decimal("balance_amount", DOCUMENT_AMOUNT)
      .generatedAlwaysAs(sql`\`invoice_total\` - \`paid_amount\``, { mode: "stored" })
      .notNull(),
    // Nullable, deliberately: legacy DueDate defaulted to *now*, meaningless for a cash business
    // (06 §5.6 D4, Verified, Deprecated).
    dueDate: date("due_date"),
    totalQty: decimal("total_qty", QUANTITY).notNull().default("0.0000"), // includes bonus qty, matching FBR TotalQuantity (11 §1.3)
    lineCount: smallint("line_count", { unsigned: true }).notNull().default(0),
    // Legacy computes this and then DISCARDS it (periodic-inventory gate, 07 §10.4, Verified) --
    // here it is stored and posted.
    cogsAmount: decimal("cogs_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    journalEntryId: fkBigInt("journal_entry_id"), // UNIQUE below -- one posting per document
    // `notes`, `machine_name`, `legacy_id` and the rest of pack DOC come from docColumns().
    // TODO(blueprint): no per-line `tax_schedule_id` roll-up here either -- tax schedules are a
    // deferred module (see sale_invoice_line).
  },
  (table) => ({
    numberUnique: uniqueIndex("uk_sale_invoice_number").on(table.docSeriesId, table.docNumber),
    journalUnique: uniqueIndex("uk_sale_invoice_journal").on(table.journalEntryId),
    legacyUnique: uniqueIndex("uk_sale_invoice_legacy").on(table.legacyId),
    dateIdx: index("ix_sale_invoice_date").on(table.tenantId, table.postingDate, table.status), // tenant-adjusted vs §T67
    customerIdx: index("ix_sale_invoice_customer").on(table.customerId, table.postingDate),
    salesmanIdx: index("ix_sale_invoice_salesman").on(table.salesmanId, table.postingDate),
    createdIdx: index("ix_sale_invoice_created").on(table.createdBy, table.createdAt),
    tenantFk: foreignKey({ name: "fk_sale_invoice_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    branchFk: foreignKey({ name: "fk_sale_invoice_branch", columns: [table.branchId], foreignColumns: [branches.branchId] }),
    seriesFk: foreignKey({ name: "fk_sale_invoice_series", columns: [table.docSeriesId], foreignColumns: [docSeries.docSeriesId] }),
    docTypeFk: foreignKey({
      name: "fk_sale_invoice_doc_type",
      columns: [table.documentTypeId],
      foreignColumns: [documentTypes.documentTypeId],
    }),
    periodFk: foreignKey({
      name: "fk_sale_invoice_period",
      columns: [table.fiscalPeriodId],
      foreignColumns: [fiscalPeriods.fiscalPeriodId],
    }),
    categoryFk: foreignKey({
      name: "fk_sale_invoice_category",
      columns: [table.saleCategoryId],
      foreignColumns: [saleCategories.saleCategoryId],
    }),
    journalFk: foreignKey({
      name: "fk_sale_invoice_journal",
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.journalEntryId],
    }),
    totalsCheck: check("ck_sale_invoice_totals", sql`${table.invoiceTotal} >= 0 and ${table.paidAmount} >= 0`),
    // §4.4's ck_<doc>_posted / ck_<doc>_cancel status checks are hand-added to the generated
    // migration SQL, per the docColumns() comment in schema/_shared.ts.
  }),
);

/**
 * §T68 `sale_invoice_line`. The legacy `Saledetail` has NO primary key at all -- only a
 * non-unique clustered index on `SaleInvcode`, so duplicate lines are structurally possible
 * (06 §6.1, §4.4 R5, Verified, High). `qty_base` is computed ONCE, at write time, by the
 * service -- the legacy multiplies bonus qty by PackUnits on purchases but not on purchase
 * returns, under-reversing bonus stock by a factor of PackUnits (08 §4.1, Verified, High);
 * a single authoritative base quantity removes that whole defect class.
 */
export const saleInvoiceLines = mysqlTable(
  "sale_invoice_line",
  {
    saleInvoiceLineId: idPk("sale_invoice_line_id"),
    tenantId: fkBigIntNotNull("tenant_id"), // denormalised -- D16 isolation defence-in-depth, as journal_line
    saleInvoiceId: fkBigIntNotNull("sale_invoice_id"), // ON DELETE RESTRICT is MySQL's default for this FK
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    itemId: fkBigIntNotNull("item_id"),
    stockLotId: fkBigIntNotNull("stock_lot_id"), // THE recall link (R4.5): given a batch, every sale that dispensed it
    branchId: fkBigIntNotNull("branch_id"), // §T68's warehouse_id -- branch in this package
    qtyPack: decimal("qty_pack", QUANTITY).notNull().default("0.0000"), // as entered
    qtyLoose: decimal("qty_loose", QUANTITY).notNull().default("0.0000"), // as entered
    qtyBonus: decimal("qty_bonus", QUANTITY).notNull().default("0.0000"), // as entered
    // Snapshot of item.pack_units at the moment of sale -- without it, a later change to
    // pack_units silently restates history.
    packUnitsAtTxn: smallint("pack_units_at_txn", { unsigned: true }).notNull().default(1),
    // The single authoritative quantity in loose units: qty_loose + qty_pack × pack_units_at_txn
    // + qty_bonus. Every downstream calculation uses only this column.
    qtyBase: decimal("qty_base", QUANTITY).notNull(),
    unitSalePrice: decimal("unit_sale_price", UNIT_PRICE).notNull(), // per LOOSE unit (08 §5.2, Verified)
    packSalePrice: decimal("pack_sale_price", UNIT_PRICE).notNull().default("0.0000"), // per pack, for printing
    itemFlatDiscount: decimal("item_flat_discount", UNIT_PRICE).notNull().default("0.0000"), // per unit
    discountPercent: decimal("discount_percent", PERCENT).notNull().default("0.0000"),
    lineGrossAmount: decimal("line_gross_amount", UNIT_PRICE).notNull(),
    lineDiscountAmount: decimal("line_discount_amount", UNIT_PRICE).notNull().default("0.0000"),
    // The header discount pushed down proportionally, so line-level margin is correct.
    invoiceDiscountAllocated: decimal("invoice_discount_allocated", UNIT_PRICE).notNull().default("0.0000"),
    lineNetAmount: decimal("line_net_amount", UNIT_PRICE).notNull(),
    unitSalesTax: decimal("unit_sales_tax", UNIT_PRICE).notNull().default("0.0000"), // the live tax mechanism (11 §2.2)
    // Resolved from the tax schedule AT SALE TIME and stored -- a later rate change can never
    // restate this invoice.
    // TODO(blueprint): §T68 `tax_schedule_id` FK -> tax_schedule is deferred with the tax module;
    // the stored tax_percent keeps historical invoices self-contained meanwhile.
    taxPercent: decimal("tax_percent", PERCENT).notNull().default("0.0000"),
    lineTaxAmount: decimal("line_tax_amount", UNIT_PRICE).notNull().default("0.0000"),
    // Moving average at sale time -- the frozen COGS (legacy Saledetail.AvgPrice, Verified).
    // AVG_COST archetype, same as catalog.ts items.avgUnitCost: the fifth decimal is load-bearing
    // for the costing replay.
    unitCost: decimal("unit_cost", AVG_COST).notNull().default("0.00000"),
    lineCostAmount: decimal("line_cost_amount", UNIT_PRICE).notNull().default("0.0000"),
    // §T68: GENERATED ALWAYS AS (line_net_amount - line_cost_amount) STORED.
    lineMarginAmount: decimal("line_margin_amount", UNIT_PRICE)
      .generatedAlwaysAs(sql`\`line_net_amount\` - \`line_cost_amount\``, { mode: "stored" })
      .notNull(),
    expiryAtSale: date("expiry_at_sale"), // denormalised from the lot for dispensing audit
    fefoOverridden: boolean("fefo_overridden").notNull().default(false), // R4.3: cashier overrides are audited
    legacyRowId: fkBigInt("legacy_row_id"),
    ...auditColumns(),
  },
  (table) => ({
    lineUnique: uniqueIndex("uk_sale_line").on(table.saleInvoiceId, table.lineNo),
    legacyUnique: uniqueIndex("uk_sale_line_legacy").on(table.legacyRowId),
    itemIdx: index("ix_sale_line_item").on(table.itemId, table.saleInvoiceId),
    lotIdx: index("ix_sale_line_lot").on(table.stockLotId),
    invoiceFk: foreignKey({
      name: "fk_sale_line_invoice",
      columns: [table.saleInvoiceId],
      foreignColumns: [saleInvoices.saleInvoiceId],
    }),
    tenantFk: foreignKey({ name: "fk_sale_line_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    itemFk: foreignKey({ name: "fk_sale_line_item", columns: [table.itemId], foreignColumns: [items.itemId] }),
    lotFk: foreignKey({ name: "fk_sale_line_lot", columns: [table.stockLotId], foreignColumns: [stockLots.stockLotId] }),
    branchFk: foreignKey({ name: "fk_sale_line_branch", columns: [table.branchId], foreignColumns: [branches.branchId] }),
    qtyCheck: check("ck_sale_line_qty", sql`${table.qtyBase} > 0`),
    packCheck: check("ck_sale_line_pack", sql`${table.packUnitsAtTxn} >= 1`),
  }),
);

/**
 * §T70 `sale_invoice_payment` -- split tender (P1). How the customer ACTUALLY paid -- Missing in
 * the legacy system: PaymentMode is hardcoded to "1" (always reported as cash) in the FBR JSON
 * (11 §1.3, Verified). Supports the P1 option list Cash · Card · Mobile wallet · Mixed/split ·
 * Credit; default Cash.
 */
export const saleInvoicePayments = mysqlTable(
  "sale_invoice_payment",
  {
    saleInvoicePaymentId: idPk("sale_invoice_payment_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    saleInvoiceId: fkBigIntNotNull("sale_invoice_id"),
    paymentMethodId: fkBigIntNotNull("payment_method_id"), // soft ref -> payment_method (payments.ts, written in parallel)
    cashBankAccountId: fkBigIntNotNull("cash_bank_account_id"), // soft ref -> cash_bank_account (payments.ts, written in parallel)
    amount: decimal("amount", DOCUMENT_AMOUNT).notNull(),
    referenceNo: varchar("reference_no", { length: 64 }),
    cardLast4: char("card_last4", { length: 4 }),
    walletTxnId: varchar("wallet_txn_id", { length: 64 }),
    sequenceNo: smallint("sequence_no", { unsigned: true }).notNull().default(1),
    ...auditColumns(),
  },
  (table) => ({
    paymentUnique: uniqueIndex("uk_sale_payment").on(table.saleInvoiceId, table.sequenceNo),
    methodIdx: index("ix_sale_payment_method").on(table.paymentMethodId, table.createdAt),
    invoiceFk: foreignKey({
      name: "fk_sale_payment_invoice",
      columns: [table.saleInvoiceId],
      foreignColumns: [saleInvoices.saleInvoiceId],
    }),
    tenantFk: foreignKey({ name: "fk_sale_payment_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    amountCheck: check("ck_sale_payment_amount", sql`${table.amount} > 0`),
  }),
);

/**
 * §T72 `sale_return`. `saleInvoiceId` is NULLABLE, deliberately -- free-standing returns exist
 * and are valued differently (see saleReturnLines.costBasis). Live legacy shape: 30,704 sale
 * returns, all `SRCatCode = 8` "Retail S/R" (07 §13.1, Verified).
 */
export const saleReturns = mysqlTable(
  "sale_return",
  {
    saleReturnId: idPk("sale_return_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    branchId: fkBigIntNotNull("branch_id"),
    ...docColumns(),
    saleInvoiceId: fkBigInt("sale_invoice_id"), // NULLABLE -- free-standing returns (§T72 note)
    customerId: fkBigIntNotNull("customer_id"), // soft ref -> customer (parties.ts, written in parallel)
    saleCategoryId: fkBigIntNotNull("sale_category_id"),
    refundMethodId: fkBigInt("refund_method_id"), // soft ref -> payment_method (payments.ts, written in parallel)
    cashBankAccountId: fkBigInt("cash_bank_account_id"), // soft ref -> cash_bank_account (payments.ts, written in parallel)
    grossAmount: decimal("gross_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    netAmount: decimal("net_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    salesTaxAmount: decimal("sales_tax_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    fbrPosFeeAmount: decimal("fbr_pos_fee_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    returnTotal: decimal("return_total", DOCUMENT_AMOUNT).notNull().default("0.00"),
    cogsAmount: decimal("cogs_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    journalEntryId: fkBigInt("journal_entry_id"), // UNIQUE below -- one posting per document
  },
  (table) => ({
    numberUnique: uniqueIndex("uk_sale_return_number").on(table.docSeriesId, table.docNumber),
    journalUnique: uniqueIndex("uk_sale_return_journal").on(table.journalEntryId),
    legacyUnique: uniqueIndex("uk_sale_return_legacy").on(table.legacyId),
    dateIdx: index("ix_sale_return_date").on(table.tenantId, table.postingDate, table.status),
    customerIdx: index("ix_sale_return_customer").on(table.customerId, table.postingDate),
    invoiceIdx: index("ix_sale_return_invoice").on(table.saleInvoiceId),
    tenantFk: foreignKey({ name: "fk_sale_return_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    branchFk: foreignKey({ name: "fk_sale_return_branch", columns: [table.branchId], foreignColumns: [branches.branchId] }),
    seriesFk: foreignKey({ name: "fk_sale_return_series", columns: [table.docSeriesId], foreignColumns: [docSeries.docSeriesId] }),
    docTypeFk: foreignKey({
      name: "fk_sale_return_doc_type",
      columns: [table.documentTypeId],
      foreignColumns: [documentTypes.documentTypeId],
    }),
    periodFk: foreignKey({
      name: "fk_sale_return_period",
      columns: [table.fiscalPeriodId],
      foreignColumns: [fiscalPeriods.fiscalPeriodId],
    }),
    invoiceFk: foreignKey({
      name: "fk_sale_return_invoice",
      columns: [table.saleInvoiceId],
      foreignColumns: [saleInvoices.saleInvoiceId],
    }),
    categoryFk: foreignKey({
      name: "fk_sale_return_category",
      columns: [table.saleCategoryId],
      foreignColumns: [saleCategories.saleCategoryId],
    }),
    journalFk: foreignKey({
      name: "fk_sale_return_journal",
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.journalEntryId],
    }),
  }),
);

/**
 * §T73 `sale_return_line` -- same shape as `sale_invoice_line` plus the original-line link and
 * `cost_basis`. A verified accounting defect made EXPLICIT rather than inherited: a sale return
 * not linked to an original invoice is valued at its discounted SELLING price rather than at cost
 * -- zero margin on the return (07 §13.1, 08 §5.3, Verified, "economically wrong"). `cost_basis`
 * makes the choice explicit and reportable on every line instead of hiding it in a CASE
 * expression. The correct DEFAULT requires accountant sign-off (§19 §14 V-5).
 */
export const saleReturnLines = mysqlTable(
  "sale_return_line",
  {
    saleReturnLineId: idPk("sale_return_line_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    saleReturnId: fkBigIntNotNull("sale_return_id"),
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    itemId: fkBigIntNotNull("item_id"),
    stockLotId: fkBigIntNotNull("stock_lot_id"),
    branchId: fkBigIntNotNull("branch_id"), // §T68's warehouse_id -- branch in this package
    // The original sold line, when linked. Soft ref (bare column) even though saleInvoiceLines is
    // in this same file -- keeps the return-line insert path free of a hard dependency on the
    // original line surviving archival, matching the nullable header link.
    saleInvoiceLineId: fkBigInt("sale_invoice_line_id"), // soft ref -> sale_invoice_line (above)
    costBasis: mysqlEnum("cost_basis", ["original_cost", "current_avg", "sale_price_estimate"])
      .notNull()
      .default("original_cost"),
    qtyPack: decimal("qty_pack", QUANTITY).notNull().default("0.0000"),
    qtyLoose: decimal("qty_loose", QUANTITY).notNull().default("0.0000"),
    qtyBonus: decimal("qty_bonus", QUANTITY).notNull().default("0.0000"),
    packUnitsAtTxn: smallint("pack_units_at_txn", { unsigned: true }).notNull().default(1),
    qtyBase: decimal("qty_base", QUANTITY).notNull(),
    unitSalePrice: decimal("unit_sale_price", UNIT_PRICE).notNull(),
    packSalePrice: decimal("pack_sale_price", UNIT_PRICE).notNull().default("0.0000"),
    itemFlatDiscount: decimal("item_flat_discount", UNIT_PRICE).notNull().default("0.0000"),
    discountPercent: decimal("discount_percent", PERCENT).notNull().default("0.0000"),
    lineGrossAmount: decimal("line_gross_amount", UNIT_PRICE).notNull(),
    lineDiscountAmount: decimal("line_discount_amount", UNIT_PRICE).notNull().default("0.0000"),
    invoiceDiscountAllocated: decimal("invoice_discount_allocated", UNIT_PRICE).notNull().default("0.0000"),
    lineNetAmount: decimal("line_net_amount", UNIT_PRICE).notNull(),
    unitSalesTax: decimal("unit_sales_tax", UNIT_PRICE).notNull().default("0.0000"),
    taxPercent: decimal("tax_percent", PERCENT).notNull().default("0.0000"), // TODO(blueprint): tax_schedule_id deferred, as sale_invoice_line
    lineTaxAmount: decimal("line_tax_amount", UNIT_PRICE).notNull().default("0.0000"),
    unitCost: decimal("unit_cost", AVG_COST).notNull().default("0.00000"), // per cost_basis -- see class comment
    lineCostAmount: decimal("line_cost_amount", UNIT_PRICE).notNull().default("0.0000"),
    lineMarginAmount: decimal("line_margin_amount", UNIT_PRICE)
      .generatedAlwaysAs(sql`\`line_net_amount\` - \`line_cost_amount\``, { mode: "stored" })
      .notNull(),
    expiryAtSale: date("expiry_at_sale"),
    fefoOverridden: boolean("fefo_overridden").notNull().default(false),
    legacyRowId: fkBigInt("legacy_row_id"),
    ...auditColumns(),
  },
  (table) => ({
    lineUnique: uniqueIndex("uk_sale_return_line").on(table.saleReturnId, table.lineNo),
    legacyUnique: uniqueIndex("uk_sale_return_line_legacy").on(table.legacyRowId),
    itemIdx: index("ix_sr_line_item").on(table.itemId, table.saleReturnId),
    lotIdx: index("ix_sr_line_lot").on(table.stockLotId),
    origLineIdx: index("ix_sr_line_orig").on(table.saleInvoiceLineId),
    returnFk: foreignKey({
      name: "fk_sr_line_return",
      columns: [table.saleReturnId],
      foreignColumns: [saleReturns.saleReturnId],
    }),
    tenantFk: foreignKey({ name: "fk_sr_line_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    itemFk: foreignKey({ name: "fk_sr_line_item", columns: [table.itemId], foreignColumns: [items.itemId] }),
    lotFk: foreignKey({ name: "fk_sr_line_lot", columns: [table.stockLotId], foreignColumns: [stockLots.stockLotId] }),
    branchFk: foreignKey({ name: "fk_sr_line_branch", columns: [table.branchId], foreignColumns: [branches.branchId] }),
    qtyCheck: check("ck_sr_line_qty", sql`${table.qtyBase} > 0`),
    packCheck: check("ck_sr_line_pack", sql`${table.packUnitsAtTxn} >= 1`),
  }),
);
