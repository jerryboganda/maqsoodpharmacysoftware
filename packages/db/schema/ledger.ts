// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T85-T88 (the four-level chart of
// accounts) and §T91-T92 (`journal_entry`/`journal_line`); docs/system-analysis/17-technical-
// blueprint.md §7.8 "The ledger: immutable, synchronous, period-locked" (four changes from the
// legacy: posting writes the ledger, immutability, corrections are audited reversals, period
// control); docs/system-analysis/00b-owner-decisions-and-requirements.md D16/R6 (tenant_id -- each
// tenant is a separate pharmacy business with its own books) and D6/D10 (the operated system is a
// trading ledger; opening balances start at zero, out of scope for this table definition).
//
// §00b F1 (Verified): the legacy hierarchy MainAccounts(5) -> CategoryAccounts(13) ->
// SubAccounts(29) -> Accounts(264-267) "is sound and is preserved intact." §17§7.8 fixes the two
// defects the legacy ledger has: `VirtualGl` has 1,021,852 rows, NO primary key, NO FK to the
// chart of accounts and NO FK to any source document (06 §4.4 R1-R2, Verified, Critical); and
// posting doesn't write the ledger at all -- `SP_VirtualGL` materialises it on every balance
// enquiry under TABLOCKX, and `AutoPurgeVirtualGL='Y'` can truncate the entire GL with no
// confirmation (07 §3.5, the highest-severity latent defect found in the whole accounting domain).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  datetime,
  decimal,
  index,
  mysqlEnum,
  mysqlTable,
  smallint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { appUsers } from "./identity";
import { auditColumns, DOCUMENT_AMOUNT, fkBigInt, fkBigIntNotNull, idPk, softDeleteColumns, TIMESTAMP_FSP } from "./_shared";
import { branches, tenants } from "./tenant";

/** §T85 `gl_account_main` -- level 1. Seed (Verified, 00b F1): ASSETS, LIABILITIES,
 * EQUITY/CAPITAL, REVENUES, EXPENSES. */
export const glAccountMains = mysqlTable(
  "gl_account_main",
  {
    glAccountMainId: idPk("gl_account_main_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    nameUr: varchar("name_ur", { length: 120 }),
    accountNature: mysqlEnum("account_nature", ["asset", "liability", "equity", "revenue", "expense"]).notNull(),
    normalBalance: mysqlEnum("normal_balance", ["debit", "credit"]).notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: smallint("sort_order", { unsigned: true }).notNull().default(100),
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_gl_account_main_tenant_code").on(table.tenantId, table.code),
  }),
);

/** §T86 `gl_account_category` -- level 2. Seed the 13 live rows, excluding the two data-quality
 * artefacts `FIXED ASSETS1` and `TEST` (00b F1, Verified as noise) -- a migration/seed concern,
 * not a schema one; this table simply has room for the clean 13. */
export const glAccountCategories = mysqlTable(
  "gl_account_category",
  {
    glAccountCategoryId: idPk("gl_account_category_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    glAccountMainId: fkBigIntNotNull("gl_account_main_id").references(() => glAccountMains.glAccountMainId),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    nameUr: varchar("name_ur", { length: 120 }),
    statementSection: mysqlEnum("statement_section", ["balance_sheet", "income_statement"]).notNull(),
    presentationOrder: smallint("presentation_order", { unsigned: true }).notNull().default(100),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_gl_account_category_tenant_code").on(table.tenantId, table.code),
    mainIdx: index("ix_gl_account_category_main").on(table.glAccountMainId),
  }),
);

/** §T87 `gl_account_sub` -- level 3. Verified: "9 of 29 sub-accounts have zero leaf accounts --
 * CASH AT BANK, MARKETING EXPENSES, all three PAYROLL sub-accounts, both STOCK ADJUSTMENT
 * sub-accounts, ADVANCES TO EMPLOYEES, PAYROLL DEDUCTIONS." R2 requires these be populated with
 * real leaf accounts at seeding -- again a seed-data concern, not this table's shape. */
