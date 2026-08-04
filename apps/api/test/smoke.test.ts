// First real test in this suite -- proves the harness itself works (real Nest app boots against
// real MySQL, real login, real permission enforcement) before any other test file trusts it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestUser, loginAsOwner } from "./support/auth.js";
import { createTestApp, request, type TestApp } from "./support/test-app.js";

describe("smoke: test harness itself", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("rejects an unauthenticated request to a protected route", async () => {
    const res = await request(testApp, { method: "GET", url: "/identity/me" });
    expect(res.status).toBe(401);
  });

  it("rejects a request with a garbage bearer token", async () => {
    const res = await request(testApp, { method: "GET", url: "/identity/me", token: "not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("logs in as the seeded owner and reads its own identity", async () => {
    const owner = await loginAsOwner(testApp);
    expect(owner.username).toBe("dev.owner");
    expect(owner.roles).toContain("owner");

    const me = await request<{ username: string }>(testApp, { method: "GET", url: "/identity/me", token: owner.token });
    expect(me.status).toBe(200);
    expect(me.json.username).toBe("dev.owner");
  });

  it("creates a fresh role-scoped user and that user's token is independently usable", async () => {
    const owner = await loginAsOwner(testApp);
    const manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    expect(manager.roles).toEqual(["pharmacy_manager"]);

    const me = await request<{ username: string }>(testApp, { method: "GET", url: "/identity/me", token: manager.token });
    expect(me.status).toBe(200);
    expect(me.json.username).toBe(manager.username);
  });

  it("enforces real permission checks -- owner cannot create a sale invoice (cannot post transactions)", async () => {
    // 09-roles-permissions.md §I.3: owner "sees all financials + reports; cannot post
    // transactions" -- a real, load-bearing business rule this whole test suite must respect
    // (every posting test below authenticates as a role that CAN, never as owner).
    const owner = await loginAsOwner(testApp);
    const res = await request(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: owner.token,
      idempotencyKey: crypto.randomUUID(),
      body: { documentDate: "2026-01-01", lines: [{ itemId: 1, qty: "1", unitSalePrice: "1.00" }], payments: [{ paymentMethodId: 1, amount: "1.00" }] },
    });
    expect(res.status).toBe(403);
  });
});
