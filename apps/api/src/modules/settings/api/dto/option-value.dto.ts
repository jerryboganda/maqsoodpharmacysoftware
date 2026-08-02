// Blueprint: docs/system-analysis/17-technical-blueprint.md §10.2, §9.3 layer 1 (Edge).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const OptionSetKeyParamSchema = z.object({
  // e.g. "supplier_payment.method" -- module-dotted-concept, per §10.5's key naming.
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'must look like "module.concept", e.g. "sale.tender_method"'),
});
export class OptionSetKeyParamDto extends createZodDto(OptionSetKeyParamSchema) {}

export const OptionValueResponseSchema = z.object({
  optionValueId: z.string(),
  setKey: z.string(),
  code: z.string(),
  displayName: z.string(),
  helpText: z.string().nullable(),
  groupLabel: z.string().nullable(),
  sortOrder: z.number().int(),
  isDefault: z.boolean(),
  meta: z.record(z.unknown()).nullable(),
});
export class OptionValueResponseDto extends createZodDto(OptionValueResponseSchema) {}
