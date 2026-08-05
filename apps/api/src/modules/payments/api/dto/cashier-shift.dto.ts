// Blueprint: 18-api-plan.md §5.3 "/cashier-shifts/*" (R2.4). Mirrors cash-bank.dto.ts's shape
// conventions (same module family).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

const zNonNegativeAmount = (label: string) =>
  zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

export const CashierShiftIdParamSchema = z.object({ id: zIntString });
export class CashierShiftIdParamDto extends createZodDto(CashierShiftIdParamSchema) {}

export const ListCashierShiftsQuerySchema = z.object({
  status: z.enum(["open", "closed", "approved"]).optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListCashierShiftsQueryDto extends createZodDto(ListCashierShiftsQuerySchema) {}

/** POST /cashier-shifts -- opens a till session. `cashBankAccountId` must be an active
 *  cash_drawer/petty_cash-kind account (service-layer -- a "till" is cash on hand, not a bank/
 *  card-settlement account); `openingFloatAmount` may be zero but never negative. */
export const OpenCashierShiftSchema = z.object({
  cashBankAccountId: z.number().int().positive(),
  openingFloatAmount: zNonNegativeAmount("openingFloatAmount"),
});
export class OpenCashierShiftDto extends createZodDto(OpenCashierShiftSchema) {}

const DenominationCountLineSchema = z.object({
  denominationAmount: zDecimalString("denominationAmount").refine((v) => Number.parseFloat(v) > 0, "denominationAmount must be greater than zero"),
  denominationCount: z.number().int().nonnegative(),
});

/** POST /cashier-shifts/:id/count -- the blind denomination count. Every submitted line must be
 *  one of the fixed PKR denominations (D4 -- PKR-only, no currency/currency_denomination table
 *  exists in this rebuild; see cashier-shift.service.ts's own PKR_DENOMINATIONS constant) --
 *  validated service-side, not here, so the 422 can name which value was invalid. Replaces the
 *  shift's whole count set (delete-then-insert, mirroring role_scope's own PUT replace semantics)
 *  -- a re-submitted count is a correction, not an addition. */
export const CountCashierShiftSchema = z.object({
  counts: z.array(DenominationCountLineSchema).min(1),
});
export class CountCashierShiftDto extends createZodDto(CountCashierShiftSchema) {}

/** POST /cashier-shifts/:id/close -- `varianceReason` is mandatory whenever the count() call
 *  already persisted a non-zero varianceAmount (FT-117/AC-5: "an over/short cannot be dismissed,
 *  only explained") -- enforced service-side against the persisted figure, not against a
 *  client-supplied number, so a client can't dodge the requirement by omitting/mis-stating it.
 *  `varianceAccountId` is deliberately NOT an accepted field here -- see cashier-shift.service.ts's
 *  own header comment (RS-3 / gl_account_binding gap): this wave never posts a variance journal
 *  entry, so there is nothing for a variance account to be applied to. */
export const CloseCashierShiftSchema = z.object({
  varianceReason: z.string().max(500).optional(),
});
export class CloseCashierShiftDto extends createZodDto(CloseCashierShiftSchema) {}

export const ApproveCashierShiftSchema = z.object({
  reason: z.string().max(500).optional(),
});
export class ApproveCashierShiftDto extends createZodDto(ApproveCashierShiftSchema) {}

export type OpenCashierShiftInput = z.infer<typeof OpenCashierShiftSchema>;
export type CountCashierShiftInput = z.infer<typeof CountCashierShiftSchema>;
export type CloseCashierShiftInput = z.infer<typeof CloseCashierShiftSchema>;
export type ApproveCashierShiftInput = z.infer<typeof ApproveCashierShiftSchema>;
