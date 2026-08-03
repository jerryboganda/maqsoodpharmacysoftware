// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T57 `stock_movement`, §T58
// `stock_balance`, §T59 `item_cost_snapshot`, §T61 `stock_adjustment`, §T62
// `stock_adjustment_line`, §T63 `adjustment_reason`; docs/system-analysis/08-inventory-logic.md
// (the verified legacy behaviour these tables replace: destructive GodownDetail updates §7.1/§25.1,
// the moving-average costing chain §8.1-8.5, adjustments invisible to the GL §28.5).
//
// DEFERRED (not in this file, by instruction): §T64 `stock_take` / §T65 `stock_take_line`,
// §T66 `expiry_alert_rule`, §T60 `stock_snapshot_daily`. `stock_adjustment.stock_take_id` below
// stays a bare soft reference until the stock-take module lands.
//
// Package-wide deviations from §19's literal DDL, deliberate and shared with every other schema
// file here (see schema/_shared.ts header):
//   - Precision archetypes come from 17-technical-blueprint.md §6.2, NOT §19's 18,x widths:
//     QUANTITY DECIMAL(15,4) for every qty column (§19 says 18,3), AVG_COST DECIMAL(15,5) for
//     unit costs entering the costing chain (§19 says 18,6), DOCUMENT_AMOUNT DECIMAL(15,2) for
//     cost_amount / value totals (§19 says 18,4). These match packages/money's value objects,
//     which are the source of truth for scale.
//   - §19's `warehouse_id` is `branch_id` in this package -- there is no separate warehouse
//     table (see tenant.ts branches TODO and catalog.ts stockLots).
//   - Every table carries tenant_id with a real FK (D16); §19's narrowed key widths
//     (SMALLINT/INT) are standardised to BIGINT UNSIGNED (_shared.ts idPk comment).
//   - CHECK constraints (ck_stock_movement_qty/cost, ck_stock_balance_nonneg,
//     ck_adjustment_approval, ck_adj_line_qty) are enforced at the service layer and hand-added
//     to the generated migration SQL per the documented generate -> review -> commit flow --
//     noted per-table below.
//   - Append-only enforcement for stock_movement / item_cost_snapshot (INSERT/SELECT-only grants
//     + BEFORE UPDATE/DELETE triggers, §T57) is deployment SQL, hand-added to the migration.
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  datetime,
  decimal,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  appendOnlyAuditColumns,
  auditColumns,
  AVG_COST,
  docColumns,
  DOCUMENT_AMOUNT,
  fkBigInt,
  fkBigIntNotNull,
  idPk,
  lkColumns,
  QUANTITY,
  TIMESTAMP_FSP,
} from "./_shared";
import { items, stockLots } from "./catalog";
import { documentTypes, fiscalPeriods } from "./docflow";
import { glAccounts } from "./ledger";
import { branches, tenants } from "./tenant";

/**
 * §T63 `adjustment_reason` -- options-as-data (P1), pack LK plus behavioural columns. Replaces
 * the legacy `AdjCategory` (exactly two rows, INCREASE and DECREASE, plus free-text Remarks --
 * 08 §4.2, Verified) with a real taxonomy.
 *
 * `glAccountId` is NOT NULL by design: 100% of legacy stock adjustments (all 1,542) were silently
 * excluded from the GL because `AdjHeader.AccCode IS NULL` on every row (07 §13.3, Verified,
 * high severity). Here a reason that cannot post cannot exist, so an adjustment that cannot post
 * cannot be saved.
 *
 * Seed (00b P1): Damage · Expiry · Theft/shrinkage · Count correction · Sample/donation ·
 * Breakage · Internal use · Data-entry error · Other. Default: Count correction (P1.2).
 */
