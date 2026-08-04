// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge), §6.3 boundary 3 -- money/qty
// fields are decimal STRINGS on the wire (Rule M), validated via common/validation/
// money-schemas.ts helpers, parsed into value objects only inside the application service.
// Mirrors purchase-return.dto.ts's shape (a sale return is the reverse-direction sibling of a
// cash sale, §T72/§T73), NOT sale-invoice.dto.ts's -- deliberately narrower than
// CreateSaleInvoiceSchema: no per-line stockLotId (sale-returns.service.ts resolves which lot(s)
// each return line refills from the original invoice's own lines, see its header comment), no
// saleCategoryId/refundMethodId (both are derived server-side from the referenced invoice, not
// re-asked of the caller -- see sale-returns.service.ts's header comment on refund-leg
// resolution).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zDateString = z.string().regex(BUSINESS_DATE_RE, "must be a YYYY-MM-DD date");

/** Non-negative decimal-string (a return quantity is never negative). */
const zNonNegative = (label: string) =>
  zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

export const SaleReturnIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export class SaleReturnIdParamDto extends createZodDto(SaleReturnIdParamSchema) {}

export const ListSaleReturnsQuerySchema = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  saleInvoiceId: z.coerce.number().int().positive().optional(),
  status: z.enum(["draft", "confirmed", "posted", "cancelled", "reversed"]).optional(),
  dateFrom: z.string().regex(BUSINESS_DATE_RE, "dateFrom must be YYYY-MM-DD").optional(),
  dateTo: z.string().regex(BUSINESS_DATE_RE, "dateTo must be YYYY-MM-DD").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export class ListSaleReturnsQueryDto extends createZodDto(ListSaleReturnsQuerySchema) {}

export const SaleReturnLineInputSchema = z.object({
  itemId: z.number().int().positive(),
  /** Loose units, flat (no pack/bonus split) -- same simplification purchase-return.dto.ts's
   *  `returnQty` makes. No `stockLotId`: which lot(s) this refills is resolved service-side
   *  against the original invoice's own sale_invoice_line rows for this item (never a fresh
   *  lot). */
  returnQty: zNonNegative("returnQty"),
});

export const CreateSaleReturnSchema = z.object({
  customerId: z.number().int().positive(),
  /** The original posted sale invoice being returned against; must belong to `customerId`
   *  (validated service-side). */
  saleInvoiceId: z.number().int().positive(),
  documentDate: zDateString,
  lines: z.array(SaleReturnLineInputSchema).min(1).max(200),
  notes: z.string().max(1000).optional(),
});
export class CreateSaleReturnDto extends createZodDto(CreateSaleReturnSchema) {}

export type SaleReturnLineInput = z.infer<typeof SaleReturnLineInputSchema>;
export type CreateSaleReturnInput = z.infer<typeof CreateSaleReturnSchema>;
