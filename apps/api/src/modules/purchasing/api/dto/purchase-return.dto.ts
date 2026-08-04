// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge), §6.3 boundary 3 -- money/qty
// fields are decimal STRINGS on the wire (Rule M), validated via common/validation/
// money-schemas.ts helpers, parsed into value objects only inside the application service.
// Mirrors purchase-invoice.dto.ts's shape; a purchase return is the reverse-direction sibling
// of a purchase invoice (§T80/§T81), not a different DTO pattern.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

/** Non-negative decimal-string (quantities/costs on a return are never negative). */
const zNonNegative = (label: string) =>
  zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

/** AVG_COST-scale (5dp) override -- mirrors stock-adjustment.dto.ts's `zUnitCost`: stored
 *  verbatim at the item's costing scale, never wrapped in Money (which is 2dp). */
const zUnitCost = z
  .string()
  .regex(/^\d{1,10}(?:\.\d{1,5})?$/, 'unitCost must be a non-negative decimal string, e.g. "12.50000"');

export const PurchaseReturnIdParamSchema = z.object({ id: zIntString });
export class PurchaseReturnIdParamDto extends createZodDto(PurchaseReturnIdParamSchema) {}

export const ListPurchaseReturnsQuerySchema = z.object({
  supplierId: zIntString.optional(),
  purchaseInvoiceId: zIntString.optional(),
  status: z.enum(["draft", "confirmed", "posted", "cancelled", "reversed"]).optional(),
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListPurchaseReturnsQueryDto extends createZodDto(ListPurchaseReturnsQuerySchema) {}

export const PurchaseReturnLineInputSchema = z.object({
  itemId: z.number().int().positive(),
  /** Which stock lot the returned goods come out of -- same shape as
   *  stock-adjustment.dto.ts's `stockLotId` (not a fresh lot: returns never create one). */
  stockLotId: z.number().int().positive(),
  /** Loose units, flat (no pack/bonus split) -- the same simplification
   *  sale-invoices.service.ts makes for its line `qty` (a return line is a single quantity
   *  coming out of one named lot, not a fresh receipt that needs qtyPack/qtyLoose/qtyBonus
   *  broken out). */
  returnQty: zNonNegative("returnQty"),
  /** Defaults to the original purchase-invoice line's unit_cost_in when omitted (service-side;
   *  see purchase-return.service.ts's header comment on why costing is never re-averaged). */
  unitCost: zUnitCost.optional(),
});

export const CreatePurchaseReturnSchema = z.object({
  supplierId: z.number().int().positive(),
  /** The original goods-receipt document being returned against; must belong to `supplierId`
   *  and be posted (validated service-side). */
  purchaseInvoiceId: z.number().int().positive(),
  /** Optional: defaults to the tenant's default RETURN-flagged purchase category. Required
   *  when none is marked default (service-side 422, same shape as
   *  purchase-invoice.service.ts's PURCHASE.NO_DEFAULT_CATEGORY). */
  purchaseCategoryId: z.number().int().positive().optional(),
  /** Soft ref -> option_item list `purchase_return_reason` (purchasing.ts's header comment);
   *  not validated against that list this increment, same soft-ref treatment as cancelReasonId
   *  elsewhere in the schema. */
  reasonId: z.number().int().positive().optional(),
  documentDate: zDateString,
  lines: z.array(PurchaseReturnLineInputSchema).min(1),
  notes: z.string().max(1000).optional(),
});
export class CreatePurchaseReturnDto extends createZodDto(CreatePurchaseReturnSchema) {}

export type PurchaseReturnLineInput = z.infer<typeof PurchaseReturnLineInputSchema>;
export type CreatePurchaseReturnInput = z.infer<typeof CreatePurchaseReturnSchema>;
