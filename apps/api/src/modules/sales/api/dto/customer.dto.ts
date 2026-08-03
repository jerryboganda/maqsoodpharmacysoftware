// Blueprint: docs/system-analysis/17-technical-blueprint.md §6.3/§6.7 (money fields are decimal
// strings, never z.number()); 19-mysql-schema-blueprint.md §T28 `customer`.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/index.js";

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
