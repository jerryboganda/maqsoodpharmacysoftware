// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge) -- zod DTOs, reject never coerce.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Positive integer expressed as a route/query string -- parsed, never coerced. */
const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const SupplierIdParamSchema = z.object({ id: zIntString });
export class SupplierIdParamDto extends createZodDto(SupplierIdParamSchema) {}

export const ListSuppliersQuerySchema = z.object({
  q: z.string().min(1).max(160).optional(),
  isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListSuppliersQueryDto extends createZodDto(ListSuppliersQuerySchema) {}

export const CreateSupplierSchema = z.object({
  name: z.string().min(1).max(160),
  /** Optional user-facing code; derived from the name when absent. */
  code: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).optional(),
  nameUr: z.string().max(160).optional(),
  ntnNo: z.string().max(24).optional(),
  strnNo: z.string().max(24).optional(),
  cnicNo: z.string().max(20).optional(),
  phone: z.string().max(32).optional(),
  mobile: z.string().max(32).optional(),
  email: z.string().email().max(190).optional(),
  addressLine1: z.string().max(255).optional(),
  addressLine2: z.string().max(255).optional(),
  city: z.string().max(80).optional(),
  creditDays: z.number().int().min(0).max(3650).optional(),
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  specialInstructions: z.string().max(4000).optional(),
});
export class CreateSupplierDto extends createZodDto(CreateSupplierSchema) {}

/**
 * PATCH /suppliers/:id -- every editable field from `CreateSupplierSchema`, all optional, minus
 * `glAccountId`/`isActive`: the control-account link is immutable via this endpoint (it is set
 * once, atomically, at create time -- see SupplierService.create's header comment), and
 * activation state has its own endpoint (POST /suppliers/:id/deactivate) so a single flag isn't
 * reachable from two different write paths with two different permission checks.
 */
export const UpdateSupplierSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    code: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).optional(),
    nameUr: z.string().max(160).optional(),
    ntnNo: z.string().max(24).optional(),
    strnNo: z.string().max(24).optional(),
    cnicNo: z.string().max(20).optional(),
    phone: z.string().max(32).optional(),
    mobile: z.string().max(32).optional(),
    email: z.string().email().max(190).optional(),
    addressLine1: z.string().max(255).optional(),
    addressLine2: z.string().max(255).optional(),
    city: z.string().max(80).optional(),
    creditDays: z.number().int().min(0).max(3650).optional(),
    leadTimeDays: z.number().int().min(0).max(3650).optional(),
    specialInstructions: z.string().max(4000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export class UpdateSupplierDto extends createZodDto(UpdateSupplierSchema) {}

/** POST /suppliers/:id/deactivate. `reason` mirrors the API plan's request field for the audit
 *  trail but there is no column on `supplier` to persist free-text deactivation reasons -- same
 *  accepted-but-not-stored treatment as StockAdjustmentService.approve's `reason` parameter. */
export const DeactivateSupplierSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});
export class DeactivateSupplierDto extends createZodDto(DeactivateSupplierSchema) {}

/** GET /suppliers/:id/ledger -- optional posting-date window plus offset/limit pagination,
 *  matching ListPurchaseInvoicesQueryDto's dateFrom/dateTo/offset/limit shape (purchase-
 *  invoice.dto.ts) so the two purchasing-module list endpoints read the same way on the wire. */
export const SupplierLedgerQuerySchema = z.object({
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class SupplierLedgerQueryDto extends createZodDto(SupplierLedgerQuerySchema) {}
