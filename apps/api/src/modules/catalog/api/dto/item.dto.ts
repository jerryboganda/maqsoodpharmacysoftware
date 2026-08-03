// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge). Read-only catalog surface -- the
// item master itself (creation/pricing edits) is out of scope for this increment; this module
// exists so purchase/sale invoice screens have something to search and pick an itemId from.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const zId = z.coerce.number().int().positive();
const zLimit = z.coerce.number().int().min(1).max(500).default(50);
const zOffset = z.coerce.number().int().min(0).default(0);
// `.optional()` must be OUTERMOST: ZodOptional short-circuits on `undefined` before invoking
// the inner schema at all, so an absent query param stays `undefined`. Doing `.enum(...)
// .optional().transform(...)` (as this used to read) instead runs the transform on `undefined`
// itself (`undefined === "true"` -> `false`), silently turning "param not given" into
// "isActive=false" -- exactly the query-none-means-filter-everything-out bug that made a plain
// GET /items return zero rows despite two active seeded items.
const zBoolFlag = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

export const ItemIdParamSchema = z.object({ id: zId });
export class ItemIdParamDto extends createZodDto(ItemIdParamSchema) {}

export const ListItemsQuerySchema = z.object({
  q: z.string().min(1).max(160).optional(),
  isActive: zBoolFlag,
  limit: zLimit,
  offset: zOffset,
});
export class ListItemsQueryDto extends createZodDto(ListItemsQuerySchema) {}
