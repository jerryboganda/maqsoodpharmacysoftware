// Query helpers shared between ReportsService (the low-stock / expiry-report report handlers)
// and DashboardService (GET /dashboards/summary's lowStockCount / expiryValueAtRisk /
// cashBankBalances fields) -- kept here, not duplicated in each service, so the dashboard's
// numbers can never silently drift from the report that explains them.
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { cashBankAccounts, getDb, glAccounts, items, journalEntries, journalLines, stockBalances, stockLots } from "@pharmacy/db";
import { Money, Quantity } from "@pharmacy/money";

import { localToday } from "../../../common/dates/index.js";
import type { TenantBranchScope } from "../../inventory/infrastructure/tenant-context.service.js";
import { addDays, businessDateParam } from "./report-helpers.js";

export const DEFAULT_LOW_STOCK_THRESHOLD = "20.0000"; // PharmacyDashboardPage.svelte's "< 20 units" convention -- see report-filters.ts's doc comment

export interface LowStockRow {
  readonly itemId: number;
  readonly itemName: string;
  readonly qtyOnHand: string;
}

/** items with qty_on_hand summed across lots > 0 and < `threshold`, scoped to one branch (the
 *  same single-branch resolution TenantContextService.resolveScope gives every other module
 *  today -- see its own header comment). No SQL LIMIT: the tenant's own item catalogue bounds the
 *  row count, and callers (ReportsService.paginate / DashboardService's plain `.length`) apply
 *  their own cap/page. */
