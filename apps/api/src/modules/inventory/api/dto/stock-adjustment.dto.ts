// Stock adjustment DTOs (18-api-plan.md §2.6). Rule M (§6.7): quantities/costs cross the wire
// as decimal STRINGS -- `zQuantity` parses into the Quantity value object; `unitCost` stays a
// validated string because it is stored verbatim at AVG_COST scale (5dp).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zQuantity } from "../../../../common/validation/money-schemas.js";

const zDateYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a business date like "2026-08-03"');

/** Non-negative unit cost at AVG_COST scale -- up to 5 decimals, never a JSON number. */
const zUnitCost = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,5})?$/, 'unitCost must be a non-negative decimal string, e.g. "12.50000"');

export const CreateAdjustmentLineSchema = z.object({
  itemId: z.number().int().positive(),
  stockLotId: z.number().int().positive(),
  qty: zQuantity,
  unitCost: zUnitCost.optional(),
  notes: z.string().max(255).optional(),
});

export const CreateAdjustmentSchema = z.object({
  direction: z.enum(["increase", "decrease"]),
  adjustmentReasonId: z.number().int().positive(),
  documentDate: zDateYmd,
  updateAvgCost: z.boolean().optional(),
  notes: z.string().max(1000).optional(),
  lines: z.array(CreateAdjustmentLineSchema).min(1, "an adjustment needs at least one line"),
});
export class CreateAdjustmentDto extends createZodDto(CreateAdjustmentSchema) {}

export const PostAdjustmentSchema = z.object({
  postingDate: zDateYmd.optional(),
});
export class PostAdjustmentDto extends createZodDto(PostAdjustmentSchema) {}

/** 18-api-plan.md §2.6 `/stock-adjustments/{id}/approve` -- `reason` is the only body field. */
export const ApproveAdjustmentSchema = z.object({
  reason: z.string().max(500).optional(),
});
export class ApproveAdjustmentDto extends createZodDto(ApproveAdjustmentSchema) {}

export const AdjustmentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export class AdjustmentIdParamDto extends createZodDto(AdjustmentIdParamSchema) {}

export const AdjustmentListQuerySchema = z.object({
  status: z.enum(["draft", "confirmed", "posted", "cancelled", "reversed"]).optional(),
  direction: z.enum(["increase", "decrease"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export class AdjustmentListQueryDto extends createZodDto(AdjustmentListQuerySchema) {}
