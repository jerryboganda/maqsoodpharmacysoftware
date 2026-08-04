// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.2 "Module `payments` -- expenses"
// (R2.2). Endpoint/field list narrowed to exactly what packages/db/schema/expenses.ts's
// `expense`/`expense_line` tables actually carry -- the Wave 5 foundation report's documented,
// deliberate DOC-pack deviation (no warehouseId/payeeName/supplierId/taxAmount/
// withholdingAmount/attachmentId/recurringTemplateId columns exist yet), per this task's own
// instruction to build against the schema as it actually landed rather than 18-api-plan.md's
// fuller wishlist. Money fields are decimal STRINGS (Rule M, 17§6.3 boundary 3), mirroring
// payment.dto.ts's `zNonNegativeAmount` split -- shape validated here, strict ">0" enforced
// service-side via `Money` (ExpenseService.computeLines).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

/** Non-negative decimal-string (an expense line amount is never negative). Strict ">0" is
 *  enforced service-side via Money, mirroring purchase-return.dto.ts's zNonNegative /
 *  payment.dto.ts's zNonNegativeAmount split (shape here, value there). */
const zNonNegativeAmount = (label: string) => zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

export const ExpenseIdParamSchema = z.object({ id: zIntString });
export class ExpenseIdParamDto extends createZodDto(ExpenseIdParamSchema) {}

export const ListExpensesQuerySchema = z.object({
  status: z.enum(["draft", "posted", "cancelled", "reversed"]).optional(),
  cashBankAccountId: zIntString.optional(),
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListExpensesQueryDto extends createZodDto(ListExpensesQuerySchema) {}

/** One expense line -- `expense_line`'s exact shape (expenseCategoryId/amount/memo, nothing
 *  more; no warehouseId/description split -- see this file's header comment). */
export const ExpenseLineInputSchema = z.object({
  expenseCategoryId: z.number().int().positive(),
  amount: zNonNegativeAmount("amount"),
  memo: z.string().max(500).optional(),
});
export type ExpenseLineInput = z.infer<typeof ExpenseLineInputSchema>;

/**
 * POST /expenses -- creates a DRAFT (status "draft", no journal posting yet; a real "EXP-" doc
 * number is still allocated at create time -- see ExpenseService.create's own comment on why,
 * mirroring stock-take.service.ts's N-1-relaxed-for-drafts precedent). `totalAmount` is never
 * accepted from the wire -- it is Σ(lines.amount), computed service-side (a header CHECK cannot
 * span rows, packages/db/schema/expenses.ts's own header comment on `expense.total_amount`).
 */
export const CreateExpenseSchema = z.object({
  expenseDate: zDateString,
  cashBankAccountId: z.number().int().positive(),
  description: z.string().max(500).optional(),
  lines: z.array(ExpenseLineInputSchema).min(1),
});
export class CreateExpenseDto extends createZodDto(CreateExpenseSchema) {}
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>;

/**
 * PATCH /expenses/:id -- draft only (422 `EXPENSE.NOT_DRAFT` otherwise, service-side).
 * `lines`, when supplied, REPLACES the entire line set (not a per-line patch) -- the simplest
 * correct semantics for a still-editable draft's line list; ExpenseService.update deletes and
 * re-inserts rather than trying to reconcile an insert/update/delete diff against `lineNo`.
 * `description: null` explicitly clears the field; omitting it leaves the current value alone.
 */
export const UpdateExpenseSchema = z
  .object({
    expenseDate: zDateString.optional(),
    cashBankAccountId: z.number().int().positive().optional(),
    description: z.string().max(500).nullable().optional(),
    lines: z.array(ExpenseLineInputSchema).min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export class UpdateExpenseDto extends createZodDto(UpdateExpenseSchema) {}
export type UpdateExpenseInput = z.infer<typeof UpdateExpenseSchema>;

/**
 * POST /expenses/:id/reverse -- `reason` is stored on the REVERSING journal_entry's own
 * `reversalReason` column (ledger.ts: "mandatory ... when reversing"), not on `expense` itself
 * (no such column on this table -- packages/db/schema/expenses.ts's documented DOC-pack
 * deviation drops cancelReasonId/notes along with the rest of the pack). Required (not optional)
 * because the ledger column it feeds is documented as mandatory on a reversal.
 */
export const ReverseExpenseSchema = z.object({
  reason: z.string().min(1).max(500),
});
export class ReverseExpenseDto extends createZodDto(ReverseExpenseSchema) {}
export type ReverseExpenseInput = z.infer<typeof ReverseExpenseSchema>;
