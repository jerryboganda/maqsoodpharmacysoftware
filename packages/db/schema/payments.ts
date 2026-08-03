// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T94 (`payment_method`,
// options-as-data per P1/D9), §T90 (`cash_bank_account`, the 1:1 money-holding extension of
// `gl_account` enabling R2.3 cash/bank book and R2.4 reconciliation), §T95 (`payment` -- R2.1,
// "this table does not exist in any form in the legacy system": suppliers credited 186,197,682
// and debited only 3,526,552, every debit a purchase return, never a payment -- 00b F1.1,
// Verified, Critical) and §T96 (`payment_allocation` -- partial allocations first-class).
//
// Precision deviation (deliberate, package-wide): every amount column here uses the
// DOCUMENT_AMOUNT archetype DECIMAL(15,2) from _shared.ts, NOT the blueprint's DECIMAL(18,4) --
// this package standardises on 17-technical-blueprint.md §6.2's archetypes, which is what
// packages/money/src/Money.ts (`Money.SCALE = 2`) actually round-trips. See the block comment
// above DOCUMENT_AMOUNT in _shared.ts for the full reconciliation of 17§6.2 vs 19§3.1.
//
// CHECK constraints: drizzle-orm 0.36's `check()` builder is used below to mirror ledger.ts,
// but drizzle-kit's MySQL dialect does not reliably emit CHECK clauses -- per the package's
// documented generate -> hand-review -> commit flow (§5.4), verify (and hand-add if missing)
// ck_payment_amount / ck_payment_alloc / ck_alloc_amount in the generated migration SQL.
// §T95's ck_payment_party ("exactly one party reference consistent with party_kind") is a
// multi-column conditional that is enforced at the service layer and hand-added to the
// migration; it is not expressed here.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  datetime,
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
  appendOnlyAuditColumns,
  auditColumns,
  docColumns,
  DOCUMENT_AMOUNT,
  fkBigInt,
  fkBigIntNotNull,
  idPk,
  lkColumns,
  TIMESTAMP_FSP,
} from "./_shared";
import { documentTypes } from "./docflow";
import { glAccounts } from "./ledger";
import { branches, tenants } from "./tenant";

/**
 * §T90 `cash_bank_account` -- 1:1 extension of `gl_account` for accounts that hold money
 * (R2.3 cash and bank book, R2.4 daily reconciliation). Legacy sub-account CASH AT BANK has
 * zero leaf accounts and zero GL entries in 19 months (00b F1, 07 §2.4, Verified).
 *
 * Defined BEFORE payment_method so that payment_method.default_cash_bank_account_id can carry a
 * real DB-enforced FK instead of a soft reference -- the dependency is one-way (nothing here
 * points back at payment_method), so ordering the declarations resolves what would otherwise be
 * a circular import problem.
 *
 * Deviations from §T90's literal DDL:
 *   - Own surrogate `cash_bank_account_id` PK (package S7 standardisation, _shared.ts) instead
 *     of §T90's "gl_account_id PK FK"; the 1:1 relationship is preserved by the UNIQUE FK on
 *     glAccountId.
 *   - §T90's `warehouse_id` is `branch_id` (see tenant.ts branches TODO -- no warehouse table).
 *   - §T90's functional unique `uk_cash_bank_default ((IF(is_default_for_sales=1,1,NULL)))`
 *     cannot be expressed through drizzle 0.36's uniqueIndex builder (and would need a tenant
 *     dimension anyway) -- "at most one default-for-sales account per tenant" is enforced at
 *     the service layer and the functional index hand-added to the generated migration.
 */
