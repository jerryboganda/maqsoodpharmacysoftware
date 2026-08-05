// Blueprint: this file exercises `apps/api/src/modules/inventory/**` end to end -- read fully
// before writing these tests: `api/stock-adjustments.controller.ts` +
// `application/stock-adjustment.service.ts` (create-draft / post / approve, the
// requiresApproval/approvedBy gate -- ck_adjustment_approval, "MGR never the creator"),
// `api/stock-takes.controller.ts` + `application/stock-take.service.ts` (draft -> counting ->
// reviewed -> closed, `generateAdjustments` composing `StockAdjustmentService.create()`+`.post()`
// for both an increase AND a decrease document inside one outer transaction), and
// `application/stock-lot.service.ts` + `api/expiry.controller.ts` /
// `application/stock-query.service.ts#expiryDashboard` (hold/release quarantine, and how
// `StockService.allocateFefo` -- infrastructure/stock.service.ts -- filters `lotStatus ===
// 'available'` before it ever looks at expiry).
//
// These are REAL integration tests against a REAL MySQL instance (test/support/test-app.ts) --
// every assertion that matters is a direct DB read via `getDb()` + the real `@pharmacy/db` schema
// (stock_balance deltas, stock_adjustment/stock_take status, stock_lot.lot_status), not just a
// check of the HTTP response body, mirroring purchasing.test.ts's own established convention.
//
// The hold/release -> FEFO-exclusion assertion reuses `POST /sale-invoices/preview` (a dry run of
// the exact same `StockService.allocateFefo` call a real cash sale would make, per
// sale-invoices.service.ts's own header comment) rather than inventing a bespoke allocation check
// -- this is "however this codebase's own hold mechanism actually manifests": a held lot simply
// never appears in a FEFO allocation, so a sale that only that lot could cover fails with a real
// 422 INVENTORY.INSUFFICIENT_STOCK, and succeeds again the moment it is released.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appUsers,
  getDb,
  items,
  paymentMethods,
  stockAdjustments,
  stockBalances,
  stockLots,
  stockTakeLines,
} from "@pharmacy/db";
import { Quantity } from "@pharmacy/money";

import { localToday } from "../src/common/dates/index.js";
import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

/** RFC 9457 problem+json shape every error response in this API uses (common/errors/problem-details.ts). */
interface ProblemResponseBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  traceId: string;
}

interface SupplierResponseBody {
  supplierId: number;
  glAccountId: number;
  name: string;
}

interface PurchaseInvoiceLineResponse {
  purchaseInvoiceLineId: number;
  itemId: number;
  stockLotId: number;
  qtyBase: string;
  unitCostIn: string;
}
interface PurchaseInvoiceResponse {
  purchaseInvoice: { purchaseInvoiceId: number; status: string; docNumber: string };
  lines: PurchaseInvoiceLineResponse[];
}

interface AdjustmentLineResponse {
  lineId: number;
  itemId: number;
  stockLotId: number;
  qty: string;
  unitCost: string;
  costAmount: string;
}
interface AdjustmentResponse {
  stockAdjustmentId: number;
  docNumber: string;
  status: string;
  direction: "increase" | "decrease";
  requiresApproval: boolean;
  approvedBy: number | null;
  totalQty: string;
  lines: AdjustmentLineResponse[];
}

interface AdjustmentReasonRow {
  adjustmentReasonId: number;
  code: string;
  requiresApproval: boolean;
  direction: "increase" | "decrease" | "both";
}
interface AdjustmentReasonsListResponse {
  adjustmentReasons: AdjustmentReasonRow[];
}

interface StockTakeLineResponse {
  lineId: number;
  itemId: number;
  stockLotId: number;
  qtySystem: string;
  qtyCounted: string | null;
  qtyVariance: string | null;
  adjustmentLineId: number | null;
}
interface StockTakeResponse {
  stockTakeId: number;
  docNumber: string;
  status: string;
  increaseAdjustmentId: number | null;
  decreaseAdjustmentId: number | null;
  lines: StockTakeLineResponse[];
}

interface VarianceTotals {
  totalLines: number;
  countedLines: number;
  pendingLines: number;
  varianceLines: number;
  netCostImpact: string;
}
interface VarianceLineResponse {
  lineId: number;
  itemId: number;
  stockLotId: number;
  qtySystem: string;
  qtyCounted: string | null;
  qtyVariance: string | null;
  unitCostSnapshot: string;
  costImpact: string | null;
}
interface VarianceResponse {
  lines: VarianceLineResponse[];
  totals: VarianceTotals;
}

interface RecordCountsResponse {
  acceptedCount: number;
  varianceSummary: VarianceTotals;
}

