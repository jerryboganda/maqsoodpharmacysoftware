// Blueprint: docs/system-analysis/00b-owner-decisions-and-requirements.md D16, R6.
//
// Multi-tenancy is NOT in 19-mysql-schema-blueprint.md's table catalogue -- that document models
// a single deployment (Fazal Din PP19) and predates D16's "add multi tenancy and multi branch
// management" expansion (decided 2026-08-02, the same day as the rest of the D13-D21 batch). D16
// is explicit and binding: "every tenant-owned table carries a tenant_id (and, within a tenant, a
// branch_id) from day one -- retrofitting this to a live multi-tenant ledger later is exactly the
// kind of expensive-later change ... now confirmed as needed." This file defines the two
// structural tables every other schema/*.ts file's tenant_id/branch_id columns reference.
//
// R6 also fixes the admin model this maps to: "a platform-level admin (the owner, across all his
// sites) manages tenants themselves; a tenant-level admin manages their own branches, staff, item
// visibility (R1), options (P1) and settings" -- confirmed again at D21 ("Both -- me across sites,
// staff per-site").
import { sql } from "drizzle-orm";
import { boolean, date, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, fkBigInt, fkBigIntNotNull, idPk, softDeleteColumns } from "./_shared";

/**
 * One row per pharmacy business. D16: "the owner wants the rebuild to support multiple separate
 * pharmacy businesses (tenants), each with their own branches, isolated data, and admin" --
 * distinct from the legacy reality of one physical SQL Server database per client
 * (`FazalDinPP19DataBaseV2`, `MehmoodDataBase`, `KausarDataBase`), which R6 explicitly asks to
 * replace with a real shared platform instead of one-database-per-client.
 */
export const tenants = mysqlTable(
  "tenant",
  {
    tenantId: idPk("tenant_id"),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    nameUr: varchar("name_ur", { length: 160 }),
    legalName: varchar("legal_name", { length: 200 }),
    // D17: "NTN/STRN and other business-identity fields are admin-editable settings, scoped per
    // tenant (each pharmacy business has its own tax identity) given D16. No single value is
    // baked into config or code." Kept as tenant identity columns (not app_setting rows) because
    // they identify the legal entity, not a configurable behaviour.
    ntnNo: varchar("ntn_no", { length: 24 }),
    strnNo: varchar("strn_no", { length: 24 }),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_tenant_code").on(table.code),
    activeIdx: index("ix_tenant_active").on(table.isActive, table.name),
  }),
);

/**
 * A physical/operational site belonging to one tenant. R6: "each with their own branches,
 * isolated data, and admin." Modelled on the same "day-one-even-if-unused" principle
 * 19-mysql-schema-blueprint.md §T21 `warehouse` documents for the legacy's single-godown reality
 * ("every stock table is keyed by warehouse_id from day one even though only one row exists, so
 * enabling a second location is data entry, not a migration") -- D16 asks for exactly that, one
 * level up: every tenant starts with one branch, and adding a second is data entry.
 *
 * // TODO(blueprint): 00b-owner-decisions-and-requirements.md R6 does not specify whether
 * // `branch` and 19-mysql-schema-blueprint.md §T21 `warehouse` (physical stock location) are the
 * // same concept or two levels (e.g. a branch with multiple stock rooms). This package treats a
 * // branch as the unit both organisational scoping (D16) and physical stock (R4's stock_lot,
 * // see catalog.ts) key off, matching the legacy's single Godown-per-site reality. Revisit if a
 * // future module needs multiple warehouses per branch.
 */
export const branches = mysqlTable(
  "branch",
  {
    branchId: idPk("branch_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    nameUr: varchar("name_ur", { length: 160 }),
    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    city: varchar("city", { length: 80 }),
    // U-062/D18/R7 (docs/system-analysis/00b-owner-decisions-and-requirements.md): a drug-sale
    // licence under the Drugs Act 1976 is issued per physical premises, so this lives on `branch`
    // (the physical/operational site -- see this table's own header comment), mirroring D17's
    // ntnNo/strnNo pattern on `tenant` exactly: an admin-editable identity field, nullable because
    // most tenants have not entered it yet, never a value baked into config or code. Whether DRAP
    // requires this AT ALL for a retail dispensing pharmacy (vs. purely upstream manufacturers) is
    // still open pending pharmacist/regulatory consultant sign-off (R7) -- these two columns exist
    // so the record CAN be kept once that's confirmed; nothing downstream assumes they are filled.
    drugSaleLicenceNo: varchar("drug_sale_licence_no", { length: 64 }),
    drugLicenceExpiryDate: date("drug_licence_expiry_date"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    // Blueprint §4.3 functional-unique-index pattern ("exactly one default per group"), applied
    // here per-tenant instead of per-option-list: at most one default branch per tenant. NULL
    // when this branch is not the default (MySQL UNIQUE allows unlimited NULLs), otherwise the
    // owning tenant_id -- so a second `is_default = 1` row for the same tenant collides on this
    // generated column and is rejected by the engine, exactly like §4.3's raw functional index,
    // without relying on drizzle-kit's `.on(sql\`...\`)` renderer (which mis-renders SQL
    // fragments containing commas -- see catalog.ts stockLots for the same fix applied to §T56).
    defaultTenantKey: fkBigInt("default_tenant_key").generatedAlwaysAs(
      sql`if(\`is_default\` = 1, \`tenant_id\`, null)`,
      { mode: "stored" },
    ),
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_branch_tenant_code").on(table.tenantId, table.code),
    activeIdx: index("ix_branch_tenant_active").on(table.tenantId, table.isActive),
    defaultUnique: uniqueIndex("uk_branch_tenant_default").on(table.defaultTenantKey),
  }),
);