export const glAccountSubs = mysqlTable(
  "gl_account_sub",
  {
    glAccountSubId: idPk("gl_account_sub_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    glAccountCategoryId: fkBigIntNotNull("gl_account_category_id").references(() => glAccountCategories.glAccountCategoryId),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    nameUr: varchar("name_ur", { length: 120 }),
    isControlAccount: boolean("is_control_account").notNull().default(false),
    subledgerKind: mysqlEnum("subledger_kind", ["none", "supplier", "customer", "cash_bank", "tax", "inventory", "expense"])
      .notNull()
      .default("none"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_gl_account_sub_tenant_code").on(table.tenantId, table.code),
    categoryIdx: index("ix_gl_account_sub_category").on(table.glAccountCategoryId),
  }),
);

/** §T88 `gl_account` -- level 4, the postable leaf. `glAccountId` is a real BIGINT (per this
 * package's S7 standardisation, schema/_shared.ts) rather than the legacy `Accounts.AccCode
 * smallint`, which caps the chart of accounts at 32,767 (06 §8.1, Verified). */
export const glAccounts = mysqlTable(
  "gl_account",
  {
    glAccountId: idPk("gl_account_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    glAccountSubId: fkBigIntNotNull("gl_account_sub_id").references(() => glAccountSubs.glAccountSubId),
    code: varchar("code", { length: 24 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    nameUr: varchar("name_ur", { length: 160 }),
    accountNature: mysqlEnum("account_nature", ["asset", "liability", "equity", "revenue", "expense"]).notNull(), // denormalised from level 1
    normalBalance: mysqlEnum("normal_balance", ["debit", "credit"]).notNull(),
    // §T88: "Explicitly flags the two accounts whose natural balance is inverted relative to
    // their parent category: SALES RETURN sits under REVENUE FROM SALES with a debit balance,
    // and PURCHASES RETURNS sits under DIRECT EXPENSES with a credit balance (07 §2.5, Verified,
    // flagged to an accountant)."
    isContra: boolean("is_contra").notNull().default(false),
    isPostable: boolean("is_postable").notNull().default(true), // summary-only accounts cannot be posted to directly
    isSystem: boolean("is_system").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    isRestricted: boolean("is_restricted").notNull().default(false), // legacy Accounts.Restricted
    balanceLimitAmount: decimal("balance_limit_amount", DOCUMENT_AMOUNT), // legacy Accounts.BalanceLimit
    openedOn: date("opened_on"),
    aliasName: varchar("alias_name", { length: 24 }),
    remarks: varchar("remarks", { length: 1000 }),
    legacyId: varchar("legacy_id", { length: 16 }), // legacy Accounts.AccCode
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_gl_account_tenant_code").on(table.tenantId, table.code),
    nameUnique: uniqueIndex("uk_gl_account_tenant_name").on(table.tenantId, table.name),
    legacyUnique: uniqueIndex("uk_gl_account_legacy").on(table.legacyId),
    subIdx: index("ix_gl_account_sub").on(table.glAccountSubId, table.isActive),
    natureIdx: index("ix_gl_account_nature").on(table.accountNature, table.isActive),
  }),
);

/**
 * §T91 `journal_entry` -- one posting event. Replaces `VirtualGl` (1,021,852 rows, no primary
 * key, no FK to the chart of accounts, no FK to any source document -- 06 §4.4 R1-R2, §6.1,
 * Verified, Critical). Per 17§7.8: "Posting writes the ledger. `ledger.post(journal)` inserts
 * `gl_entry` rows inside the business transaction" -- synchronous, not a read-time rebuild.
 *
 * Append-only after posting -- `status` transitions only, never a row edit (S2). Corrections are
 * audited reversals (`reversalOfJournalId` + a new balanced entry), never an in-place edit,
 * replacing the legacy's "correction = delete and re-enter" (12 R-012, Verified).
 */
export const journalEntries = mysqlTable(
  "journal_entry",
  {
    journalEntryId: idPk("journal_entry_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    branchId: fkBigInt("branch_id").references(() => branches.branchId), // nullable: some journal vouchers are tenant-wide
    entryNo: varchar("entry_no", { length: 32 }).notNull(), // human-visible number, unique per series (doc_series -- out of scope here)
    entryDate: date("entry_date").notNull(),
    // Document type ('SV','SR','PV','PR','SPAY','EXP','CBT','ADJ','CSHIFT','JV','OPEN' -- §T91)
    // is out of scope for this Foundations package (no document_type registry table yet); kept as
    // a plain code so this table is still usable standalone.
    // TODO(blueprint): 19-mysql-schema-blueprint.md §T04 `document_type` and §T91's FK to it are
    // deferred until the platform/document-numbering module (§T04-T06) is built; replace this
    // varchar with a real FK at that point.
    documentTypeCode: varchar("document_type_code", { length: 16 }).notNull(),
    sourceDocumentId: fkBigInt("source_document_id"), // the invoice/payment/expense/adjustment that caused it; NULL only for manual JVs
    reversalSeq: smallint("reversal_seq", { unsigned: true }).notNull().default(0), // 0 = original; >=1 = nth reversal/re-post
    description: varchar("description", { length: 500 }).notNull(),
    totalDebit: decimal("total_debit", DOCUMENT_AMOUNT).notNull().default("0.00"),
    totalCredit: decimal("total_credit", DOCUMENT_AMOUNT).notNull().default("0.00"),
    lineCount: smallint("line_count", { unsigned: true }).notNull().default(0),
    status: mysqlEnum("status", ["draft", "posted", "reversed"]).notNull().default("draft"),
    postedAt: datetime("posted_at", { fsp: TIMESTAMP_FSP }),
    postedBy: fkBigInt("posted_by").references(() => appUsers.userId),
    reversalOfJournalId: fkBigInt("reversal_of_journal_id"), // self-FK, added via foreignKey() below is unnecessary at this scope; see index
    reversalReason: varchar("reversal_reason", { length: 500 }), // mandatory (enforced at the service layer) when reversing
    legacyKey: varchar("legacy_key", { length: 64 }), // source DocumentType|DocumentCode pair
    ...auditColumns(),
    // No SD pack: journal entries are never soft- or hard-deleted (S2) -- only reversed.
  },
  (table) => ({
    // §T91: "one posting per document, enforced by the engine. This makes double-posting
    // structurally impossible" -- directly satisfies R2.3's requirement that cash sales appear in
    // the cash book exactly once.
    sourceUnique: uniqueIndex("uk_journal_source").on(table.documentTypeCode, table.sourceDocumentId, table.reversalSeq),
    entryNoUnique: uniqueIndex("uk_journal_entry_no").on(table.tenantId, table.entryNo),
    legacyUnique: uniqueIndex("uk_journal_legacy").on(table.legacyKey),
    dateIdx: index("ix_journal_date").on(table.tenantId, table.entryDate, table.status),
    typeIdx: index("ix_journal_type").on(table.documentTypeCode, table.entryDate),
    // §T91: "the single most important constraint in this schema."
    balancedCheck: check("ck_journal_balanced", sql`${table.totalDebit} = ${table.totalCredit}`),
    postedCheck: check(
      "ck_journal_posted",
      sql`${table.status} <> 'posted' or (${table.postedAt} is not null and ${table.postedBy} is not null and ${table.lineCount} >= 2)`,
    ),
  }),
);

/**
 * §T92 `journal_line` -- the balanced leg. Three CHECK constraints together "make it impossible
 * to store a leg that is negative, double-sided or empty -- three states the legacy `VirtualGl`
 * permits and has no way to detect" (§T92).
 */
export const journalLines = mysqlTable(
  "journal_line",
  {
    journalLineId: idPk("journal_line_id"),
    journalEntryId: fkBigIntNotNull("journal_entry_id").references(() => journalEntries.journalEntryId),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId), // denormalised -- D16 isolation defence-in-depth
    lineNo: smallint("line_no", { unsigned: true }).notNull(),
    glAccountId: fkBigIntNotNull("gl_account_id").references(() => glAccounts.glAccountId), // §T92: "the single most important missing constraint in the legacy system"
    debitAmount: decimal("debit_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    creditAmount: decimal("credit_amount", DOCUMENT_AMOUNT).notNull().default("0.00"),
    // Preserves the legacy AlternateAccCode "statistical customer dimension": on a cash sale the
    // customer is not the debit account, cash is, and the customer code rides in a shadow column
    // (07 §3.4, Verified) -- §T92.
    analysisAccountId: fkBigInt("analysis_account_id").references(() => glAccounts.glAccountId),
    supplierId: fkBigInt("supplier_id"), // TODO(blueprint): FK -> supplier (§T26) once the parties module exists
    customerId: fkBigInt("customer_id"), // TODO(blueprint): FK -> customer (§T28) once the parties module exists
    itemId: fkBigInt("item_id"), // TODO(blueprint): FK -> item (catalog.ts) -- optional analysis dimension, left unconstrained to avoid a hard cross-module coupling for an optional field
    // Preserves the legacy VRow fan-out taxonomy (07 §3.2, Verified, up to 8 legs per document)
    // so every historical entry keeps its meaning (§T92).
    legRole: mysqlEnum("leg_role", [
      "primary_debit",
      "primary_credit",
      "sales_tax",
      "income_tax",
      "fbr_fee",
      "payment",
      "cogs",
      "rounding",
      "charge",
      "other",
    ])
      .notNull()
      .default("other"),
    memo: varchar("memo", { length: 500 }),
    legacyRowKey: varchar("legacy_row_key", { length: 80 }),
    createdAt: datetime("created_at", { fsp: TIMESTAMP_FSP }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    createdBy: fkBigInt("created_by"),
    // Append-only (§T92): no updated_*, no deleted_* -- deliberately not spreading auditColumns()
    // or softDeleteColumns() here, matching §4.2's "ledger and movement rows ... append-only. No
    // UPDATE, no DELETE -- enforced by MySQL grants ... and by BEFORE UPDATE/BEFORE DELETE
    // triggers." The grants/triggers themselves are a deployment concern (§9.10/§4.2), out of
    // scope for this Drizzle schema definition -- add them by hand to the generated migration.
  },
  (table) => ({
    lineNoUnique: uniqueIndex("uk_journal_line").on(table.journalEntryId, table.lineNo),
    accountDateIdx: index("ix_jl_account_date").on(table.glAccountId, table.journalEntryId), // account ledger
    supplierIdx: index("ix_jl_supplier").on(table.supplierId, table.journalEntryId), // supplier statement / aged payables
    customerIdx: index("ix_jl_customer").on(table.customerId, table.journalEntryId),
    roleIdx: index("ix_jl_role").on(table.legRole),
    oneSideCheck: check("ck_journal_line_one_side", sql`${table.debitAmount} = 0 or ${table.creditAmount} = 0`),
    nonNegCheck: check("ck_journal_line_nonneg", sql`${table.debitAmount} >= 0 and ${table.creditAmount} >= 0`),
    nonZeroCheck: check("ck_journal_line_nonzero", sql`(${table.debitAmount} + ${table.creditAmount}) > 0`),
  }),
);
