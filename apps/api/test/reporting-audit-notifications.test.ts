// Integration tests for reporting (src/modules/reporting/**), audit (src/modules/audit/**, plus
// the cross-cutting writer at src/common/audit/**), and notifications (src/modules/notifications/
// **). Real Nest+Fastify app, real MySQL -- see test/support/test-app.ts's own header comment for
// why: these three modules are pure read/aggregate surfaces over data every OTHER module writes,
// so the only meaningful way to test them is against a real posted document, not a stub.
//
// Shared-database discipline (same reasoning sales.test.ts's own header comment documents): this
// file never asserts an absolute report/dashboard total, because other test files (and other runs
// of this one, on a shared local dev database) may have already posted sales "today" for the same
// tenant. Every numeric assertion here is a real before/after DELTA read off two live API calls
// that bracket one real mutation -- proof the aggregate actually moved by exactly what the new
// document contributed, not a stale or wrong number that merely happens to look plausible.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  adjustmentReasons,
  auditLog,
  customers,
  getDb,
  items,
  notifications,
  paymentMethods,
  suppliers,
} from "@pharmacy/db";
import { costAmount, Money } from "@pharmacy/money";

import { localToday } from "../src/common/dates/index.js";
import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

// ---- response-shape types (only the fields these tests actually assert on) -------------------

interface SaleInvoiceJson {
  saleInvoiceId: number;
  status: string;
  netAmount: string;
  invoiceTotal: string;
}

interface CreateSaleInvoiceResponse {
  saleInvoice: SaleInvoiceJson;
}

interface PurchaseInvoiceLineJson {
  purchaseInvoiceLineId: number;
  itemId: number;
  stockLotId: number;
  qtyBase: string;
}

interface CreatePurchaseInvoiceResponse {
  purchaseInvoice: { purchaseInvoiceId: number; docNumber: string; status: string };
  lines: PurchaseInvoiceLineJson[];
}

interface SalesSummaryRow {
  key: string;
  label: string;
  netAmount: string;
  invoiceCount: number;
}

interface RunReportResponse {
  reportId: string;
  generatedAt: string;
  data: SalesSummaryRow[];
  meta: { offset: number; limit: number; total: number; hasMore: boolean };
}

interface DashboardSummaryResponse {
  todaysSalesTotal: string;
  todaysSaleCount: number;
  [key: string]: unknown;
}

interface CreateUserResponse {
  userId: string;
  username: string;
  roles: string[];
  temporaryPassword: string;
}

interface AuditEventJson {
  auditLogId: number;
  action: string;
  entityType: string;
  entityId: number | null;
  afterJson: unknown;
  [key: string]: unknown;
}

interface StockAdjustmentJson {
  stockAdjustmentId: number;
  status: string;
  direction: string;
  requiresApproval: boolean;
  approvedBy: number | null;
}

interface NotificationRow {
  notificationId: number;
  recipientRoleKey: string | null;
  kind: string;
  severity: string;
  sourceType: string;
  sourceId: number | null;
  readAt: string | null;
}

interface NotificationsListResponse {
  notifications: NotificationRow[];
  unreadCount: number;
  offset: number;
  limit: number;
}

interface MarkReadResponse {
  notification: NotificationRow;
}

// ---- fixtures (real seeded rows -- packages/db/scripts/seed.ts) -------------------------------

interface Fixtures {
  readonly tenantId: number;
  readonly supplierId: number;
  readonly orsItemId: number;
  readonly orsSalePrice: string;
  readonly cashPaymentMethodId: number;
  readonly walkInCustomerId: number;
  /** "Theft / shrinkage" -- the one seeded reason with `requiresApproval: true`
   *  (packages/db/scripts/seed.ts's ADJUSTMENT_REASONS, its own comment on that row). */
  readonly theftReasonId: number;
}

