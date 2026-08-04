// Blueprint: purchase-invoice.service.ts (P-1: create-and-post-in-one-tx, C-2..C-5 costing),
// purchase-order.service.ts (draft->confirmed->closed / cancelled state machine, self-approval
// forbidden), purchase-return.service.ts (reverse-direction sibling of purchase-invoice, never
// re-averages costing), packages/db/schema/purchasing.ts (real table shapes), packages/money/
// src/Costing.ts (the moving-average formula these assertions replay).
//
// These are REAL integration tests against a REAL MySQL instance (test/support/test-app.ts) --
// every assertion below that matters (stock_balance, item.avg_unit_cost, journal_line rows) is a
// direct DB read via `getDb()` + the real `@pharmacy/db` schema, not just a check of the HTTP
// response body. A brand-new item is inserted directly (there is no POST /items create endpoint
// -- see catalog/api/dto/item.dto.ts's header comment) with zero prior stock/cost so the
// moving-average arithmetic is fully deterministic and not polluted by any other test file or
// prior run sharing the same dev database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appUsers,
  getDb,
  glAccounts,
  items,
  purchaseCategories,
  purchaseOrders,
  purchaseReturns,
  journalLines,
  stockBalances,
} from "@pharmacy/db";
import { Money, movingAverage, Quantity } from "@pharmacy/money";

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
  isActive: boolean;
}

interface PurchaseInvoiceLineResponse {
  purchaseInvoiceLineId: number;
  itemId: number;
  stockLotId: number;
  qtyBase: string;
  unitCostIn: string;
  avgCostBefore: string;
  avgCostAfter: string;
  lineNetAmount: string;
}
interface PurchaseInvoiceHeaderResponse {
  purchaseInvoiceId: number;
  status: string;
  invoiceTotal: string;
  netAmount: string;
  docNumber: string;
}
interface CreatePurchaseInvoiceResponse {
  purchaseInvoice: PurchaseInvoiceHeaderResponse;
  lines: PurchaseInvoiceLineResponse[];
  journalEntryId: number;
  newAvgCosts: { itemId: number; avgCostBefore: string; avgCostAfter: string }[];
}

interface PurchaseReturnLineResponse {
  purchaseReturnLineId: number;
  itemId: number;
  stockLotId: number;
  qtyBase: string;
  unitCostIn: string;
  avgCostBefore: string;
  avgCostAfter: string;
  lineNetAmount: string;
}
interface PurchaseReturnHeaderResponse {
  purchaseReturnId: number;
  status: string;
  returnTotal: string;
  netAmount: string;
}
interface CreatePurchaseReturnResponse {
  purchaseReturn: PurchaseReturnHeaderResponse;
  lines: PurchaseReturnLineResponse[];
  journalEntryId: number;
}

interface PurchaseOrderHeaderResponse {
  purchaseOrderId: number;
  status: string;
  orderStatus: string;
  totalAmount: string;
  createdBy: number | null;
}
interface PurchaseOrderResponse {
  purchaseOrder: PurchaseOrderHeaderResponse;
  lines: unknown[];
}

/** A date safely inside the seeded FY2027 fiscal year (2026-07-01..2027-06-30, all months
 *  open -- seed.ts FY_START/FY_END/FISCAL_MONTHS), independent of whatever "today" happens to be. */
const DOC_DATE = "2026-08-15";

async function getUserTenantId(userId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ tenantId: appUsers.tenantId }).from(appUsers).where(eq(appUsers.userId, userId));
  if (!row || row.tenantId === null) throw new Error(`user ${userId} has no tenant`);
  return row.tenantId;
}

/** Inserts a brand-new item directly (no create endpoint exists yet -- catalog/api/dto/item.dto.ts's
 *  header comment). Zero prior stock, zero avg_unit_cost -- makes the moving-average arithmetic in
 *  the tests below fully deterministic. */
