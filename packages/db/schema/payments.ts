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
  int,
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
import { appUsers } from "./identity";
import { glAccounts, journalLines } from "./ledger";
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
 * Wave 10d (`/cash-bank/reconciliations`, R2.3 -- this file's own §T90 comment already names "R2.4
 * daily reconciliation" as the reason cash_bank_account is 1:1 with gl_account). One header row
 * per statement reconciliation attempt. `differenceAmount`/`completedAt` are NULL until
 * `POST .../complete` -- this wave only completes a reconciliation when the difference is exactly
 * zero (an `adjustments[]` sub-step that would post a NEW, never-before-modelled GL rule for an
 * unexplained bank difference is deliberately NOT built -- same "don't invent a contra account"
 * discipline `sale-invoices.service.ts`'s own discount 422 already establishes; see
 * cash-bank-reconciliation.service.ts's header comment).
 */
export const cashBankReconciliations = mysqlTable(
  "cash_bank_reconciliation",
  {
    reconciliationId: idPk("reconciliation_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    cashBankAccountId: fkBigIntNotNull("cash_bank_account_id"),
    statementDate: date("statement_date").notNull(),
    statementClosingBalance: decimal("statement_closing_balance", DOCUMENT_AMOUNT).notNull(),
    status: mysqlEnum("status", ["open", "completed"]).notNull().default("open"),
    differenceAmount: decimal("difference_amount", DOCUMENT_AMOUNT),
    reason: varchar("reason", { length: 500 }),
    completedAt: datetime("completed_at", { fsp: TIMESTAMP_FSP }),
    completedBy: fkBigInt("completed_by"),
    ...auditColumns(),
  },
  (table) => ({
    accountIdx: index("ix_cash_bank_recon_account").on(table.cashBankAccountId, table.statementDate),
    accountFk: foreignKey({
      name: "fk_cash_bank_recon_account",
      columns: [table.cashBankAccountId],
      foreignColumns: [cashBankAccounts.cashBankAccountId],
    }),
  }),
);

/**
 * Join table: which append-only `journal_line` rows a reconciliation matched against the bank
 * statement. Never mutates `journal_line` itself (ledger.ts's own append-only convention) --
 * match state lives entirely here. A `journal_line` can only ever belong to ONE reconciliation
 * (`uk_recon_match_line`) -- once matched by a completed reconciliation it is permanently
 * accounted for; a still-open (never completed) reconciliation's matches don't block a future
 * reconciliation from also proposing the same line (only COMPLETED matches are excluded from a
 * new reconciliation's candidate list -- see the service's own `unreconciledLines` query).
 */
export const cashBankReconciliationMatches = mysqlTable(
  "cash_bank_reconciliation_match",
  {
    reconciliationId: fkBigIntNotNull("reconciliation_id"),
    journalLineId: fkBigIntNotNull("journal_line_id"),
    matchedAt: datetime("matched_at", { fsp: TIMESTAMP_FSP }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => ({
    pk: uniqueIndex("uk_recon_match_line").on(table.reconciliationId, table.journalLineId),
    lineIdx: index("ix_recon_match_line").on(table.journalLineId),
    reconFk: foreignKey({
      name: "fk_recon_match_reconciliation",
      columns: [table.reconciliationId],
      foreignColumns: [cashBankReconciliations.reconciliationId],
    }),
    lineFk: foreignKey({
      name: "fk_recon_match_journal_line",
      columns: [table.journalLineId],
      foreignColumns: [journalLines.journalLineId],
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

/**
 * §T100/T101 `cashier_shift` / `cashier_shift_count` -- R2.4, the till/cashier-session lifecycle
 * (open -> blind denomination count -> close -> supervisor approve), plus a read-only z-report.
 * Dormant in the legacy system (0 rows, `06` §3.6) -- activated, not reinvented, per R2.4/AC-5;
 * R-049 forbids porting the vendor code, so every column below is a fresh design against the
 * blueprint's own T100/T101 DDL, adapted to this package's conventions (own idPk, DOCUMENT_AMOUNT
 * instead of the blueprint's literal DECIMAL(18,4) -- same file-wide deviation this file's own
 * header comment already documents for every other money column here).
 *
 * RS-3 (`19` §15 / `20`'s own "hard precondition" language): "no R2 code is written until the
 * accountant has signed the debit/credit rules for every new posting" -- covers supplier payment,
 * expense, cash/bank transfer, AND cashier variance (`19` §14 V-2). Wave 5 already resolved this
 * for payment/expense/transfer by deriving their GL legs from ALREADY-EXISTING account bindings
 * (supplier.glAccountId, cashBankAccount.glAccountId -- no invented rule). The cashier-variance
 * leg has no such existing binding to derive from: the blueprint's own `variance_account_id`
 * column defaults from `gl_account_binding['cashier_variance']`, and `gl_account_binding` (T89)
 * itself has never been built anywhere in this rebuild (grep-confirmed zero references across
 * packages/db/schema). Building a brand-new generic account-binding config table AND guessing
 * which real account 'cashier_variance' should point at, with no sign-off, is exactly the risk
 * RS-3 exists to prevent -- same "don't invent a contra account" discipline
 * cash-bank-reconciliation.service.ts's own header comment already establishes for an analogous
 * gap. This wave therefore builds the FULL shift lifecycle and computes/persists the variance
 * honestly, but never posts a GL journal entry for it -- `varianceAccountId`/`journalEntryId` stay
 * in the schema (matching the blueprint, ready for a future wave once V-2 is signed) but are never
 * populated by this wave's service; see cashier-shift.service.ts's own header comment.
 *
 * Shift attribution to sales/returns/expenses (the z-report's own salesByMethod[]/expensesPaid
 * breakdown) is derived from `cashBankAccountId` + the shift's own [openedAt, closedAt-or-now)
 * time window against `journal_line`/`sale_invoice_payment`, NOT a new `cashier_shift_id` FK
 * retrofitted onto `sale_invoice`/`expense` -- sales.ts's own `cashier_shift_id`
 * TODO(blueprint) comment anticipated exactly this column, but adding it would touch the
 * already-shipped, heavily-tested sale-invoice creation path for a value this derivation can
 * compute without it; left deferred for a future wave that wants hard per-invoice attribution
 * rather than a time-window derivation.
 */
export const cashierShifts = mysqlTable(
  "cashier_shift",
  {
    cashierShiftId: idPk("cashier_shift_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId),
    docNumber: varchar("doc_number", { length: 32 }).notNull(),
    docSeriesId: fkBigIntNotNull("doc_series_id"),
    documentTypeId: fkBigIntNotNull("document_type_id"),
    userId: fkBigIntNotNull("user_id").references(() => appUsers.userId), // the cashier
    // Plain column, explicit FK below -- mirrors cashBankAccounts.glAccountId's own reasoning
    // (auto-generated name risk near MySQL's 64-char limit once table/column names compound).
    cashBankAccountId: fkBigIntNotNull("cash_bank_account_id"),
    openedAt: datetime("opened_at", { fsp: TIMESTAMP_FSP }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    closedAt: datetime("closed_at", { fsp: TIMESTAMP_FSP }),
    openingFloatAmount: decimal("opening_float_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    // Persisted at count() time (not deferred to close()) -- the blind-count response
    // (countedTotal/expectedCash/variance) IS this pair, so close() just requires they're already set.
    expectedCashAmount: decimal("expected_cash_amount", DOCUMENT_AMOUNT),
    countedCashAmount: decimal("counted_cash_amount", DOCUMENT_AMOUNT),
    varianceAmount: decimal("variance_amount", DOCUMENT_AMOUNT).generatedAlwaysAs(
      sql`\`counted_cash_amount\` - \`expected_cash_amount\``,
      { mode: "stored" },
    ),
    varianceReason: varchar("variance_reason", { length: 500 }),
    // Never populated this wave -- see class comment (RS-3 / gl_account_binding gap).
    varianceAccountId: fkBigInt("variance_account_id"),
    status: mysqlEnum("status", ["open", "closed", "approved"]).notNull().default("open"),
    approvedBy: fkBigInt("approved_by").references(() => appUsers.userId),
    approvedAt: datetime("approved_at", { fsp: TIMESTAMP_FSP }),
    // Never populated this wave -- see class comment.
    journalEntryId: fkBigInt("journal_entry_id"),
    ...auditColumns(),
  },
  (table) => ({
    docNumberUnique: uniqueIndex("uk_cashier_shift_doc_number").on(table.tenantId, table.docNumber),
    // "No other open shift for this user+till" (18-api-plan.md's own POST /cashier-shifts row) --
    // a real partial unique index would need a functional/filtered form Drizzle 0.36 can't express
    // (same class of gap this file's own cashBankAccounts header comment already documents for
    // uk_cash_bank_default); enforced at the service layer instead, this index just makes the
    // lookup itself efficient.
    openShiftIdx: index("ix_cashier_shift_open").on(table.userId, table.cashBankAccountId, table.status),
    accountIdx: index("ix_cashier_shift_account").on(table.cashBankAccountId, table.openedAt),
    cashBankFk: foreignKey({
      name: "fk_cashier_shift_cash_bank_account",
      columns: [table.cashBankAccountId],
      foreignColumns: [cashBankAccounts.cashBankAccountId],
    }),
  }),
);

export const cashierShiftCounts = mysqlTable(
  "cashier_shift_count",
  {
    countId: idPk("count_id"),
    cashierShiftId: fkBigIntNotNull("cashier_shift_id"),
    denominationAmount: decimal("denomination_amount", DOCUMENT_AMOUNT).notNull(),
    denominationCount: int("denomination_count", { unsigned: true }).notNull(),
    lineTotal: decimal("line_total", DOCUMENT_AMOUNT).generatedAlwaysAs(
      sql`\`denomination_amount\` * \`denomination_count\``,
      { mode: "stored" },
    ),
    countedAt: datetime("counted_at", { fsp: TIMESTAMP_FSP }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    countedBy: fkBigInt("counted_by").references(() => appUsers.userId),
  },
  (table) => ({
    // §T101's uk_shift_count -- one row per denomination value per shift; count() replaces the
    // whole set (delete-then-insert), mirroring role_scope's own PUT replace semantics.
    denomUnique: uniqueIndex("uk_shift_count").on(table.cashierShiftId, table.denominationAmount),
    shiftFk: foreignKey({
      name: "fk_shift_count_cashier_shift",
      columns: [table.cashierShiftId],
      foreignColumns: [cashierShifts.cashierShiftId],
    }),
  }),
);
