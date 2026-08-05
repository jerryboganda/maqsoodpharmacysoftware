// Blueprint: 18-api-plan.md §1.6/§1.7 `/admin/visibility/*`, `/items/:id/visibility`
// (R1, 00b-owner-decisions-and-requirements.md D7). Zod as the single validation source.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const VISIBILITY_SCOPES = ["pos", "purchase", "reports", "stock_list"] as const;
export const VisibilityScopeSchema = z.enum(VISIBILITY_SCOPES);
export type VisibilityScope = z.infer<typeof VisibilityScopeSchema>;

const VISIBILITY_SOURCES = ["default", "manual", "bulk", "preset"] as const;
export const VisibilitySourceSchema = z.enum(VISIBILITY_SOURCES);

export const ItemIdParamSchema = z.object({ itemId: z.coerce.number().int().positive() });
export class ItemIdParamDto extends createZodDto(ItemIdParamSchema) {}

export const BulkOperationIdParamSchema = z.object({ bulkOperationId: z.coerce.number().int().positive() });
export class BulkOperationIdParamDto extends createZodDto(BulkOperationIdParamSchema) {}

/** `GET /admin/visibility/items` -- the curation workbench. Lists `item_visibility` OVERRIDE rows
 *  (joined with the item's name for display), not the whole 30,052-item catalogue -- "what is
 *  hidden, where, and why" (18-api-plan.md) is a question about the override table, not every
 *  item (most of which have no row at all -- default visible, R1.2). */
export const VisibilityWorkbenchQuerySchema = z.object({
  scope: VisibilityScopeSchema.optional(),
  source: VisibilitySourceSchema.optional(),
  q: z.string().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export class VisibilityWorkbenchQueryDto extends createZodDto(VisibilityWorkbenchQuerySchema) {}

/** `PUT /items/:itemId/visibility` -- set per-scope visibility for one item. `isVisible: true`
 *  DELETES the override (R1.2 -- absence means visible, no redundant "true" rows); `false` upserts
 *  one, tagged `source: 'manual'`. */
export const SetItemVisibilitySchema = z.object({
  scopes: z.array(z.object({ scope: VisibilityScopeSchema, isVisible: z.boolean() })).min(1),
  reason: z.string().max(500).optional(),
});
export class SetItemVisibilityDto extends createZodDto(SetItemVisibilitySchema) {}

/** `POST /admin/visibility/bulk`. Selection is `itemIds[]` (explicit, safest) or `q` (a simple
 *  name/code substring match) -- a broader filter engine (category, manufacturer,
 *  never-stocked-since, ...) is exactly the saved-PRESET rule engine (R1.5), deliberately deferred
 *  as its own Wave 10 backlog item alongside role_scope/cashier-shifts (tracked, not dropped --
 *  see visibility.service.ts's own header comment). `dryRun: true` returns the live affected count
 *  (R1.5's "before anything happens" guarantee) and writes nothing. */
export const BulkVisibilitySchema = z
  .object({
    itemIds: z.array(z.number().int().positive()).max(10000).optional(),
    q: z.string().min(1).max(200).optional(),
    scopes: z.array(VisibilityScopeSchema).min(1),
    isVisible: z.boolean(),
    reason: z.string().min(10, "reason must be at least 10 characters -- a bulk action affecting many items needs a real explanation"),
    dryRun: z.boolean().optional().default(false),
  })
  .refine((v) => (v.itemIds !== undefined && v.itemIds.length > 0) || v.q !== undefined, {
    message: "either itemIds or q must be provided to select which items this bulk action affects",
  });
export class BulkVisibilityDto extends createZodDto(BulkVisibilitySchema) {}

export const UndoBulkVisibilitySchema = z.object({ reason: z.string().max(500).optional() });
export class UndoBulkVisibilityDto extends createZodDto(UndoBulkVisibilitySchema) {}

export const EffectiveVisibilityQuerySchema = z.object({ scope: VisibilityScopeSchema });
export class EffectiveVisibilityQueryDto extends createZodDto(EffectiveVisibilityQuerySchema) {}