async function createFreshItem(tenantId: number, packUnits: number): Promise<{ itemId: number; customCode: string }> {
  const db = getDb();
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const customCode = `PURTEST-${suffix}`;
  await db.insert(items).values({
    tenantId,
    customCode,
    name: `Purchasing Test Item ${suffix}`,
    packUnits,
    salePrice: "25.0000",
    purchasePrice: "18.0000",
    hasExpiry: false, // keeps lot identity down to (item, ~none~, 9999-12-31) -- one lot, deterministic
    createdSource: "api",
  });
  const [row] = await db
    .select({ itemId: items.itemId })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.customCode, customCode)));
  if (!row) throw new Error("test item insert did not land");
  return { itemId: row.itemId, customCode };
}

async function currentAvgUnitCost(itemId: number): Promise<string> {
  const db = getDb();
  const [row] = await db.select({ avgUnitCost: items.avgUnitCost }).from(items).where(eq(items.itemId, itemId));
  if (!row) throw new Error(`item ${itemId} vanished`);
  return row.avgUnitCost;
}

/** Total on-hand across every (branch, lot) row for this item -- the item has exactly one lot
 *  (hasExpiry: false, no batch given), but summing is the honest, assumption-free way to read it. */
async function totalStockOnHand(itemId: number): Promise<Quantity> {
  const db = getDb();
  const rows = await db.select({ qtyOnHand: stockBalances.qtyOnHand }).from(stockBalances).where(eq(stockBalances.itemId, itemId));
  let total = Quantity.zero();
  for (const row of rows) total = total.add(Quantity.fromDb(row.qtyOnHand));
  return total;
}

async function sumJournalLegs(journalEntryId: number): Promise<{ debit: Money; credit: Money; legCount: number }> {
  const db = getDb();
  const rows = await db
    .select({ debitAmount: journalLines.debitAmount, creditAmount: journalLines.creditAmount })
    .from(journalLines)
    .where(eq(journalLines.journalEntryId, journalEntryId));
  let debit = Money.zero();
  let credit = Money.zero();
  for (const row of rows) {
    debit = debit.add(Money.fromDb(row.debitAmount));
    credit = credit.add(Money.fromDb(row.creditAmount));
  }
  return { debit, credit, legCount: rows.length };
}

