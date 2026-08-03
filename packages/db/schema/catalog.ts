// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T31 `item`, §T45
// `item_visibility` (R1.6), §T56 `stock_lot` (R4); docs/system-analysis/00b-owner-decisions-and-
// requirements.md D7/R1 (item visibility, 100% admin-configurable, never delete) and D12/R4 (real
// batch + expiry tracking as a Tier-1 feature); docs/system-analysis/17-technical-blueprint.md
// §6.2 (precision archetypes, via schema/_shared.ts).
//
// Scope note: the full §T31 `item` has ~30 columns including FKs to item_category, item_class,
// generic_item, manufacturer, dosage_form, uom, tax_schedule and hs_code -- none of those
// reference tables exist in this Foundations package (they belong to a future catalog-support
// module). Columns that would FK to them are omitted rather than left as dangling/untyped FKs;
// see the `// TODO(blueprint)` markers below. What is kept is exactly what the task asked this
// file to cover: the item identity/pricing core, R1's per-context visibility, and R4's
// batch/expiry fields.
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  datetime,
  decimal,
  index,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { AVG_COST, auditColumns, fkBigInt, fkBigIntNotNull, idPk, QUANTITY, softDeleteColumns, TIMESTAMP_FSP, UNIT_PRICE } from "./_shared";
import { branches, tenants } from "./tenant";

/**
 * The pharmacy item master. §T31: legacy `Item` has 135 columns for 30,052 rows, including
 * garment/textile residue that exist only to satisfy `NOT NULL DEFAULT 1` foreign keys pointing
 * at one-row lookup tables (06 §3.4, Verified) -- those column groups are dropped outright, per
 * §T31 and 08 §28.1.
 *
 * Tenant-scoped, not branch-scoped: the catalogue is shared across a tenant's branches (typical
 * multi-branch retail pattern -- one catalogue, per-branch stock/pricing), matching D16's
 * "within a tenant a branch_id" wording, which does not require every table to carry both.
 * Physical, location-bound facts (batch/expiry/stock) live on `stockLots` below, which DOES carry
 * `branchId`.
 */
export const items = mysqlTable(
  "item",
  {
    itemId: idPk("item_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    customCode: varchar("custom_code", { length: 75 }).notNull(), // legacy Item.CustomICode
    name: varchar("name", { length: 160 }).notNull(),
    nameLocal: varchar("name_local", { length: 255 }), // legacy Item.LocalItemName, D15 Urdu
    registrationNo: varchar("registration_no", { length: 64 }), // legacy Item.RegdNo (drug registration)
    // TODO(blueprint): §T31 item_category_id/item_class_id/generic_item_id/manufacturer_id/
    // dosage_form_id/uom_id/tax_schedule_id/hs_code_id all FK into catalog-support tables
    // (item_category, manufacturer, generic_item, uom, dosage_form, tax_schedule, hs_code) that
    // are out of scope for this Foundations package. Add these FKs when that module is built;
    // until then those attributes belong in `attributesJson` below rather than as untyped columns.
    packUnits: smallint("pack_units", { unsigned: true }).notNull().default(1), // loose units per pack
    allowDecimalQty: boolean("allow_decimal_qty").notNull().default(false), // legacy AllowSaleInDecimalQty
    salePrice: decimal("sale_price", UNIT_PRICE).notNull().default("0.0000"), // per pack, §T31 Verified basis
    purchasePrice: decimal("purchase_price", UNIT_PRICE).notNull().default("0.0000"), // per pack
    // §T31: "per loose unit -- the moving weighted average (08 §8.1, Verified). Maintained only
    // by the costing service; never edited directly." R4.5: "keep costing at item level (proven,
    // simple) but carry batch as a dimension, not as a separate costing method." Uses the
    // AVG_COST archetype (DECIMAL(15,5)) rather than UNIT_PRICE -- 17§6.2 is explicit that this
    // is the one column the legacy is actually consistent about, and the fifth decimal is load-
    // bearing for the costing replay (see schema/_shared.ts AVG_COST comment).
    avgUnitCost: decimal("avg_unit_cost", AVG_COST).notNull().default("0.00000"),
    minQty: decimal("min_qty", QUANTITY), // legacy ReorderQty is 0 for all 30,050 items (08 §18.1) -- reorder mgmt is new
    maxQty: decimal("max_qty", QUANTITY),
    reorderQty: decimal("reorder_qty", QUANTITY),
    // R1: never delete, ship visible by default, admin-configurable. This is the master
    // visibility switch (R1.3); per-context overrides live in `itemVisibility` below (R1.6).
    isActive: boolean("is_active").notNull().default(true),
    // R4.1: batch/expiry capture strictness, admin-configurable per item (category supplies the
    // fallback default, out of scope here since item_category isn't in this package -- default
    // is `required`, matching §T31's stated default for medicines).
    hasExpiry: boolean("has_expiry").notNull().default(true),
    expiryCaptureMode: mysqlEnum("expiry_capture_mode", ["required", "prompt", "off"]).notNull().default("required"),
    shelfLifeDays: smallint("shelf_life_days", { unsigned: true }), // validation bound for R4.1
    storageLocation: varchar("storage_location", { length: 100 }),
    isControlledDrug: boolean("is_controlled_drug").notNull().default(false), // drives stricter audit on dispensing (R7)
    // The validated long tail -- where the dropped legacy garment/textile column groups, and the
    // category/manufacturer/etc. references from the TODO above, go until their own tables exist.
    attributesJson: varchar("attributes_json", { length: 4000 }), // TODO(blueprint): promote to a real `json()` column once the JSON-Schema validation layer (§T31) is implemented at the service layer
    notes: varchar("notes", { length: 1000 }),
    legacyId: varchar("legacy_id", { length: 16 }), // legacy Item.ICode
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    customCodeUnique: uniqueIndex("uk_item_tenant_custom_code").on(table.tenantId, table.customCode),
    nameUnique: uniqueIndex("uk_item_tenant_name").on(table.tenantId, table.name),
    legacyUnique: uniqueIndex("uk_item_legacy").on(table.legacyId),
    activeIdx: index("ix_item_tenant_active_name").on(table.tenantId, table.isActive, table.name),
  }),
);

