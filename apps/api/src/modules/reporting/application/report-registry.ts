// GET /reports -- a hardcoded-in-code registry (task's own explicit instruction: "simplest
// correct choice for a first version", not DB-driven). Each entry names a reportId POST
// /reports/{reportId}/run dispatches to (ReportsService.run's switch); the two lists are kept in
// sync by hand today (a small, fixed set -- 8 reports).
//
// PERMISSION FILTERING (documented simplification, per the task's own explicit fallback):
// PermissionsService.can(actor, required) exists as the codebase's established precedent for a
// "can this actor do X" check outside the route-level @RequirePermission guard (see its own file
// header) -- but every report here shares the exact same "report:list"/"report:view" grant (the
// seeded permission grid, packages/db/scripts/seed.ts, has no per-report permission key), so
// calling PermissionsService.can() once per report in this list would just re-check the identical
// grant @RequirePermission("report","list") already enforced at the route for the whole request.
// There is nothing to differentiate per-report yet. GET /reports therefore returns the full
// registry to any caller who already cleared the route guard; per-report filtering is deferred
// until a real per-report permission key exists (tracked here, not silently skipped).
export interface ReportDefinition {
  readonly reportId: string;
  readonly title: string;
  readonly description: string;
  readonly group: "sales" | "purchase" | "inventory" | "finance";
}

export const REPORT_DEFINITIONS: readonly ReportDefinition[] = [
  {
    reportId: "sales-summary",
    title: "Sales summary",
    description: "Net sales amount and invoice count for posted sale invoices, grouped by date, item, or customer.",
    group: "sales",
  },
  {
    reportId: "purchase-summary",
    title: "Purchase summary",
    description: "Net purchase amount and invoice count for posted purchase invoices, grouped by date, item, or supplier.",
    group: "purchase",
  },
  {
    reportId: "stock-valuation",
    title: "Stock valuation",
    description: "Current on-hand quantity valued at the moving-average unit cost, per item (or a branch total).",
    group: "inventory",
  },
  {
    reportId: "expiry-report",
    title: "Expiry report",
    description: "Lots with stock on hand, bucketed by days to expiry, with count and valuation per bucket.",
    group: "inventory",
  },
  {
    reportId: "reorder-level",
    title: "Reorder level",
    description: "Items at or below their configured reorder quantity.",
    group: "inventory",
  },
  {
    reportId: "ap-aging",
    title: "Accounts payable aging",
    description: "Outstanding balance owed to each supplier on posted purchase invoices, bucketed by days overdue.",
    group: "finance",
  },
  {
    reportId: "ar-aging",
    title: "Accounts receivable aging",
    description: "Outstanding balance owed by each customer on posted sale invoices, bucketed by days overdue.",
    group: "finance",
  },
  {
    reportId: "low-stock",
    title: "Low stock",
    description: "Items with on-hand quantity below a configurable threshold (default 20 units).",
    group: "inventory",
  },
] as const;
