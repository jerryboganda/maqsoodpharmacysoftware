// Stock-take DTOs. Endpoint shapes follow the task instruction's explicit 7-endpoint list, cross-
// checked against 18-api-plan.md §2.6 (the closest published spec) where the two agree; the
// service's own header comment documents the handful of places this task's list overrides §2.6
// (most notably: a distinct materialise-the-count-sheet step, and a header status lifecycle that
// isn't pack DOC's draft/confirmed/posted/cancelled/reversed). Same wire rule as
// stock-adjustment.dto.ts: quantities cross the wire as decimal strings, never JSON numbers
// (Rule M, §6.7) -- `zQuantity` parses into the `Quantity` value object.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zQuantity } from "../../../../common/validation/money-schemas.js";

const zDateYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a business date like "2026-08-03"');

/** POST /stock-takes -- create a draft count session, optionally scoped to one item. */
export const CreateStockTakeSchema = z.object({
  documentDate: zDateYmd,
  scopeItemId: z.number().int().positive().optional(),
  // `item_category` doesn't exist in this package yet (catalog.ts's own TODO(blueprint) marker
  // on `item.item_category_id` -- inventory.ts's stockTakes doc comment repeats the same
  // deferral). Accepted and stored now so the DTO shape does not change once that table lands;
  // NOT YET applied as a live filter by `generateCountSheet` -- see that method's comment.
  scopeCategoryId: z.number().int().positive().optional(),
  notes: z.string().max(1000).optional(),
});
export class CreateStockTakeDto extends createZodDto(CreateStockTakeSchema) {}

export const StockTakeIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export class StockTakeIdParamDto extends createZodDto(StockTakeIdParamSchema) {}

export const StockTakeListQuerySchema = z.object({
  status: z.enum(["draft", "counting", "reviewed", "closed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export class StockTakeListQueryDto extends createZodDto(StockTakeListQuerySchema) {}

/** PUT /stock-takes/:id/lines -- one submitted count. Identified by (itemId, stockLotId), the
 *  same pair `generateCountSheet` used to materialise the line -- there is no lot-less counting
 *  in this module (inventory.ts's stockTakeLines doc comment explains why lot identity is
 *  mandatory here, mirroring stock_adjustment_line). */
const CountLineInputSchema = z.object({
  itemId: z.number().int().positive(),
  stockLotId: z.number().int().positive(),
  qtyCounted: zQuantity,
  // What the counter physically found, when it differs from the system's batch record --
  // recorded as a finding, never silently applied to the lot (see the schema comment). Sentinel-
  // date rejection (18-api-plan.md §2.6's "`capturedExpiryDate` rejects sentinels") is not
  // implemented here -- this package has no shared sentinel-date validator yet (only
  // purchase-invoice.service.ts's §T56 *generated-column* sentinels, a different, DB-side
  // concern); a real wire-level check belongs in a follow-up alongside that validator, not
  // invented ad hoc for this one field.
  capturedBatchNo: z.string().max(40).optional(),
  capturedExpiryDate: zDateYmd.optional(),
  notes: z.string().max(255).optional(),
});
export const RecordCountsSchema = z.object({
  lines: z
    .array(CountLineInputSchema)
    .min(1, "at least one counted line is required")
    .max(1000, "at most 1,000 lines per call"),
});
export class RecordCountsDto extends createZodDto(RecordCountsSchema) {}

/** GET /stock-takes/:id/variance -- `minVarianceQty` filters to lines whose |variance| is at
 *  least this much (e.g. hide noise from +/-1 loose-unit miscounts on a large take). */
export const VarianceQuerySchema = z.object({
  minVarianceQty: zQuantity.optional(),
});
export class VarianceQueryDto extends createZodDto(VarianceQuerySchema) {}

/** POST /stock-takes/:id/generate-adjustments -- `adjustmentReasonId` should normally be a
 *  direction `'both'` reason (e.g. the seeded `COUNT_CORRECTION`, the default `adjustment_reason`
 *  row) since a take with variance in both directions produces one increase AND one decrease
 *  document sharing this same reason id; a direction-restricted reason simply fails whichever
 *  document it doesn't cover, via `StockAdjustmentService`'s own existing validation (no special
 *  case needed here). */
export const GenerateAdjustmentsSchema = z.object({
  adjustmentReasonId: z.number().int().positive(),
  postingDate: zDateYmd.optional(),
  notes: z.string().max(1000).optional(),
});
export class GenerateAdjustmentsDto extends createZodDto(GenerateAdjustmentsSchema) {}

export const CloseStockTakeSchema = z.object({
  reason: z.string().max(500).optional(),
});
export class CloseStockTakeDto extends createZodDto(CloseStockTakeSchema) {}