/**
 * §T45 `item_visibility` -- R1.6: "The admin can control visibility independently per context,
 * because the right answer differs by screen: Sales/POS search, Purchase entry, Reports, Stock
 * lists." Absence of a row means "visible" (R1.2 -- everything ships visible by default), so the
 * table stays small until an administrator actually curates, exactly as §T45 specifies.
 */
export const itemVisibility = mysqlTable(
  "item_visibility",
  {
    itemId: fkBigIntNotNull("item_id").references(() => items.itemId),
    // Denormalised from item for tenant-scoped queries without a join (D16 isolation
    // defence-in-depth, same reasoning as options.ts optionItems.tenantId).
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    scope: mysqlEnum("scope", ["pos", "purchase", "reports", "stock_list"]).notNull(),
    isVisible: boolean("is_visible").notNull().default(true), // R1.2: everything ships visible
    source: mysqlEnum("source", ["default", "manual", "bulk", "preset"]).notNull().default("default"), // R1.8
    changedAt: datetime("changed_at", { fsp: TIMESTAMP_FSP }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    changedBy: fkBigInt("changed_by"),
    // Groups one bulk action so R1.4's "single-click undo" is a single reversal, not thousands.
    bulkOperationId: fkBigInt("bulk_operation_id"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.itemId, table.scope] }),
    scopeIdx: index("ix_item_visibility_scope").on(table.tenantId, table.scope, table.isVisible),
    bulkIdx: index("ix_item_visibility_bulk").on(table.bulkOperationId),
  }),
);

/**
 * §T56 `stock_lot` -- R4: batch as a first-class entity. In the legacy schema "batch" is a
 * `varchar(100)` component of a composite primary key holding `'.'` on 95.2% of rows, with
 * `ItemBatches`/`ItemBatchPricing`/`ExpiryIntimation` all empty and only 62 distinct batch values
 * warehouse-wide (06 §6.7, 08 §10, Verified, Critical finding F2). D12/R4 makes this Tier-1.
 *
 * Every stock-bearing lot has a row here, always -- when batch/expiry are genuinely unknown, a
 * lot is still created with `batchNo = NULL`, `expiryDate = NULL`, `expiryStatus = 'unknown'`
 * (§T56), which is what keeps the unknowns countable and reportable instead of hidden behind a
 * placeholder like the legacy's `'.'` and `2030-12-12` sentinel.
 *
 * Scoped by `branchId` (not a separate `warehouse` table -- see tenant.ts branches TODO): a lot is
 * a physical receipt of stock at one site.
 */
