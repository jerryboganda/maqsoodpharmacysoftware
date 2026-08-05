// Wave 8 (U-062/D18/R7 -- docs/system-analysis/00b-owner-decisions-and-requirements.md) integration
// tests: controlled-drug dispensing capture at the point of sale, the Controlled Drug Register
// report, branch DRAP licence CRUD, and the licence-expiring notification -- including a real
// regression guard for the Date-serialization bug this wave found (and fixed) in
// notification.service.ts's own PRE-EXISTING condition (b) `expiry_risk` scan; see that file's
// `dateOnlyParam` doc comment for the full root-cause writeup. Mirrors sales.test.ts's own
// fixture-loading conventions (real seeded rows, real purchase-then-sale round trip, never
// invented stock).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { branches, getDb, items, paymentMethods, suppliers } from "@pharmacy/db";
import { costAmount } from "@pharmacy/money";

import { localToday } from "../src/common/dates/index.js";
import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

// ---- response-shape types (only the fields these tests actually assert on) -------------------

interface SaleInvoiceLineJson {
  saleInvoiceLineId: number;
  itemId: number;
  qtyBase: string;
  dispensingNote: string | null;
}

interface CreateSaleInvoiceResponse {
  saleInvoice: { saleInvoiceId: number; status: string };
  lines: SaleInvoiceLineJson[];
}

interface CreatePurchaseInvoiceResponse {
  purchaseInvoice: { purchaseInvoiceId: number; status: string };
}

interface ReportRunResponse {
  data: {
    key: string;
    docNumber: string;
    postingDate: string;
    itemId: number;
    itemName: string;
    batchNo: string | null;
    qty: string;
    dispensingNote: string | null;
    dispensedByUserId: number | null;
    dispensedByName: string | null;
  }[];
  meta: { total: number };
}

interface BranchJson {
  branchId: number;
  name: string;
  drugSaleLicenceNo: string | null;
  drugLicenceExpiryDate: string | null;
}

interface NotificationRow {
  notificationId: number;
  kind: string;
  severity: string;
  sourceType: string;
  sourceId: number;
  title: string;
  body: string;
}

interface NotificationsListResponse {
  notifications: NotificationRow[];
}

// ---- fixtures (real seeded rows -- packages/db/scripts/seed.ts) -------------------------------

interface Fixtures {
  readonly tenantId: number;
  readonly supplierId: number;
  readonly branchId: number;
  readonly paraItemId: number;
  readonly cashPaymentMethodId: number;
}

async function loadFixtures(): Promise<Fixtures> {
  const db = getDb();

  const [supplier] = await db
    .select({ supplierId: suppliers.supplierId, tenantId: suppliers.tenantId })
    .from(suppliers)
    .where(eq(suppliers.code, "DEV_SUPPLIER"));
  if (!supplier) throw new Error('loadFixtures: seeded supplier "DEV_SUPPLIER" not found -- is the test database migrated+seeded?');
  const tenantId = supplier.tenantId;

  const [para] = await db
    .select({ itemId: items.itemId })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.customCode, "PARA500")));
  if (!para) throw new Error('loadFixtures: seeded dev item "PARA500" not found.');

  const [cash] = await db
    .select({ paymentMethodId: paymentMethods.paymentMethodId })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.code, "CASH")));
  if (!cash) throw new Error('loadFixtures: seeded payment method "CASH" not found.');

  const [branch] = await db.select({ branchId: branches.branchId }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.isDefault, true)));
  if (!branch) throw new Error("loadFixtures: seeded default branch not found.");

  return { tenantId, supplierId: supplier.supplierId, branchId: branch.branchId, paraItemId: para.itemId, cashPaymentMethodId: cash.paymentMethodId };
}

let batchCounter = 0;
function freshBatch(label: string): string {
  batchCounter += 1;
  return `T-CDR-${label}-${Date.now().toString(36)}-${batchCounter}`;
}
const FAR_FUTURE_EXPIRY = "2030-06-30";