interface GenerateAdjustmentsResponse {
  stockTake: StockTakeResponse;
  increaseAdjustment: AdjustmentResponse | null;
  decreaseAdjustment: AdjustmentResponse | null;
}

interface StockLotResponse {
  stockLotId: number;
  itemId: number;
  lotStatus: string;
  holdReasonId: number | null;
}

interface SalePreviewAllocation {
  stockLotId: number;
  qty: string;
}
interface SalePreviewLine {
  itemId: number;
  qty: string;
  allocations: SalePreviewAllocation[];
}
interface SalePreviewResponse {
  lines: SalePreviewLine[];
  invoiceTotal: string;
}

interface ExpiryDashboardRow {
  stockLotId: number;
  itemId: number;
  batchNo: string | null;
  lotStatus: string;
  qtyOnHand: string;
  daysToExpiry: number;
  bucket: "expired" | "30" | "60" | "90";
}
interface ExpiryDashboardResponse {
  data: ExpiryDashboardRow[];
  meta: { asOfDate: string };
}

/** A date safely inside the seeded FY2027 fiscal year (2026-07-01..2027-06-30, all months open --
 *  seed.ts FY_START/FY_END/FISCAL_MONTHS), same constant purchasing.test.ts uses, independent of
 *  whatever "today" happens to be. */
const DOC_DATE = "2026-08-15";

async function getUserTenantId(userId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ tenantId: appUsers.tenantId }).from(appUsers).where(eq(appUsers.userId, userId));
  if (!row || row.tenantId === null) throw new Error(`user ${userId} has no tenant`);
  return row.tenantId;
}

/** Inserts a brand-new item directly (no create endpoint exists yet -- catalog/api/dto/item.dto.ts's
 *  header comment, same as purchasing.test.ts's own `createFreshItem`). Zero prior stock/cost, so
 *  every quantity assertion below is against a clean slate this test itself created. */
async function createFreshItem(
  tenantId: number,
  packUnits: number,
  opts: { hasExpiry?: boolean; salePrice?: string; purchasePrice?: string } = {},
): Promise<{ itemId: number; customCode: string }> {
  const db = getDb();
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const customCode = `INVTEST-${suffix}`;
  await db.insert(items).values({
    tenantId,
    customCode,
    name: `Inventory Test Item ${suffix}`,
    packUnits,
    salePrice: opts.salePrice ?? "25.0000",
    purchasePrice: opts.purchasePrice ?? "18.0000",
    hasExpiry: opts.hasExpiry ?? false,
    createdSource: "api",
  });
  const [row] = await db
    .select({ itemId: items.itemId })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.customCode, customCode)));
  if (!row) throw new Error("test item insert did not land");
  return { itemId: row.itemId, customCode };
}

/** Real `stock_balance.qty_on_hand` for one exact (item, lot) -- the ground truth every delta
 *  assertion below reads back, not a re-derivation from the HTTP response. */
async function lotStockOnHand(itemId: number, stockLotId: number): Promise<Quantity> {
  const db = getDb();
  const [row] = await db
    .select({ qtyOnHand: stockBalances.qtyOnHand })
    .from(stockBalances)
    .where(and(eq(stockBalances.itemId, itemId), eq(stockBalances.stockLotId, stockLotId)));
  return row ? Quantity.fromDb(row.qtyOnHand) : Quantity.zero();
}

async function currentAvgUnitCost(itemId: number): Promise<string> {
  const db = getDb();
  const [row] = await db.select({ avgUnitCost: items.avgUnitCost }).from(items).where(eq(items.itemId, itemId));
  if (!row) throw new Error(`item ${itemId} vanished`);
  return row.avgUnitCost;
}

/** `YYYY-MM-DD` `days` calendar-days from the real "today" the test is actually running on --
 *  matches `localToday()`'s own local-calendar-field convention (common/dates/business-date.ts),
 *  so the expiry-dashboard bucket math the server computes against its own `localToday()` lines up
 *  exactly with what this helper hands the purchase invoice as the lot's `expiryDate`. */
/** Bug fix (found live, same class as common/dates/business-date.ts's own header comment):
 *  this originally anchored on `new Date()` -- the server PROCESS's own OS-local "now" -- then
 *  read OS-local calendar fields back out. That's a DIFFERENT reference point than the real
 *  application code's own `asOf = new Date(\`${localToday()}T00:00:00\`)` (stock-query.service.ts),
 *  which is correctly pinned to the Asia/Karachi business date regardless of server OS timezone.
 *  On any server whose OS timezone isn't Asia/Karachi (CI's ubuntu-latest runner defaults to UTC),
 *  the two could disagree on "today" by a day, throwing every computed expiry bucket off by
 *  exactly one day. Anchoring on `localToday()` here instead matches the application's own
 *  reference point exactly; the day-arithmetic itself (setDate + read local fields back) is safe
 *  regardless of OS timezone once given a correct starting point (add/subtract-then-read-same-
 *  fields is a symmetric round-trip, unlike computing "today" from scratch). */
