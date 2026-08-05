// Blueprint: docs/system-analysis/05a-workflows-sales.md (cash sale S-1);
// 17-technical-blueprint.md §6.3/§6.7 -- every money/qty field is a decimal STRING (Rule M),
// validated by regex at the wire and parsed through @pharmacy/money in the service, never
// `Number()`.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString, zDecimalString4dp } from "../../../../common/validation/index.js";

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SaleInvoiceIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export class SaleInvoiceIdParamDto extends createZodDto(SaleInvoiceIdParamSchema) {}

export const ListSaleInvoicesQuerySchema = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  status: z.enum(["draft", "confirmed", "posted", "cancelled", "reversed"]).optional(),
  dateFrom: z.string().regex(BUSINESS_DATE_RE, "dateFrom must be YYYY-MM-DD").optional(),
  dateTo: z.string().regex(BUSINESS_DATE_RE, "dateTo must be YYYY-MM-DD").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export class ListSaleInvoicesQueryDto extends createZodDto(ListSaleInvoicesQuerySchema) {}

const SaleLineSchema = z.object({
  itemId: z.number().int().positive(),
  /** Requested quantity in LOOSE units (08 §5.2 -- unit price is per loose unit). */
  qty: zDecimalString("qty"),
  /** Per-LOOSE-unit sale price. Optional -- see the service's price-resolution rules.
   *  sale_invoice_line.unit_sale_price is DECIMAL(15,4) (UNIT_PRICE archetype) -- validated at
   *  that exact scale, not the wider 5dp `zDecimalString` ceiling. */
  unitSalePrice: zDecimalString4dp("unitSalePrice").optional(),
  /** Discounts are a later increment (rounding ladder M-5) -- any non-zero value is a 422. */
  discountPercent: zDecimalString("discountPercent").optional(),
  itemFlatDiscount: zDecimalString("itemFlatDiscount").optional(),
  /** U-062/D18/R7 (docs/system-analysis/00b-owner-decisions-and-requirements.md): one free-text
   *  field the frontend surfaces only when this line's item is `is_controlled_drug`, per R7's
   *  design commitment ("one extra, clearly-labelled field at the point it's already being rung
   *  up"). Never required and never validated against any invented rule -- the exact record DRAP
   *  requires is still open pending pharmacist/regulatory consultant sign-off. Accepted for ANY
   *  line (not just controlled ones) since enforcing the flag here would itself be inventing a
   *  requirement; sale-invoices.service.ts persists it verbatim on sale_invoice_line.*/
  dispensingNote: z.string().max(500).optional(),
});

const SalePaymentSchema = z.object({
  paymentMethodId: z.number().int().positive(),
  amount: zDecimalString("amount"),
  referenceNo: z.string().max(64).optional(),
});

export const CreateSaleInvoiceSchema = z.object({
  /** Defaults to the seeded walk-in customer (00b D5) when omitted. */
  customerId: z.number().int().positive().optional(),
  /** Defaults to the tenant's default sale category (seed: CASH_SALE). */
  saleCategoryId: z.number().int().positive().optional(),
  documentDate: z.string().regex(BUSINESS_DATE_RE, "documentDate must be YYYY-MM-DD"),
  lines: z.array(SaleLineSchema).min(1).max(200),
  payments: z.array(SalePaymentSchema).min(1).max(10),
  /** Header discounts: same not-implemented gate as line discounts. */
  invoiceDiscountPercent: zDecimalString("invoiceDiscountPercent").optional(),
  invoiceDiscountAmount: zDecimalString("invoiceDiscountAmount").optional(),
  notes: z.string().max(1000).optional(),
});
/** POST /sale-invoices AND POST /sale-invoices/preview share this exact body shape -- a preview
 *  is "the same would-be sale", just not written (SaleInvoicesService.preview reuses
 *  createCashSale's own computeSale() rather than a parallel DTO). */
export class CreateSaleInvoiceDto extends createZodDto(CreateSaleInvoiceSchema) {}

/** POST /sale-invoices/:id/cancel -- only reachable when no `sale_return` already references this
 *  invoice (SaleInvoicesService.cancel's own 422 otherwise -- use reverse instead). Mirrors
 *  payments/api/dto/payment.dto.ts's CancelPaymentSchema shape exactly: `reason` is accepted for
 *  the audit trail / journal reversalReason, `cancelReasonId` is a soft-ref option-list id (list
 *  `cancel_reason`, not validated against that list this increment -- same treatment
 *  CancelPaymentSchema documents for its own identical field). */
export const CancelSaleInvoiceSchema = z.object({
  cancelReasonId: z.number().int().positive().optional(),
  reason: z.string().min(1).max(500).optional(),
});
export class CancelSaleInvoiceDto extends createZodDto(CancelSaleInvoiceSchema) {}
export type CancelSaleInvoiceInput = z.infer<typeof CancelSaleInvoiceSchema>;

/** POST /sale-invoices/:id/reverse -- an unconditional compensating entry, reachable even when a
 *  sale_return already references the invoice (unlike cancel). No `cancelReasonId` -- a reversal
 *  is not a cancellation; only `reason` (-> the reversing journal entry's `reversalReason`)
 *  applies. */
export const ReverseSaleInvoiceSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});
export class ReverseSaleInvoiceDto extends createZodDto(ReverseSaleInvoiceSchema) {}
export type ReverseSaleInvoiceInput = z.infer<typeof ReverseSaleInvoiceSchema>;
