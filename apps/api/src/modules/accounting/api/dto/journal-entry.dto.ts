// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge), §6.3 boundary 3 -- money fields are
// decimal STRINGS on the wire (Rule M), never z.number(). Mirrors purchase-return.dto.ts's shape
// conventions. 18-api-plan.md §5.4's `POST /gl/journal-entries` and
// `POST /gl/journal-entries/{id}/reverse` rows are the source spec.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

/** Non-negative decimal-string (a debit/credit leg amount is never negative -- the *side* is
 *  which field is populated, not the sign). */
const zNonNegative = (label: string) =>
  zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

export const JournalEntryIdParamSchema = z.object({ id: zIntString });
export class JournalEntryIdParamDto extends createZodDto(JournalEntryIdParamSchema) {}

export const ListJournalEntriesQuerySchema = z.object({
  documentTypeCode: z.string().min(1).max(16).optional(),
  status: z.enum(["draft", "posted", "reversed"]).optional(),
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListJournalEntriesQueryDto extends createZodDto(ListJournalEntriesQuerySchema) {}

/** One leg of a manual voucher. Exactly one of debit/credit must be present (checked here AND
 *  re-checked by JournalService.post() -- belt and braces, §9.4 E-1: the edge-layer check gives
 *  a field-level 422 with a path, JournalService's is the structural backstop for any other
 *  caller). */
export const JournalLineInputSchema = z
  .object({
    glAccountId: z.number().int().positive(),
    debit: zNonNegative("debit").optional(),
    credit: zNonNegative("credit").optional(),
    supplierId: z.number().int().positive().optional(),
    customerId: z.number().int().positive().optional(),
    memo: z.string().max(500).optional(),
  })
  .refine((line) => (line.debit === undefined) !== (line.credit === undefined), {
    message: "Each line needs exactly one of debit or credit.",
    path: ["debit"],
  });

export const CreateJournalEntrySchema = z.object({
  /** FK -> option_item under the seeded `voucher_category` option_list (JV/CP/CR/BP/BR). */
  voucherCategoryId: z.number().int().positive(),
  /** Voucher/document date -- accepted and validated but NOT persisted as its own column
   *  (journal_entry/manual_voucher have a single date, `entryDate`, which is stamped from
   *  `postingDate` -- see journal-entry.service.ts's createManualVoucher doc comment for the
   *  documented gap, same shape as expenses.ts's own flagged fiscalPeriodId gap). */
  documentDate: zDateString,
  /** The ledger-effective date: resolves the fiscal period and becomes journal_entry.entryDate. */
  postingDate: zDateString,
  narration: z.string().min(1).max(500),
  lines: z.array(JournalLineInputSchema).min(2),
});
export class CreateJournalEntryDto extends createZodDto(CreateJournalEntrySchema) {}

export const ReverseJournalEntrySchema = z.object({
  reason: z.string().min(1).max(500),
  postingDate: zDateString,
});
export class ReverseJournalEntryDto extends createZodDto(ReverseJournalEntrySchema) {}

export type JournalLineInput = z.infer<typeof JournalLineInputSchema>;
export type CreateJournalEntryInput = z.infer<typeof CreateJournalEntrySchema>;
export type ReverseJournalEntryInput = z.infer<typeof ReverseJournalEntrySchema>;