async function loadFixtures(): Promise<Fixtures> {
  const db = getDb();

  const [supplier] = await db
    .select({ supplierId: suppliers.supplierId, tenantId: suppliers.tenantId })
    .from(suppliers)
    .where(eq(suppliers.code, "DEV_SUPPLIER"));
  if (!supplier) throw new Error('loadFixtures: seeded supplier "DEV_SUPPLIER" not found -- is the test database migrated+seeded?');
  const tenantId = supplier.tenantId;

  const [ors] = await db
    .select({ itemId: items.itemId, salePrice: items.salePrice })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.customCode, "ORS200")));
  if (!ors) throw new Error('loadFixtures: seeded dev item "ORS200" not found.');

  const [cash] = await db
    .select({ paymentMethodId: paymentMethods.paymentMethodId })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.code, "CASH")));
  if (!cash) throw new Error('loadFixtures: seeded payment method "CASH" not found.');

  const [walkIn] = await db
    .select({ customerId: customers.customerId })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.isWalkIn, true)));
  if (!walkIn) throw new Error("loadFixtures: seeded walk-in customer not found.");

  const [theft] = await db
    .select({ adjustmentReasonId: adjustmentReasons.adjustmentReasonId })
    .from(adjustmentReasons)
    .where(and(eq(adjustmentReasons.tenantId, tenantId), eq(adjustmentReasons.code, "THEFT")));
  if (!theft) throw new Error('loadFixtures: seeded adjustment reason "THEFT" (requiresApproval: true) not found.');

  return {
    tenantId,
    supplierId: supplier.supplierId,
    orsItemId: ors.itemId,
    orsSalePrice: ors.salePrice,
    cashPaymentMethodId: cash.paymentMethodId,
    walkInCustomerId: walkIn.customerId,
    theftReasonId: theft.adjustmentReasonId,
  };
}

// ---- small helpers ------------------------------------------------------------------------------

let batchCounter = 0;
/** A fresh batch number per purchase -- see sales.test.ts's identical helper/reasoning: `stock_lot`
 *  identity is (item, batchKey, expiryKey), so a unique batch always mints a brand-new lot rather
 *  than reusing one another test (or an earlier run of this file) already touched. */
function freshBatch(label: string): string {
  batchCounter += 1;
  return `T-RAN-${label}-${Date.now().toString(36)}-${batchCounter}`;
}

const FAR_FUTURE_EXPIRY = "2030-06-30";

async function purchase(
  testApp: TestApp,
  token: string,
  fx: Fixtures,
  params: { itemId: number; qtyPack: string; unitPurchasePrice: string; batchNo: string },
): Promise<CreatePurchaseInvoiceResponse> {
  const res = await request<CreatePurchaseInvoiceResponse>(testApp, {
    method: "POST",
    url: "/purchase-invoices",
    token,
    idempotencyKey: newIdempotencyKey(),
    body: {
      supplierId: fx.supplierId,
      documentDate: localToday(),
      lines: [{ itemId: params.itemId, qtyPack: params.qtyPack, unitPurchasePrice: params.unitPurchasePrice, batchNo: params.batchNo, expiryDate: FAR_FUTURE_EXPIRY }],
    },
  });
  if (res.status !== 201) throw new Error(`fixture purchase: POST /purchase-invoices returned ${res.status}: ${JSON.stringify(res.json)}`);
  return res.json;
}

/** Sells `qty` units of ORS200 to the walk-in customer for exactly its own `qty x salePrice` (cash,
 *  no change), and returns the real posted invoice. Callers read `saleInvoice.netAmount` back off
 *  the response rather than recomputing it -- that field is exactly what both the sales-summary
 *  report and the dashboard's `todaysSalesTotal` sum server-side (metric-definitions.ts's own
 *  "net_sales" definition), so comparing against it (not a locally-recomputed gross) is the
 *  correct way to prove the aggregate reflects THIS invoice. */