export const adjustmentReasons = mysqlTable(
  "adjustment_reason",
  {
    adjustmentReasonId: idPk("adjustment_reason_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    ...lkColumns(),
    direction: mysqlEnum("direction", ["increase", "decrease", "both"]).notNull().default("both"),
    // Real FK, mandatory -- the fix for the invisible-shrinkage defect above (§T63).
    glAccountId: fkBigIntNotNull("gl_account_id"),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvalThresholdAmount: decimal("approval_threshold_amount", DOCUMENT_AMOUNT),
    requiresNote: boolean("requires_note").notNull().default(false),
    // Shrinkage is PKR 290,494 net over 19 months and completely invisible in the legacy
    // system (08 §28.5, Verified) -- this flag is what makes the KPI computable.
    affectsShrinkageKpi: boolean("affects_shrinkage_kpi").notNull().default(true),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_adjustment_reason_code").on(table.tenantId, table.code),
    glAccountFk: foreignKey({
      name: "fk_adjustment_reason_gl",
      columns: [table.glAccountId],
      foreignColumns: [glAccounts.glAccountId],
    }),
  }),
);

/**
 * §T57 `stock_movement` -- the append-only inventory ledger. Every physical stock change, ever,
 * as an immutable row. Replaces the legacy design in which `GodownDetail.CurrQty` is destructively
 * updated in place -- exactly why five stock-repair procedures exist (08 §25.1, Verified) and why
 * a batch drawn to zero is deleted rather than left at zero (08 §7.1, Verified).
 *
 * Append-only: appendOnlyAuditColumns() only -- no updated_*, no row_version, no deleted_*.
 * Enforced beyond discipline by INSERT/SELECT-only grants and BEFORE UPDATE / BEFORE DELETE
 * triggers that SIGNAL SQLSTATE '45000' (§T57) -- hand-added to the generated migration.
 * Corrections are compensating rows via `reversalOfId`, never edits.
 *
 * CHECKs enforced at the service layer (hand-added to migration SQL, see header):
 *   ck_stock_movement_qty  (qty_delta <> 0)
 *   ck_stock_movement_cost (unit_cost >= 0)
 *
 * Not partitioned (§T57): ~700K rows per 19 months; partitioning would cost the foreign keys
 * (MySQL 8 forbids FKs on partitioned InnoDB, §7.3).
 */
