// Read-side query DTOs (18-api-plan.md §2.4). Query strings arrive as strings -- coerce ids and
// limits at the edge; nothing here is money (Rule M applies to the adjustment DTOs instead).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const zId = z.coerce.number().int().positive();
const zLimit = z.coerce.number().int().min(1).max(500).default(50);
const zOffset = z.coerce.number().int().min(0).default(0);
// `.optional()` must be OUTERMOST: ZodOptional short-circuits on `undefined` before invoking
// the inner schema, so an absent query param stays `undefined`. `.enum(...).optional()
// .transform(...)` (the previous order here) instead runs the transform on `undefined` itself
// (`undefined === "true"` -> `false`) -- harmless for `includeZero` only because its intended
// default happens to also be `false`; the same broken order in a filter with a different
// intended default (see catalog/api/dto/item.dto.ts's `isActive`) silently drops every row.
const zBoolFlag = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

export const StockListQuerySchema = z.object({
  itemId: zId.optional(),
  includeZero: zBoolFlag,
  limit: zLimit,
  offset: zOffset,
});
export class StockListQueryDto extends createZodDto(StockListQuerySchema) {}

export const MovementListQuerySchema = z.object({
  itemId: zId.optional(),
  stockLotId: zId.optional(),
  limit: zLimit,
  afterId: zId.optional(),
});
export class MovementListQueryDto extends createZodDto(MovementListQuerySchema) {}

export const LotListQuerySchema = z.object({
  itemId: zId.optional(),
  lotStatus: z.enum(["available", "quarantined", "expired", "recalled", "consumed"]).optional(),
  limit: zLimit,
  offset: zOffset,
});
export class LotListQueryDto extends createZodDto(LotListQuerySchema) {}
