// GET /metrics/definitions -- a small static catalogue of the metrics this module's reports and
// dashboard actually compute, in plain English, so a future report can't silently redefine "net
// sales" differently (the task's own stated reason for this endpoint). Low effort, real value:
// one row per metric actually used above, no schema/versioning/ownership machinery.
export interface MetricDefinition {
  readonly key: string;
  readonly title: string;
  readonly definition: string;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: "net_sales",
    title: "Net Sales",
    definition:
      "sale_invoice.net_amount: the invoice amount after line and invoice discounts, before sales tax, for status=\"posted\" invoices only. Used by the sales-summary report and the dashboard's todaysSalesTotal.",
  },
  {
    key: "net_purchase_amount",
    title: "Net Purchase Amount",
    definition:
      "purchase_invoice.net_amount: the invoice amount after line and invoice discounts, before sales tax and other charges, for status=\"posted\" invoices only. Used by the purchase-summary report.",
  },
  {
    key: "outstanding_balance",
    title: "Outstanding Balance",
    definition:
      "invoice_total - paid_amount (the balance_amount generated column) on a status=\"posted\" purchase_invoice or sale_invoice. Draft, cancelled and reversed documents never contribute. Used by ap-aging, ar-aging, and the dashboard's outstandingApTotal/outstandingArTotal.",
  },
  {
    key: "stock_valuation",
    title: "Stock Valuation",
    definition:
      "Sum of qty_on_hand x item.avg_unit_cost per item, using the item's current moving-average cost (not its original purchase price or sale price). Used by the stock-valuation report.",
  },
  {
    key: "expiry_value_at_risk",
    title: "Expiry Value at Risk",
    definition:
      "Stock valuation (qty_on_hand x avg_unit_cost) restricted to lots with stock on hand whose expiry_date falls within 90 days of today, including already-expired lots. Used by the expiry-report and the dashboard's expiryValueAtRisk.",
  },
  {
    key: "low_stock",
    title: "Low Stock",
    definition:
      "An item whose total on-hand quantity (summed across lots) is greater than zero and below a threshold quantity, default 20 units (matching the legacy dashboard's own \"< 20 units\" convention). Used by the low-stock report and the dashboard's lowStockCount.",
  },
  {
    key: "reorder_level",
    title: "Reorder Level",
    definition:
      "An item whose total on-hand quantity is at or below its own configured item.reorder_qty. Items with no reorder_qty configured are excluded from this metric, not treated as a zero threshold. Used by the reorder-level report.",
  },
  {
    key: "cash_bank_balance",
    title: "Cash/Bank Balance",
    definition:
      "Sum of posted journal_line debit amounts minus credit amounts against a cash/bank account's bound gl_account (or credit minus debit, for a credit-normal account) -- the same running-balance formula GET /gl/accounts/{id}/ledger and GET /cash-bank/book use. Used by the dashboard's cashBankBalances.",
  },
] as const;
