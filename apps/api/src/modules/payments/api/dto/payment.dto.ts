// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.1 "Module `payments`" (R2.1);
// 19-mysql-schema-blueprint.md §T95 `payment` / §T96 `payment_allocation`. Mirrors
// purchase-return.dto.ts's shape (money fields are decimal STRINGS -- Rule M, 17§6.3 boundary 3
// -- validated via common/validation/money-schemas.ts, parsed into value objects only inside the
// application service).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

/** Non-negative decimal-string (amounts on a payment are never negative). Strict ">0" is
 *  enforced service-side via Money, mirroring purchase-return.dto.ts's zNonNegative /
 *  PurchaseReturnService.computeLine's isZero() check split (shape here, value there). */
const zNonNegativeAmount = (label: string) =>
  zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

export const PaymentIdParamSchema = z.object({ id: zIntString });
export class PaymentIdParamDto extends createZodDto(PaymentIdParamSchema) {}

export const PaymentAllocationIdParamSchema = z.object({ id: zIntString, allocationId: zIntString });
export class PaymentAllocationIdParamDto extends createZodDto(PaymentAllocationIdParamSchema) {}

export const ListPaymentsQuerySchema = z.object({
  direction: z.enum(["out", "in"]).optional(),
  partyKind: z.enum(["supplier", "customer", "employee", "other"]).optional(),
  supplierId: zIntString.optional(),
  customerId: zIntString.optional(),
  status: z.enum(["draft", "confirmed", "posted", "cancelled", "reversed"]).optional(),
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListPaymentsQueryDto extends createZodDto(ListPaymentsQuerySchema) {}

/** GET /payments/allocation-candidates -- exactly one of supplierId/customerId, mirroring the
 *  payment.party_kind exclusivity rule (§T95's documented-but-not-DDL-expressed ck_payment_party,
 *  enforced service-side per payments.ts's own header comment). */
export const AllocationCandidatesQuerySchema = z
  .object({
    supplierId: zIntString.optional(),
    customerId: zIntString.optional(),
  })
  .refine((v) => (v.supplierId !== undefined) !== (v.customerId !== undefined), {
    message: "exactly one of supplierId or customerId is required",
  });
export class AllocationCandidatesQueryDto extends createZodDto(AllocationCandidatesQuerySchema) {}

/** One allocation line, shared by the inline `allocations` array on POST /payments and by
 *  POST /payments/:id/allocations. `targetDocumentTypeId` is the real `document_type.document_
 *  type_id` (not a code) -- §T96's own FK shape; PaymentService resolves it to one of the four
 *  document kinds it understands (PURCHASE / PURCHASE_RETURN / SALE / SALE_RETURN) and 422s on
 *  anything else. */
export const PaymentAllocationInputSchema = z.object({
  targetDocumentTypeId: z.number().int().positive(),
  targetDocumentId: z.number().int().positive(),
  allocatedAmount: zNonNegativeAmount("allocatedAmount"),
});
export class PaymentAllocationInputDto extends createZodDto(PaymentAllocationInputSchema) {}
export type PaymentAllocationInput = z.infer<typeof PaymentAllocationInputSchema>;

/**
 * POST /payments. `direction`/`partyKind`/party-reference cross-validation mirrors §T95's
 * documented ck_payment_party (exactly one party reference consistent with party_kind) -- shape
 * validated here (superRefine), the DEEPER "does this supplierId/customerId actually exist"
 * check is service-side (needs the DB). Which (direction, partyKind) COMBINATIONS are actually
 * postable this wave (out+supplier, in+customer) is a service-side 422, not encoded here -- see
 * PaymentService.createAndPost's header comment for why the other combinations (in+supplier,
 * out+customer, employee/other) are deliberately deferred rather than guessed at.
 */
export const CreatePaymentSchema = z
  .object({
    direction: z.enum(["out", "in"]),
    partyKind: z.enum(["supplier", "customer", "employee", "other"]).default("supplier"),
    supplierId: z.number().int().positive().optional(),
    customerId: z.number().int().positive().optional(),
    otherPartyName: z.string().min(1).max(160).optional(),
    paymentMethodId: z.number().int().positive(),
    cashBankAccountId: z.number().int().positive(),
    amount: zNonNegativeAmount("amount"),
    referenceNo: z.string().max(64).optional(),
    chequeNo: z.string().max(32).optional(),
    chequeDate: zDateString.optional(),
    documentDate: zDateString,
    allocationMode: z.enum(["specific", "oldest_first", "on_account"]).default("oldest_first"),
    /** Optional at creation -- can also be allocated later via POST /payments/:id/allocations. */
    allocations: z.array(PaymentAllocationInputSchema).optional(),
    notes: z.string().max(1000).optional(),
  })
  .superRefine((v, ctx) => {
    const partyFieldsSet = { supplier: v.supplierId !== undefined, customer: v.customerId !== undefined, other: v.otherPartyName !== undefined };
    const wanted = v.partyKind === "supplier" ? "supplier" : v.partyKind === "customer" ? "customer" : "other";
    if (!partyFieldsSet[wanted]) {
      const field = wanted === "supplier" ? "supplierId" : wanted === "customer" ? "customerId" : "otherPartyName";
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required when partyKind is "${v.partyKind}"` });
    }
    for (const [key, isSet] of Object.entries(partyFieldsSet)) {
      if (key !== wanted && isSet) {
        const field = key === "supplier" ? "supplierId" : key === "customer" ? "customerId" : "otherPartyName";
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} must not be set when partyKind is "${v.partyKind}"` });
      }
    }
  })
  .refine((v) => v.chequeNo === undefined || v.chequeDate !== undefined, {
    message: "chequeDate is required when chequeNo is provided",
    path: ["chequeDate"],
  });
export class CreatePaymentDto extends createZodDto(CreatePaymentSchema) {}
export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;

/** POST /payments/:id/allocations -- add allocations against an existing payment's
 *  unallocatedAmount (the GENERATED column, §T95). */
export const AddPaymentAllocationsSchema = z.object({
  allocations: z.array(PaymentAllocationInputSchema).min(1),
});
export class AddPaymentAllocationsDto extends createZodDto(AddPaymentAllocationsSchema) {}
export type AddPaymentAllocationsInput = z.infer<typeof AddPaymentAllocationsSchema>;

/** POST /payments/:id/cancel -- only reachable with zero active (non-reversed) allocations
 *  (PaymentService.cancel's own 422 otherwise). `reason` is accepted for the audit trail,
 *  mirroring DeactivateSupplierDto's accepted-but-not-persisted-as-a-column treatment (there is
 *  no free-text reason column on `payment` -- cancelReasonId is a soft-ref option-list id, not
 *  validated against that list this increment, same treatment as purchase-return.dto's reasonId). */
export const CancelPaymentSchema = z.object({
  cancelReasonId: z.number().int().positive().optional(),
  reason: z.string().min(1).max(500).optional(),
});
export class CancelPaymentDto extends createZodDto(CancelPaymentSchema) {}
export type CancelPaymentInput = z.infer<typeof CancelPaymentSchema>;
