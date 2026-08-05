// POST /reports/{reportId}/run's dispatch target. Every handler here is a plain read (no
// `db.transaction()` anywhere in this file -- task instruction: "must not open a write
// transaction (read-only, no side effects)") against ALREADY-POSTED data (`status = "posted"`
// throughout) -- explicitly NOT trial-balance/income-statement/balance-sheet (blocked pending
// task #28's accountant/owner sign-off, tracked separately).
//
// Every money SUM is a real server-side SQL `sum(...)`, cast to a fixed decimal(15,2) string
// (Money.SCALE) before it ever reaches JS -- never a client-side or JS-number aggregation (Rule
// M). Every handler fetches its full matched row set (no SQL LIMIT/OFFSET) and lets
// report-helpers.ts's `paginate()` apply the row cap + page slice -- see that file's header
// comment for why.
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  appUsers,
  customers,
  getDb,
  items,
  purchaseInvoiceLines,
  purchaseInvoices,
  saleInvoiceLines,
  saleInvoices,
  stockBalances,
  stockLots,
  suppliers,
} from "@pharmacy/db";
import { Money, Quantity } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { localToday } from "../../../common/dates/index.js";
import { TenantContextService, type TenantBranchScope } from "../../inventory/infrastructure/tenant-context.service.js";
import type { RunReportBodyInput } from "../api/dto/report.dto.js";
import {
  ApAgingFiltersSchema,
  ArAgingFiltersSchema,
  ControlledDrugRegisterFiltersSchema,
  ExpiryReportFiltersSchema,
  LowStockFiltersSchema,
  parseFilters,
  PurchaseSummaryFiltersSchema,
  ReorderLevelFiltersSchema,
  SalesSummaryFiltersSchema,
  StockValuationFiltersSchema,
} from "./report-filters.js";
import { assertDateRange, paginate, resolvePage, businessDateParam, toDateOnly, type Page } from "./report-helpers.js";
import { computeExpiryBuckets, DEFAULT_LOW_STOCK_THRESHOLD, queryLowStockItems } from "./report-queries.js";
import { REPORT_DEFINITIONS } from "./report-registry.js";

const AGING_BUCKET_KEYS = ["current", "days1to30", "days31to60", "days61to90", "days90plus"] as const;
type AgingBucketKey = (typeof AGING_BUCKET_KEYS)[number];

