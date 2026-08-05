// Per-report filter shapes. RunReportBodySchema (api/dto/report.dto.ts) only validates that
// `filters` is a JSON object -- each report interprets its own shape, per the task instruction,
// so that interpretation (and its 422 REPORT.FILTER_INVALID on bad input) lives here rather than
// in the wire DTO, which cannot discriminate on the `reportId` path param.
import { z } from "zod";

import { BusinessRuleException } from "../../../common/errors/index.js";
import { DECIMAL_RE } from "../../../common/validation/money-schemas.js";

const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");
const zId = z.number().int().positive();

export const SalesSummaryFiltersSchema = z.object({
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  groupBy: z.enum(["date", "item", "customer"]).default("date"),
  customerId: zId.optional(),
  itemId: zId.optional(),
});

export const PurchaseSummaryFiltersSchema = z.object({
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  groupBy: z.enum(["date", "item", "supplier"]).default("date"),
  supplierId: zId.optional(),
  itemId: zId.optional(),
});

export const StockValuationFiltersSchema = z.object({
  groupBy: z.enum(["item", "branch"]).default("item"),
  itemId: zId.optional(),
});

export const ExpiryReportFiltersSchema = z.object({
  itemId: zId.optional(),
});

export const ReorderLevelFiltersSchema = z.object({
  itemId: zId.optional(),
});

export const ApAgingFiltersSchema = z.object({
  supplierId: zId.optional(),
  /** Overrides "today" for the overdue-days computation -- reproducible aging as-of a past date. */
  asOfDate: zDateString.optional(),
});

export const ArAgingFiltersSchema = z.object({
  customerId: zId.optional(),
  asOfDate: zDateString.optional(),
});

/** Wave 8 (U-062/D18/R7): the "controlled-medicines register" the owner asked whether the new
 *  system should keep (14-unknowns-and-questions.md question 30) -- see reports.service.ts's
 *  `runControlledDrugRegister` for what it actually reports and does not invent. */
export const ControlledDrugRegisterFiltersSchema = z.object({
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  itemId: zId.optional(),
});

export const LowStockFiltersSchema = z.object({
  itemId: zId.optional(),
  /** Decimal STRING (Rule M) -- defaults to "20.0000" (PharmacyDashboardPage.svelte's committed
   *  "< 20 units" convention, frontend repo E:\Pharma Software\frontend, git show
   *  HEAD:src/lib/components/pharmacy/PharmacyDashboardPage.svelte) when omitted. */
  thresholdQty: z.string().regex(DECIMAL_RE, "thresholdQty must be a decimal string").optional(),
});

/** Parses `raw` (the wire-level `filters` object) against `schema`, converting a Zod failure into
 *  the module's own 422 REPORT.FILTER_INVALID shape (field-level errors, not a raw Zod error). */
export function parseFilters<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const result = schema.safeParse(raw ?? {});
  if (result.success) return result.data;

  const errors = result.error.issues.map((issue) => ({
    path: `filters${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}`,
    code: "REPORT.FILTER_INVALID",
    message: issue.message,
  }));
  throw new BusinessRuleException(
    "REPORT.FILTER_INVALID",
    "Invalid report filters",
    `The filters supplied for this report are invalid: ${result.error.issues.map((i) => i.message).join("; ")}`,
    errors,
  );
}
