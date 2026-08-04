// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.3/§6.7 (money fields are decimal
// strings, never z.number()); 19-mysql-schema-blueprint.md §T28 `customer`.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/index.js";

/** YYYY-MM-DD, parsed not coerced -- mirrors SupplierLedgerQuerySchema's local zDateString
 *  (purchasing/api/dto/supplier.dto.ts). */
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const CustomerIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export class CustomerIdParamDto extends createZodDto(CustomerIdParamSchema) {}

export const ListCustomersQuerySchema = z.object({
  /** Free-text search over code and name. */
  q: z.string().min(1).max(160).optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export class ListCustomersQueryDto extends createZodDto(ListCustomersQuerySchema) {}

export const CreateCustomerSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(160),
  nameUr: z.string().max(160).optional(),
  phone: z.string().max(32).optional(),
  mobile: z.string().max(32).optional(),
  email: z.string().email().max(190).optional(),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(80).optional(),
  ntnNo: z.string().max(24).optional(),
  cnicNo: z.string().max(20).optional(),
  // Rule M (17 §6.1): decimal string, never a JS number.
  creditLimitAmount: zDecimalString("creditLimitAmount").optional(),
  creditDays: z.number().int().min(0).max(365).optional(),
});
export class CreateCustomerDto extends createZodDto(CreateCustomerSchema) {}

/**
 * PATCH /customers/:id -- every editable field from `CreateCustomerSchema`, all optional, minus
 * `glAccountId`/`isActive`: the control-account link is immutable via this endpoint (it is set
 * once, atomically, at create time -- see CustomersService.create's header comment), and
 * activation state has its own endpoint (POST /customers/:id/deactivate) so a single flag isn't
 * reachable from two different write paths with two different permission checks. Mirrors
 * UpdateSupplierSchema (purchasing/api/dto/supplier.dto.ts) field-for-field.
 */
export const UpdateCustomerSchema = z
  .object({
    code: z.string().min(1).max(32).optional(),
    name: z.string().min(1).max(160).optional(),
    nameUr: z.string().max(160).optional(),
    phone: z.string().max(32).optional(),
    mobile: z.string().max(32).optional(),
    email: z.string().email().max(190).optional(),
    addressLine1: z.string().max(255).optional(),
    addressLine2: z.string().max(255).optional(),
    city: z.string().max(80).optional(),
    ntnNo: z.string().max(24).optional(),
    cnicNo: z.string().max(20).optional(),
    // Rule M (17 §6.1): decimal string, never a JS number.
    creditLimitAmount: zDecimalString("creditLimitAmount").optional(),
    creditDays: z.number().int().min(0).max(365).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export class UpdateCustomerDto extends createZodDto(UpdateCustomerSchema) {}

/** POST /customers/:id/deactivate. `reason` mirrors DeactivateSupplierSchema's request field
 *  for the audit trail but there is no column on `customer` to persist free-text deactivation
 *  reasons -- same accepted-but-not-stored treatment as SupplierService.deactivate's `reason`. */
export const DeactivateCustomerSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});
export class DeactivateCustomerDto extends createZodDto(DeactivateCustomerSchema) {}

/** GET /customers/:id/ledger -- optional posting-date window plus offset/limit pagination. Kept
 *  in this file's own coerced-with-defaults style (see ListCustomersQuerySchema above) rather
 *  than SupplierLedgerQueryDto's optional-with-service-side-defaults style, for consistency
 *  within this module. */
export const CustomerLedgerQuerySchema = z.object({
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export class CustomerLedgerQueryDto extends createZodDto(CustomerLedgerQuerySchema) {}
