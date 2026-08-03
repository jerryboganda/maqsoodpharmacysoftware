// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge) -- zod DTOs, reject never coerce.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Positive integer expressed as a route/query string -- parsed, never coerced. */
const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

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
