// Blueprint: 18-api-plan.md §8.2 "/cash-bank-accounts, /cash-bank/book, /cash-bank/transfers"
// (R2.3). Mirrors purchase-return.dto.ts's shape conventions.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

const zPositiveAmount = (label: string) =>
  zDecimalString(label)
    .refine((v) => !v.startsWith("-"), `${label} cannot be negative`)
    .refine((v) => Number.parseFloat(v) > 0, `${label} must be greater than zero`);

export const CashBankAccountIdParamSchema = z.object({ id: zIntString });
export class CashBankAccountIdParamDto extends createZodDto(CashBankAccountIdParamSchema) {}

export const ListCashBankAccountsQuerySchema = z.object({
  accountKind: z.enum(["cash_drawer", "petty_cash", "bank", "mobile_wallet", "card_settlement"]).optional(),
  isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListCashBankAccountsQueryDto extends createZodDto(ListCashBankAccountsQuerySchema) {}

/** POST /cash-bank-accounts -- `glAccountId` must reference a postable, active leaf under a
 *  gl_account_sub with subledgerKind='cash_bank' that isn't already bound to another
 *  cash_bank_account (service-layer + schema unique constraint, cash-bank.service.ts).
 *  `openingBalanceAmount` is deliberately NOT an accepted field here (18-api-plan.md D10/R3.1) --
 *  the service always forces "0.00" server-side regardless of anything the client might send. */
export const CreateCashBankAccountSchema = z.object({
  glAccountId: z.number().int().positive(),
  accountKind: z.enum(["cash_drawer", "petty_cash", "bank", "mobile_wallet", "card_settlement"]),
  bankName: z.string().max(120).optional(),
  branchName: z.string().max(120).optional(),
  accountNo: z.string().max(34).optional(),
  iban: z.string().max(34).optional(),
  allowNegative: z.boolean().optional(),
  isDefaultForSales: z.boolean().optional(),
});
export class CreateCashBankAccountDto extends createZodDto(CreateCashBankAccountSchema) {}

export const CashBankBookQuerySchema = z.object({
  cashBankAccountId: z.string().regex(/^\d+$/, "must be a positive integer").transform(Number),
  from: zDateString.optional(),
  to: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class CashBankBookQueryDto extends createZodDto(CashBankBookQuerySchema) {}

export const CreateCashBankTransferSchema = z.object({
  fromCashBankAccountId: z.number().int().positive(),
  toCashBankAccountId: z.number().int().positive(),
  amount: zPositiveAmount("amount"),
  transferDate: zDateString,
  memo: z.string().max(500).optional(),
});
export class CreateCashBankTransferDto extends createZodDto(CreateCashBankTransferSchema) {}

// ---- Wave 10d: /cash-bank/reconciliations (R2.3) ------------------------------------------------

export const StartReconciliationSchema = z.object({
  cashBankAccountId: z.number().int().positive(),
  statementDate: zDateString,
  statementClosingBalance: zDecimalString("statementClosingBalance"),
});
export class StartReconciliationDto extends createZodDto(StartReconciliationSchema) {}

export const ReconciliationIdParamSchema = z.object({ id: zIntString });
export class ReconciliationIdParamDto extends createZodDto(ReconciliationIdParamSchema) {}

/** `adjustments` is accepted (forward-compatible with 18-api-plan.md's literal field list) but not
 *  implemented this wave -- see cash-bank-reconciliation.service.ts's own header comment for why a
 *  non-zero difference always 422s regardless of whether it's supplied. */
export const CompleteReconciliationSchema = z.object({
  matchedLineIds: z.array(z.number().int().positive()),
  adjustments: z.array(z.unknown()).optional(),
  reason: z.string().max(500).optional(),
});
export class CompleteReconciliationDto extends createZodDto(CompleteReconciliationSchema) {}

export type CreateCashBankAccountInput = z.infer<typeof CreateCashBankAccountSchema>;
export type CashBankBookQuery = z.infer<typeof CashBankBookQuerySchema>;
export type CreateCashBankTransferInput = z.infer<typeof CreateCashBankTransferSchema>;
export type StartReconciliationInput = z.infer<typeof StartReconciliationSchema>;
export type CompleteReconciliationInput = z.infer<typeof CompleteReconciliationSchema>;