export const stockMovements = mysqlTable(
  "stock_movement",
  {
    stockMovementId: idPk("stock_movement_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId), // §T57 warehouse_id
    occurredAt: datetime("occurred_at", { fsp: TIMESTAMP_FSP }).notNull(), // when it physically happened
    postingDate: date("posting_date").notNull(), // the date it counts for
    fiscalPeriodId: fkBigIntNotNull("fiscal_period_id"), // real FK below -- makes period locking a join
    documentTypeId: fkBigIntNotNull("document_type_id"), // real FK below
    sourceDocumentId: fkBigIntNotNull("source_document_id"), // soft -- polymorphic across document tables
    sourceLineId: fkBigInt("source_line_id"), // soft, same reason
    itemId: fkBigIntNotNull("item_id"), // real FK below
    stockLotId: fkBigIntNotNull("stock_lot_id"), // real FK below; NOT NULL -- every movement has a lot, always (§T56 note)
    qtyDelta: decimal("qty_delta", QUANTITY).notNull(), // SIGNED: positive = in, negative = out
    // §T57: indexable without a function. Generated from the sign of qty_delta, STORED (same
    // pattern as catalog.ts stockLots.batchKey).
    direction: mysqlEnum("direction", ["in", "out"])
      .generatedAlwaysAs(sql`if(\`qty_delta\` >= 0, 'in', 'out')`, { mode: "stored" })
      .notNull(),
    // The item's moving average AT THE MOMENT of the movement -- the frozen COGS record. Legacy
    // precedent: SaleDetail.AvgPrice (08 §8.1, Verified). AVG_COST archetype, entering costing.
    unitCost: decimal("unit_cost", AVG_COST).notNull().default("0.00000"),
    // ROUND(ABS(qty_delta) * unit_cost, 2), signed with the movement. Stored, not generated --
    // it is the audited value (§T57).
    costAmount: decimal("cost_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    // Informational snapshots only, never authoritative (§T57; legacy Purdetail.CurrStock /
    // Saledetail.balancestock, kept per 06 §6.4 as the costing chain's audit trail).
    qtyBefore: decimal("qty_before", QUANTITY),
    qtyAfter: decimal("qty_after", QUANTITY),
    reversalOfId: fkBigInt("reversal_of_id"), // self-reference, soft (same-table FK)
    reasonId: fkBigInt("reason_id"), // real FK below -> adjustment_reason, where applicable
    notes: varchar("notes", { length: 255 }),
    ...appendOnlyAuditColumns(),
  },
  (table) => ({
    // §T57's five indexes, warehouse_id -> branch_id.
    itemTimeIdx: index("ix_movement_item_time").on(table.itemId, table.postingDate, table.stockMovementId), // item stock card
    lotIdx: index("ix_movement_lot").on(table.stockLotId, table.postingDate), // lot trace: every movement of batch X
    docIdx: index("ix_movement_doc").on(table.documentTypeId, table.sourceDocumentId), // document -> movements
    balanceIdx: index("ix_movement_balance").on(table.branchId, table.itemId, table.stockLotId, table.postingDate), // balance rebuild
    periodIdx: index("ix_movement_period").on(table.fiscalPeriodId, table.documentTypeId), // period reporting
    // Explicit FK names -- Drizzle's auto-generated names for these exceed MySQL's 64-char
    // identifier limit (same reasoning as ledger.ts glAccountCategories.mainFk).
    fiscalPeriodFk: foreignKey({
      name: "fk_movement_fiscal_period",
      columns: [table.fiscalPeriodId],
      foreignColumns: [fiscalPeriods.fiscalPeriodId],
    }),
    documentTypeFk: foreignKey({
      name: "fk_movement_document_type",
      columns: [table.documentTypeId],
      foreignColumns: [documentTypes.documentTypeId],
    }),
    itemFk: foreignKey({ name: "fk_movement_item", columns: [table.itemId], foreignColumns: [items.itemId] }),
    lotFk: foreignKey({ name: "fk_movement_lot", columns: [table.stockLotId], foreignColumns: [stockLots.stockLotId] }),
    reasonFk: foreignKey({
      name: "fk_movement_reason",
      columns: [table.reasonId],
      foreignColumns: [adjustmentReasons.adjustmentReasonId],
    }),
  }),
);

/**
 * §T58 `stock_balance` -- the materialised projection: current quantity per branch × item × lot.
 * Rebuildable from `stock_movement` by definition (qty_on_hand = SUM(qty_delta)) -- principle S3.
 *
 * Zero-quantity rows are RETAINED, never deleted (§T58): the legacy allocation loop deletes a
 * batch row drawn to exactly zero (08 §7.1, Verified), destroying the fact the lot was ever held.
 *
 * Concurrency (§T58): all decrements happen inside one transaction with SELECT ... FOR UPDATE on
 * the affected rows, ordered by primary key -- a service-layer contract, not a schema artefact.
 *
 * CHECK enforced at the service layer (hand-added to migration): ck_stock_balance_nonneg
 * (qty_on_hand >= 0), relaxed where a branch legitimately allows negative stock.
 */
export const stockBalances = mysqlTable(
  "stock_balance",
  {
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId), // §T58 warehouse_id, PK part 1
    itemId: fkBigIntNotNull("item_id").references(() => items.itemId), // PK part 2
    stockLotId: fkBigIntNotNull("stock_lot_id"), // PK part 3, real FK below
    // Denormalised for tenant-scoped queries without a join (D16 defence-in-depth).
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    qtyOnHand: decimal("qty_on_hand", QUANTITY).notNull().default("0.0000"),
    qtyReserved: decimal("qty_reserved", QUANTITY).notNull().default("0.0000"), // deferred order/reservation capability
    qtyAvailable: decimal("qty_available", QUANTITY)
      .generatedAlwaysAs(sql`\`qty_on_hand\` - \`qty_reserved\``, { mode: "stored" })
      .notNull(),
    lastMovementId: fkBigInt("last_movement_id"), // real FK below -- makes "is this projection stale?" answerable
    lastMovementAt: datetime("last_movement_at", { fsp: TIMESTAMP_FSP }), // legacy GodownDetail.LastUpdated
    // ON UPDATE CURRENT_TIMESTAMP(3) hand-added to the migration (see _shared.ts auditColumns note).
    updatedAt: datetime("updated_at", { fsp: TIMESTAMP_FSP }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.branchId, table.itemId, table.stockLotId] }),
    itemIdx: index("ix_balance_item").on(table.itemId, table.branchId), // total stock for an item
    nonzeroIdx: index("ix_balance_nonzero").on(table.itemId, table.qtyOnHand),
    lotFk: foreignKey({ name: "fk_balance_lot", columns: [table.stockLotId], foreignColumns: [stockLots.stockLotId] }),
    lastMovementFk: foreignKey({
      name: "fk_balance_last_movement",
      columns: [table.lastMovementId],
      foreignColumns: [stockMovements.stockMovementId],
    }),
  }),
);

