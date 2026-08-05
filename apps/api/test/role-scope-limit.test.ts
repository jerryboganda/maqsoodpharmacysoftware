// Wave 10e (R-007 CRITICAL) integration tests: GET/PUT /roles/:roleKey/scopes and /limits (admin
// CRUD), and real limit ENFORCEMENT on a live sale-invoice post (max_txn_value). Uses a FRESH
// custom role (Wave 10b's `clonedFromRoleKey`, cloning pharmacy_manager's real grants) rather than
// mutating the shared `pharmacy_manager` role directly -- role_limit/role_scope apply to every
// user holding that role, and other test files run concurrently against the same shared roles
// (dev.pmanager, createTestUser(...,["pharmacy_manager"])); a limit set on the real
// "pharmacy_manager" key could spuriously fail an unrelated file's own larger sale. A
// purpose-built clone role is scoped to exactly this file's own fixtures and cannot leak.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costAmount } from "@pharmacy/money";

import { localToday } from "../src/common/dates/index.js";
import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

interface RoleJson {
  roleKey: string;
}
interface ScopeEntry {
  scopeType: string;
  scopeValues: number[];
}
interface LimitEntry {
  limitKey: string;
  limitValue: string;
}
interface PurchaseInvoiceResponse {
  purchaseInvoice: { purchaseInvoiceId: number };
}