export const cashBankAccounts = mysqlTable(
  "cash_bank_account",
  {
    cashBankAccountId: idPk("cash_bank_account_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    // Plain column, explicit FK below -- Drizzle's auto name
    // (`cash_bank_account_gl_account_id_gl_account_gl_account_id_fk`) is near MySQL's 64-char
    // identifier limit; keep it short and stable instead.
    glAccountId: fkBigIntNotNull("gl_account_id"),
    accountKind: mysqlEnum("account_kind", [
      "cash_drawer",
      "petty_cash",
      "bank",
      "mobile_wallet",
      "card_settlement",
    ]).notNull(),
    bankName: varchar("bank_name", { length: 120 }),
    branchName: varchar("branch_name", { length: 120 }),
    accountNo: varchar("account_no", { length: 34 }), // as_cs collation hand-added to migration (see _shared.ts KNOWN GAP)
    iban: varchar("iban", { length: 34 }), // as_cs collation hand-added to migration
    branchId: fkBigInt("branch_id").references(() => branches.branchId), // §T90 warehouse_id
    // D10/R3.1: defaults to 0.00 for every account; the zero/manual/imported choice is recorded
    // in opening_balance_decision (§T102, out of scope for this file).
    openingBalanceAmount: decimal("opening_balance_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    openingBalanceDate: date("opening_balance_date"),
    allowNegative: boolean("allow_negative").notNull().default(false),
    isDefaultForSales: boolean("is_default_for_sales").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns(),
  },
  (table) => ({
    glAccountUnique: uniqueIndex("uk_cash_bank_gl_account").on(table.glAccountId), // the 1:1 with gl_account
    kindIdx: index("ix_cash_bank_kind").on(table.tenantId, table.accountKind, table.isActive),
    glAccountFk: foreignKey({
      name: "fk_cash_bank_gl_account",
      columns: [table.glAccountId],
      foreignColumns: [glAccounts.glAccountId],
    }),
  }),
);

/**
 * §T94 `payment_method` -- "the direct implementation of decision D9, 'add all options for the
 * respective user to select from'". Pack LK plus the behavioural columns below. Seeded exactly
 * from the P1 options table in 00b: Cash (default) · Bank transfer · Cheque · Bank draft/pay
 * order · Online transfer IBFT · Mobile wallet Easypaisa · Mobile wallet JazzCash · Credit-note
 * adjustment · Other (free text). Disabling hides but never deletes (P1.3) -- lkColumns()
 * carries is_enabled + the SD pack.
 */
export const paymentMethods = mysqlTable(
  "payment_method",
  {
    paymentMethodId: idPk("payment_method_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    ...lkColumns(),
    directionAllowed: mysqlEnum("direction_allowed", ["in", "out", "both"]).notNull().default("both"),
    // Real FK (declared below with an explicit short name -- the auto-generated one would exceed
    // MySQL's 64-char limit). Hard reference is safe because cashBankAccounts is declared above
    // in this same file -- see its class comment on declaration ordering.
    defaultCashBankAccountId: fkBigInt("default_cash_bank_account_id"),
    requiresReference: boolean("requires_reference").notNull().default(false), // cheque no, IBFT ref, wallet txn id
    requiresBankAccount: boolean("requires_bank_account").notNull().default(false),
    requiresChequeDetails: boolean("requires_cheque_details").notNull().default(false),
    settlementLagDays: smallint("settlement_lag_days", { unsigned: true }).notNull().default(0), // card/cheque clearing
    isCounterMethod: boolean("is_counter_method").notNull().default(false), // P1.5 -- cashiers see counter methods only
    minPermissionId: fkBigInt("min_permission_id"), // soft ref -> permission (access module) -- avoids a hard cross-module coupling for an optional gate
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_payment_method_tenant_code").on(table.tenantId, table.code),
    defaultAccountFk: foreignKey({
      name: "fk_payment_method_default_cba",
      columns: [table.defaultCashBankAccountId],
      foreignColumns: [cashBankAccounts.cashBankAccountId],
    }),
  }),
);

/**
 * §T95 `payment` -- R2.1, money actually leaving or entering the business. Pack DOC plus its own
 * PK and tenant/branch scoping per the package rule (_shared.ts docColumns comment).
 *
 * Posts `Dr Supplier / Cr Cash-or-Bank` exactly as R2.1 specifies -- but §T95: "the debit and
 * credit rules for every new R2 posting require accountant sign-off before implementation
 * (R2.8, §14 V-2)."
 *
 * Deferred columns (TODO(blueprint)): §T95's `supplier_bank_account_id` (needs the supplier
 * bank-accounts table, parties module) and `attachment_id` (needs the attachment table -- the
 * optional receipt photo R2.1 requires). Add both when those modules exist.
 */
export const payments = mysqlTable(
  "payment",
  {
    paymentId: idPk("payment_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId),
    ...docColumns(),
    direction: mysqlEnum("direction", ["out", "in"]).notNull(), // out = we paid; in = we received
    partyKind: mysqlEnum("party_kind", ["supplier", "customer", "employee", "other"]).notNull().default("supplier"),
    supplierId: fkBigInt("supplier_id"), // soft ref -> supplier/customer (parties.ts)
    customerId: fkBigInt("customer_id"), // soft ref -> supplier/customer (parties.ts)
    otherPartyName: varchar("other_party_name", { length: 160 }), // for party_kind = 'other'
    paymentMethodId: fkBigIntNotNull("payment_method_id").references(() => paymentMethods.paymentMethodId),
    // Plain column, explicit FK below (auto name is 71 chars, over MySQL's 64-char limit).
    cashBankAccountId: fkBigIntNotNull("cash_bank_account_id"), // paid from / received into
    amount: decimal("amount", DOCUMENT_AMOUNT).notNull(),
    allocatedAmount: decimal("allocated_amount", DOCUMENT_AMOUNT).notNull().default("0.00"), // Σ payment_allocation
    // §T95: the on-account balance, GENERATED STORED so ix_payment_open below can index it --
    // same generatedAlwaysAs(stored) pattern as catalog.ts stockLots.batchKey.
    unallocatedAmount: decimal("unallocated_amount", DOCUMENT_AMOUNT)
      .generatedAlwaysAs(sql`\`amount\` - \`allocated_amount\``, { mode: "stored" })
      .notNull(),
    allocationMode: mysqlEnum("allocation_mode", ["specific", "oldest_first", "on_account"])
      .notNull()
      .default("oldest_first"), // P1 option, default oldest-first exactly as R2.1 specifies
    referenceNo: varchar("reference_no", { length: 64 }), // as_cs collation hand-added to migration
    chequeNo: varchar("cheque_no", { length: 32 }),
    chequeDate: date("cheque_date"),
    chequeStatus: mysqlEnum("cheque_status", ["issued", "presented", "cleared", "bounced", "cancelled"]),
    // TODO(blueprint): §T95 supplier_bank_account_id + attachment_id deferred -- see class comment.
    journalEntryId: fkBigInt("journal_entry_id"), // soft ref -> journal_entry (ledger.ts) -- kept soft to match docColumns' posting-refs convention; UNIQUE below = one posting per payment
  },
  (table) => ({
    docNumberUnique: uniqueIndex("uk_payment_tenant_doc_number").on(table.tenantId, table.docNumber),
    journalUnique: uniqueIndex("uk_payment_journal_entry").on(table.journalEntryId),
    supplierIdx: index("ix_payment_supplier").on(table.tenantId, table.supplierId, table.postingDate),
    customerIdx: index("ix_payment_customer").on(table.tenantId, table.customerId, table.postingDate),
    accountIdx: index("ix_payment_account").on(table.cashBankAccountId, table.postingDate),
    openIdx: index("ix_payment_open").on(table.tenantId, table.partyKind, table.unallocatedAmount),
    chequeIdx: index("ix_payment_cheque").on(table.chequeStatus, table.chequeDate),
    cashBankFk: foreignKey({
      name: "fk_payment_cash_bank_account",
      columns: [table.cashBankAccountId],
      foreignColumns: [cashBankAccounts.cashBankAccountId],
    }),
    // Hand-verify emission in the generated migration -- see header comment.
    amountCheck: check("ck_payment_amount", sql`${table.amount} > 0`),
    allocCheck: check(
      "ck_payment_alloc",
      sql`${table.allocatedAmount} >= 0 and ${table.allocatedAmount} <= ${table.amount}`,
    ),
    // §T95 ck_payment_party (exactly one party reference consistent with party_kind): service
    // layer + hand-added migration SQL -- see header comment.
  }),
);

/**
 * §T96 `payment_allocation` -- "partial allocations are first-class: one payment can settle many
 * invoices, one invoice can be settled by many payments, and the remainder sits as
 * unallocated_amount on the payment. Reallocation is a reversal plus a new row -- never an
 * in-place edit." Append-only per §T57/T59 grouping in _shared.ts: appendOnlyAuditColumns(),
 * no updated_* and no row_version (BEFORE UPDATE/DELETE triggers hand-added to migration SQL).
 *
 * `target_document_id` is deliberately unconstrained (polymorphic across sale_invoice /
 * purchase_invoice / returns, discriminated by target_document_type_id).
 */
export const paymentAllocations = mysqlTable(
  "payment_allocation",
  {
    paymentAllocationId: idPk("payment_allocation_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId), // denormalised -- D16 isolation defence-in-depth
    paymentId: fkBigIntNotNull("payment_id").references(() => payments.paymentId),
    // Plain column, explicit FK below (auto name would be 77 chars, over the 64-char limit).
    targetDocumentTypeId: fkBigIntNotNull("target_document_type_id"),
    targetDocumentId: fkBigIntNotNull("target_document_id"), // polymorphic -- see class comment
    allocatedAmount: decimal("allocated_amount", DOCUMENT_AMOUNT).notNull(),
    allocatedAt: datetime("allocated_at", { fsp: TIMESTAMP_FSP }).notNull(),
    allocatedBy: fkBigInt("allocated_by"), // soft ref -> app_user (auditColumns convention, _shared.ts)
    isAuto: boolean("is_auto").notNull().default(false), // oldest-first auto-allocation vs manual pick
    reversedAt: datetime("reversed_at", { fsp: TIMESTAMP_FSP }),
    reversalOfId: fkBigInt("reversal_of_id"), // self-reference, soft (same-table FK)
    ...appendOnlyAuditColumns(),
  },
  (table) => ({
    allocUnique: uniqueIndex("uk_payment_alloc").on(table.paymentId, table.targetDocumentTypeId, table.targetDocumentId),
    targetIdx: index("ix_alloc_target").on(table.targetDocumentTypeId, table.targetDocumentId),
    targetTypeFk: foreignKey({
      name: "fk_payment_alloc_doc_type",
      columns: [table.targetDocumentTypeId],
      foreignColumns: [documentTypes.documentTypeId],
    }),
    // Hand-verify emission in the generated migration -- see header comment.
    amountCheck: check("ck_alloc_amount", sql`${table.allocatedAmount} > 0`),
  }),
);