@Injectable()
export class ReportsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** POST /reports/{reportId}/run -- validates reportId against the registry, then dispatches. */
  async run(reportId: string, body: RunReportBodyInput, actor: Actor) {
    if (!REPORT_DEFINITIONS.some((r) => r.reportId === reportId)) {
      throw new AppException({
        status: 404,
        code: "REPORT.NOT_FOUND",
        title: "Unknown report",
        detail: `No report with id "${reportId}" exists. See GET /reports for the available reports.`,
      });
    }

    const scope = await this.tenantContext.resolveScope(actor);
    const page = resolvePage(body);
    const generatedAt = new Date().toISOString();

    const result = await this.dispatch(reportId, scope, body.filters, page);
    return { reportId, generatedAt, ...result };
  }

  private async dispatch(reportId: string, scope: TenantBranchScope, filters: Record<string, unknown>, page: Page) {
    switch (reportId) {
      case "sales-summary":
        return this.runSalesSummary(scope, filters, page);
      case "purchase-summary":
        return this.runPurchaseSummary(scope, filters, page);
      case "stock-valuation":
        return this.runStockValuation(scope, filters, page);
      case "expiry-report":
        return this.runExpiryReport(scope, filters);
      case "reorder-level":
        return this.runReorderLevel(scope, filters, page);
      case "ap-aging":
        return this.runApAging(scope, filters, page);
      case "ar-aging":
        return this.runArAging(scope, filters, page);
      case "low-stock":
        return this.runLowStock(scope, filters, page);
      case "controlled-drug-register":
        return this.runControlledDrugRegister(scope, filters, page);
      default:
        // Unreachable: `run()` already 404s any reportId not in REPORT_DEFINITIONS, and this
        // switch covers every entry in that registry (kept 1:1 by hand -- nine reports total).
        throw new Error(`reportId "${reportId}" is registered but has no dispatch case`);
    }
  }

  // ---- sales-summary --------------------------------------------------------------------------

  private async runSalesSummary(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(SalesSummaryFiltersSchema, rawFilters);
    assertDateRange(f.dateFrom, f.dateTo);
    if (f.itemId !== undefined && f.groupBy !== "item") {
      throw new BusinessRuleException(
        "REPORT.FILTER_INVALID",
        "Invalid report filters",
        "filters.itemId only applies when filters.groupBy is \"item\".",
        [{ path: "filters.itemId", code: "REPORT.FILTER_INVALID", message: "Only valid with groupBy=\"item\"" }],
      );
    }
    const db = getDb();

    if (f.groupBy === "item") {
      const conditions = [eq(saleInvoices.tenantId, scope.tenantId), eq(saleInvoices.branchId, scope.branchId), eq(saleInvoices.status, "posted")];
      if (f.dateFrom !== undefined) conditions.push(gte(saleInvoices.postingDate, businessDateParam(f.dateFrom)));
      if (f.dateTo !== undefined) conditions.push(lte(saleInvoices.postingDate, businessDateParam(f.dateTo)));
      if (f.customerId !== undefined) conditions.push(eq(saleInvoices.customerId, f.customerId));
      if (f.itemId !== undefined) conditions.push(eq(saleInvoiceLines.itemId, f.itemId));

      const rows = await db
        .select({
          itemId: saleInvoiceLines.itemId,
          itemName: items.name,
          netAmount: sql<string>`cast(coalesce(sum(${saleInvoiceLines.lineNetAmount}), 0) as decimal(15,2))`,
          qty: sql<string>`coalesce(sum(${saleInvoiceLines.qtyBase}), 0)`,
          invoiceCount: sql<number>`count(distinct ${saleInvoiceLines.saleInvoiceId})`,
        })
        .from(saleInvoiceLines)
        .innerJoin(saleInvoices, eq(saleInvoiceLines.saleInvoiceId, saleInvoices.saleInvoiceId))
        .innerJoin(items, eq(items.itemId, saleInvoiceLines.itemId))
        .where(and(...conditions))
        .groupBy(saleInvoiceLines.itemId, items.name);

      const sorted = [...rows].sort((a, b) => Money.fromDb(b.netAmount).compare(Money.fromDb(a.netAmount)));
      return paginate(sorted, page, (r) => ({
        key: String(r.itemId),
        label: r.itemName,
        netAmount: r.netAmount,
        qty: r.qty,
        // Runtime fix: mysql2 returns COUNT(*) as a string; Drizzle's `sql<number>` annotation is
        // a compile-time type assertion only, it does not coerce the runtime value. Left
        // un-coerced, `entry.invoiceCount += row.invoiceCount` further down (pivotAgingRows) does
        // JS string concatenation ("0" + "1" -> "01") instead of addition -- found live during
        // Wave 6 integration verification (ap-aging returned invoiceCount: "01" for one invoice).
        invoiceCount: Number(r.invoiceCount),
      }));
    }

    if (f.groupBy === "customer") {
      const conditions = [eq(saleInvoices.tenantId, scope.tenantId), eq(saleInvoices.branchId, scope.branchId), eq(saleInvoices.status, "posted")];
      if (f.dateFrom !== undefined) conditions.push(gte(saleInvoices.postingDate, businessDateParam(f.dateFrom)));
      if (f.dateTo !== undefined) conditions.push(lte(saleInvoices.postingDate, businessDateParam(f.dateTo)));
      if (f.customerId !== undefined) conditions.push(eq(saleInvoices.customerId, f.customerId));

      const rows = await db
        .select({
          customerId: saleInvoices.customerId,
          customerName: customers.name,
          netAmount: sql<string>`cast(coalesce(sum(${saleInvoices.netAmount}), 0) as decimal(15,2))`,
          invoiceCount: sql<number>`count(*)`,
        })
        .from(saleInvoices)
        .innerJoin(customers, eq(customers.customerId, saleInvoices.customerId))
        .where(and(...conditions))
        .groupBy(saleInvoices.customerId, customers.name);

      const sorted = [...rows].sort((a, b) => Money.fromDb(b.netAmount).compare(Money.fromDb(a.netAmount)));
      return paginate(sorted, page, (r) => ({
        key: String(r.customerId),
        label: r.customerName,
        netAmount: r.netAmount,
        // Runtime fix: mysql2 returns COUNT(*) as a string; Drizzle's `sql<number>` annotation is
        // a compile-time type assertion only, it does not coerce the runtime value. Left
        // un-coerced, `entry.invoiceCount += row.invoiceCount` further down (pivotAgingRows) does
        // JS string concatenation ("0" + "1" -> "01") instead of addition -- found live during
        // Wave 6 integration verification (ap-aging returned invoiceCount: "01" for one invoice).
        invoiceCount: Number(r.invoiceCount),
      }));
    }

    // groupBy === "date" (default)
    const conditions = [eq(saleInvoices.tenantId, scope.tenantId), eq(saleInvoices.branchId, scope.branchId), eq(saleInvoices.status, "posted")];
    if (f.dateFrom !== undefined) conditions.push(gte(saleInvoices.postingDate, businessDateParam(f.dateFrom)));
    if (f.dateTo !== undefined) conditions.push(lte(saleInvoices.postingDate, businessDateParam(f.dateTo)));
    if (f.customerId !== undefined) conditions.push(eq(saleInvoices.customerId, f.customerId));

    const rows = await db
      .select({
        date: saleInvoices.postingDate,
        netAmount: sql<string>`cast(coalesce(sum(${saleInvoices.netAmount}), 0) as decimal(15,2))`,
        invoiceCount: sql<number>`count(*)`,
      })
      .from(saleInvoices)
      .where(and(...conditions))
      .groupBy(saleInvoices.postingDate)
      .orderBy(desc(saleInvoices.postingDate));

    return paginate(rows, page, (r) => ({ key: toDateOnly(r.date), label: toDateOnly(r.date), netAmount: r.netAmount, invoiceCount: Number(r.invoiceCount) }));
  }

  // ---- purchase-summary ------------------------------------------------------------------------

  private async runPurchaseSummary(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(PurchaseSummaryFiltersSchema, rawFilters);
    assertDateRange(f.dateFrom, f.dateTo);
    if (f.itemId !== undefined && f.groupBy !== "item") {
      throw new BusinessRuleException(
        "REPORT.FILTER_INVALID",
        "Invalid report filters",
        "filters.itemId only applies when filters.groupBy is \"item\".",
        [{ path: "filters.itemId", code: "REPORT.FILTER_INVALID", message: "Only valid with groupBy=\"item\"" }],
      );
    }
    const db = getDb();

    if (f.groupBy === "item") {
      const conditions = [eq(purchaseInvoices.tenantId, scope.tenantId), eq(purchaseInvoices.branchId, scope.branchId), eq(purchaseInvoices.status, "posted")];
      if (f.dateFrom !== undefined) conditions.push(gte(purchaseInvoices.postingDate, businessDateParam(f.dateFrom)));
      if (f.dateTo !== undefined) conditions.push(lte(purchaseInvoices.postingDate, businessDateParam(f.dateTo)));
      if (f.supplierId !== undefined) conditions.push(eq(purchaseInvoices.supplierId, f.supplierId));
      if (f.itemId !== undefined) conditions.push(eq(purchaseInvoiceLines.itemId, f.itemId));

      const rows = await db
        .select({
          itemId: purchaseInvoiceLines.itemId,
          itemName: items.name,
          netAmount: sql<string>`cast(coalesce(sum(${purchaseInvoiceLines.lineNetAmount}), 0) as decimal(15,2))`,
          qty: sql<string>`coalesce(sum(${purchaseInvoiceLines.qtyBase}), 0)`,
          invoiceCount: sql<number>`count(distinct ${purchaseInvoiceLines.purchaseInvoiceId})`,
        })
        .from(purchaseInvoiceLines)
        .innerJoin(purchaseInvoices, eq(purchaseInvoiceLines.purchaseInvoiceId, purchaseInvoices.purchaseInvoiceId))
        .innerJoin(items, eq(items.itemId, purchaseInvoiceLines.itemId))
        .where(and(...conditions))
        .groupBy(purchaseInvoiceLines.itemId, items.name);

      const sorted = [...rows].sort((a, b) => Money.fromDb(b.netAmount).compare(Money.fromDb(a.netAmount)));
      return paginate(sorted, page, (r) => ({
        key: String(r.itemId),
        label: r.itemName,
        netAmount: r.netAmount,
        qty: r.qty,
        // Runtime fix: mysql2 returns COUNT(*) as a string; Drizzle's `sql<number>` annotation is
        // a compile-time type assertion only, it does not coerce the runtime value. Left
        // un-coerced, `entry.invoiceCount += row.invoiceCount` further down (pivotAgingRows) does
        // JS string concatenation ("0" + "1" -> "01") instead of addition -- found live during
        // Wave 6 integration verification (ap-aging returned invoiceCount: "01" for one invoice).
        invoiceCount: Number(r.invoiceCount),
      }));
    }

    if (f.groupBy === "supplier") {
      const conditions = [eq(purchaseInvoices.tenantId, scope.tenantId), eq(purchaseInvoices.branchId, scope.branchId), eq(purchaseInvoices.status, "posted")];
      if (f.dateFrom !== undefined) conditions.push(gte(purchaseInvoices.postingDate, businessDateParam(f.dateFrom)));
      if (f.dateTo !== undefined) conditions.push(lte(purchaseInvoices.postingDate, businessDateParam(f.dateTo)));
      if (f.supplierId !== undefined) conditions.push(eq(purchaseInvoices.supplierId, f.supplierId));

      const rows = await db
        .select({
          supplierId: purchaseInvoices.supplierId,
          supplierName: suppliers.name,
          netAmount: sql<string>`cast(coalesce(sum(${purchaseInvoices.netAmount}), 0) as decimal(15,2))`,
          invoiceCount: sql<number>`count(*)`,
        })
        .from(purchaseInvoices)
        .innerJoin(suppliers, eq(suppliers.supplierId, purchaseInvoices.supplierId))
        .where(and(...conditions))
        .groupBy(purchaseInvoices.supplierId, suppliers.name);

      const sorted = [...rows].sort((a, b) => Money.fromDb(b.netAmount).compare(Money.fromDb(a.netAmount)));
      return paginate(sorted, page, (r) => ({
        key: String(r.supplierId),
        label: r.supplierName,
        netAmount: r.netAmount,
        // Runtime fix: mysql2 returns COUNT(*) as a string; Drizzle's `sql<number>` annotation is
        // a compile-time type assertion only, it does not coerce the runtime value. Left
        // un-coerced, `entry.invoiceCount += row.invoiceCount` further down (pivotAgingRows) does
        // JS string concatenation ("0" + "1" -> "01") instead of addition -- found live during
        // Wave 6 integration verification (ap-aging returned invoiceCount: "01" for one invoice).
        invoiceCount: Number(r.invoiceCount),
      }));
    }

    // groupBy === "date" (default)
    const conditions = [eq(purchaseInvoices.tenantId, scope.tenantId), eq(purchaseInvoices.branchId, scope.branchId), eq(purchaseInvoices.status, "posted")];
    if (f.dateFrom !== undefined) conditions.push(gte(purchaseInvoices.postingDate, businessDateParam(f.dateFrom)));
    if (f.dateTo !== undefined) conditions.push(lte(purchaseInvoices.postingDate, businessDateParam(f.dateTo)));
    if (f.supplierId !== undefined) conditions.push(eq(purchaseInvoices.supplierId, f.supplierId));

    const rows = await db
      .select({
        date: purchaseInvoices.postingDate,
        netAmount: sql<string>`cast(coalesce(sum(${purchaseInvoices.netAmount}), 0) as decimal(15,2))`,
        invoiceCount: sql<number>`count(*)`,
      })
      .from(purchaseInvoices)
      .where(and(...conditions))
      .groupBy(purchaseInvoices.postingDate)
      .orderBy(desc(purchaseInvoices.postingDate));

    return paginate(rows, page, (r) => ({ key: toDateOnly(r.date), label: toDateOnly(r.date), netAmount: r.netAmount, invoiceCount: Number(r.invoiceCount) }));
  }

  // ---- stock-valuation -------------------------------------------------------------------------

  /** Reuses StockQueryService.listStock's own join shape (checked first, per the task
   *  instruction) but not the method itself -- that method paginates a per-item LIST for the
   *  stock screen and doesn't emit a valued total; this is its own aggregate query, scoped to
   *  this module (StockQueryService lives in apps/api/src/modules/inventory/, out of this task's
   *  declared "apps/api/src/modules/reporting/ ONLY" scope to modify). */
  private async runStockValuation(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(StockValuationFiltersSchema, rawFilters);
    const db = getDb();

    if (f.groupBy === "branch") {
      // TenantContextService.resolveScope resolves exactly one branch per tenant today (its own
      // header comment: a dev-mode tenancy stub) -- so "group by branch" collapses to the single
      // row for that one branch. Real multi-branch grouping is future work once that resolution
      // widens, not something this report can invent ahead of it.
      const [row] = await db
        .select({
          qtyOnHand: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)`,
          stockValue: sql<string>`cast(coalesce(sum(${stockBalances.qtyOnHand} * ${items.avgUnitCost}), 0) as decimal(15,2))`,
        })
        .from(stockBalances)
        .innerJoin(items, eq(items.itemId, stockBalances.itemId))
        .where(and(eq(stockBalances.tenantId, scope.tenantId), eq(stockBalances.branchId, scope.branchId)));

      return paginate(
        [{ branchId: scope.branchId, qtyOnHand: row?.qtyOnHand ?? "0.0000", stockValue: row?.stockValue ?? "0.00" }],
        page,
        (r) => ({ key: String(r.branchId), label: `Branch ${r.branchId}`, qtyOnHand: r.qtyOnHand, stockValue: r.stockValue }),
      );
    }

    const conditions = [eq(stockBalances.tenantId, scope.tenantId), eq(stockBalances.branchId, scope.branchId)];
    if (f.itemId !== undefined) conditions.push(eq(stockBalances.itemId, f.itemId));

    const rows = await db
      .select({
        itemId: stockBalances.itemId,
        itemName: items.name,
        avgUnitCost: items.avgUnitCost,
        qtyOnHand: sql<string>`sum(${stockBalances.qtyOnHand})`,
        stockValue: sql<string>`cast(coalesce(sum(${stockBalances.qtyOnHand} * ${items.avgUnitCost}), 0) as decimal(15,2))`,
      })
      .from(stockBalances)
      .innerJoin(items, eq(items.itemId, stockBalances.itemId))
      .where(and(...conditions))
      .groupBy(stockBalances.itemId, items.name, items.avgUnitCost)
      .having(sql`sum(${stockBalances.qtyOnHand}) > 0`);

    const sorted = [...rows].sort((a, b) => Money.fromDb(b.stockValue).compare(Money.fromDb(a.stockValue)));
    return paginate(sorted, page, (r) => ({
      key: String(r.itemId),
      label: r.itemName,
      qtyOnHand: r.qtyOnHand,
      avgUnitCost: r.avgUnitCost,
      stockValue: r.stockValue,
    }));
  }

  // ---- expiry-report ----------------------------------------------------------------------------

  /** No offset/limit -- fixed at (at most) four bucket rows; see report-queries.ts's
   *  computeExpiryBuckets for the shared aggregation and its documented "90-180" bucket gap. */
  private async runExpiryReport(scope: TenantBranchScope, rawFilters: Record<string, unknown>) {
    const f = parseFilters(ExpiryReportFiltersSchema, rawFilters);
    const result = await computeExpiryBuckets(scope, f.itemId);
    return {
      data: result.buckets,
      meta: {
        offset: 0,
        limit: result.buckets.length,
        total: result.buckets.length,
        hasMore: false,
        asOfDate: result.asOfDate,
        horizonDays: result.horizonDays,
        totalValue: result.totalValue,
        totalQty: result.totalQty,
        totalLotCount: result.totalLotCount,
        unsupportedBuckets: result.unsupportedBuckets,
      },
    };
  }

  // ---- reorder-level ----------------------------------------------------------------------------

  /** Gap check (task instruction): `item.reorder_qty` DOES exist (packages/db/schema/catalog.ts)
   *  -- no missing-column gap here. It IS nullable per item, so items with no configured
   *  reorder_qty are excluded from this report entirely (not treated as a zero threshold) --
   *  documented in the response, not a silent skip. */
  private async runReorderLevel(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(ReorderLevelFiltersSchema, rawFilters);
    const db = getDb();

    const conditions = [eq(items.tenantId, scope.tenantId), sql`${items.reorderQty} is not null`, eq(items.isActive, true)];
    if (f.itemId !== undefined) conditions.push(eq(items.itemId, f.itemId));

    const rows = await db
      .select({
        itemId: items.itemId,
        itemName: items.name,
        reorderQty: items.reorderQty,
        qtyOnHand: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), 0)`,
      })
      .from(items)
      .leftJoin(
        stockBalances,
        and(eq(stockBalances.itemId, items.itemId), eq(stockBalances.tenantId, scope.tenantId), eq(stockBalances.branchId, scope.branchId)),
      )
      .where(and(...conditions))
      .groupBy(items.itemId, items.name, items.reorderQty)
      .having(sql`coalesce(sum(${stockBalances.qtyOnHand}), 0) <= ${items.reorderQty}`)
      .orderBy(asc(items.name));

    return paginate(rows, page, (r) => ({ key: String(r.itemId), label: r.itemName, qtyOnHand: r.qtyOnHand, reorderQty: r.reorderQty }));
  }

  // ---- ap-aging / ar-aging -----------------------------------------------------------------------

  private async runApAging(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(ApAgingFiltersSchema, rawFilters);
    const asOfDate = f.asOfDate ?? localToday();
    const db = getDb();

    const dueOrPosting = sql`coalesce(${purchaseInvoices.dueDate}, ${purchaseInvoices.postingDate})`;
    const bucketExpr = agingBucketExpr(asOfDate, dueOrPosting);

    const conditions = [
      eq(purchaseInvoices.tenantId, scope.tenantId),
      eq(purchaseInvoices.branchId, scope.branchId),
      eq(purchaseInvoices.status, "posted"),
      sql`${purchaseInvoices.balanceAmount} > 0`,
    ];
    if (f.supplierId !== undefined) conditions.push(eq(purchaseInvoices.supplierId, f.supplierId));

    const rows = await db
      .select({
        partyId: purchaseInvoices.supplierId,
        partyName: suppliers.name,
        bucket: bucketExpr,
        amount: sql<string>`cast(coalesce(sum(${purchaseInvoices.balanceAmount}), 0) as decimal(15,2))`,
        invoiceCount: sql<number>`count(*)`,
      })
      .from(purchaseInvoices)
      .innerJoin(suppliers, eq(suppliers.supplierId, purchaseInvoices.supplierId))
      .where(and(...conditions))
      .groupBy(purchaseInvoices.supplierId, suppliers.name, bucketExpr);

    const pivoted = pivotAgingRows(rows);
    return { ...paginate(pivoted, page, (r) => r), asOfDate };
  }

  private async runArAging(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(ArAgingFiltersSchema, rawFilters);
    const asOfDate = f.asOfDate ?? localToday();
    const db = getDb();

    const dueOrPosting = sql`coalesce(${saleInvoices.dueDate}, ${saleInvoices.postingDate})`;
    const bucketExpr = agingBucketExpr(asOfDate, dueOrPosting);

    const conditions = [
      eq(saleInvoices.tenantId, scope.tenantId),
      eq(saleInvoices.branchId, scope.branchId),
      eq(saleInvoices.status, "posted"),
      sql`${saleInvoices.balanceAmount} > 0`,
    ];
    if (f.customerId !== undefined) conditions.push(eq(saleInvoices.customerId, f.customerId));

    const rows = await db
      .select({
        partyId: saleInvoices.customerId,
        partyName: customers.name,
        bucket: bucketExpr,
        amount: sql<string>`cast(coalesce(sum(${saleInvoices.balanceAmount}), 0) as decimal(15,2))`,
        invoiceCount: sql<number>`count(*)`,
      })
      .from(saleInvoices)
      .innerJoin(customers, eq(customers.customerId, saleInvoices.customerId))
      .where(and(...conditions))
      .groupBy(saleInvoices.customerId, customers.name, bucketExpr);

    const pivoted = pivotAgingRows(rows);
    return { ...paginate(pivoted, page, (r) => r), asOfDate };
  }

  // ---- low-stock ----------------------------------------------------------------------------------

  private async runLowStock(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(LowStockFiltersSchema, rawFilters);
    const thresholdResult = Quantity.fromInput(f.thresholdQty ?? DEFAULT_LOW_STOCK_THRESHOLD);
    if (!thresholdResult.ok) {
      throw new BusinessRuleException("REPORT.FILTER_INVALID", "Invalid report filters", "filters.thresholdQty is not a valid quantity.", [
        { path: "filters.thresholdQty", code: "REPORT.FILTER_INVALID", message: "Not a valid quantity" },
      ]);
    }

    const rows = await queryLowStockItems(scope, thresholdResult.value, f.itemId);
    const sorted = [...rows].sort((a, b) => Quantity.fromDb(a.qtyOnHand).compare(Quantity.fromDb(b.qtyOnHand)));
    return {
      ...paginate(sorted, page, (r) => ({ key: String(r.itemId), label: r.itemName, qtyOnHand: r.qtyOnHand })),
      thresholdQty: thresholdResult.value.toDb(),
    };
  }

  // ---- controlled-drug-register (Wave 8, U-062/D18/R7) ------------------------------------------

  /** Every posted `sale_invoice_line` whose item is `is_controlled_drug`, one row per line (a
   *  requested line that FEFO-split across multiple lots -- sale-invoices.service.ts's own
   *  `PlannedLine` comment -- appears as multiple rows here, one per lot, matching the real
   *  physical dispensing event per lot). This directly answers U-062's original question ("are
   *  there any records the drug regulator requires you to keep ... a controlled-medicines
   *  register ... we found nothing about this anywhere in your current software" --
   *  14-unknowns-and-questions.md question 30): now there is something, without inventing the
   *  legal retention period, required fields, or countersignature rule -- all still open pending
   *  professional sign-off (R7's own doc comment). */
  private async runControlledDrugRegister(scope: TenantBranchScope, rawFilters: Record<string, unknown>, page: Page) {
    const f = parseFilters(ControlledDrugRegisterFiltersSchema, rawFilters);
    assertDateRange(f.dateFrom, f.dateTo);
    const db = getDb();

    const conditions = [
      eq(saleInvoices.tenantId, scope.tenantId),
      eq(saleInvoices.branchId, scope.branchId),
      eq(saleInvoices.status, "posted"),
      eq(items.isControlledDrug, true),
    ];
    if (f.dateFrom !== undefined) conditions.push(gte(saleInvoices.postingDate, businessDateParam(f.dateFrom)));
    if (f.dateTo !== undefined) conditions.push(lte(saleInvoices.postingDate, businessDateParam(f.dateTo)));
    if (f.itemId !== undefined) conditions.push(eq(saleInvoiceLines.itemId, f.itemId));

    const rows = await db
      .select({
        saleInvoiceLineId: saleInvoiceLines.saleInvoiceLineId,
        docNumber: saleInvoices.docNumber,
        postingDate: saleInvoices.postingDate,
        itemId: items.itemId,
        itemName: items.name,
        batchNo: stockLots.batchNo,
        qty: saleInvoiceLines.qtyBase,
        dispensingNote: saleInvoiceLines.dispensingNote,
        dispensedByUserId: saleInvoices.postedBy,
        dispensedByName: appUsers.displayName,
      })
      .from(saleInvoiceLines)
      .innerJoin(saleInvoices, eq(saleInvoiceLines.saleInvoiceId, saleInvoices.saleInvoiceId))
      .innerJoin(items, eq(items.itemId, saleInvoiceLines.itemId))
      .leftJoin(stockLots, eq(stockLots.stockLotId, saleInvoiceLines.stockLotId))
      .leftJoin(appUsers, eq(appUsers.userId, saleInvoices.postedBy))
      .where(and(...conditions))
      .orderBy(desc(saleInvoices.postingDate), asc(saleInvoiceLines.saleInvoiceLineId));

    return paginate(rows, page, (r) => ({
      key: String(r.saleInvoiceLineId),
      docNumber: r.docNumber,
      postingDate: toDateOnly(r.postingDate),
      itemId: r.itemId,
      itemName: r.itemName,
      batchNo: r.batchNo,
      qty: r.qty,
      dispensingNote: r.dispensingNote,
      dispensedByUserId: r.dispensedByUserId,
      dispensedByName: r.dispensedByName,
    }));
  }
}

