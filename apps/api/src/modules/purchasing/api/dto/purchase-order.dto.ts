// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T82/§T83 (purchase_order,
// purchase_order_line); 17-technical-blueprint.md §9.3 layer 1 (Edge), §6.3 boundary 3 -- money/
// qty fields are decimal STRINGS on the wire (Rule M), same convention as
// purchase-invoice.dto.ts's sibling schemas in this module.
//
// SCOPE: a purchase order is a commitment/intent document -- it never touches stock or posts to
// the GL (purchasing.ts's header comment: "purchase orders never post to the ledger; the
// financial document is the purchase_invoice they are received into"). No costing/lot/bonus-qty
// breakdown here, unlike purchase-invoice.dto.ts's lines -- just what the order actually commits
// to: itemId, the ordered quantity, and the agreed unit price (per PACK, matching purchasing.ts
// purchase_order_line.unit_price / UNIT_PRICE archetype).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString, zQuantity } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

/** Non-negative decimal-string (a purchase order's unit price is never negative). */
const zNonNegative = (label: string) =>
  zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

export const PurchaseOrderIdParamSchema = z.object({ id: zIntString });
export class PurchaseOrderIdParamDto extends createZodDto(PurchaseOrderIdParamSchema) {}

// purchasing.ts's `order_status` enum (open/partial/received/closed/cancelled) -- the PO-specific
// receiving-progress axis, distinct from docColumns()'s generic `status` (draft/confirmed/
// posted/cancelled/reversed) document-workflow axis. See purchase-order.service.ts's header
// comment for how the two axes are used together.
const ORDER_STATUSES = ["open", "partial", "received", "closed", "cancelled"] as const;
const DOC_STATUSES = ["draft", "confirmed", "posted", "cancelled", "reversed"] as const;

export const ListPurchaseOrdersQuerySchema = z.object({
  supplierId: zIntString.optional(),
  status: z.enum(DOC_STATUSES).optional(),
  orderStatus: z.enum(ORDER_STATUSES).optional(),
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListPurchaseOrdersQueryDto extends createZodDto(ListPurchaseOrdersQuerySchema) {}

export const PurchaseOrderLineInputSchema = z.object({
  itemId: z.number().int().positive(),
  /** Loose/base units committed to on this line -- no pack/bonus breakdown (that's a
   *  purchase-invoice-only concept; see this file's header comment). */
  qtyOrdered: zQuantity,
  /** Per PACK, matching purchase_order_line.unit_price (UNIT_PRICE archetype, §T83). */
  unitPrice: zNonNegative("unitPrice"),
});

export const CreatePurchaseOrderSchema = z.object({
  supplierId: z.number().int().positive(),
  documentDate: zDateString,
  /** purchase_order.expected_date -- when the supplier is expected to deliver. */
  expectedDate: zDateString.optional(),
  lines: z.array(PurchaseOrderLineInputSchema).min(1),
  notes: z.string().max(1000).optional(),
});
export class CreatePurchaseOrderDto extends createZodDto(CreatePurchaseOrderSchema) {}

/** POST /purchase-orders/:id/approve -- no body fields required; accepted for parity with
 *  stock-adjustment's ApproveAdjustmentDto (an optional free-text audit note, not persisted --
 *  purchase_order has no column to hold it, same gap that service documents). */
export const ApprovePurchaseOrderSchema = z.object({
  reason: z.string().max(500).optional(),
});
export class ApprovePurchaseOrderDto extends createZodDto(ApprovePurchaseOrderSchema) {}

/** POST /purchase-orders/:id/close -- no body fields required today; reserved shape for parity
 *  with approve/cancel. */
export const ClosePurchaseOrderSchema = z.object({
  reason: z.string().max(500).optional(),
});
export class ClosePurchaseOrderDto extends createZodDto(ClosePurchaseOrderSchema) {}

/** POST /purchase-orders/:id/cancel -- `cancelReasonId` is a real column (purchase_order.
 *  cancel_reason_id, docColumns() pack DOC, soft ref -> option_item list `cancel_reason`, same
 *  soft-FK convention as every other DOC-pack column per _shared.ts's header comment). */
export const CancelPurchaseOrderSchema = z.object({
  cancelReasonId: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
});
export class CancelPurchaseOrderDto extends createZodDto(CancelPurchaseOrderSchema) {}

export type PurchaseOrderLineInput = z.infer<typeof PurchaseOrderLineInputSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof CreatePurchaseOrderSchema>;