async function sellOrs(testApp: TestApp, token: string, fx: Fixtures, qty: string): Promise<SaleInvoiceJson> {
  const gross = costAmount(qty, fx.orsSalePrice);
  const res = await request<CreateSaleInvoiceResponse>(testApp, {
    method: "POST",
    url: "/sale-invoices",
    token,
    idempotencyKey: newIdempotencyKey(),
    body: {
      customerId: fx.walkInCustomerId,
      documentDate: localToday(),
      lines: [{ itemId: fx.orsItemId, qty }],
      payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: gross }],
    },
  });
  if (res.status !== 201 || res.json.saleInvoice.status !== "posted") {
    throw new Error(`fixture sale: POST /sale-invoices returned ${res.status}: ${JSON.stringify(res.json)}`);
  }
  return res.json.saleInvoice;
}

async function runSalesSummaryToday(testApp: TestApp, token: string): Promise<RunReportResponse> {
  const today = localToday();
  const res = await request<RunReportResponse>(testApp, {
    method: "POST",
    url: "/reports/sales-summary/run",
    token,
    body: { filters: { dateFrom: today, dateTo: today }, limit: 200 },
  });
  // reports.controller.ts's `run` route carries no `@HttpCode` override -- Nest's default success
  // status for a POST is 201, confirmed against the real running app (same gotcha sales.test.ts
  // documents for several of its own POST routes).
  if (res.status !== 201) throw new Error(`POST /reports/sales-summary/run returned ${res.status}: ${JSON.stringify(res.json)}`);
  return res.json;
}

/** `AuditInterceptor`'s write is fire-and-forget (`void this.audit.write(...)`, see its own header
 *  comment) -- the row lands sometime after the mutating call's own HTTP response, not before.
 *  Polls `GET /audit/events` (identity-users.test.ts's identical pattern) rather than asserting
 *  immediately, so this test doesn't become flaky on a slower runner. */
async function pollForAuditEvent(
  testApp: TestApp,
  token: string,
  entityType: string,
  entityId: number,
  action: string,
  timeoutMs = 5000,
): Promise<AuditEventJson | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request<{ events: AuditEventJson[] }>(testApp, {
      method: "GET",
      url: `/audit/events?entityType=${encodeURIComponent(entityType)}&entityId=${entityId}&action=${encodeURIComponent(action)}&limit=10`,
      token,
    });
    if (res.status === 200 && res.json.events.length > 0) return res.json.events[0];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

let usernameCounter = 0;
function uniqueUsername(label: string): string {
  usernameCounter += 1;
  return `test.rptaudit.${label}.${Date.now().toString(36)}${usernameCounter}`;
}

// ---- suite ------------------------------------------------------------------------------------