function daysFromToday(days: number): string {
  const d = new Date(`${localToday()}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("inventory module", () => {
  let testApp: TestApp;
  let ownerToken: string;
  let managerA: LoggedInUser; // creates/posts adjustments+takes; also self-approval-forbidden subject
  let managerB: LoggedInUser; // different eligible approver (owner cannot post transactions, 09 §I.3)
  let tenantId: number;
  let supplier: SupplierResponseBody;
  let reasonByCode: Record<string, AdjustmentReasonRow>;
  let cashPaymentMethodId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    const owner = await loginAsOwner(testApp);
    ownerToken = owner.token;

    // inventory.adjustment:approve / inventory.stock_take:generate_adjustments / :close /
    // inventory.stock_lot:hold|release are all owner/pharmacy_manager only (seed.ts, isSensitive)
    // -- both managers must be pharmacy_manager so the self-approval-vs-different-approver test
    // below exercises the real business rule (APPROVAL.SELF_APPROVAL_FORBIDDEN), not a plain 403.
    [managerA, managerB] = await Promise.all([
      createTestUser(testApp, ownerToken, ["pharmacy_manager"]),
      createTestUser(testApp, ownerToken, ["pharmacy_manager"]),
    ]);
    tenantId = await getUserTenantId(managerA.userId);

    const supplierRes = await request<SupplierResponseBody>(testApp, {
      method: "POST",
      url: "/suppliers",
      token: managerA.token,
      idempotencyKey: newIdempotencyKey(),
      body: { name: `Inventory Test Supplier ${Date.now().toString(36)}` },
    });
    expect(supplierRes.status, JSON.stringify(supplierRes.json)).toBe(201);
    supplier = supplierRes.json;

    const reasonsRes = await request<AdjustmentReasonsListResponse>(testApp, {
      method: "GET",
      url: "/adjustment-reasons",
      token: managerA.token,
    });
    expect(reasonsRes.status, JSON.stringify(reasonsRes.json)).toBe(200);
    reasonByCode = Object.fromEntries(reasonsRes.json.adjustmentReasons.map((r) => [r.code, r]));
    if (!reasonByCode["DAMAGE"] || !reasonByCode["THEFT"] || !reasonByCode["COUNT_CORRECTION"]) {
      throw new Error(`seed gap: expected DAMAGE/THEFT/COUNT_CORRECTION adjustment reasons, got ${JSON.stringify(reasonsRes.json)}`);
    }
    // The real gate this whole module exists for (§T63 doc comment): THEFT is the one seeded
    // reason with requiresApproval=true; DAMAGE/COUNT_CORRECTION are not. Assert the fixture is
    // what the tests below assume, not just trust it silently.
    expect(reasonByCode["DAMAGE"]!.requiresApproval).toBe(false);
    expect(reasonByCode["THEFT"]!.requiresApproval).toBe(true);
    expect(reasonByCode["COUNT_CORRECTION"]!.requiresApproval).toBe(false);

    const db = getDb();
    const [cash] = await db
      .select({ paymentMethodId: paymentMethods.paymentMethodId })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.code, "CASH")));
    if (!cash) throw new Error("seed gap: CASH payment method not found");
    cashPaymentMethodId = cash.paymentMethodId;
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe("stock adjustments: create+approve+post, increase and decrease legs", () => {
    it("posts an increase leg unaided, blocks an unapproved decrease leg with a real 422 until a second eligible user approves it, and stock ends exactly where the deltas say it should", async () => {
      const item = await createFreshItem(tenantId, 10); // 10 loose units per pack

      // ---- Seed real stock via a real purchase invoice: 10 packs @ 100.00/pack -> 100 loose ---
      const purchaseRes = await request<PurchaseInvoiceResponse>(testApp, {
        method: "POST",
        url: "/purchase-invoices",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qtyPack: "10", unitPurchasePrice: "100.0000" }],
        },
      });
      expect(purchaseRes.status, JSON.stringify(purchaseRes.json)).toBe(201);
      const stockLotId = purchaseRes.json.lines[0]!.stockLotId;
      expect((await lotStockOnHand(item.itemId, stockLotId)).compare(Quantity.fromDb("100.0000"))).toBe(0);
      expect(await currentAvgUnitCost(item.itemId)).toBe("10.00000"); // 100.00/10 packUnits

      // ---- INCREASE leg: DAMAGE (requiresApproval=false) -- create then post straight through --
      const incCreate = await request<AdjustmentResponse>(testApp, {
        method: "POST",
        url: "/stock-adjustments",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          direction: "increase",
          adjustmentReasonId: reasonByCode["DAMAGE"]!.adjustmentReasonId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, stockLotId, qty: "15" }],
        },
      });
      expect(incCreate.status, JSON.stringify(incCreate.json)).toBe(201);
      expect(incCreate.json.status).toBe("draft");
      expect(incCreate.json.requiresApproval).toBe(false);
      expect(incCreate.json.direction).toBe("increase");

      const incPost = await request<AdjustmentResponse>(testApp, {
        method: "POST",
        url: `/stock-adjustments/${incCreate.json.stockAdjustmentId}/post`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: { postingDate: DOC_DATE },
      });
      expect(incPost.status, JSON.stringify(incPost.json)).toBe(200);
      expect(incPost.json.status).toBe("posted");
      expect(incPost.json.lines[0]!.qty).toBe("15.0000");

      // Real DB: exactly +15 -- 100 + 15 = 115, not a re-derivation of the HTTP response.
      const afterIncrease = await lotStockOnHand(item.itemId, stockLotId);
      expect(afterIncrease.compare(Quantity.fromDb("115.0000"))).toBe(0);

      // ---- DECREASE leg: THEFT (requiresApproval=true) -- draft, then a real 422 on early post -
      const decCreate = await request<AdjustmentResponse>(testApp, {
        method: "POST",
        url: "/stock-adjustments",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          direction: "decrease",
          adjustmentReasonId: reasonByCode["THEFT"]!.adjustmentReasonId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, stockLotId, qty: "20" }],
        },
      });
      expect(decCreate.status, JSON.stringify(decCreate.json)).toBe(201);
      expect(decCreate.json.status).toBe("draft");
      expect(decCreate.json.requiresApproval).toBe(true);
      expect(decCreate.json.approvedBy).toBeNull();
      const decId = decCreate.json.stockAdjustmentId;

      const earlyPost = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/stock-adjustments/${decId}/post`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: { postingDate: DOC_DATE },
      });
      expect(earlyPost.status).toBe(422);
      expect(earlyPost.json.code).toBe("ADJUSTMENT.APPROVAL_REQUIRED");

      // managerA holds inventory.adjustment:approve (pharmacy_manager) but IS the creator -- the
      // real business-rule rejection, 422 APPROVAL.SELF_APPROVAL_FORBIDDEN, mirroring
      // purchase-order.service.ts's identical rule (purchasing.test.ts's own POs suite).
      const selfApprove = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/stock-adjustments/${decId}/approve`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(selfApprove.status).toBe(422);
      expect(selfApprove.json.code).toBe("APPROVAL.SELF_APPROVAL_FORBIDDEN");

      // Real DB: still draft/unapproved, and stock is STILL exactly where the increase leg left
      // it -- neither rejected attempt moved anything.
      const db = getDb();
      const [afterRejections] = await db
        .select({ status: stockAdjustments.status, approvedBy: stockAdjustments.approvedBy })
        .from(stockAdjustments)
        .where(eq(stockAdjustments.stockAdjustmentId, decId));
      expect(afterRejections?.status).toBe("draft");
      expect(afterRejections?.approvedBy).toBeNull();
      expect((await lotStockOnHand(item.itemId, stockLotId)).compare(afterIncrease)).toBe(0);

      // A different eligible user (managerB, also pharmacy_manager, NOT the creator) approves.
      const approveRes = await request<AdjustmentResponse>(testApp, {
        method: "POST",
        url: `/stock-adjustments/${decId}/approve`,
        token: managerB.token,
        idempotencyKey: newIdempotencyKey(),
        body: { reason: "confirmed shrinkage" },
      });
      expect(approveRes.status, JSON.stringify(approveRes.json)).toBe(200);
      expect(approveRes.json.approvedBy).toBe(managerB.userId);
      expect(approveRes.json.status).toBe("draft"); // approve never posts by itself

      // NOW post succeeds -- the approval, not who calls post, is what unblocks it.
      const decPost = await request<AdjustmentResponse>(testApp, {
        method: "POST",
        url: `/stock-adjustments/${decId}/post`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: { postingDate: DOC_DATE },
      });
      expect(decPost.status, JSON.stringify(decPost.json)).toBe(200);
      expect(decPost.json.status).toBe("posted");
      expect(decPost.json.lines[0]!.qty).toBe("20.0000");
      // Decrease lines re-read the item's CURRENT moving average at post time (C-5/C-6) -- avg
      // cost never moved (no updateAvgCost on the increase leg), so it is still exactly 10.00000.
      expect(decPost.json.lines[0]!.unitCost).toBe("10.00000");

      // Real DB: exactly -20 on top of the +15 already posted -- 100 + 15 - 20 = 95, the exact
      // net of both adjustment deltas, nothing more and nothing less.
      const final = await lotStockOnHand(item.itemId, stockLotId);
      expect(final.compare(Quantity.fromDb("95.0000"))).toBe(0);
    });
  });

  describe("stock take: open -> count (physical qty differs from system qty) -> generate adjustments -> close", () => {
    it("generates the correct real increase AND decrease adjustments via StockTakeService.generateAdjustments and lands stock at the physically-counted quantities, not the originals", async () => {
      const item = await createFreshItem(tenantId, 10, { hasExpiry: true });
      const suffix = Date.now().toString(36);

      // Two lots of the SAME item (distinct batches) so a single scopeItemId-scoped take can
      // exercise BOTH an increase-variance line and a decrease-variance line without touching any
      // other test's stock in this shared dev database.
      const purchaseRes = await request<PurchaseInvoiceResponse>(testApp, {
        method: "POST",
        url: "/purchase-invoices",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [
            { itemId: item.itemId, qtyPack: "3", unitPurchasePrice: "100.0000", batchNo: `STK-A-${suffix}`, expiryDate: "2027-06-01" },
            { itemId: item.itemId, qtyPack: "2", unitPurchasePrice: "100.0000", batchNo: `STK-B-${suffix}`, expiryDate: "2027-06-01" },
          ],
        },
      });
      expect(purchaseRes.status, JSON.stringify(purchaseRes.json)).toBe(201);
      const lotA = purchaseRes.json.lines[0]!.stockLotId; // 3 packs x 10 = 30 loose units
      const lotB = purchaseRes.json.lines[1]!.stockLotId; // 2 packs x 10 = 20 loose units
      expect((await lotStockOnHand(item.itemId, lotA)).compare(Quantity.fromDb("30.0000"))).toBe(0);
      expect((await lotStockOnHand(item.itemId, lotB)).compare(Quantity.fromDb("20.0000"))).toBe(0);

      // ---- open: create the draft session, scoped to just this item -------------------------
      const takeCreate = await request<StockTakeResponse>(testApp, {
        method: "POST",
        url: "/stock-takes",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: { documentDate: DOC_DATE, scopeItemId: item.itemId },
      });
      expect(takeCreate.status, JSON.stringify(takeCreate.json)).toBe(201);
      expect(takeCreate.json.status).toBe("draft");
      expect(takeCreate.json.lines).toHaveLength(0); // header only, no count sheet yet
      const takeId = takeCreate.json.stockTakeId;

      // ---- materialise the frozen count sheet (snapshots current stock_balance) --------------
      const sheetRes = await request<StockTakeResponse>(testApp, {
        method: "POST",
        url: `/stock-takes/${takeId}/count-sheet`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
      });
      expect(sheetRes.status, JSON.stringify(sheetRes.json)).toBe(200);
      expect(sheetRes.json.status).toBe("counting");
      expect(sheetRes.json.lines).toHaveLength(2);
      const sheetLineA = sheetRes.json.lines.find((l) => l.stockLotId === lotA)!;
      const sheetLineB = sheetRes.json.lines.find((l) => l.stockLotId === lotB)!;
      expect(sheetLineA.qtySystem).toBe("30.0000");
      expect(sheetLineB.qtySystem).toBe("20.0000");

      // ---- record a physical count that DIFFERS from the system qty on both lots ------------
      // lotA: physically counted 22 (system said 30 -> variance -8, a decrease)
      // lotB: physically counted 35 (system said 20 -> variance +15, an increase)
      const recordRes = await request<RecordCountsResponse>(testApp, {
        method: "PUT",
        url: `/stock-takes/${takeId}/lines`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          lines: [
            { itemId: item.itemId, stockLotId: lotA, qtyCounted: "22" },
            { itemId: item.itemId, stockLotId: lotB, qtyCounted: "35" },
          ],
        },
      });
      expect(recordRes.status, JSON.stringify(recordRes.json)).toBe(200);
      expect(recordRes.json.acceptedCount).toBe(2);
      expect(recordRes.json.varianceSummary.varianceLines).toBe(2);

      // Real variance, before committing to any adjustment: both lines, correct sign each way.
      const varRes = await request<VarianceResponse>(testApp, {
        method: "GET",
        url: `/stock-takes/${takeId}/variance`,
        token: managerA.token,
      });
      expect(varRes.status, JSON.stringify(varRes.json)).toBe(200);
      const varA = varRes.json.lines.find((l) => l.stockLotId === lotA)!;
      const varB = varRes.json.lines.find((l) => l.stockLotId === lotB)!;
      expect(varA.qtyVariance).toBe("-8.0000");
      expect(varB.qtyVariance).toBe("15.0000");
      expect(varRes.json.totals.varianceLines).toBe(2);
      expect(varRes.json.totals.pendingLines).toBe(0);
      // netCostImpact: (-8 x 10.00000) + (15 x 10.00000) = -80.00 + 150.00 = 70.00
      expect(varRes.json.totals.netCostImpact).toBe("70.00");

      // ---- generate-adjustments: turns that variance into real, POSTED stock_adjustment docs -
      const genRes = await request<GenerateAdjustmentsResponse>(testApp, {
        method: "POST",
        url: `/stock-takes/${takeId}/generate-adjustments`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: { adjustmentReasonId: reasonByCode["COUNT_CORRECTION"]!.adjustmentReasonId, postingDate: DOC_DATE },
      });
      expect(genRes.status, JSON.stringify(genRes.json)).toBe(201);
      expect(genRes.json.stockTake.status).toBe("reviewed");

      expect(genRes.json.increaseAdjustment).not.toBeNull();
      expect(genRes.json.increaseAdjustment!.status).toBe("posted");
      expect(genRes.json.increaseAdjustment!.direction).toBe("increase");
      expect(genRes.json.increaseAdjustment!.totalQty).toBe("15.0000"); // lotB's variance only

      expect(genRes.json.decreaseAdjustment).not.toBeNull();
      expect(genRes.json.decreaseAdjustment!.status).toBe("posted");
      expect(genRes.json.decreaseAdjustment!.direction).toBe("decrease");
      expect(genRes.json.decreaseAdjustment!.totalQty).toBe("8.0000"); // lotA's variance only

      // Real DB: stock lands EXACTLY at the physically-counted quantities, not the originals --
      // lotA: 30 -> 22 (not 30), lotB: 20 -> 35 (not 20).
      expect((await lotStockOnHand(item.itemId, lotA)).compare(Quantity.fromDb("22.0000"))).toBe(0);
      expect((await lotStockOnHand(item.itemId, lotB)).compare(Quantity.fromDb("35.0000"))).toBe(0);

      // Real DB: both stock_take_line rows now point at the real adjustment line they produced.
      const db = getDb();
      const takeLineRows = await db
        .select({ stockLotId: stockTakeLines.stockLotId, adjustmentLineId: stockTakeLines.adjustmentLineId })
        .from(stockTakeLines)
        .where(eq(stockTakeLines.stockTakeId, takeId));
      expect(takeLineRows).toHaveLength(2);
      for (const row of takeLineRows) expect(row.adjustmentLineId).not.toBeNull();

      // ---- close: reachable from 'reviewed' now that generate-adjustments has run ------------
      const closeRes = await request<StockTakeResponse>(testApp, {
        method: "POST",
        url: `/stock-takes/${takeId}/close`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(closeRes.status, JSON.stringify(closeRes.json)).toBe(200);
      expect(closeRes.json.status).toBe("closed");
    });
  });

  describe("stock lot hold/release: a held lot is excluded from FEFO allocation, a released one is allocatable again", () => {
    it("holds a lot (real 422 on a sale that can only be covered by it), releases it, and the same sale then succeeds", async () => {
      // packUnits=1 keeps sale pricing trivial: item.salePrice IS the per-loose-unit price
      // (sale-invoices.service.ts's own price-resolution rule), so `preview` needs no explicit
      // unitSalePrice.
      const item = await createFreshItem(tenantId, 1, { salePrice: "25.0000", purchasePrice: "25.0000" });

      const purchaseRes = await request<PurchaseInvoiceResponse>(testApp, {
        method: "POST",
        url: "/purchase-invoices",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qtyPack: "10", unitPurchasePrice: "25.0000" }],
        },
      });
      expect(purchaseRes.status, JSON.stringify(purchaseRes.json)).toBe(201);
      const stockLotId = purchaseRes.json.lines[0]!.stockLotId;
      expect((await lotStockOnHand(item.itemId, stockLotId)).compare(Quantity.fromDb("10.0000"))).toBe(0);

      const previewBody = {
        documentDate: DOC_DATE,
        lines: [{ itemId: item.itemId, qty: "1" }],
        payments: [{ paymentMethodId: cashPaymentMethodId, amount: "25.00" }],
      };

      // Before hold: this item has exactly one lot, and it is allocatable.
      const previewBefore = await request<SalePreviewResponse>(testApp, {
        method: "POST",
        url: "/sale-invoices/preview",
        token: managerA.token,
        body: previewBody,
      });
      expect(previewBefore.status, JSON.stringify(previewBefore.json)).toBe(200);
      expect(previewBefore.json.lines[0]!.allocations[0]!.stockLotId).toBe(stockLotId);

      // ---- hold: 'available' -> 'quarantined' ------------------------------------------------
      const holdRes = await request<StockLotResponse>(testApp, {
        method: "POST",
        url: `/stock-lots/${stockLotId}/hold`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: { reason: "quarantined for testing" },
      });
      expect(holdRes.status, JSON.stringify(holdRes.json)).toBe(200);
      expect(holdRes.json.lotStatus).toBe("quarantined");

      // Real DB: lot_status really is 'quarantined', not just what the response body claims.
      const db = getDb();
      const [afterHold] = await db.select({ lotStatus: stockLots.lotStatus }).from(stockLots).where(eq(stockLots.stockLotId, stockLotId));
      expect(afterHold?.lotStatus).toBe("quarantined");

      // FEFO exclusion, manifesting exactly as `StockService.allocateFefo`'s own header comment
      // says it will: this item's only lot is quarantined, so `usableStatusRows` is empty and the
      // sale gets a real 422 INVENTORY.INSUFFICIENT_STOCK -- not a silent short allocation.
      const previewHeld = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/sale-invoices/preview",
        token: managerA.token,
        body: previewBody,
      });
      expect(previewHeld.status).toBe(422);
      expect(previewHeld.json.code).toBe("INVENTORY.INSUFFICIENT_STOCK");

      // ---- release: 'quarantined' -> 'available' ---------------------------------------------
      const releaseRes = await request<StockLotResponse>(testApp, {
        method: "POST",
        url: `/stock-lots/${stockLotId}/release`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(releaseRes.status, JSON.stringify(releaseRes.json)).toBe(200);
      expect(releaseRes.json.lotStatus).toBe("available");

      const [afterRelease] = await db.select({ lotStatus: stockLots.lotStatus }).from(stockLots).where(eq(stockLots.stockLotId, stockLotId));
      expect(afterRelease?.lotStatus).toBe("available");

      // Allocatable again: the identical sale that just 422'd now succeeds off the same lot.
      const previewAfter = await request<SalePreviewResponse>(testApp, {
        method: "POST",
        url: "/sale-invoices/preview",
        token: managerA.token,
        body: previewBody,
      });
      expect(previewAfter.status, JSON.stringify(previewAfter.json)).toBe(200);
      expect(previewAfter.json.lines[0]!.allocations[0]!.stockLotId).toBe(stockLotId);
      expect(previewAfter.json.lines[0]!.allocations[0]!.qty).toBe("1.0000");
    });
  });

  describe("GET /stock-lots/:id/recall-trace (Wave 9, R4.5: given a batch, every sale that dispensed it)", () => {
    it("traces a real posted sale line back to the exact lot it drew from, including its dispensingNote, and 404s for a lot that doesn't exist", async () => {
      const item = await createFreshItem(tenantId, 1, { salePrice: "30.0000", purchasePrice: "20.0000" });

      const purchaseRes = await request<PurchaseInvoiceResponse>(testApp, {
        method: "POST",
        url: "/purchase-invoices",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qtyPack: "10", unitPurchasePrice: "20.0000" }],
        },
      });
      expect(purchaseRes.status, JSON.stringify(purchaseRes.json)).toBe(201);
      const stockLotId = purchaseRes.json.lines[0]!.stockLotId;

      const note = `recall-trace-note-${Date.now().toString(36)}`;
      const saleRes = await request<{ saleInvoice: { saleInvoiceId: number; docNumber: string }; lines: { stockLotId: number }[] }>(testApp, {
        method: "POST",
        url: "/sale-invoices",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qty: "3", dispensingNote: note }],
          payments: [{ paymentMethodId: cashPaymentMethodId, amount: "90.00" }],
        },
      });
      expect(saleRes.status, JSON.stringify(saleRes.json)).toBe(201);
      expect(saleRes.json.lines[0]!.stockLotId).toBe(stockLotId); // this item has exactly one lot -- FEFO can only have drawn from it

      const traceRes = await request<{
        lot: { stockLotId: number; itemId: number; batchNo: string | null; supplierId: number };
        sales: { saleInvoiceId: number; docNumber: string; qtyBase: string; dispensingNote: string | null; status: string }[];
      }>(testApp, { method: "GET", url: `/stock-lots/${stockLotId}/recall-trace`, token: managerA.token });
      expect(traceRes.status, JSON.stringify(traceRes.json)).toBe(200);
      expect(traceRes.json.lot.stockLotId).toBe(stockLotId);
      expect(traceRes.json.lot.itemId).toBe(item.itemId);
      expect(traceRes.json.lot.supplierId).toBe(supplier.supplierId);

      const line = traceRes.json.sales.find((s) => s.docNumber === saleRes.json.saleInvoice.docNumber);
      expect(line).toBeDefined();
      expect(line!.saleInvoiceId).toBe(saleRes.json.saleInvoice.saleInvoiceId);
      expect(line!.qtyBase).toBe("3.0000");
      expect(line!.dispensingNote).toBe(note);
      expect(line!.status).toBe("posted");

      // A non-existent lot 404s -- same tenant/branch-scoped not-found handling getLotById uses.
      const notFound = await request<ProblemResponseBody>(testApp, {
        method: "GET",
        url: "/stock-lots/999999999/recall-trace",
        token: managerA.token,
      });
      expect(notFound.status).toBe(404);
      expect(notFound.json.code).toBe("INVENTORY.STOCK_LOT_NOT_FOUND");
    });
  });

  describe("expiry dashboard: real lots bucketed by days-to-expiry", () => {
    it("buckets lots into expired/30/60/90 by a real, controllable expiryDate set at purchase time, and excludes a lot beyond the 90-day horizon", async () => {
      const item = await createFreshItem(tenantId, 1, { hasExpiry: true });
      const suffix = Date.now().toString(36);

      // Five distinct batches of the same item, each a lot with 1 unit on hand and a controlled
      // expiryDate relative to whatever "today" this test actually runs on (daysFromToday mirrors
      // localToday()'s own local-calendar convention -- see that helper's comment):
      //   -5 days  -> already past due       -> bucket "expired"
      //   +10 days -> inside the 30-day cut  -> bucket "30"
      //   +45 days -> inside the 60-day cut  -> bucket "60"
      //   +75 days -> inside the 90-day cut  -> bucket "90"
      //   +120 days -> beyond the dashboard's 90-day horizon -> must NOT appear at all
      const expiredDate = daysFromToday(-5);
      const bucket30Date = daysFromToday(10);
      const bucket60Date = daysFromToday(45);
      const bucket90Date = daysFromToday(75);
      const beyondHorizonDate = daysFromToday(120);

      const purchaseRes = await request<PurchaseInvoiceResponse>(testApp, {
        method: "POST",
        url: "/purchase-invoices",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [
            { itemId: item.itemId, qtyPack: "1", unitPurchasePrice: "10.0000", batchNo: `EXP-EXPIRED-${suffix}`, expiryDate: expiredDate },
            { itemId: item.itemId, qtyPack: "1", unitPurchasePrice: "10.0000", batchNo: `EXP-30-${suffix}`, expiryDate: bucket30Date },
            { itemId: item.itemId, qtyPack: "1", unitPurchasePrice: "10.0000", batchNo: `EXP-60-${suffix}`, expiryDate: bucket60Date },
            { itemId: item.itemId, qtyPack: "1", unitPurchasePrice: "10.0000", batchNo: `EXP-90-${suffix}`, expiryDate: bucket90Date },
            { itemId: item.itemId, qtyPack: "1", unitPurchasePrice: "10.0000", batchNo: `EXP-BEYOND-${suffix}`, expiryDate: beyondHorizonDate },
          ],
        },
      });
      expect(purchaseRes.status, JSON.stringify(purchaseRes.json)).toBe(201);
      expect(purchaseRes.json.lines).toHaveLength(5);
      const [expiredLot, lot30, lot60, lot90, beyondLot] = purchaseRes.json.lines.map((l) => l.stockLotId);

      const dashRes = await request<ExpiryDashboardResponse>(testApp, {
        method: "GET",
        url: `/inventory/expiry-dashboard?itemId=${item.itemId}`,
        token: managerA.token,
      });
      expect(dashRes.status, JSON.stringify(dashRes.json)).toBe(200);
      const rows = dashRes.json.data;

      // The beyond-horizon lot never appears -- excluded by the dashboard's own 90-day `lte`
      // filter, not just left out of this test's assertions.
      expect(rows.find((r) => r.stockLotId === beyondLot)).toBeUndefined();
      expect(rows).toHaveLength(4);

      const rowFor = (stockLotId: number): ExpiryDashboardRow => {
        const row = rows.find((r) => r.stockLotId === stockLotId);
        if (!row) throw new Error(`lot ${stockLotId} missing from expiry dashboard: ${JSON.stringify(rows)}`);
        return row;
      };

      const expiredRow = rowFor(expiredLot!);
      expect(expiredRow.bucket).toBe("expired");
      expect(expiredRow.daysToExpiry).toBe(-5);
      expect(expiredRow.qtyOnHand).toBe("1.0000");

      const row30 = rowFor(lot30!);
      expect(row30.bucket).toBe("30");
      expect(row30.daysToExpiry).toBe(10);

      const row60 = rowFor(lot60!);
      expect(row60.bucket).toBe("60");
      expect(row60.daysToExpiry).toBe(45);

      const row90 = rowFor(lot90!);
      expect(row90.bucket).toBe("90");
      expect(row90.daysToExpiry).toBe(75);

      // Soonest-first ordering (ORDER BY expiry_date ASC): expired, then 30, then 60, then 90.
      expect(rows.map((r) => r.stockLotId)).toEqual([expiredLot, lot30, lot60, lot90]);
    });
  });
});