export async function queryLowStockItems(scope: TenantBranchScope, threshold: Quantity, itemId?: number): Promise<LowStockRow[]> {
  const db = getDb();
  const conditions = [eq(stockBalances.tenantId, scope.tenantId), eq(stockBalances.branchId, scope.branchId)];
  if (itemId !== undefined) conditions.push(eq(stockBalances.itemId, itemId));

  return db
    .select({
      itemId: stockBalances.itemId,
      itemName: items.name,
      qtyOnHand: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)`,
    })
    .from(stockBalances)
    .innerJoin(items, eq(items.itemId, stockBalances.itemId))
    .where(and(...conditions))
    .groupBy(stockBalances.itemId, items.name)
    .having(sql`sum(${stockBalances.qtyOnHand}) > 0 and sum(${stockBalances.qtyOnHand}) < ${threshold.toDb()}`);
}

/** Mirrors StockQueryService.expiryDashboard's own hard-coded 90-day horizon (inventory module,
 *  out of this task's declared scope to modify) -- see computeExpiryBuckets's own doc comment for
 *  why the task's requested 5th "90-180" bucket cannot be populated without changing that shared
 *  method. */
export const EXPIRY_HORIZON_DAYS = 90;
export const EXPIRY_BUCKET_KEYS = ["expired", "d0to30", "d30to60", "d60to90"] as const;
export type ExpiryBucketKey = (typeof EXPIRY_BUCKET_KEYS)[number];

export interface ExpiryBucketRow {
  readonly bucket: ExpiryBucketKey;
  readonly lotCount: number;
  readonly qty: string;
  readonly value: string;
}

export interface ExpiryBucketsResult {
  readonly asOfDate: string;
  readonly horizonDays: number;
  readonly buckets: readonly ExpiryBucketRow[];
  readonly totalValue: string;
  readonly totalQty: string;
  readonly totalLotCount: number;
  /** Documented gap (not silently dropped): the task's own bucket list additionally asks for a
   *  "90-180" bucket, but the row-level data this aggregate reuses (StockQueryService.
   *  expiryDashboard, apps/api/src/modules/inventory/**, out of this task's declared scope --
   *  "build out apps/api/src/modules/reporting/ ONLY") hard-codes a 90-day horizon at the query
   *  level (`lte(stockLots.expiryDate, horizon)` with `horizon = 90 days from today`). Extending
   *  it to 180 days means widening that shared method, not this one -- so this aggregate mirrors
   *  the same 90-day horizon exactly and reports the missing bucket here explicitly rather than
   *  fabricating a fifth range this pass cannot actually query into two different horizons at
   *  once from a single shared source. */
  readonly unsupportedBuckets: readonly string[];
}

/** Bucketed count + value ("qty_on_hand x avg_unit_cost", the same valuation formula
 *  stock-valuation uses) for lots with stock on hand expiring within EXPIRY_HORIZON_DAYS days --
 *  a from-scratch aggregate query (not a call into StockQueryService.expiryDashboard) because
 *  that method's row shape carries no cost column to value against; it mirrors that method's own
 *  scope/join/horizon shape as closely as this module's own tables allow. See
 *  `unsupportedBuckets`'s doc comment for the one documented divergence from the task's literal
 *  bucket list. */
export async function computeExpiryBuckets(scope: TenantBranchScope, itemId?: number): Promise<ExpiryBucketsResult> {
  const db = getDb();
  const asOfDate = localToday();
  const horizon = addDays(asOfDate, EXPIRY_HORIZON_DAYS);

  const bucketExpr = sql<string>`case
    when ${stockLots.expiryDate} < ${asOfDate} then 'expired'
    when datediff(${stockLots.expiryDate}, ${asOfDate}) <= 30 then 'd0to30'
    when datediff(${stockLots.expiryDate}, ${asOfDate}) <= 60 then 'd30to60'
    else 'd60to90' end`;

  const conditions = [
    eq(stockLots.tenantId, scope.tenantId),
    eq(stockLots.branchId, scope.branchId),
    isNotNull(stockLots.expiryDate),
    lte(stockLots.expiryDate, businessDateParam(horizon)),
  ];
  if (itemId !== undefined) conditions.push(eq(stockLots.itemId, itemId));

  const rows = await db
    .select({
      bucket: bucketExpr,
      lotCount: sql<number>`count(*)`,
      qty: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)`,
      value: sql<string>`cast(coalesce(sum(${stockBalances.qtyOnHand} * ${items.avgUnitCost}), 0) as decimal(15,2))`,
    })
    .from(stockLots)
    .innerJoin(
      stockBalances,
      and(
        eq(stockBalances.stockLotId, stockLots.stockLotId),
        eq(stockBalances.itemId, stockLots.itemId),
        eq(stockBalances.branchId, stockLots.branchId),
      ),
    )
    .innerJoin(items, eq(items.itemId, stockLots.itemId))
    .where(and(...conditions, sql`${stockBalances.qtyOnHand} > 0`))
    .groupBy(bucketExpr);

  const byBucket = new Map(rows.map((r) => [r.bucket as ExpiryBucketKey, r]));
  let totalValue = Money.zero();
  let totalQty = Quantity.zero();
  let totalLotCount = 0;
  const buckets = EXPIRY_BUCKET_KEYS.map((key) => {
    const row = byBucket.get(key);
    const value = Money.fromDb(row?.value ?? "0.00");
    const qty = Quantity.fromDb(row?.qty ?? "0.0000");
    totalValue = totalValue.add(value);
    totalQty = totalQty.add(qty);
    // Number(...): mysql2 returns COUNT(*) as a string; Drizzle's `sql<number>` annotation is a
    // compile-time type assertion only, not a runtime cast. Left un-coerced, `totalLotCount +=`
    // does JS string concatenation instead of addition (same bug class found and fixed in
    // reports.service.ts's ap-aging/ar-aging invoiceCount during Wave 6 integration).
    const lotCount = Number(row?.lotCount ?? 0);
    totalLotCount += lotCount;
    return { bucket: key, lotCount, qty: qty.toDb(), value: value.toDb() };
  });

  return {
    asOfDate,
    horizonDays: EXPIRY_HORIZON_DAYS,
    buckets,
    totalValue: totalValue.toDb(),
    totalQty: totalQty.toDb(),
    totalLotCount,
    unsupportedBuckets: ["90-180"],
  };
}

export interface CashBankBalanceRow {
  readonly cashBankAccountId: number;
  readonly label: string;
  readonly balance: string;
}