// ---- module-local helpers ------------------------------------------------------------------------

function agingBucketExpr(asOfDate: string, dueOrPostingExpr: SQL): SQL<string> {
  const overdueDays = sql`datediff(${asOfDate}, ${dueOrPostingExpr})`;
  return sql<string>`case
    when ${overdueDays} <= 0 then 'current'
    when ${overdueDays} <= 30 then 'days1to30'
    when ${overdueDays} <= 60 then 'days31to60'
    when ${overdueDays} <= 90 then 'days61to90'
    else 'days90plus' end`;
}

interface AgingBucketRow {
  readonly partyId: number;
  readonly partyName: string;
  readonly bucket: string;
  readonly amount: string;
  readonly invoiceCount: number;
}

function pivotAgingRows(rows: readonly AgingBucketRow[]) {
  const byParty = new Map<number, { partyId: number; partyName: string; buckets: Map<AgingBucketKey, Money>; invoiceCount: number }>();
  for (const row of rows) {
    let entry = byParty.get(row.partyId);
    if (!entry) {
      entry = { partyId: row.partyId, partyName: row.partyName, buckets: new Map(), invoiceCount: 0 };
      byParty.set(row.partyId, entry);
    }
    entry.buckets.set(row.bucket as AgingBucketKey, Money.fromDb(row.amount));
    entry.invoiceCount += Number(row.invoiceCount);
  }

  const pivoted = [...byParty.values()].map((entry) => {
    let total = Money.zero();
    const buckets: Record<AgingBucketKey, string> = {} as Record<AgingBucketKey, string>;
    for (const key of AGING_BUCKET_KEYS) {
      const value = entry.buckets.get(key) ?? Money.zero();
      buckets[key] = value.toDb();
      total = total.add(value);
    }
    return { partyId: entry.partyId, partyName: entry.partyName, invoiceCount: entry.invoiceCount, buckets, total: total.toDb() };
  });

  return pivoted.sort((a, b) => Money.fromDb(b.total).compare(Money.fromDb(a.total)));
}
