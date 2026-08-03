// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md Module I -- Purchase (T77-T84):
// §T77 `purchase_invoice`, §T78 `purchase_invoice_line`, §T80 `purchase_return`, §T81
// `purchase_return_line`, §T82 `purchase_order`, §T83 `purchase_order_line`, §T84
// `purchase_category`; workflow evidence in docs/system-analysis/05b-workflows-purchase.md
// (purchase entry, goods receipt, costing update, supplier return).
//
// DEFERRED -- §T79 `purchase_charge` (the itemised freight/handling replacement for legacy
// Purledger's 20 unlabelled QE*/WE* account columns) is intentionally NOT in this file: its
// `include_in_cost` switch "requires accountant sign-off (§14 V-6)" and its charge_type FK
// targets option_item wiring that belongs with that sign-off. purchase_invoice keeps the
// `other_charges_amount` rollup column so the header total is complete meanwhile.
//
// Precision deviation (deliberate, package-wide): the blueprint writes DECIMAL(18,4)/(18,6)/
// (18,3) widths; this package standardises on 17-technical-blueprint.md §6.2's archetypes via
// schema/_shared.ts -- DOCUMENT_AMOUNT (15,2) for header amounts, UNIT_PRICE (15,4) for unit
// prices / net_rate / line amounts, AVG_COST (15,5) for unit_cost_in / avg_cost_before /
// avg_cost_after (the fifth decimal is load-bearing for the costing replay -- see catalog.ts
// items.avgUnitCost), QUANTITY (15,4) for quantities, PERCENT (9,4) for discount percents.
// See the _shared.ts header comment for the full reconciliation of 17§6.2 vs 19§3.1.
//
// Omitted -- §T77's `currency_id` / `exchange_rate` pair: single-currency PKR per owner
// decision D4 (00b), same omission as every other document table in this package.
//
// CHECK constraints the blueprint specifies on these tables (qty_base > 0,
// pack_units_at_txn >= 1, etc.) follow the ledger.ts pattern where expressible; anything
// drizzle-orm 0.36 cannot express is enforced at the service layer and hand-added to the
// generated migration SQL per the documented generate -> review -> commit flow.
//
// Every FK on these tables is declared table-level via foreignKey({ name: ... }) with an
// explicit short name: drizzle's auto-generated FK names for these long table names (e.g.
// `purchase_invoice_line_purchase_invoice_id_purchase_invoice_purchase_invoice_id_fk`)
// exceed MySQL's 64-character identifier limit (ER_TOO_LONG_IDENT -- a real bug hit earlier
// in this package; see ledger.ts glAccountCategories for the pattern).
import { sql } from "drizzle-orm";
import {
  boolean,
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
  DOCUMENT_AMOUNT,
  PERCENT,
  QUANTITY,
  UNIT_PRICE,
  auditColumns,
  docColumns,
  fkBigInt,
  fkBigIntNotNull,
  idPk,
  lkColumns,
} from "./_shared";
import { items, stockLots } from "./catalog";
import { journalEntries } from "./ledger";
import { branches, tenants } from "./tenant";

/**
 * §T84 `purchase_category` -- pack LK plus the behavioural columns that turn legacy hardcoded
 * category-number rules into data (P1.1): `qty_basis` encodes "categories 1 and 2 are
 * pack-based (PackQty x PackUnits), 3/7/8 are loose-based" (08 §4.1-§4.2, Verified), currently
 * literal integers inside SP_STOCKLEDGER; `counterparty = 'equity'` encodes the legacy
 * "opening purchase credits equity" branch (07 §4.2, Verified).
 *
 * Seed (Verified from live PurCategory, 8 rows): Normal Purchase Cash · Normal Purchase Credit
 * (6,396 invoices, 99.6%) · Opening Purchase · Normal/Opening Purchase Return variants · Loose
 * Purchase Cash/Credit -- a seed concern, not a schema one.
 */