/** `localToday()` + `days` calendar days, as YYYY-MM-DD -- local-time arithmetic, mirrors
 *  report-helpers.ts's own `addDays` (duplicated here rather than imported: that function lives in
 *  the reporting module, this is a small test-local need). */
function daysFromToday(days: number): string {
  const d = new Date(`${localToday()}T00:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("Wave 8: controlled-drug compliance (U-062/D18/R7)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let manager: LoggedInUser; // pharmacy_manager -- catalog.item:edit, sale.cash:create, report:view
  let fx: Fixtures;
  // Unique per run (not a fixed literal): a posted sale invoice is immutable, so an earlier run of
  // this file against the same shared local dev database leaves its own dispensingNote row behind
  // forever -- a fixed string would make test 2's `.find()` pick up a STALE row from a previous
  // run (with a different dispensing user), not this run's own row. Same "never assume a fixture
  // is fresh on a reused local DB" discipline sales.test.ts's own `freshBatch()` already documents.
  const DISPENSING_NOTE = `Buyer: Test Patient (walk-in); prescribing physician on file [${Date.now().toString(36)}]`;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    fx = await loadFixtures();
  });

  afterAll(async () => {
    // Leave the shared seeded fixtures (PARA500, the default branch) exactly as this suite found
    // them -- same "don't leave state behind on a shared local dev database" discipline
    // sales.test.ts's own fixtures already establish.
    await request(testApp, {
      method: "PATCH",
      url: `/items/${fx.paraItemId}`,
      token: manager.token,
      body: { isControlledDrug: false },
    });
    await request(testApp, {
      method: "PATCH",
      url: `/settings/branches/${fx.branchId}`,
      token: owner.token,
      body: { drugSaleLicenceNo: null, drugLicenceExpiryDate: null },
    });
    await testApp.close();
  });

  it("1. marking an item controlled-drug + posting a cash sale with a dispensingNote persists it on the real sale_invoice_line row", async () => {
    const patchItem = await request<{ itemId: number; isControlledDrug: boolean }>(testApp, {
      method: "PATCH",
      url: `/items/${fx.paraItemId}`,
      token: manager.token,
      body: { isControlledDrug: true },
    });
    expect(patchItem.status).toBe(200);
    expect(patchItem.json.isControlledDrug).toBe(true);

    const purchaseRes = await request<CreatePurchaseInvoiceResponse>(testApp, {
      method: "POST",
      url: "/purchase-invoices",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        supplierId: fx.supplierId,
        documentDate: localToday(),
        lines: [{ itemId: fx.paraItemId, qtyPack: "10", unitPurchasePrice: "15.00", batchNo: freshBatch("t1"), expiryDate: FAR_FUTURE_EXPIRY }],
      },
    });
    expect(purchaseRes.status).toBe(201);

    const saleRes = await request<CreateSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        documentDate: localToday(),
        lines: [{ itemId: fx.paraItemId, qty: "2", unitSalePrice: "20.00", dispensingNote: DISPENSING_NOTE }],
        payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: costAmount("2", "20.00") }],
      },
    });
    expect(saleRes.status).toBe(201);
    expect(saleRes.json.saleInvoice.status).toBe("posted");
    expect(saleRes.json.lines.length).toBeGreaterThan(0);
    expect(saleRes.json.lines[0]!.dispensingNote).toBe(DISPENSING_NOTE);

    // -- real DB row, not just the response echo -----------------------------------------------
    const db = getDb();
    const { saleInvoiceLines } = await import("@pharmacy/db");
    const [row] = await db
      .select({ dispensingNote: saleInvoiceLines.dispensingNote })
      .from(saleInvoiceLines)
      .where(eq(saleInvoiceLines.saleInvoiceLineId, saleRes.json.lines[0]!.saleInvoiceLineId));
    expect(row?.dispensingNote).toBe(DISPENSING_NOTE);
  });

  it("2. GET (POST /reports/controlled-drug-register/run) includes that exact dispensing event with its note and dispensing user", async () => {
    const res = await request<ReportRunResponse>(testApp, {
      method: "POST",
      url: "/reports/controlled-drug-register/run",
      token: manager.token,
      body: { filters: { dateFrom: localToday(), dateTo: localToday(), itemId: fx.paraItemId } },
    });
    expect(res.status).toBe(201); // POST /reports/:reportId/run has no @HttpCode override -- Nest's POST default
    const row = res.json.data.find((r) => r.dispensingNote === DISPENSING_NOTE);
    expect(row).toBeDefined();
    expect(row!.itemId).toBe(fx.paraItemId);
    expect(row!.dispensedByUserId).toBe(manager.userId);
  });

  it("3. PATCH /settings/branches/:id sets DRAP licence fields; GET /settings/branches reflects the real row", async () => {
    const expiry = daysFromToday(10); // inside the 60-day warning window -- feeds test 4
    const patchRes = await request<BranchJson>(testApp, {
      method: "PATCH",
      url: `/settings/branches/${fx.branchId}`,
      token: owner.token,
      body: { drugSaleLicenceNo: "DRAP-TEST-0001", drugLicenceExpiryDate: expiry },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.json.drugSaleLicenceNo).toBe("DRAP-TEST-0001");
    expect(patchRes.json.drugLicenceExpiryDate).toBe(expiry);

    const listRes = await request<{ branchId: number; drugSaleLicenceNo: string | null; drugLicenceExpiryDate: string | null }[]>(testApp, {
      method: "GET",
      url: "/settings/branches",
      token: owner.token,
    });
    expect(listRes.status).toBe(200);
    const found = listRes.json.find((b) => b.branchId === fx.branchId);
    expect(found?.drugSaleLicenceNo).toBe("DRAP-TEST-0001");
    expect(found?.drugLicenceExpiryDate).toBe(expiry);
  });

  it("4. a licence expiring within 60 days materializes a real licence_expiring alert for the owner, and pushing it past the window clears it -- the regression guard for the Date-serialization bug notification.service.ts's dateOnlyParam fixes", async () => {
    // Test 3 already set drugLicenceExpiryDate to today+10 (inside the 60-day window). If the
    // pre-fix bug (Date object serialized via .toISOString() into a "...T00:00:00.000Z" SQL
    // parameter MySQL's DATE comparison does not reliably match) were still present, this `lte`
    // filter would silently match nothing and NO alert would ever materialize here.
    const list1 = await request<NotificationsListResponse>(testApp, { method: "GET", url: "/notifications?limit=200", token: owner.token });
    expect(list1.status).toBe(200);
    const alert = list1.json.notifications.find((n) => n.kind === "licence_expiring" && n.sourceType === "branch" && n.sourceId === fx.branchId);
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("warning"); // not yet lapsed

    // -- the real notification table, queried directly ------------------------------------------
    const db = getDb();
    const { notifications } = await import("@pharmacy/db");
    const dbRows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, fx.tenantId), eq(notifications.sourceType, "branch"), eq(notifications.sourceId, fx.branchId), eq(notifications.kind, "licence_expiring")));
    expect(dbRows).toHaveLength(1);

    // -- clear the condition: push the expiry well past the 60-day window -----------------------
    const farExpiry = daysFromToday(200);
    const clearRes = await request(testApp, {
      method: "PATCH",
      url: `/settings/branches/${fx.branchId}`,
      token: owner.token,
      body: { drugLicenceExpiryDate: farExpiry },
    });
    expect(clearRes.status).toBe(200);

    const list2 = await request<NotificationsListResponse>(testApp, { method: "GET", url: "/notifications?limit=200", token: owner.token });
    const stillThere = list2.json.notifications.find((n) => n.kind === "licence_expiring" && n.sourceType === "branch" && n.sourceId === fx.branchId);
    expect(stillThere).toBeUndefined();

    const dbRowsAfter = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, fx.tenantId), eq(notifications.sourceType, "branch"), eq(notifications.sourceId, fx.branchId), eq(notifications.kind, "licence_expiring")));
    expect(dbRowsAfter).toHaveLength(0);
  });
});