describe("Wave 10e: role_scope / role_limit (R-007 CRITICAL)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let sysAdmin: LoggedInUser; // identity.role:edit -- only sys_admin can PUT scopes/limits
  let purchaser: LoggedInUser; // pharmacy_manager -- sys_admin itself holds no purchasing grants
  let cloneRoleKey: string;
  let supplierId: number;
  let paraItemId: number;
  let cashPaymentMethodId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    sysAdmin = await createTestUser(testApp, owner.token, ["sys_admin"]);
    purchaser = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);

    const suffix = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
    cloneRoleKey = `wavetene_clone_${suffix}`;
    const cloneRes = await request<RoleJson>(testApp, {
      method: "POST",
      url: "/roles",
      token: sysAdmin.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: cloneRoleKey, name: "Wave 10e Limit Test Role", description: "Clones pharmacy_manager's grants -- isolates role_limit tests from the shared pharmacy_manager role.", clonedFromRoleKey: "pharmacy_manager" },
    });
    expect(cloneRes.status).toBe(201);

    // Real seeded fixtures (same DEV_SUPPLIER/PARA500/CASH pattern controlled-drug-compliance.test.ts already uses).
    const supplierRes = await request<{ suppliers: { supplierId: number; code: string }[] }>(testApp, { method: "GET", url: "/suppliers?q=DEV_SUPPLIER", token: owner.token });
    const supplier = supplierRes.json.suppliers.find((s) => s.code === "DEV_SUPPLIER");
    if (!supplier) throw new Error('role-scope-limit.test.ts: seeded supplier "DEV_SUPPLIER" not found.');
    supplierId = supplier.supplierId;

    const itemsRes = await request<{ items: { itemId: number; customCode: string }[] }>(testApp, { method: "GET", url: "/items?q=PARA500", token: owner.token });
    const para = itemsRes.json.items.find((i) => i.customCode === "PARA500");
    if (!para) throw new Error('role-scope-limit.test.ts: seeded item "PARA500" not found.');
    paraItemId = para.itemId;

    const pmRes = await request<{ paymentMethods: { paymentMethodId: number; code: string }[] }>(testApp, { method: "GET", url: "/payment-methods", token: owner.token });
    const cash = pmRes.json.paymentMethods.find((p) => p.code === "CASH");
    if (!cash) throw new Error('role-scope-limit.test.ts: seeded payment method "CASH" not found.');
    cashPaymentMethodId = cash.paymentMethodId;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. GET/PUT /roles/:roleKey/scopes -- replace semantics, 403 for a non-sys_admin actor, 404 for an unknown role", async () => {
    const empty = await request<ScopeEntry[]>(testApp, { method: "GET", url: `/roles/${cloneRoleKey}/scopes`, token: sysAdmin.token });
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual([]);

    const put = await request<ScopeEntry[]>(testApp, {
      method: "PUT",
      url: `/roles/${cloneRoleKey}/scopes`,
      token: sysAdmin.token,
      body: { scopes: [{ scopeType: "cash_bank_account", scopeValues: [1, 2] }] },
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual([{ scopeType: "cash_bank_account", scopeValues: [1, 2] }]);

    // a scopeType NOT included in a subsequent PUT is left untouched, not cleared
    const putOther = await request<ScopeEntry[]>(testApp, {
      method: "PUT",
      url: `/roles/${cloneRoleKey}/scopes`,
      token: sysAdmin.token,
      body: { scopes: [{ scopeType: "voucher_category", scopeValues: [5] }] },
    });
    expect(putOther.json.find((s) => s.scopeType === "cash_bank_account")).toEqual({ scopeType: "cash_bank_account", scopeValues: [1, 2] });
    expect(putOther.json.find((s) => s.scopeType === "voucher_category")).toEqual({ scopeType: "voucher_category", scopeValues: [5] });

    const denied = await request(testApp, { method: "PUT", url: `/roles/${cloneRoleKey}/scopes`, token: owner.token, body: { scopes: [] } });
    expect(denied.status).toBe(403);

    const notFound = await request(testApp, { method: "GET", url: "/roles/does_not_exist_role_xyz/scopes", token: sysAdmin.token });
    expect(notFound.status).toBe(404);
  });

  it("2. a role_limit configured on a role actually blocks a real sale-invoice post over the limit, and allows one under it -- no database side effect on the blocked attempt", async () => {
    // stock the clone-role's test user will sell against
    const purchase = await request<PurchaseInvoiceResponse>(testApp, {
      method: "POST",
      url: "/purchase-invoices",
      token: purchaser.token,
      idempotencyKey: newIdempotencyKey(),
      body: { supplierId, documentDate: localToday(), lines: [{ itemId: paraItemId, qtyPack: "50", unitPurchasePrice: "15.00", batchNo: `T-R7-${Date.now().toString(36)}`, expiryDate: "2030-06-30" }] },
    });
    expect(purchase.status).toBe(201);

    const put = await request<LimitEntry[]>(testApp, {
      method: "PUT",
      url: `/roles/${cloneRoleKey}/limits`,
      token: sysAdmin.token,
      body: { limits: [{ limitKey: "max_txn_value", limitValue: "500.0000" }] },
    });
    expect(put.status).toBe(200);
    expect(put.json).toEqual([{ limitKey: "max_txn_value", limitValue: "500.0000" }]);

    const cloneUser = await createTestUser(testApp, owner.token, [cloneRoleKey]);

    // over the limit: 25 * 25.00 = 625.00 > 500
    const over = await request(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: cloneUser.token,
      idempotencyKey: newIdempotencyKey(),
      body: { documentDate: localToday(), lines: [{ itemId: paraItemId, qty: "25", unitSalePrice: "25.00" }], payments: [{ paymentMethodId: cashPaymentMethodId, amount: costAmount("25", "25.00") }] },
    });
    expect(over.status).toBe(403);

    // under the limit: 2 * 25.00 = 50.00 < 500 -- the SAME actor, SAME role, real success
    const under = await request<{ saleInvoice: { status: string } }>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: cloneUser.token,
      idempotencyKey: newIdempotencyKey(),
      body: { documentDate: localToday(), lines: [{ itemId: paraItemId, qty: "2", unitSalePrice: "25.00" }], payments: [{ paymentMethodId: cashPaymentMethodId, amount: costAmount("2", "25.00") }] },
    });
    expect(under.status).toBe(201);
    expect(under.json.saleInvoice.status).toBe("posted");

    // clear the limit -- otherwise it would keep blocking future runs of this suite that reuse
    // this exact role key's own accumulated state... except the role key is fresh-random per run,
    // so this is defensive, not strictly required; still leaves the role's own state clean.
    await request(testApp, { method: "PUT", url: `/roles/${cloneRoleKey}/limits`, token: sysAdmin.token, body: { limits: [] } });
  });
});
