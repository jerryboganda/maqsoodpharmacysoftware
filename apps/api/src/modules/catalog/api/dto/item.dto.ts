// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge). Mostly read-only catalog surface --
// full item CREATE and the item_category/generic_item/manufacturer/dosage_form reference tables
// remain out of scope (see items.service.ts's header comment); this module now also carries the
// narrow edit surface for an EXISTING item's own already-populated fields (name/pricing/etc) and
// the deactivate action, per the same task that added those to items.controller.ts.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString4dp } from "../../../../common/validation/money-schemas.js";
import { VisibilityScopeSchema } from "./visibility.dto.js";

const zId = z.coerce.number().int().positive();

/** Non-negative UNIT_PRICE/QUANTITY-archetype (DECIMAL(15,4)) decimal-string (Rule M) -- prices
 *  and stock-level thresholds on an item are never negative. Passed straight through to the DB
 *  as a string; no Money/Quantity value-object arithmetic happens on this endpoint. */
const zNonNegativeDecimal4dp = (label: string) =>
  zDecimalString4dp(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);
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
  // R1.7 (18-api-plan.md): "Every catalogue-reading endpoint accepts includeHidden=true, and
  // every collection reports meta.hiddenByVisibility -- hidden must never mean unreachable." Only
  // takes effect when `scope` is also given -- omitting `scope` preserves this endpoint's exact
  // prior behaviour (isActive-only filtering) for any existing caller that doesn't know about
  // per-scope visibility yet.
  scope: VisibilityScopeSchema.optional(),
  includeHidden: zBoolFlag,
});
export class ListItemsQueryDto extends createZodDto(ListItemsQuerySchema) {}

/**
 * PATCH /items/:id -- edits an existing item's own already-populated fields. Deliberately
 * excludes `isActive` (that is the separate, separately-permissioned `POST /items/:id/deactivate`
 * action below -- see permissions.ts's ACTION_KEYS comment on why) and every FK-shaped attribute
 * the class comment in catalog.ts's `items` table defers to a future catalog-support module
 * (category/class/generic/manufacturer/dosage form/uom/tax schedule/hs code), plus `avgUnitCost`
 * (catalog.ts: "Maintained only by the costing service; never edited directly") and `legacyId`
 * (reconciliation key, not a business field). All fields optional, but at least one must be
 * supplied -- an empty PATCH is a caller bug, not a no-op.
 */
export const PatchItemSchema = z
  .object({
    customCode: z.string().min(1).max(75).optional(),
    name: z.string().min(1).max(160).optional(),
    nameLocal: z.string().max(255).optional(),
    registrationNo: z.string().max(64).optional(),
    packUnits: z.coerce.number().int().min(1).max(65535).optional(),
    allowDecimalQty: z.boolean().optional(),
    salePrice: zNonNegativeDecimal4dp("salePrice").optional(),
    purchasePrice: zNonNegativeDecimal4dp("purchasePrice").optional(),
    minQty: zNonNegativeDecimal4dp("minQty").optional(),
    maxQty: zNonNegativeDecimal4dp("maxQty").optional(),
    reorderQty: zNonNegativeDecimal4dp("reorderQty").optional(),
    hasExpiry: z.boolean().optional(),
    expiryCaptureMode: z.enum(["required", "prompt", "off"]).optional(),
    shelfLifeDays: z.coerce.number().int().min(0).max(65535).optional(),
    storageLocation: z.string().max(100).optional(),
    isControlledDrug: z.boolean().optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field must be supplied." });
export class PatchItemDto extends createZodDto(PatchItemSchema) {}
