// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.2 "Module `payments` -- expenses"
// (R2.2) and its seeding note (§2.4/§07 -- 9 of 29 legacy sub-accounts, including MARKETING
// EXPENSES and all three PAYROLL sub-accounts, have zero leaf accounts and R2 requires real leaf
// accounts at seeding); docs/system-analysis/00b-owner-decisions-and-requirements.md F1 (the
// legacy GL has never recorded a single expense in 19 months, Critical).
//
// Wave 5 "lay the shared foundation" package -- this file is schema-only. The posting service
// (Dr expense_line.expenseCategoryId.glAccountId / Cr expense.cashBankAccountId, allocated via
// DocNumberService + posted via JournalService) is built by the follow-up `expenses` module
// agent, not here (see apps/api/src/modules/expenses/expenses.module.ts).
//
// §5.2's explicit binding, satisfied here exactly like `expense_category.gl_account_id`
// (adjustment_reason's own fix, inventory.ts): "glAccountId NOT NULL and postable -- this is the
// same fix as adjustment_reason, and it is why the legacy adjustments could never post."
//
// Deliberate shape deviation (documented, not silent): `expense` does NOT spread the full DOC
// pack (_shared.ts docColumns()) the way `payment` (payments.ts) and every purchasing/sales
// document does -- no docSeriesId/documentTypeId/fiscalPeriodId/cancelledAt/cancelledBy/
// cancelReasonId/notes/machineName/legacyId, and a narrower 4-state status enum (no `confirmed`,
// this module has no draft-then-confirm workflow). This is the exact column set the Wave 5 task
// spec calls out by name for this table. Concretely: the posting service can and should still
// call FiscalPeriodService.resolveOpenPeriod(tx, tenantId, expenseDate) for period-lock
// VALIDATION exactly like every other posting flow -- it just has nowhere on this row to persist
// the resulting fiscalPeriodId. Flagged for the follow-up `expenses` agent / a future reviewer to
// reconcile with the docColumns() convention if that gap turns out to matter in practice (period
// close reporting needs it eventually); not resolved unilaterally here since three follow-up
// agents are relying on this exact, pre-agreed shape.
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
import { auditColumns, DOCUMENT_AMOUNT, fkBigInt, fkBigIntNotNull, idPk, lkColumns, TIMESTAMP_FSP } from "./_shared";
import { cashBankAccounts } from "./payments";
import { glAccounts } from "./ledger";
import { branches, tenants } from "./tenant";

/**
 * `expense_category` -- the P1 expense taxonomy (18-api-plan.md §5.2), a real dedicated table
 * (pack LK) rather than a generic `option_item`, deliberately, per the task instruction: this is
 * the identical bug class `adjustment_reason` (inventory.ts) already fixes -- a nullable/optional
 * GL binding is why the legacy system's adjustments (and, here, expenses) could never post. Real,
 * mandatory, named FK to a postable `gl_account` leaf, not a soft reference.
 */
export const expenseCategories = mysqlTable(
  "expense_category",
  {
    expenseCategoryId: idPk("expense_category_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    // Pack LK: code, name, description, isEnabled, isDefault, sortOrder, auditColumns(),
    // softDeleteColumns() -- same reuse-not-reinvent reasoning as adjustmentReasons (inventory.ts).
    ...lkColumns(),
    // Plain column, explicit FK below (adjustmentReasons' fk_adjustment_reason_gl mirror) --
    // mandatory, the §5.2 fix.
    glAccountId: fkBigInt("gl_account_id").notNull(),
    isSystem: boolean("is_system").notNull().default(false), // seeded rows the application depends on (option_item convention)
    remarks: varchar("remarks", { length: 1000 }),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_expense_category_tenant_code").on(table.tenantId, table.code),
    enabledIdx: index("ix_expense_category_enabled").on(table.tenantId, table.isEnabled, table.sortOrder),
    glAccountFk: foreignKey({
      name: "fk_expense_category_gl",
      columns: [table.glAccountId],
      foreignColumns: [glAccounts.glAccountId],
    }),
  }),
);

/**
 * `expense` -- R2.2, the header. Money leaving the business for a non-supplier-invoice reason
 * (rent, utilities, salaries, ...). Per-line categorisation (`expense_line`) so one expense
 * document can span multiple categories in one payment, matching how
 * purchase_invoice/purchase_invoice_line and sale_invoice/sale_invoice_line split header vs.
 * line elsewhere in this codebase. See file header for the documented DOC-pack shape deviation.
 */