export const stockLots = mysqlTable(
  "stock_lot",
  {
    stockLotId: idPk("stock_lot_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId),
    itemId: fkBigIntNotNull("item_id").references(() => items.itemId),
    batchNo: varchar("batch_no", { length: 64 }), // NULL, never '.' -- see class comment
    expiryDate: date("expiry_date"), // NULL, never 2030-12-12. DATE not DATETIME (§3.6 -- removes the time-component landmine)
    expiryStatus: mysqlEnum("expiry_status", ["known", "unknown", "not_applicable"]).notNull().default("known"),
    manufacturedOn: date("manufactured_on"), // legacy GodownDetail.ManfDate
    // §T56 recall traceability (R4.5): which supplier delivered this lot, and through which
    // document. Soft references (bare columns) -- supplier lives in parties.ts and document_type
    // in docflow.ts, both of which import catalog concepts; hard FKs here would be circular.
    supplierId: fkBigInt("supplier_id"), // soft ref -> supplier (parties.ts)
    sourceDocumentTypeId: fkBigInt("source_document_type_id"), // soft ref -> document_type (docflow.ts)
    sourceDocumentId: fkBigInt("source_document_id"), // the purchase_invoice (etc.) that created the lot
    receivedOn: date("received_on"),
    receiptUnitCost: decimal("receipt_unit_cost", UNIT_PRICE), // informational -- costing stays at item level (R4.5)
    // Replaces legacy GodownDetail.Locked char(1).
    lotStatus: mysqlEnum("lot_status", ["available", "quarantined", "expired", "recalled", "consumed"])
      .notNull()
      .default("available"),
    // §T56: why a lot is quarantined/held -- soft ref -> option_item (P1 list `stock_hold_reason`).
    holdReasonId: fkBigInt("hold_reason_id"),
    priority: smallint("priority", { unsigned: true }).notNull().default(10), // FEFO consumption rank, lower first
    // §T56: "MySQL treats multiple NULLs as distinct, so a naive UNIQUE(item_id, batch_no,
    // expiry_date) would permit unlimited duplicate 'unknown' lots" -- the blueprint's own fix,
    // reproduced verbatim: two STORED generated columns coalescing NULL to a sentinel, so the
    // plain composite unique index below behaves correctly even when batch/expiry are unknown.
    // (An earlier attempt used a raw-SQL functional index directly on `coalesce(...)` instead of
    // materialising these columns; drizzle-kit 0.28's index-column renderer naively splits its
    // `.on(sql\`...\`)` argument on every comma, which corrupted the COALESCE(...) call's own
    // argument-separating commas into broken DDL. Real generated columns + a plain index sidestep
    // that renderer bug entirely and match §T56's specified DDL shape more closely besides.)
    batchKey: varchar("batch_key", { length: 64 })
      .generatedAlwaysAs(sql`ifnull(\`batch_no\`, '~none~')`, { mode: "stored" })
      .notNull(),
    expiryKey: date("expiry_key")
      .generatedAlwaysAs(sql`ifnull(\`expiry_date\`, '9999-12-31')`, { mode: "stored" })
      .notNull(),
    legacyKey: varchar("legacy_key", { length: 160 }), // source GCode|ICode|Batch|Expiry tuple, for reconciliation
    ...auditColumns(),
    // No SD pack (§T56): "lots are consumed or written off, never deleted."
  },
  (table) => ({
    identityUnique: uniqueIndex("uk_stock_lot_identity").on(table.itemId, table.batchKey, table.expiryKey),
    expiryIdx: index("ix_stock_lot_expiry").on(table.branchId, table.expiryDate, table.lotStatus), // R4.2 dashboard
    fefoIdx: index("ix_stock_lot_item_fefo").on(table.itemId, table.lotStatus, table.priority, table.expiryDate), // R4.3
    batchIdx: index("ix_stock_lot_batch").on(table.batchNo), // R4.5 recall traceability
    supplierIdx: index("ix_stock_lot_supplier").on(table.supplierId, table.receivedOn), // §T56 recall by supplier
    legacyUnique: uniqueIndex("uk_stock_lot_legacy").on(table.legacyKey), // §T56 reconciliation key
  }),
);
