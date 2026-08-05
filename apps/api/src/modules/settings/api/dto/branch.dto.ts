// Blueprint: docs/system-analysis/00b-owner-decisions-and-requirements.md D17 ("NTN/STRN and
// other business-identity fields are admin-editable settings") and D18/R7 (U-062, DRAP
// controlled-drug obligations -- Wave 8). D17 says branch/tenant identity fields ARE meant to be
// admin-editable, but no endpoint existed anywhere in this codebase to actually edit a `branch`
// row (confirmed by search before writing this file) -- this DTO/controller/service trio is that
// missing admin surface, scoped to exactly the fields a branch admin needs to maintain: display
// fields (name/address/city) plus the two new DRAP licence-tracking columns (tenant.ts's own
// header comment on those two columns). Mirrors option-item.dto.ts's conventions (zIntString for
// the numeric id param, a `.refine` "at least one field" PATCH schema) since this is the same
// shape of admin-CRUD-over-a-simple-table problem.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mirrors option-item.dto.ts's own zIntString -- branch_id is a BIGINT UNSIGNED idPk (tenant.ts),
// never negative/fractional.
const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

export const BranchIdParamSchema = z.object({ branchId: zIntString });
export class BranchIdParamDto extends createZodDto(BranchIdParamSchema) {}

/**
 * PATCH /branches/:branchId. All fields optional (at least one required, same convention
 * UpdateOptionItemSchema establishes) -- a branch admin editing the licence fields should not be
 * forced to resend name/address/city untouched.
 *
 * `code` and `isDefault`/`isActive` are deliberately NOT exposed here: `code` is this row's own
 * stable business key (same reasoning UpdateOptionItemDto gives for excluding `option_item.code`),
 * and `isDefault`/`isActive` are structural flags with no dedicated toggle endpoint built yet --
 * out of this wave's scope (U-062 record-keeping), not silently forgotten.
 *
 * `drugSaleLicenceNo`/`drugLicenceExpiryDate` are nullable-and-optional: clearing either back to
 * null (e.g. a licence lapsed and the new number isn't known yet) is a legitimate edit, not just
 * setting a value. Neither is validated against any DRAP-specific format or requiredness rule --
 * whether DRAP requires this field AT ALL for a retail dispensing pharmacy is still open pending
 * professional sign-off (R7); this endpoint only lets the owner record whatever their pharmacist
 * or regulatory consultant tells them to keep, "super easy" (D18's own words), never invents or
 * enforces the rule itself.
 */
export const UpdateBranchSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    addressLine1: z.string().max(255).nullable().optional(),
    addressLine2: z.string().max(255).nullable().optional(),
    city: z.string().max(80).nullable().optional(),
    drugSaleLicenceNo: z.string().max(64).nullable().optional(),
    drugLicenceExpiryDate: z.string().regex(BUSINESS_DATE_RE, "drugLicenceExpiryDate must be YYYY-MM-DD").nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export class UpdateBranchDto extends createZodDto(UpdateBranchSchema) {}
export type UpdateBranchInput = z.infer<typeof UpdateBranchSchema>;