/**
 * Current balance per active cash/bank account -- "Σ debit - Σ credit" (or the reverse, for a
 * credit-normal account) over POSTED journal_line rows against the account's own bound
 * gl_account_id.
 *
 * NOT a call into accounting/application/ledger-query.service.ts's LedgerQueryService (the task's
 * first-choice instruction) -- read that file before writing this one: `getAccountLedger` folds
 * the running balance over every matched row internally, but only PAGES that fold through its own
 * `limit`/`offset`, and `limit` is hard-clamped to `MAX_PAGE_SIZE = 200` inside that file
 * (`Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)`, no caller override possible).
 * Its returned `closingBalance` is the running balance after the LAST ROW OF THE RETURNED PAGE,
 * not the account's true current balance, for any account with more than 200 posted journal
 * lines -- silently wrong for exactly the busy cash/bank accounts a dashboard summary most needs
 * to be right about. That method is correct and sufficient for its own two callers (a paginated
 * ledger VIEW: GET /gl/accounts/{id}/ledger, GET /cash-bank/book), just not reusable as-is for a
 * single "give me the current balance" number.
 *
 * This is therefore the SAME formula (`Σdebit - Σcredit` for debit-normal, reversed for
 * credit-normal) replicated as a plain grouped SQL aggregate with no pagination to truncate --
 * matching the task's own fallback instruction ("replicate the exact same formula ... comment
 * that it must be kept in sync"), and the third copy of this exact formula in this codebase
 * (payments/application/payment.service.ts#getCashBankBalance and expenses/application/
 * expense.service.ts#getCashBankBalance both already carry their own single-account copy for the
 * identical reason: an insufficient-funds check needs a true current balance, not a paginated
 * view). KEEP IN SYNC with LedgerQueryService.getAccountLedger's per-line fold
 * (`normalBalance === "debit" ? running.add(debit).sub(credit) : running.add(credit).sub(debit)`)
 * if that formula ever changes.
 */
export async function getCashBankBalances(scope: TenantBranchScope): Promise<CashBankBalanceRow[]> {
  const db = getDb();
  const accounts = await db
    .select({
      cashBankAccountId: cashBankAccounts.cashBankAccountId,
      glAccountId: cashBankAccounts.glAccountId,
      accountKind: cashBankAccounts.accountKind,
      bankName: cashBankAccounts.bankName,
      accountNo: cashBankAccounts.accountNo,
    })
    .from(cashBankAccounts)
    .where(and(eq(cashBankAccounts.tenantId, scope.tenantId), eq(cashBankAccounts.isActive, true)));
  if (accounts.length === 0) return [];

  const glAccountIds = accounts.map((a) => a.glAccountId);
  const glRows = await db
    .select({ glAccountId: glAccounts.glAccountId, normalBalance: glAccounts.normalBalance })
    .from(glAccounts)
    .where(inArray(glAccounts.glAccountId, glAccountIds));
  const normalBalanceByGl = new Map(glRows.map((r) => [r.glAccountId, r.normalBalance]));

  const sums = await db
    .select({
      glAccountId: journalLines.glAccountId,
      debit: sql<string>`coalesce(sum(${journalLines.debitAmount}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.creditAmount}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
    .where(
      and(
        inArray(journalLines.glAccountId, glAccountIds),
        eq(journalLines.tenantId, scope.tenantId),
        eq(journalEntries.tenantId, scope.tenantId),
        eq(journalEntries.status, "posted"),
      ),
    )
    .groupBy(journalLines.glAccountId);
  const sumsByGl = new Map(sums.map((r) => [r.glAccountId, r]));

  return accounts.map((account) => {
    const normalBalance = normalBalanceByGl.get(account.glAccountId) ?? "debit";
    const sum = sumsByGl.get(account.glAccountId);
    const debit = Money.fromDb(sum?.debit ?? "0.00");
    const credit = Money.fromDb(sum?.credit ?? "0.00");
    const balance = normalBalance === "debit" ? debit.sub(credit) : credit.sub(debit);
    const label = account.bankName
      ? `${account.bankName}${account.accountNo ? ` (${account.accountNo})` : ""}`
      : `${account.accountKind} #${account.cashBankAccountId}`;
    return { cashBankAccountId: account.cashBankAccountId, label, balance: balance.toDb() };
  });
}
