// Blueprint: docs/system-analysis/18-api-plan.md §5.4 "Module `ledger` -- chart of accounts,
// journals, periods", POST /api/v1/gl/journal-entries row ("Manual voucher (JV, CP, CR, BP,
// BR)"). Built by the follow-up `accounting` agent (apps/api/src/modules/accounting/**), per its
// own task instruction: `journal_entry` (ledger.ts) has no `voucherCategoryId` column -- adding
// one there would touch the Wave 5 foundation pass's own migration file, which this task is
// explicitly told not to do. Instead: a tiny 1:1 extension table, its own additive migration.
//
// Column set is deliberately narrow (the task's own exact list): manualVoucherId PK,
// journalEntryId FK (soft/nullable then populated, unique -- one manual-voucher row per journal
// entry, same soft-ref-then-populate convention as payment.journalEntryId/expense.journalEntryId
// in payments.ts/expenses.ts: the header row is inserted FIRST so its own id can be used as
// journal_entry.source_document_id, then journalEntryId is stamped onto this row once
// JournalService.post() returns the new journal_entry_id -- see journal-entry.service.ts's
// createManualVoucher for the exact sequencing and why: TX-6 requires DocNumberService.allocate()
// to be the first lock, and journal_entry.source_document_id needs a real numeric id that only
// this table's own PK can supply for a manual voucher (there is no other header row for a JV)),
// voucherCategoryId FK -> option_item (the seeded `voucher_category` list: JV/CP/CR/BP/BR,
// packages/db/scripts/seed.ts Block 1d), narration.
//
// tenantId is denormalised onto this row too (D16 isolation defence-in-depth, same convention
// applied to every other table in this package, e.g. journal_line.tenantId in ledger.ts) even
// though it is derivable via journalEntryId -> journal_entry.tenant_id.
import { foreignKey, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, fkBigInt, fkBigIntNotNull, idPk } from "./_shared";
import { journalEntries } from "./ledger";
import { optionItems } from "./options";
import { tenants } from "./tenant";

export const manualVouchers = mysqlTable(
  "manual_voucher",
  {
    manualVoucherId: idPk("manual_voucher_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    // Nullable + unique, populated after JournalService.post() returns -- see file header. Plain
    // column with an explicit-named FK below (the auto-generated name would be long, same
    // reasoning as every other cross-file FK in this package, e.g. payments.ts's
    // fk_payment_cash_bank_account).
    journalEntryId: fkBigInt("journal_entry_id"),
    // Plain column, explicit FK below -- points at option_item rows under the seeded
    // `voucher_category` option_list (options.ts), never a bespoke enum (P1).
    voucherCategoryId: fkBigIntNotNull("voucher_category_id"),
    narration: varchar("narration", { length: 500 }).notNull(),
    ...auditColumns(),
  },
  (table) => ({
    journalEntryUnique: uniqueIndex("uk_manual_voucher_journal_entry").on(table.journalEntryId),
    categoryIdx: index("ix_manual_voucher_category").on(table.voucherCategoryId),
    tenantIdx: index("ix_manual_voucher_tenant").on(table.tenantId),
    journalEntryFk: foreignKey({
      name: "fk_manual_voucher_journal_entry",
      columns: [table.journalEntryId],
      foreignColumns: [journalEntries.journalEntryId],
    }),
    categoryFk: foreignKey({
      name: "fk_manual_voucher_category",
      columns: [table.voucherCategoryId],
      foreignColumns: [optionItems.optionItemId],
    }),
  }),
);