export const purchaseCategories = mysqlTable(
  "purchase_category",
  {
    purchaseCategoryId: idPk("purchase_category_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    ...lkColumns(),
    qtyBasis: mysqlEnum("qty_basis", ["pack", "loose"]).notNull().default("pack"),
    counterparty: mysqlEnum("counterparty", ["supplier", "equity", "customer"]).notNull().default("supplier"),
    isReturn: boolean("is_return").notNull().default(false),
    isOpening: boolean("is_opening").notNull().default(false),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_purchase_category_tenant_code").on(table.tenantId, table.code),
    tenantFk: foreignKey({
      name: "fk_purchase_category_tenant",
      columns: [table.tenantId],
      foreignColumns: [tenants.tenantId],
    }),
  }),
);

/**
 * §T82 `purchase_order` -- pack DOC header. Legacy volume: 2,810 orders / 108,423 lines
 * (06a §2, Verified). No journal_entry_id: purchase orders never post to the ledger; the
 * financial document is the purchase_invoice they are received into.
 */
export const purchaseOrders = mysqlTable(
  "purchase_order",
  {
    purchaseOrderId: idPk("purchase_order_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    branchId: fkBigIntNotNull("branch_id"),
    ...docColumns(),
    supplierId: fkBigIntNotNull("supplier_id"), // soft ref -> supplier (parties.ts, written in parallel)
    expectedDate: date("expected_date"),
    orderStatus: mysqlEnum("order_status", ["open", "partial", "received", "closed", "cancelled"])
      .notNull()
      .default("open"),
    totalAmount: decimal("total_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    // `notes` comes from docColumns().
  },
  (table) => ({
    docNoUnique: uniqueIndex("uk_purchase_order_doc_no").on(table.tenantId, table.docNumber),
    supplierIdx: index("ix_purchase_order_supplier").on(table.supplierId, table.postingDate),
    statusIdx: index("ix_purchase_order_status").on(table.tenantId, table.orderStatus),
    tenantFk: foreignKey({ name: "fk_po_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    branchFk: foreignKey({ name: "fk_po_branch", columns: [table.branchId], foreignColumns: [branches.branchId] }),
  }),
);

/**
 * §T83 `purchase_order_line`. `qty_outstanding` is STORED generated (qty_ordered -
 * qty_received) so ix_po_line_item_open can power "hide zero-stock items with no pending
 * purchase order" (R1.5) and the transit-stock view without a computed scan. The reorder
 * analytics columns carry what legacy PurOrderDetail already records (06 §3.1, Verified).
 */
export const purchaseOrderLines = mysqlTable(
  "purchase_order_line",
  {
    purchaseOrderLineId: idPk("purchase_order_line_id"),
    tenantId: fkBigIntNotNull("tenant_id"), // denormalised -- D16 isolation defence-in-depth
    purchaseOrderId: fkBigIntNotNull("purchase_order_id"),
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    itemId: fkBigIntNotNull("item_id"),
    qtyOrdered: decimal("qty_ordered", QUANTITY).notNull(),
    qtyReceived: decimal("qty_received", QUANTITY).notNull().default("0.0000"),
    qtyOutstanding: decimal("qty_outstanding", QUANTITY)
      .generatedAlwaysAs(sql`\`qty_ordered\` - \`qty_received\``, { mode: "stored" })
      .notNull(),
    unitPrice: decimal("unit_price", UNIT_PRICE),
    expectedDate: date("expected_date"),
    reorderQty: decimal("reorder_qty", QUANTITY),
    optimumQty: decimal("optimum_qty", QUANTITY),
    soldQty: decimal("sold_qty", QUANTITY),
    returnQty: decimal("return_qty", QUANTITY),
    transitStock: decimal("transit_stock", QUANTITY),
    ...auditColumns(),
  },
  (table) => ({
    lineUnique: uniqueIndex("uk_po_line").on(table.purchaseOrderId, table.lineNo),
    itemOpenIdx: index("ix_po_line_item_open").on(table.itemId, table.qtyOutstanding),
    orderFk: foreignKey({
      name: "fk_po_line_order",
      columns: [table.purchaseOrderId],
      foreignColumns: [purchaseOrders.purchaseOrderId],
    }),
    itemFk: foreignKey({ name: "fk_po_line_item", columns: [table.itemId], foreignColumns: [items.itemId] }),
    tenantFk: foreignKey({ name: "fk_po_line_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
  }),
);

/**
 * §T77 `purchase_invoice` -- supplier invoice and goods receipt. Legacy Purledger has 100
 * columns for 6,417 rows; its 20 unlabelled QE- and WE-prefixed expense-allocation columns become rows in
 * the deferred purchase_charge (§T79), not columns here.
 *
 * `cost_basis` replaces PurLedger.UpdateAvgPriceWithNetRate -- the per-invoice switch that
 * silently varied the moving-average costing basis mid-history (08 §8.3, Verified, High).
 * Retained for historical fidelity on migrated rows; new documents take the value from the
 * versioned period setting.
 *
 * `balance_amount` (STORED generated, invoice_total - paid_amount) is "the column that makes
 * R2.6 'who do I owe and how much' possible" -- indexed as ix_purchase_open, the aged-payables
 * index (§8 index #9). Legacy paid_amount is always 0: no supplier payment has ever been
 * recorded (00b F1.1, Verified).
 */
export const purchaseInvoices = mysqlTable(
  "purchase_invoice",
  {
    purchaseInvoiceId: idPk("purchase_invoice_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    branchId: fkBigIntNotNull("branch_id"),
    ...docColumns(),
    supplierId: fkBigIntNotNull("supplier_id"), // soft ref -> supplier (parties.ts, written in parallel)
    purchaseCategoryId: fkBigIntNotNull("purchase_category_id"), // 99.6% of legacy invoices are category 2 "Normal Purchase Credit" (08 §4.2, Verified)
    supplierInvoiceNo: varchar("supplier_invoice_no", { length: 64 }),
    supplierInvoiceDate: date("supplier_invoice_date"),
    dueDate: date("due_date"),
    // No currency_id / exchange_rate -- PKR-only (D4); see file header.
    grossAmount: decimal("gross_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    lineDiscountAmount: decimal("line_discount_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    invoiceDiscountPercent: decimal("invoice_discount_percent", PERCENT).notNull().default("0.0000"),
    invoiceDiscountAmount: decimal("invoice_discount_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    netAmount: decimal("net_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    salesTaxAmount: decimal("sales_tax_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // input tax -- debited to account 3 (07 §12.1, Verified)
    advanceIncomeTaxAmount: decimal("advance_income_tax_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // ApplyAdvanceIncomeTaxInPur='Y'; live Dr 696,928.69 / 3,808 rows (Verified)
    otherChargesAmount: decimal("other_charges_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // Σ purchase_charge (§T79, deferred)
    invoiceTotal: decimal("invoice_total", DOCUMENT_AMOUNT).notNull().default("0.00"),
    paidAmount: decimal("paid_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // Σ allocations from payment (R2.1)
    balanceAmount: decimal("balance_amount", DOCUMENT_AMOUNT)
      .generatedAlwaysAs(sql`\`invoice_total\` - \`paid_amount\``, { mode: "stored" })
      .notNull(),
    costBasis: mysqlEnum("cost_basis", ["net_rate", "gross_price"]).notNull().default("net_rate"),
    totalQty: decimal("total_qty", QUANTITY).notNull().default("0.0000"),
    journalEntryId: fkBigInt("journal_entry_id"), // NULL until posted; UNIQUE below -- one posting per document
    purchaseOrderId: fkBigInt("purchase_order_id"),
  },
  (table) => ({
    docNoUnique: uniqueIndex("uk_purchase_invoice_doc_no").on(table.tenantId, table.docNumber),
    journalUnique: uniqueIndex("uk_purchase_invoice_journal").on(table.journalEntryId),
    supplierIdx: index("ix_purchase_supplier").on(table.supplierId, table.postingDate),
    openIdx: index("ix_purchase_open").on(table.supplierId, table.balanceAmount), // aged payables, R2.6
    suppInvIdx: index("ix_purchase_supp_inv").on(table.supplierId, table.supplierInvoiceNo), // duplicate-invoice detection
    tenantFk: foreignKey({ name: "fk_pi_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    branchFk: foreignKey({ name: "fk_pi_branch", columns: [table.branchId], foreignColumns: [branches.branchId] }),
    categoryFk: foreignKey({
      name: "fk_pi_category",
      columns: [table.purchaseCategoryId],
      foreignColumns: [purchaseCategories.purchaseCategoryId],
    }),
    journalFk: foreignKey({
      name: "fk_pi_journal",
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.journalEntryId],
    }),
    orderFk: foreignKey({
      name: "fk_pi_order",
      columns: [table.purchaseOrderId],
      foreignColumns: [purchaseOrders.purchaseOrderId],
    }),
  }),
);

// Shared line-body enum -- §T78 capture_method, "R4.1 measurement: proves whether the scan
// path is really removing the data-entry burden that killed batch tracking in the legacy
// system."
const CAPTURE_METHODS = ["scan_gs1", "manual", "copied_previous", "defaulted_unknown"] as const;

/**
 * §T78 `purchase_invoice_line` -- "the line that creates the lot": stock_lot_id is NOT NULL,
 * batch and expiry are captured here (R4.1). Legacy Purdetail's PK is the 5-part
 * (PurInvCode, Gcode, ICode, Batch, Expiry) tuple -- exactly the key that collapses when batch
 * is '.' (06 §3.1, Verified); a surrogate PK plus uk_purchase_line replaces it.
 *
 * Quantity rule as §T68: qty_base is the single authoritative quantity in loose units,
 * computed once by the service as qty_loose + qty_pack x pack_units_at_txn + qty_bonus --
 * this is what removes the legacy bonus-qty under-reversal defect (08 §4.1, Verified, High).
 * CHECKs (qty_base > 0, pack_units_at_txn >= 1) are enforced at the service layer and
 * hand-added to migration SQL.
 */
export const purchaseInvoiceLines = mysqlTable(
  "purchase_invoice_line",
  {
    purchaseInvoiceLineId: idPk("purchase_invoice_line_id"),
    tenantId: fkBigIntNotNull("tenant_id"), // denormalised -- D16 isolation defence-in-depth
    purchaseInvoiceId: fkBigIntNotNull("purchase_invoice_id"),
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    itemId: fkBigIntNotNull("item_id"),
    stockLotId: fkBigIntNotNull("stock_lot_id"),
    qtyPack: decimal("qty_pack", QUANTITY).notNull().default("0.0000"),
    qtyLoose: decimal("qty_loose", QUANTITY).notNull().default("0.0000"),
    qtyBonus: decimal("qty_bonus", QUANTITY).notNull().default("0.0000"),
    packUnitsAtTxn: smallint("pack_units_at_txn", { unsigned: true }).notNull().default(1), // snapshot of item.pack_units at receipt
    qtyBase: decimal("qty_base", QUANTITY).notNull(),
    unitPurchasePrice: decimal("unit_purchase_price", UNIT_PRICE).notNull(), // per pack (08 §5.2, Verified)
    netRate: decimal("net_rate", UNIT_PRICE).notNull(), // per pack, after line discounts + allocated charges -- the costing basis
    unitCostIn: decimal("unit_cost_in", AVG_COST).notNull(), // basis_rate / pack_units_at_txn -- per loose unit, feeds the moving average
    unitSalePrice: decimal("unit_sale_price", UNIT_PRICE).notNull(), // sale price captured at purchase (drives the item_change_log price trail)
    unitSalesTax: decimal("unit_sales_tax", UNIT_PRICE).notNull().default("0.0000"), // captured at purchase, carried onto sale (11 §2.2)
    discountPercent: decimal("discount_percent", PERCENT).notNull().default("0.0000"),
    lineGrossAmount: decimal("line_gross_amount", UNIT_PRICE).notNull(),
    lineDiscountAmount: decimal("line_discount_amount", UNIT_PRICE).notNull().default("0.0000"),
    lineNetAmount: decimal("line_net_amount", UNIT_PRICE).notNull(),
    lineTaxAmount: decimal("line_tax_amount", UNIT_PRICE).notNull().default("0.0000"),
    // Informational snapshots of the costing chain, matching legacy AvgPrice/NewAvgPrice
    // (06 §6.4 says keep these). AVG_COST (15,5) -- the fifth decimal is load-bearing for
    // the costing replay (catalog.ts items.avgUnitCost).
    avgCostBefore: decimal("avg_cost_before", AVG_COST).notNull().default("0.00000"),
    avgCostAfter: decimal("avg_cost_after", AVG_COST).notNull().default("0.00000"),
    expiryDateCaptured: date("expiry_date_captured"), // what the user/scanner actually entered, before lot resolution
    batchNoCaptured: varchar("batch_no_captured", { length: 64 }),
    captureMethod: mysqlEnum("capture_method", CAPTURE_METHODS).notNull().default("manual"),
    legacyRowId: fkBigInt("legacy_row_id"), // legacy identity at 237,424 for 113,082 surviving rows -- ~52% line-deletion rate (06 §10 V7)
    ...auditColumns(),
  },
  (table) => ({
    lineUnique: uniqueIndex("uk_purchase_line").on(table.purchaseInvoiceId, table.lineNo),
    legacyUnique: uniqueIndex("uk_purchase_line_legacy").on(table.legacyRowId),
    itemIdx: index("ix_purchase_line_item").on(table.itemId, table.purchaseInvoiceId),
    lotIdx: index("ix_purchase_line_lot").on(table.stockLotId),
    invoiceFk: foreignKey({
      name: "fk_pi_line_invoice",
      columns: [table.purchaseInvoiceId],
      foreignColumns: [purchaseInvoices.purchaseInvoiceId],
    }),
    itemFk: foreignKey({ name: "fk_pi_line_item", columns: [table.itemId], foreignColumns: [items.itemId] }),
    lotFk: foreignKey({ name: "fk_pi_line_lot", columns: [table.stockLotId], foreignColumns: [stockLots.stockLotId] }),
    tenantFk: foreignKey({ name: "fk_pi_line_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
  }),
);

/**
 * §T80 `purchase_return` -- mirror of the sale_return shape (§T72) against the supplier.
 * Live legacy: 634 returns / 2,481 lines; the counter is at 2,122, meaning 1,488
 * purchase-return numbers were consumed for documents that no longer exist (06 §10 V6,
 * Verified) -- which is exactly why this rebuild's DOC pack cancels/reverses and never
 * deletes.
 */
export const purchaseReturns = mysqlTable(
  "purchase_return",
  {
    purchaseReturnId: idPk("purchase_return_id"),
    tenantId: fkBigIntNotNull("tenant_id"),
    branchId: fkBigIntNotNull("branch_id"),
    ...docColumns(),
    purchaseInvoiceId: fkBigInt("purchase_invoice_id"), // nullable -- free-standing supplier returns exist
    supplierId: fkBigIntNotNull("supplier_id"), // soft ref -> supplier (parties.ts, written in parallel)
    purchaseCategoryId: fkBigIntNotNull("purchase_category_id"),
    reasonId: fkBigInt("reason_id"), // soft ref -> option_item (list `purchase_return_reason`, options.ts)
    // Amount block, mirroring §T72's; DOCUMENT_AMOUNT per the package archetypes.
    grossAmount: decimal("gross_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    lineDiscountAmount: decimal("line_discount_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    netAmount: decimal("net_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    salesTaxAmount: decimal("sales_tax_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    returnTotal: decimal("return_total", DOCUMENT_AMOUNT).notNull().default("0.00"),
    totalQty: decimal("total_qty", QUANTITY).notNull().default("0.0000"),
    creditNoteNo: varchar("credit_note_no", { length: 64 }),
    journalEntryId: fkBigInt("journal_entry_id"), // NULL until posted; UNIQUE below
  },
  (table) => ({
    docNoUnique: uniqueIndex("uk_purchase_return_doc_no").on(table.tenantId, table.docNumber),
    journalUnique: uniqueIndex("uk_purchase_return_journal").on(table.journalEntryId),
    supplierIdx: index("ix_purchase_return_supplier").on(table.supplierId, table.postingDate),
    invoiceIdx: index("ix_purchase_return_invoice").on(table.purchaseInvoiceId),
    tenantFk: foreignKey({ name: "fk_pr_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    branchFk: foreignKey({ name: "fk_pr_branch", columns: [table.branchId], foreignColumns: [branches.branchId] }),
    invoiceFk: foreignKey({
      name: "fk_pr_invoice",
      columns: [table.purchaseInvoiceId],
      foreignColumns: [purchaseInvoices.purchaseInvoiceId],
    }),
    categoryFk: foreignKey({
      name: "fk_pr_category",
      columns: [table.purchaseCategoryId],
      foreignColumns: [purchaseCategories.purchaseCategoryId],
    }),
    journalFk: foreignKey({
      name: "fk_pr_journal",
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.journalEntryId],
    }),
  }),
);

/**
 * §T81 `purchase_return_line` -- mirrors §T78 plus `purchase_invoice_line_id` (nullable link
 * to the original receipt line) and `stock_lot_id` NOT NULL: "returning to the supplier must
 * name the lot, which is what makes the near-expiry supplier-return workflow of R4.2
 * possible."
 */
export const purchaseReturnLines = mysqlTable(
  "purchase_return_line",
  {
    purchaseReturnLineId: idPk("purchase_return_line_id"),
    tenantId: fkBigIntNotNull("tenant_id"), // denormalised -- D16 isolation defence-in-depth
    purchaseReturnId: fkBigIntNotNull("purchase_return_id"),
    purchaseInvoiceLineId: fkBigInt("purchase_invoice_line_id"), // the original receipt line, when linked
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    itemId: fkBigIntNotNull("item_id"),
    stockLotId: fkBigIntNotNull("stock_lot_id"), // NOT NULL -- see class comment (R4.2)
    qtyPack: decimal("qty_pack", QUANTITY).notNull().default("0.0000"),
    qtyLoose: decimal("qty_loose", QUANTITY).notNull().default("0.0000"),
    qtyBonus: decimal("qty_bonus", QUANTITY).notNull().default("0.0000"),
    packUnitsAtTxn: smallint("pack_units_at_txn", { unsigned: true }).notNull().default(1),
    qtyBase: decimal("qty_base", QUANTITY).notNull(),
    unitPurchasePrice: decimal("unit_purchase_price", UNIT_PRICE).notNull(),
    netRate: decimal("net_rate", UNIT_PRICE).notNull(),
    unitCostIn: decimal("unit_cost_in", AVG_COST).notNull(), // per loose unit, reversed out of the moving average
    discountPercent: decimal("discount_percent", PERCENT).notNull().default("0.0000"),
    lineGrossAmount: decimal("line_gross_amount", UNIT_PRICE).notNull(),
    lineDiscountAmount: decimal("line_discount_amount", UNIT_PRICE).notNull().default("0.0000"),
    lineNetAmount: decimal("line_net_amount", UNIT_PRICE).notNull(),
    lineTaxAmount: decimal("line_tax_amount", UNIT_PRICE).notNull().default("0.0000"),
    avgCostBefore: decimal("avg_cost_before", AVG_COST).notNull().default("0.00000"),
    avgCostAfter: decimal("avg_cost_after", AVG_COST).notNull().default("0.00000"),
    expiryDateCaptured: date("expiry_date_captured"),
    batchNoCaptured: varchar("batch_no_captured", { length: 64 }),
    captureMethod: mysqlEnum("capture_method", CAPTURE_METHODS).notNull().default("manual"),
    legacyRowId: fkBigInt("legacy_row_id"),
    ...auditColumns(),
  },
  (table) => ({
    lineUnique: uniqueIndex("uk_purchase_return_line").on(table.purchaseReturnId, table.lineNo),
    legacyUnique: uniqueIndex("uk_pr_line_legacy").on(table.legacyRowId),
    itemIdx: index("ix_pr_line_item").on(table.itemId, table.purchaseReturnId),
    lotIdx: index("ix_pr_line_lot").on(table.stockLotId),
    returnFk: foreignKey({
      name: "fk_pr_line_return",
      columns: [table.purchaseReturnId],
      foreignColumns: [purchaseReturns.purchaseReturnId],
    }),
    invoiceLineFk: foreignKey({
      name: "fk_pr_line_invoice_line",
      columns: [table.purchaseInvoiceLineId],
      foreignColumns: [purchaseInvoiceLines.purchaseInvoiceLineId],
    }),
    itemFk: foreignKey({ name: "fk_pr_line_item", columns: [table.itemId], foreignColumns: [items.itemId] }),
    lotFk: foreignKey({ name: "fk_pr_line_lot", columns: [table.stockLotId], foreignColumns: [stockLots.stockLotId] }),
    tenantFk: foreignKey({ name: "fk_pr_line_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
  }),
);