describe("purchasing module", () => {
  let testApp: TestApp;
  let ownerToken: string;
  let purchaseOfficer: LoggedInUser;
  let managerA: LoggedInUser; // creates POs; also self-approval-forbidden subject
  let managerB: LoggedInUser; // different eligible approver
  let tenantId: number;
  let supplier: SupplierResponseBody;
  let returnCategoryId: number;
  let inventoryGlAccountId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    const owner = await loginAsOwner(testApp);
    ownerToken = owner.token;

    // purchase.order:approve is owner/pharmacy_manager only (seed.ts, isSensitive) -- managerA/B
    // must both be pharmacy_manager for the self-approval-vs-different-approver test to exercise
    // the real business rule rather than a plain 403 permission denial.
    [purchaseOfficer, managerA, managerB] = await Promise.all([
      createTestUser(testApp, ownerToken, ["purchase_officer"]),
      createTestUser(testApp, ownerToken, ["pharmacy_manager"]),
      createTestUser(testApp, ownerToken, ["pharmacy_manager"]),
    ]);

    tenantId = await getUserTenantId(purchaseOfficer.userId);

    const supplierRes = await request<SupplierResponseBody>(testApp, {
      method: "POST",
      url: "/suppliers",
      token: purchaseOfficer.token,
      idempotencyKey: newIdempotencyKey(),
      body: { name: `Purchasing Test Supplier ${Date.now().toString(36)}` },
    });
    expect(supplierRes.status, JSON.stringify(supplierRes.json)).toBe(201);
    supplier = supplierRes.json;

    const db = getDb();
    const [returnCategory] = await db
      .select({ purchaseCategoryId: purchaseCategories.purchaseCategoryId })
      .from(purchaseCategories)
      .where(and(eq(purchaseCategories.tenantId, tenantId), eq(purchaseCategories.code, "RETURN_CASH")));
    if (!returnCategory) throw new Error("seed gap: RETURN_CASH purchase category not found");
    returnCategoryId = returnCategory.purchaseCategoryId;

    const [inventoryAccount] = await db
      .select({ glAccountId: glAccounts.glAccountId })
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, "1200")));
    if (!inventoryAccount) throw new Error("seed gap: GL account 1200 (Inventory) not found");
    inventoryGlAccountId = inventoryAccount.glAccountId;
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe("purchase invoice: create + post (real stock, real avg-cost, real GL)", () => {
    it("receives stock, moves the average per the real Costing.ts formula, and posts a balanced journal entry", async () => {
      const item = await createFreshItem(tenantId, 10); // 10 loose units per pack

      // ---- Invoice 1: 5 packs @ 120.00/pack, packUnits=10 -> qtyBase=50, unitCostIn=12.00000 ---
      const inv1Res = await request<CreatePurchaseInvoiceResponse>(testApp, {
        method: "POST",
        url: "/purchase-invoices",
        token: purchaseOfficer.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qtyPack: "5", unitPurchasePrice: "120.0000" }],
        },
      });
      expect(inv1Res.status, JSON.stringify(inv1Res.json)).toBe(201);
      expect(inv1Res.json.purchaseInvoice.status).toBe("posted");
      expect(inv1Res.json.lines).toHaveLength(1);
      const line1 = inv1Res.json.lines[0]!;
      const stockLotId = line1.stockLotId;

      // Fresh item: avgBefore=0, stockBefore=0 -> avgAfter must equal unitCostIn exactly
      // (movingAverage's own zero-denominator branch, Costing.ts).
      expect(line1.qtyBase).toBe("50.0000");
      expect(line1.unitCostIn).toBe("12.00000");
      expect(line1.avgCostBefore).toBe("0.00000");
      expect(line1.avgCostAfter).toBe("12.00000");
      expect(inv1Res.json.purchaseInvoice.invoiceTotal).toBe("600.00"); // 50 x 12.00000, 2dp

      // ---- Real DB state after invoice 1 -----------------------------------------------------
      expect(await currentAvgUnitCost(item.itemId)).toBe("12.00000");
      expect((await totalStockOnHand(item.itemId)).compare(Quantity.fromDb("50.0000"))).toBe(0);

      const legs1 = await sumJournalLegs(inv1Res.json.journalEntryId);
      expect(legs1.legCount).toBe(2); // Dr Inventory, Cr Supplier AP (no tax this increment)
      expect(legs1.debit.compare(legs1.credit)).toBe(0); // Sigma debit === Sigma credit, exactly
      expect(legs1.debit.toDb()).toBe("600.00");
      expect(legs1.credit.toDb()).toBe("600.00");

      // ---- Invoice 2: 5 more packs @ 180.00/pack -- moves the average up, not just re-stamps it
      const inv2Res = await request<CreatePurchaseInvoiceResponse>(testApp, {
        method: "POST",
        url: "/purchase-invoices",
        token: purchaseOfficer.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qtyPack: "5", unitPurchasePrice: "180.0000" }],
        },
      });
      expect(inv2Res.status, JSON.stringify(inv2Res.json)).toBe(201);
      const line2 = inv2Res.json.lines[0]!;
      expect(line2.unitCostIn).toBe("18.00000");
      expect(line2.avgCostBefore).toBe("12.00000"); // picks up exactly where invoice 1 left off

      // Replay the REAL moving-average formula (packages/money/src/Costing.ts) against the real
      // pre-receipt stock/avg this invoice actually read, and assert the DB lands on that value --
      // not a hand-rolled re-derivation of the arithmetic.
      const expectedAvgAfter = movingAverage({
        stockBefore: "50.0000", // real qty_on_hand before invoice 2, asserted above
        avgBefore: "12.00000", // real avg_unit_cost before invoice 2, asserted above
        qtyIn: line2.qtyBase,
        unitCostIn: line2.unitCostIn,
      });
      expect(expectedAvgAfter).toBe("15.00000"); // hand-verifiable: (50x12 + 50x18) / 100 = 15
      expect(line2.avgCostAfter).toBe(expectedAvgAfter);
      expect(await currentAvgUnitCost(item.itemId)).toBe(expectedAvgAfter);
      expect((await totalStockOnHand(item.itemId)).compare(Quantity.fromDb("100.0000"))).toBe(0);

      const legs2 = await sumJournalLegs(inv2Res.json.journalEntryId);
      expect(legs2.debit.compare(legs2.credit)).toBe(0);
      expect(legs2.debit.toDb()).toBe("900.00"); // 50 x 18.00000

      // ---- Purchase return: reverse stock/GL against invoice 1; over-return rejected ----------
      const returnRes = await request<CreatePurchaseReturnResponse>(testApp, {
        method: "POST",
        url: "/purchase-returns",
        token: purchaseOfficer.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          purchaseInvoiceId: inv1Res.json.purchaseInvoice.purchaseInvoiceId,
          purchaseCategoryId: returnCategoryId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, stockLotId, returnQty: "10.0000" }],
        },
      });
      expect(returnRes.status, JSON.stringify(returnRes.json)).toBe(201);
      expect(returnRes.json.purchaseReturn.status).toBe("posted");
      const returnLine = returnRes.json.lines[0]!;
      // Never re-averaged: defaults to invoice 1's own line unit_cost_in (12.00000), never a
      // fresh computation, and avg_cost_before === avg_cost_after (purchase-return.service.ts's
      // header comment: "this document did not move the average").
      expect(returnLine.unitCostIn).toBe("12.00000");
      expect(returnLine.avgCostBefore).toBe(expectedAvgAfter);
      expect(returnLine.avgCostAfter).toBe(expectedAvgAfter);
      expect(returnRes.json.purchaseReturn.returnTotal).toBe("120.00"); // 10 x 12.00000

      // Real DB: stock moved OUT by exactly the returned qty; the average is untouched.
      expect((await totalStockOnHand(item.itemId)).compare(Quantity.fromDb("90.0000"))).toBe(0);
      expect(await currentAvgUnitCost(item.itemId)).toBe(expectedAvgAfter);

      // GL reversed relative to a purchase invoice: Dr supplier AP (reduces what's owed), Cr
      // Inventory -- and still balanced.
      const returnLegs = await sumJournalLegs(returnRes.json.journalEntryId);
      expect(returnLegs.legCount).toBe(2);
      expect(returnLegs.debit.compare(returnLegs.credit)).toBe(0);
      expect(returnLegs.debit.toDb()).toBe("120.00");
      const db = getDb();
      const rawLegs = await db
        .select({ glAccountId: journalLines.glAccountId, debitAmount: journalLines.debitAmount, creditAmount: journalLines.creditAmount, legRole: journalLines.legRole })
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, returnRes.json.journalEntryId));
      const supplierLeg = rawLegs.find((l) => l.glAccountId === supplier.glAccountId);
      const inventoryLeg = rawLegs.find((l) => l.glAccountId === inventoryGlAccountId);
      expect(supplierLeg?.debitAmount).toBe("120.00");
      expect(supplierLeg?.legRole).toBe("primary_debit");
      expect(inventoryLeg?.creditAmount).toBe("120.00");
      expect(inventoryLeg?.legRole).toBe("primary_credit");

      // Real DB: the purchase_return header itself is posted.
      const [returnRow] = await db
        .select({ status: purchaseReturns.status })
        .from(purchaseReturns)
        .where(eq(purchaseReturns.purchaseReturnId, returnRes.json.purchaseReturn.purchaseReturnId));
      expect(returnRow?.status).toBe("posted");

      // ---- Over-return: received 50 on invoice 1's line, already returned 10 -> 40 remains.
      // Requesting 41 must be rejected with a real 422, and must NOT move stock/avg at all
      // (transaction rollback, not a partial apply).
      const overReturnRes = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/purchase-returns",
        token: purchaseOfficer.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          purchaseInvoiceId: inv1Res.json.purchaseInvoice.purchaseInvoiceId,
          purchaseCategoryId: returnCategoryId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, stockLotId, returnQty: "41.0000" }],
        },
      });
      expect(overReturnRes.status, JSON.stringify(overReturnRes.json)).toBe(422);
      expect(overReturnRes.json.code).toBe("PURCHASE_RETURN.QTY_EXCEEDS_RECEIVED");

      // Real DB: nothing moved -- still exactly where the accepted 10-unit return left it.
      expect((await totalStockOnHand(item.itemId)).compare(Quantity.fromDb("90.0000"))).toBe(0);
      expect(await currentAvgUnitCost(item.itemId)).toBe(expectedAvgAfter);

      // A return of exactly the remaining 40 (not 41) is still legal -- confirms the boundary is
      // "> remaining", not an off-by-one that also rejects the exact remaining quantity.
      const exactRemainderRes = await request<CreatePurchaseReturnResponse>(testApp, {
        method: "POST",
        url: "/purchase-returns",
        token: purchaseOfficer.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          purchaseInvoiceId: inv1Res.json.purchaseInvoice.purchaseInvoiceId,
          purchaseCategoryId: returnCategoryId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, stockLotId, returnQty: "40.0000" }],
        },
      });
      expect(exactRemainderRes.status, JSON.stringify(exactRemainderRes.json)).toBe(201);
      expect((await totalStockOnHand(item.itemId)).compare(Quantity.fromDb("50.0000"))).toBe(0);
    });
  });

  describe("purchase orders: create -> approve (self-approval forbidden) -> close / cancel", () => {
    it("rejects self-approval (real 422), rejects an unauthorised approver (real 403), then a different eligible approver succeeds and close moves order_status", async () => {
      const item = await createFreshItem(tenantId, 5);

      const createRes = await request<PurchaseOrderResponse>(testApp, {
        method: "POST",
        url: "/purchase-orders",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qtyOrdered: "20", unitPrice: "50.00" }],
        },
      });
      expect(createRes.status, JSON.stringify(createRes.json)).toBe(201);
      const poId = createRes.json.purchaseOrder.purchaseOrderId;
      expect(createRes.json.purchaseOrder.status).toBe("draft");
      expect(createRes.json.purchaseOrder.orderStatus).toBe("open");
      expect(createRes.json.purchaseOrder.totalAmount).toBe("1000.00"); // 20 x 50.00
      expect(createRes.json.purchaseOrder.createdBy).toBe(managerA.userId);

      // purchase_officer has NO purchase.order:approve permission at all (seed.ts: approve is
      // owner/pharmacy_manager only) -- this is a real 403 from the permission guard, a
      // structurally different failure from the creator's own self-approval 422 below.
      const unauthorisedApprove = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/purchase-orders/${poId}/approve`,
        token: purchaseOfficer.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(unauthorisedApprove.status).toBe(403);
      expect(unauthorisedApprove.json.code).toBe("AUTHZ.FORBIDDEN");

      // managerA DOES hold purchase.order:approve (pharmacy_manager) but IS the creator -- the
      // real business-rule rejection, 422 APPROVAL.SELF_APPROVAL_FORBIDDEN, not a 403.
      const selfApprove = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/purchase-orders/${poId}/approve`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(selfApprove.status).toBe(422);
      expect(selfApprove.json.code).toBe("APPROVAL.SELF_APPROVAL_FORBIDDEN");

      // Real DB: still draft/open after both rejected attempts -- neither one moved anything.
      const db = getDb();
      const [afterRejections] = await db
        .select({ status: purchaseOrders.status, orderStatus: purchaseOrders.orderStatus })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.purchaseOrderId, poId));
      expect(afterRejections?.status).toBe("draft");
      expect(afterRejections?.orderStatus).toBe("open");

      // A different eligible user (managerB, also pharmacy_manager, NOT the creator) approves.
      const approveRes = await request<PurchaseOrderResponse>(testApp, {
        method: "POST",
        url: `/purchase-orders/${poId}/approve`,
        token: managerB.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(approveRes.status, JSON.stringify(approveRes.json)).toBe(200);
      expect(approveRes.json.purchaseOrder.status).toBe("confirmed");
      expect(approveRes.json.purchaseOrder.orderStatus).toBe("open"); // approve never touches orderStatus

      const [afterApprove] = await db
        .select({ status: purchaseOrders.status, orderStatus: purchaseOrders.orderStatus })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.purchaseOrderId, poId));
      expect(afterApprove?.status).toBe("confirmed");

      // close: confirmed -> orderStatus 'closed' (terminal); `status` itself stays 'confirmed'.
      const closeRes = await request<PurchaseOrderResponse>(testApp, {
        method: "POST",
        url: `/purchase-orders/${poId}/close`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(closeRes.status, JSON.stringify(closeRes.json)).toBe(200);
      expect(closeRes.json.purchaseOrder.status).toBe("confirmed");
      expect(closeRes.json.purchaseOrder.orderStatus).toBe("closed");

      const [afterClose] = await db
        .select({ status: purchaseOrders.status, orderStatus: purchaseOrders.orderStatus })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.purchaseOrderId, poId));
      expect(afterClose?.status).toBe("confirmed");
      expect(afterClose?.orderStatus).toBe("closed");

      // Real DB: this purchase order never touched stock or the GL (purchase-order.service.ts's
      // header comment) -- the item's average and stock are exactly as they were created (zero).
      expect(await currentAvgUnitCost(item.itemId)).toBe("0.00000");
      expect((await totalStockOnHand(item.itemId)).isZero()).toBe(true);
    });

    it("cancel moves a DRAFT order straight to a terminal cancelled state on both axes", async () => {
      const item = await createFreshItem(tenantId, 5);
      const createRes = await request<PurchaseOrderResponse>(testApp, {
        method: "POST",
        url: "/purchase-orders",
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          supplierId: supplier.supplierId,
          documentDate: DOC_DATE,
          lines: [{ itemId: item.itemId, qtyOrdered: "3", unitPrice: "10.00" }],
        },
      });
      expect(createRes.status).toBe(201);
      const poId = createRes.json.purchaseOrder.purchaseOrderId;

      const cancelRes = await request<PurchaseOrderResponse>(testApp, {
        method: "POST",
        url: `/purchase-orders/${poId}/cancel`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: { reason: "no longer needed" },
      });
      expect(cancelRes.status, JSON.stringify(cancelRes.json)).toBe(200);
      expect(cancelRes.json.purchaseOrder.status).toBe("cancelled");
      expect(cancelRes.json.purchaseOrder.orderStatus).toBe("cancelled");

      const db = getDb();
      const [row] = await db
        .select({ status: purchaseOrders.status, orderStatus: purchaseOrders.orderStatus, cancelledBy: purchaseOrders.cancelledBy })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.purchaseOrderId, poId));
      expect(row?.status).toBe("cancelled");
      expect(row?.orderStatus).toBe("cancelled");
      expect(row?.cancelledBy).toBe(managerA.userId);

      // Terminal: a second cancel is rejected, not a silent no-op.
      const secondCancel = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/purchase-orders/${poId}/cancel`,
        token: managerA.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(secondCancel.status).toBe(422);
      expect(secondCancel.json.code).toBe("PURCHASE_ORDER.ALREADY_TERMINAL");
    });
  });
});
