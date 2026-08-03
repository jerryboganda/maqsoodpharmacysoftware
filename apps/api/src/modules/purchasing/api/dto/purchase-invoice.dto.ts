// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge), §6.3 boundary 3 -- money/qty
// fields are decimal STRINGS on the wire (Rule M), validated via common/validation/
// money-schemas.ts helpers, parsed into value objects only inside the application service.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { zDecimalString } from "../../../../common/validation/money-schemas.js";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

/** Non-negative decimal-string (quantities/prices on a purchase are never negative). */
const zNonNegative = (label: string) =>
  zDecimalString(label).refine((v) => !v.startsWith("-"), `${label} cannot be negative`);

export const PurchaseInvoiceIdParamSchema = z.object({ id: zIntString });
export class PurchaseInvoiceIdParamDto extends createZodDto(PurchaseInvoiceIdParamSchema) {}

export const ListPurchaseInvoicesQuerySchema = z.object({
  supplierId: zIntString.optional(),
  status: z.enum(["draft", "confirmed", "posted", "cancelled", "reversed"]).optional(),
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListPurchaseInvoicesQueryDto extends createZodDto(ListPurchaseInvoicesQuerySchema) {}

export const PurchaseInvoiceLineInputSchema = z.object({
  itemId: z.number().int().positive(),
  qtyPack: zNonNegative("qtyPack"),
  qtyLoose: zNonNegative("qtyLoose").optional(),
  qtyBonus: zNonNegative("qtyBonus").optional(),
  /** Per PACK (§T78/§T31 -- pack-based price basis, 08 §5.2 Verified). */
  unitPurchasePrice: zNonNegative("unitPurchasePrice"),
  /** Per PACK, after supplier line discounts -- the costing basis when cost_basis='net_rate'
   *  (C-4). Defaults to unitPurchasePrice when absent. */
  netRate: zNonNegative("netRate").optional(),
  unitSalePrice: zNonNegative("unitSalePrice").optional(),
  batchNo: z.string().min(1).max(64).optional(),
  expiryDate: zDateString.optional(),
  expiryStatus: z.enum(["known", "unknown", "not_applicable"]).optional(),
  discountPercent: zNonNegative("discountPercent").optional(),
});

export const CreatePurchaseInvoiceSchema = z.object({
  supplierId: z.number().int().positive(),
  purchaseCategoryId: z.number().int().positive().optional(),
  supplierInvoiceNo: z.string().min(1).max(64).optional(),
  documentDate: zDateString,
  /** Per-document costing-basis switch (C-4, replaces legacy UpdateAvgPriceWithNetRate). */
  costBasis: z.enum(["net_rate", "gross_price"]).default("net_rate"),
  lines: z.array(PurchaseInvoiceLineInputSchema).min(1),
  notes: z.string().max(1000).optional(),
});
export class CreatePurchaseInvoiceDto extends createZodDto(CreatePurchaseInvoiceSchema) {}

export type PurchaseInvoiceLineInput = z.infer<typeof PurchaseInvoiceLineInputSchema>;
export type CreatePurchaseInvoiceInput = z.infer<typeof CreatePurchaseInvoiceSchema>;