describe("reporting + audit + notifications integration", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let manager: LoggedInUser; // pharmacy_manager -- holds report:view, dashboard:view_dashboard, notification:*, inventory.adjustment:create
  let fx: Fixtures;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    fx = await loadFixtures();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. POST /reports/sales-summary/run reflects a real posted sale invoice's own netAmount/invoiceCount via a real before/after delta", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "20", unitPurchasePrice: "22.00", batchNo: freshBatch("rpt1") });

    const before = await runSalesSummaryToday(testApp, manager.token);
    const today = localToday();
    const beforeRow = before.data.find((r) => r.key === today);
    const beforeNet = beforeRow ? Money.fromDb(beforeRow.netAmount) : Money.zero();
    const beforeCount = beforeRow?.invoiceCount ?? 0;

    const invoice = await sellOrs(testApp, manager.token, fx, "5");
    const invoiceNet = Money.fromDb(invoice.netAmount);
    expect(invoiceNet.isZero()).toBe(false);

    const after = await runSalesSummaryToday(testApp, manager.token);
    expect(after.reportId).toBe("sales-summary");
    const afterRow = after.data.find((r) => r.key === today);
    expect(afterRow).toBeDefined();
    const afterNet = Money.fromDb(afterRow!.netAmount);

    // The real delta is EXACTLY this invoice's own real netAmount -- not a stale number that merely
    // increased, and not a wrong aggregate that happens to differ.
    expect(afterNet.sub(beforeNet).toDb()).toBe(invoiceNet.toDb());
    expect(afterRow!.invoiceCount - beforeCount).toBe(1);
  });

  it("2. GET /dashboards/summary's todaysSalesTotal moves by exactly the invoice just posted (real before/after delta)", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "20", unitPurchasePrice: "22.00", batchNo: freshBatch("dash1") });

    const before = await request<DashboardSummaryResponse>(testApp, { method: "GET", url: "/dashboards/summary", token: manager.token });
    expect(before.status).toBe(200);
    const beforeTotal = Money.fromDb(before.json.todaysSalesTotal);
    const beforeCount = before.json.todaysSaleCount;

    const invoice = await sellOrs(testApp, manager.token, fx, "3");
    const invoiceNet = Money.fromDb(invoice.netAmount);

    const after = await request<DashboardSummaryResponse>(testApp, { method: "GET", url: "/dashboards/summary", token: manager.token });
    expect(after.status).toBe(200);
    const afterTotal = Money.fromDb(after.json.todaysSalesTotal);

    expect(afterTotal.sub(beforeTotal).toDb()).toBe(invoiceNet.toDb());
    expect(after.json.todaysSaleCount - beforeCount).toBe(1);
  });

  it("3. REGRESSION: POST /users' real plaintext temporaryPassword is redacted to \"[REDACTED]\" in the real audit_log row, never stored anywhere in plaintext", async () => {
    const username = uniqueUsername("redact");
    const created = await request<CreateUserResponse>(testApp, {
      method: "POST",
      url: "/users",
      token: owner.token,
      idempotencyKey: newIdempotencyKey(),
      body: { username, displayName: "Redaction Regression User", roles: ["sales_officer"] },
    });
    expect(created.status).toBe(201);
    const plaintextPassword = created.json.temporaryPassword;
    expect(typeof plaintextPassword).toBe("string");
    expect(plaintextPassword.length).toBeGreaterThanOrEqual(12);
    const userId = Number(created.json.userId);

    // -- via the API (GET /audit/events), the redaction is real -----------------------------------
    const event = await pollForAuditEvent(testApp, owner.token, "identity.user", userId, "create");
    expect(event).toBeDefined();
    const apiAfterJsonStr = JSON.stringify(event!.afterJson);
    expect(apiAfterJsonStr).toContain("[REDACTED]");
    expect(apiAfterJsonStr).not.toContain(plaintextPassword);
    expect((event!.afterJson as Record<string, unknown>)["temporaryPassword"]).toBe("[REDACTED]");

    // -- strongest version: the REAL audit_log row, read directly off the database, not just the
    // API's own re-serialization of it. The plaintext password must never be present anywhere in
    // its actual persisted content.
    const db = getDb();
    const [dbRow] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "identity.user"), eq(auditLog.entityId, userId), eq(auditLog.action, "create")));
    expect(dbRow).toBeDefined();
    // mysql2 parses a JSON column into a real JS value by default; defensively handle either shape.
    const dbAfterJson = typeof dbRow!.afterJson === "string" ? (JSON.parse(dbRow!.afterJson) as unknown) : dbRow!.afterJson;
    const dbAfterJsonStr = JSON.stringify(dbAfterJson);
    expect(dbAfterJsonStr).toContain("[REDACTED]");
    expect(dbAfterJsonStr).not.toContain(plaintextPassword);
    expect((dbAfterJson as Record<string, unknown>)["temporaryPassword"]).toBe("[REDACTED]");
    // Full-row belt-and-braces: the plaintext must not leak into any OTHER column on this row either
    // (beforeJson, reason, entityLabel, ...).
    expect(JSON.stringify(dbRow)).not.toContain(plaintextPassword);
  });

  it("4. a real unapproved adjustment-pending-approval condition materializes for a pharmacy_manager via GET /notifications, marks read (unreadCount -1), and re-scanning is idempotent (no duplicate row)", async () => {
    const purchased = await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "30", unitPurchasePrice: "22.00", batchNo: freshBatch("notif1") });
    const stockLotId = purchased.lines[0]!.stockLotId;

    // notification.service.ts scanForAlerts's condition (c): status='draft' AND requiresApproval=true
    // AND approvedBy IS NULL -- exactly what creating (and NOT posting/approving) a "THEFT" reason
    // adjustment produces, per stock-adjustment.service.ts's create().
    const adjRes = await request<StockAdjustmentJson>(testApp, {
      method: "POST",
      url: "/stock-adjustments",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        direction: "decrease",
        adjustmentReasonId: fx.theftReasonId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, stockLotId, qty: "2" }],
      },
    });
    expect(adjRes.status).toBe(201);
    expect(adjRes.json.status).toBe("draft");
    expect(adjRes.json.requiresApproval).toBe(true);
    expect(adjRes.json.approvedBy).toBeNull();
    const adjustmentId = adjRes.json.stockAdjustmentId;

    // -- GET /notifications re-runs scanForAlerts SYNCHRONOUSLY -- the alert must be materialized
    // now, visible to the SAME pharmacy_manager actor (role-broadcast, recipientRoleKey). -----------
    const list1 = await request<NotificationsListResponse>(testApp, { method: "GET", url: "/notifications?limit=200", token: manager.token });
    expect(list1.status).toBe(200);
    const alert = list1.json.notifications.find(
      (n) => n.sourceType === "stock_adjustment" && n.sourceId === adjustmentId && n.kind === "adjustment_pending_approval",
    );
    expect(alert).toBeDefined();
    expect(alert!.readAt).toBeNull();
    expect(alert!.recipientRoleKey).toBe("pharmacy_manager");
    expect(alert!.severity).toBe("warning");

    const unreadBefore = list1.json.unreadCount;

    // -- mark it read: unreadCount must decrease by EXACTLY 1 -------------------------------------
    const markRead = await request<MarkReadResponse>(testApp, { method: "POST", url: `/notifications/${alert!.notificationId}/read`, token: manager.token });
    expect(markRead.status).toBe(200);
    expect(markRead.json.notification.readAt).not.toBeNull();

    const list2 = await request<NotificationsListResponse>(testApp, { method: "GET", url: "/notifications?limit=200", token: manager.token });
    expect(list2.status).toBe(200);
    expect(list2.json.unreadCount).toBe(unreadBefore - 1);

    // -- idempotency: the underlying condition is STILL true (never approved/posted), so re-running
    // the scan (this second GET already did) must be a no-op UPSERT on the same row -- not a second
    // row for the same (tenantId, sourceType, sourceId, kind). -------------------------------------
    const matches2 = list2.json.notifications.filter(
      (n) => n.sourceType === "stock_adjustment" && n.sourceId === adjustmentId && n.kind === "adjustment_pending_approval",
    );
    expect(matches2).toHaveLength(1);
    expect(matches2[0]!.notificationId).toBe(alert!.notificationId);
    expect(matches2[0]!.readAt).not.toBeNull();

    // -- strongest idempotency proof: the REAL notification table, queried directly -- exactly one
    // row for this (tenantId, sourceType, sourceId, kind), never duplicated by either scan above.
    const db = getDb();
    const dbRows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, fx.tenantId),
          eq(notifications.sourceType, "stock_adjustment"),
          eq(notifications.sourceId, adjustmentId),
          eq(notifications.kind, "adjustment_pending_approval"),
        ),
      );
    expect(dbRows).toHaveLength(1);
    expect(dbRows[0]!.notificationId).toBe(alert!.notificationId);
    expect(dbRows[0]!.readAt).not.toBeNull();
  });
});
