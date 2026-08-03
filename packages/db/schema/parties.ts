// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md Module D "Parties" -- §T26
// `supplier`, §T28 `customer`, §T30 `salesman`; docs/system-analysis/00b-owner-decisions-and-
// requirements.md D5 (walk-in cash model -- no AR subledger built, credit machinery kept),
// D16/R6 (tenant scoping) and P1 (option lists, R1.9 one visibility model across master data).
//
// Module D's design decision, carried from the legacy model and made safe: in WASEELA,
// `Customer.CustCode`/`Supplier.SuppCode` are simultaneously the PKs of their own tables AND
// foreign keys into `Accounts.AccCode` -- a party *is* a ledger account (06 §3.4, §4.4 R6,
// Verified). That identity is preserved explicitly: each party row carries a mandatory
// `gl_account_id` FK to its own control account, made UNIQUE so exactly one party owns one
// control account, instead of sharing an identifier space across three tables with no
// cross-table uniqueness enforcement.
//
// Scope note: §T27 `supplier_bank_account` is deliberately deferred (task instruction) -- it
// belongs with the R2.1 supplier-payments module. §T29 `manufacturer` lives with the catalog-
// support module (see catalog.ts's TODO), not here.
//
// Precision note: the blueprint's §T28 `credit_limit_amount DECIMAL(18,4)` and §T30
// `commission_percent DECIMAL(9,4)` widths are NOT copied verbatim -- this package standardises
// on the archetypes in schema/_shared.ts (17-technical-blueprint.md §6.2 reconciled against
// packages/money): DOCUMENT_AMOUNT (15,2) for money totals, PERCENT (9,4) for percentages. See
// _shared.ts's header block for why the package deviates deliberately from §19's 18,x widths.
import {
  boolean,
  decimal,
  index,
  mysqlTable,
  smallint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { auditColumns, DOCUMENT_AMOUNT, fkBigInt, fkBigIntNotNull, idPk, lkColumns, PERCENT, softDeleteColumns } from "./_shared";
import { glAccounts } from "./ledger";
import { tenants } from "./tenant";

/**
 * §T26 `supplier`. Legacy holds 235 supplier control accounts under SUPPLIERS/CREDITORS, 112 with
 * activity (00b F1, Verified). Tenant-scoped like the rest of the master data (D16), so every
 * blueprint UNIQUE (code, name) becomes tenant-prefixed here.
 */
export const suppliers = mysqlTable(
  "supplier",
  {
    supplierId: idPk("supplier_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    code: varchar("code", { length: 32 }).notNull(), // user-facing supplier code
    name: varchar("name", { length: 160 }).notNull(),
    nameUr: varchar("name_ur", { length: 160 }),
    // The supplier's control account under SUPPLIERS/CREDITORS -- mandatory and UNIQUE (one
    // control account per supplier), the safe replacement for the legacy shared-PK identity.
    glAccountId: fkBigIntNotNull("gl_account_id").references(() => glAccounts.glAccountId),
    // Soft reference -> option_item (P1 option list `supplier_category`) -- same soft-ref
    // reasoning as _shared.ts docColumns' cancelReasonId; the consuming module enforces list
    // membership at the service layer.
    supplierCategoryId: fkBigInt("supplier_category_id"),
    ntnNo: varchar("ntn_no", { length: 24 }), // Pakistan tax registration
    strnNo: varchar("strn_no", { length: 24 }), // sales-tax registration
    cnicNo: varchar("cnic_no", { length: 20 }),
    // TODO(blueprint): §T26 `tax_category_id` (FK -> tax_category, filer/non-filer withholding
    // band) and `default_payment_method_id` (FK -> payment_method, P1.2) are deferred with their
    // owning tax/payments modules -- omitted rather than left as dangling untyped columns, same
    // policy as catalog.ts items.
    phone: varchar("phone", { length: 32 }),
    mobile: varchar("mobile", { length: 32 }),
    email: varchar("email", { length: 190 }),
    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    city: varchar("city", { length: 80 }),
    creditDays: smallint("credit_days", { unsigned: true }), // legacy ItemSuppliers.days is lead time, not credit -- kept distinct
    leadTimeDays: smallint("lead_time_days", { unsigned: true }),
    specialInstructions: varchar("special_instructions", { length: 4000 }), // legacy Supplier.SpecialInstructions retained
    isActive: boolean("is_active").notNull().default(true), // R1.9 -- one visibility model across all master data
    legacyId: varchar("legacy_id", { length: 16 }), // legacy Supplier.SuppCode
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_supplier_tenant_code").on(table.tenantId, table.code),
    nameUnique: uniqueIndex("uk_supplier_tenant_name").on(table.tenantId, table.name),
    accountUnique: uniqueIndex("uk_supplier_account").on(table.glAccountId), // one control account per supplier
    legacyUnique: uniqueIndex("uk_supplier_legacy").on(table.legacyId),
    activeIdx: index("ix_supplier_tenant_active").on(table.tenantId, table.isActive, table.name),
  }),
);

/**
 * §T28 `customer`. Legacy `Customer` holds 2 rows in 82 columns (19 = RETAIL SALE CUSTOMER,
 * 22 = WHOLE SALE CUSTOMER) against 291,361 invoices -- the walk-in cash model (D5, Verified).
 * Same shape as `supplier` minus supplier-specific fields (lead time, special instructions),
 * plus `is_walk_in` and the credit columns. No AR subledger is built (D5); the schema still
 * supports credit sales because that machinery exists for supplier payments anyway, and whether
 * to expose credit sales in the UI is an admin switch (P1), defaulted off.
 *
 * ntn/cnic/phone are nullable by evidence, not laziness: the FBR JSON currently sends empty
 * BuyerNTN/BuyerCNIC/BuyerPhoneNumber for every invoice because both legacy customer rows have
 * them null (11 §1.3, Verified).
 */
export const customers = mysqlTable(
  "customer",
  {
    customerId: idPk("customer_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    nameUr: varchar("name_ur", { length: 160 }),
    // Mandatory + UNIQUE control account, mirror of supplier.glAccountId (Module D decision).
    glAccountId: fkBigIntNotNull("gl_account_id").references(() => glAccounts.glAccountId),
    // Soft reference -> option_item (P1 option list `customer_category`).
    customerCategoryId: fkBigInt("customer_category_id"),
    isWalkIn: boolean("is_walk_in").notNull().default(false), // D5: the two seeded walk-in rows carry this flag
    creditLimitAmount: decimal("credit_limit_amount", DOCUMENT_AMOUNT), // DOCUMENT_AMOUNT, not §T28's DECIMAL(18,4) -- see header precision note
    creditDays: smallint("credit_days", { unsigned: true }),
    ntnNo: varchar("ntn_no", { length: 24 }),
    strnNo: varchar("strn_no", { length: 24 }),
    cnicNo: varchar("cnic_no", { length: 20 }),
    // TODO(blueprint): tax_category_id / default_payment_method_id deferred -- see the matching
    // TODO on suppliers above.
    phone: varchar("phone", { length: 32 }),
    mobile: varchar("mobile", { length: 32 }),
    email: varchar("email", { length: 190 }),
    addressLine1: varchar("address_line1", { length: 255 }),
    addressLine2: varchar("address_line2", { length: 255 }),
    city: varchar("city", { length: 80 }),
    isActive: boolean("is_active").notNull().default(true), // R1.9
    legacyId: varchar("legacy_id", { length: 16 }), // legacy Customer.CustCode
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_customer_tenant_code").on(table.tenantId, table.code),
    nameUnique: uniqueIndex("uk_customer_tenant_name").on(table.tenantId, table.name),
    accountUnique: uniqueIndex("uk_customer_account").on(table.glAccountId), // one control account per customer
    legacyUnique: uniqueIndex("uk_customer_legacy").on(table.legacyId),
    activeIdx: index("ix_customer_tenant_active").on(table.tenantId, table.isActive, table.name),
  }),
);

/**
 * §T30 `salesman` -- pack LK (behavioural lookup, _shared.ts lkColumns) plus the link that
 * resolves a real legacy defect: `SaleLedger` carries two different salesman notions on the same
 * table (`SManCode`/`deliveredby` -> SalesMan.SalesManCode, `SalesmanCode` -> Users.UserCode --
 * 06 §4.2, Verified). In the target there is exactly one seller dimension
 * (`sale_invoice.salesman_id`) plus the operator (`created_by`), and `salesman.user_id` links the
 * two when a staff member sells under their own login.
 */
export const salesmen = mysqlTable(
  "salesman",
  {
    salesmanId: idPk("salesman_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    // lkColumns supplies code/name/description + P1 isEnabled/isDefault/sortOrder + AP + SD.
    ...lkColumns(),
    // Soft reference -> app_user.user_id (identity.ts) -- kept soft for the same reason
    // _shared.ts auditColumns leaves created_by soft; nullable because not every salesman has a
    // login (§T30: BIGINT UNSIGNED NULL).
    userId: fkBigInt("user_id"),
    // PERCENT archetype (9,4) -- coincidentally identical to §T30's DECIMAL(9,4), but sourced
    // from _shared.ts so packages/money Percent.toDb() round-trips losslessly.
    commissionPercent: decimal("commission_percent", PERCENT),
    legacyId: varchar("legacy_id", { length: 16 }), // legacy SalesMan.SalesManCode
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_salesman_tenant_code").on(table.tenantId, table.code),
    legacyUnique: uniqueIndex("uk_salesman_legacy").on(table.legacyId),
    enabledIdx: index("ix_salesman_tenant_enabled").on(table.tenantId, table.isEnabled, table.name),
    userIdx: index("ix_salesman_user").on(table.userId),
  }),
);