/**
 * §T59 `item_cost_snapshot` -- append-only costing history: every change to an item's moving
 * weighted-average cost, immutably. Makes historical COGS a lookup, never a recomputation --
 * structurally retiring `Fn_GetItemCostHistory`'s look-ahead bug and the retro-writing
 * `SP_Update_ItemHistoricalCost_In_Sale_And_Return` (08 §8.5, both Verified).
 *
 * No branch_id: costing is at ITEM level per R4.5 / 08 §28.2 ("do not silently switch to FIFO"),
 * mirroring catalog.ts items.avgUnitCost -- this table is not location-bound.
 *
 * Append-only: appendOnlyAuditColumns(), grants + triggers hand-added (see header).
 */
export const itemCostSnapshots = mysqlTable(
  "item_cost_snapshot",
  {
    itemCostSnapshotId: idPk("item_cost_snapshot_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    itemId: fkBigIntNotNull("item_id").references(() => items.itemId),
    effectiveAt: datetime("effective_at", { fsp: TIMESTAMP_FSP }).notNull(),
    postingDate: date("posting_date").notNull(),
    avgUnitCost: decimal("avg_unit_cost", AVG_COST).notNull(),
    previousAvgUnitCost: decimal("previous_avg_unit_cost", AVG_COST).notNull(),
    qtyOnHandBefore: decimal("qty_on_hand_before", QUANTITY).notNull(),
    qtyIn: decimal("qty_in", QUANTITY).notNull(),
    unitCostIn: decimal("unit_cost_in", AVG_COST).notNull(),
    // §T59: recorded on EVERY snapshot -- fixes the High-rated legacy risk of the cost basis
    // silently changing mid-history via the per-invoice UpdateAvgPriceWithNetRate override
    // (08 §8.3, Verified).
    costBasis: mysqlEnum("cost_basis", ["net_rate", "gross_price", "manual", "migration"]).notNull(),
    sourceMovementId: fkBigInt("source_movement_id"), // real FK below; NULL for manual/migration entries
    documentTypeId: fkBigInt("document_type_id"), // real FK below
    sourceDocumentId: fkBigInt("source_document_id"), // soft -- polymorphic
    ...appendOnlyAuditColumns(),
  },
  (table) => ({
    movementUnique: uniqueIndex("uk_cost_snapshot_movement").on(table.sourceMovementId),
    itemIdx: index("ix_cost_snapshot_item").on(table.itemId, table.effectiveAt),
    movementFk: foreignKey({
      name: "fk_cost_snapshot_movement",
      columns: [table.sourceMovementId],
      foreignColumns: [stockMovements.stockMovementId],
    }),
    documentTypeFk: foreignKey({
      name: "fk_cost_snapshot_doc_type",
      columns: [table.documentTypeId],
      foreignColumns: [documentTypes.documentTypeId],
    }),
  }),
);

/**
 * §T61 `stock_adjustment` -- stock increase/decrease document header. Pack DOC plus the §T61
 * extras. Legacy AdjHeader/AdjDetail: 1,542 / 11,181 rows, the most heavily used inventory
 * function after sale and purchase (08 §13).
 *
 * The approval step is new by design (§T61 defect 3): legacy sp_PostStockAdjustment writes
 * Posted='Y' immediately with no approval whatsoever (08 §28.5, Verified).
 *
 * CHECK enforced at the service layer (hand-added to migration): ck_adjustment_approval
 * (requires_approval = 0 OR status <> 'posted' OR approved_by IS NOT NULL).
 */
export const stockAdjustments = mysqlTable(
  "stock_adjustment",
  {
    stockAdjustmentId: idPk("stock_adjustment_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId),
    ...docColumns(), // docSeriesId/documentTypeId/fiscalPeriodId stay soft refs, per the pack's contract
    adjustmentReasonId: fkBigIntNotNull("adjustment_reason_id"), // real FK below
    direction: mysqlEnum("direction", ["increase", "decrease"]).notNull(),
    totalQty: decimal("total_qty", QUANTITY).notNull().default("0.0000"),
    totalCostAmount: decimal("total_cost_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    updateAvgCost: boolean("update_avg_cost").notNull().default(false), // legacy AdjDetail.UpdateAvgPrice
    requiresApproval: boolean("requires_approval").notNull().default(false),
    approvedBy: fkBigInt("approved_by"), // soft ref -> app_user, same as auditColumns' created_by
    approvedAt: datetime("approved_at", { fsp: TIMESTAMP_FSP }),
    // TODO(blueprint): §T64 stock_take is deferred (see file header) -- bare soft reference
    // until that module exists; promote to a real FK then. Set when generated by a count.
    stockTakeId: fkBigInt("stock_take_id"),
  },
  (table) => ({
    docNumberUnique: uniqueIndex("uk_stock_adjustment_doc").on(table.docSeriesId, table.docNumber),
    dateIdx: index("ix_stock_adjustment_date").on(table.tenantId, table.branchId, table.postingDate, table.status),
    reasonIdx: index("ix_stock_adjustment_reason").on(table.adjustmentReasonId),
    reasonFk: foreignKey({
      name: "fk_stock_adjustment_reason",
      columns: [table.adjustmentReasonId],
      foreignColumns: [adjustmentReasons.adjustmentReasonId],
    }),
  }),
);

/**
 * §T62 `stock_adjustment_line`. `stockLotId` is NOT NULL on every line -- the legacy loses batch
 * identity entirely (everything lands in the '.' default batch, §T61 note).
 *
 * CHECK enforced at the service layer (hand-added to migration): ck_adj_line_qty (qty > 0) --
 * the sign lives on the header's `direction`, never on the line.
 */
export const stockAdjustmentLines = mysqlTable(
  "stock_adjustment_line",
  {
    lineId: idPk("line_id"),
    stockAdjustmentId: fkBigIntNotNull("stock_adjustment_id"), // real FK below
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId), // denormalised -- D16 defence-in-depth
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId), // §T62 warehouse_id
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    itemId: fkBigIntNotNull("item_id"), // real FK below
    stockLotId: fkBigIntNotNull("stock_lot_id"), // real FK below, NOT NULL by design
    qty: decimal("qty", QUANTITY).notNull(),
    unitCost: decimal("unit_cost", AVG_COST).notNull(),
    costAmount: decimal("cost_amount", DOCUMENT_AMOUNT).notNull(),
    qtyBefore: decimal("qty_before", QUANTITY), // informational snapshot, same contract as stock_movement.qty_before
    notes: varchar("notes", { length: 255 }),
    legacyKey: varchar("legacy_key", { length: 160 }),
    // Lines are editable while the header is draft, so the full audit pack applies (not the
    // append-only subset); posted-document immutability is a service-layer rule on the header.
    ...auditColumns(),
  },
  (table) => ({
    lineUnique: uniqueIndex("uk_adj_line").on(table.stockAdjustmentId, table.lineNo),
    itemIdx: index("ix_adj_line_item").on(table.itemId),
    lotIdx: index("ix_adj_line_lot").on(table.stockLotId),
    headerFk: foreignKey({
      name: "fk_adj_line_header",
      columns: [table.stockAdjustmentId],
      foreignColumns: [stockAdjustments.stockAdjustmentId],
    }),
    itemFk: foreignKey({ name: "fk_adj_line_item", columns: [table.itemId], foreignColumns: [items.itemId] }),
    lotFk: foreignKey({ name: "fk_adj_line_lot", columns: [table.stockLotId], foreignColumns: [stockLots.stockLotId] }),
  }),
);