export const expenses = mysqlTable(
  "expense",
  {
    expenseId: idPk("expense_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigIntNotNull("branch_id").references(() => branches.branchId),
    docNumber: varchar("doc_number", { length: 32 }).notNull(), // allocated via DocNumberService against the "EXP" series
    expenseDate: date("expense_date").notNull(),
    // Plain column, explicit FK below (auto name would exceed MySQL's 64-char limit, same
    // reasoning as payment.cashBankAccountId in payments.ts).
    cashBankAccountId: fkBigIntNotNull("cash_bank_account_id"), // paid from
    totalAmount: decimal("total_amount", DOCUMENT_AMOUNT).notNull(), // Sigma(expense_line.amount), enforced at the service layer (a header CHECK cannot span rows -- 18-api-plan.md §5.2)
    description: varchar("description", { length: 500 }),
    status: mysqlEnum("status", ["draft", "posted", "cancelled", "reversed"]).notNull().default("draft"),
    // Soft ref -> journal_entry (ledger.ts), matching payment.journalEntryId's convention exactly
    // (docColumns' posting-refs convention: soft, no hard FK, UNIQUE below = one posting per
    // expense).
    journalEntryId: fkBigInt("journal_entry_id"),
    postedAt: datetime("posted_at", { fsp: TIMESTAMP_FSP }),
    postedBy: fkBigInt("posted_by"), // soft ref -> app_user, auditColumns convention
    // Self-reference, soft (same-table FK) -- identical convention to _shared.ts docColumns'
    // reversalOfId: never a hard FK from a table back onto itself in this package.
    reversalOfExpenseId: fkBigInt("reversal_of_expense_id"),
    ...auditColumns(),
  },
  (table) => ({
    docNumberUnique: uniqueIndex("uk_expense_tenant_doc_number").on(table.tenantId, table.docNumber),
    journalUnique: uniqueIndex("uk_expense_journal_entry").on(table.journalEntryId),
    accountIdx: index("ix_expense_account").on(table.cashBankAccountId, table.expenseDate),
    dateIdx: index("ix_expense_date").on(table.tenantId, table.expenseDate, table.status),
    reversalIdx: index("ix_expense_reversal").on(table.reversalOfExpenseId),
    cashBankFk: foreignKey({
      name: "fk_expense_cash_bank_account",
      columns: [table.cashBankAccountId],
      foreignColumns: [cashBankAccounts.cashBankAccountId],
    }),
    // Hand-verify emission in the generated migration -- drizzle-kit's MySQL dialect does not
    // reliably emit CHECK clauses (same documented gap as payments.ts's header comment).
    totalAmountCheck: check("ck_expense_total_amount", sql`${table.totalAmount} > 0`),
  }),
);

/**
 * `expense_line` -- the per-category breakdown. Sigma(amount) = expense.totalAmount is enforced
 * at the service layer at post time (a header CHECK cannot span rows), mirroring how
 * purchase_invoice/purchase_invoice_line and sale_invoice/sale_invoice_line reconcile header vs.
 * line totals elsewhere in this codebase.
 */
export const expenseLines = mysqlTable(
  "expense_line",
  {
    expenseLineId: idPk("expense_line_id"),
    tenantId: fkBigIntNotNull("tenant_id"), // denormalised -- D16 isolation defence-in-depth, same convention as purchaseInvoiceLines
    expenseId: fkBigIntNotNull("expense_id"),
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    expenseCategoryId: fkBigIntNotNull("expense_category_id"),
    amount: decimal("amount", DOCUMENT_AMOUNT).notNull(),
    memo: varchar("memo", { length: 500 }),
    ...auditColumns(),
  },
  (table) => ({
    lineUnique: uniqueIndex("uk_expense_line").on(table.expenseId, table.lineNo),
    categoryIdx: index("ix_expense_line_category").on(table.expenseCategoryId, table.expenseId),
    expenseFk: foreignKey({
      name: "fk_expense_line_header",
      columns: [table.expenseId],
      foreignColumns: [expenses.expenseId],
    }),
    categoryFk: foreignKey({
      name: "fk_expense_line_category",
      columns: [table.expenseCategoryId],
      foreignColumns: [expenseCategories.expenseCategoryId],
    }),
    tenantFk: foreignKey({ name: "fk_expense_line_tenant", columns: [table.tenantId], foreignColumns: [tenants.tenantId] }),
    // Hand-verify emission in the generated migration -- see header comment on `expense` above.
    amountCheck: check("ck_expense_line_amount", sql`${table.amount} > 0`),
  }),
);
