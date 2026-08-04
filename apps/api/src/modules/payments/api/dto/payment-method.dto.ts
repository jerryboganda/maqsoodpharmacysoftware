// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.1; 19-mysql-schema-blueprint.md §T94
// `payment_method` (P1/D9 -- "add all options for the respective user to select from", disable
// never delete). Mirrors purchase-return.dto.ts's int/date-string helper conventions.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

export const PaymentMethodIdParamSchema = z.object({ id: zIntString });
export class PaymentMethodIdParamDto extends createZodDto(PaymentMethodIdParamSchema) {}

export const ListPaymentMethodsQuerySchema = z.object({
  /** Default false -- disabled methods (P1.3: disable, never delete) are hidden from ordinary
   *  listing (e.g. a POS payment-method picker) unless explicitly asked for (e.g. an admin
   *  screen managing the full catalogue including disabled rows). */
  includeDisabled: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export class ListPaymentMethodsQueryDto extends createZodDto(ListPaymentMethodsQuerySchema) {}

const DIRECTIONS = ["in", "out", "both"] as const;

/**
 * Deliberately light-touch cross-field validation ("use judgement, don't over-engineer" per the
 * task instruction) -- applied in PaymentMethodService against the CREATE input and, on PATCH,
 * against the merged (existing + patch) view, not re-derived per-field here in the zod schema:
 *   - `requiresChequeDetails` implies `requiresBankAccount` (a cheque is a bank instrument; it
 *     cannot clear against a cash drawer).
 *   - `isCounterMethod` (P1.5 -- "cashiers see counter methods only") cannot also require bank
 *     account or cheque details: a counter/till method is by definition a simple, immediate
 *     tender, not one requiring bank paperwork.
 */
export const CreatePaymentMethodSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  description: z.string().max(255).optional(),
  directionAllowed: z.enum(DIRECTIONS).default("both"),
  defaultCashBankAccountId: z.number().int().positive().optional(),
  requiresReference: z.boolean().default(false),
  requiresBankAccount: z.boolean().default(false),
  requiresChequeDetails: z.boolean().default(false),
  settlementLagDays: z.number().int().min(0).max(365).default(0),
  isCounterMethod: z.boolean().default(false),
  minPermissionId: z.number().int().positive().optional(),
  isDefault: z.boolean().default(false),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(65535).default(100),
});
export class CreatePaymentMethodDto extends createZodDto(CreatePaymentMethodSchema) {}
export type CreatePaymentMethodInput = z.infer<typeof CreatePaymentMethodSchema>;

/** PATCH /payment-methods/:id -- every editable field, all optional. `code` is immutable via
 *  this endpoint (mirrors UpdateSupplierDto's treatment of identity-shaped fields elsewhere in
 *  the codebase being either fixed-at-create or given their own endpoint) -- payment_method's
 *  `code` is what `seriesCode`/DOC_TYPES-style lookups and any hardcoded integration would key
 *  off, so it is not exposed for edit here. */
export const UpdatePaymentMethodSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(255).optional(),
    directionAllowed: z.enum(DIRECTIONS).optional(),
    defaultCashBankAccountId: z.number().int().positive().nullable().optional(),
    requiresReference: z.boolean().optional(),
    requiresBankAccount: z.boolean().optional(),
    requiresChequeDetails: z.boolean().optional(),
    settlementLagDays: z.number().int().min(0).max(365).optional(),
    isCounterMethod: z.boolean().optional(),
    minPermissionId: z.number().int().positive().nullable().optional(),
    isDefault: z.boolean().optional(),
    isEnabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(65535).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export class UpdatePaymentMethodDto extends createZodDto(UpdatePaymentMethodSchema) {}
export type UpdatePaymentMethodInput = z.infer<typeof UpdatePaymentMethodSchema>;
