// User administration integration tests (src/modules/identity/**). Real Nest+Fastify app, real
// MySQL, real login -- see test/support/test-app.ts's own header comment for why. Structural
// sibling of smoke.test.ts (same beforeAll/afterAll app-per-file shape); this file goes deeper on
// the admin-only `UsersController` surface (`POST /users`, `PATCH /users/:id`,
// `PUT /users/:id/roles`, `GET /users`) plus a small cross-cutting permission-matrix spot-check
// against seed.ts's real PERMISSIONS grants (not invented role/resource/action combos).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestUser, loginAsOwner } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

interface AdminUser {
  userId: string;
  username: string;
  displayName: string;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: string[];
}

interface CreateUserResponse extends AdminUser {
  temporaryPassword: string;
}

interface LoginResponseBody {
  token: string;
  expiresAt: string;
  userId: string;
  username: string;
  displayName: string;
  roles: string[];
  mustChangePassword: boolean;
}

interface ProblemResponseBody {
  code: string;
  [key: string]: unknown;
}

interface AuditEvent {
  auditLogId: number;
  action: string;
  entityType: string;
  entityId: number | null;
  [key: string]: unknown;
}

let usernameCounter = 0;

/** A fresh, collision-free username for this file's own directly-created (not `createTestUser`)
 *  admin-endpoint calls -- mirrors test/support/auth.ts's own `createTestUser` counter/suffix
 *  scheme so two test files running the same day never collide. */
function uniqueUsername(label: string): string {
  usernameCounter += 1;
  return `test.identity.${label}.${Date.now().toString(36)}${usernameCounter}`;
}

/** `AuditInterceptor` writes are fire-and-forget (`void this.audit.write(...)`, see its own header
 *  comment) -- the row lands sometime after the HTTP response the mutating call already returned,
 *  not before. Polls `GET /audit/events` for up to `timeoutMs` rather than asserting immediately,
 *  so this test doesn't become flaky on a slower CI runner. */
async function waitForAuditActions(
  testApp: TestApp,
  token: string,
  entityId: number,
  expectedActions: readonly string[],
  timeoutMs = 5000,
): Promise<AuditEvent[]> {
  const deadline = Date.now() + timeoutMs;
  let events: AuditEvent[] = [];
  while (Date.now() < deadline) {
    const res = await request<{ events: AuditEvent[] }>(testApp, {
      method: "GET",
      url: `/audit/events?entityType=identity.user&entityId=${entityId}&limit=50`,
      token,
    });
    if (res.status === 200) {
      events = res.json.events;
      const actions = new Set(events.map((e) => e.action));
      if (expectedActions.every((a) => actions.has(a))) return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return events;
}

describe("identity: user administration", () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("owner creates a user with real roles; the response includes a real, working temporaryPassword and mustChangePassword: true", async () => {
    const owner = await loginAsOwner(testApp);
    const username = uniqueUsername("create");

    const res = await request<CreateUserResponse>(testApp, {
      method: "POST",
      url: "/users",
      token: owner.token,
      body: { username, displayName: "Test Create User", roles: ["pharmacy_manager"] },
    });

    expect(res.status).toBe(201);
    expect(res.json.username).toBe(username);
    expect(res.json.displayName).toBe("Test Create User");
    expect(res.json.roles).toEqual(["pharmacy_manager"]);
    expect(res.json.isActive).toBe(true);
    expect(res.json.mustChangePassword).toBe(true);
    expect(typeof res.json.temporaryPassword).toBe("string");
    // 09-roles-permissions.md §I.5's 12-char floor -- this codebase mints 27 (20 random bytes,
    // base64url), well past it; assert the floor, not the implementation's exact length.
    expect(res.json.temporaryPassword.length).toBeGreaterThanOrEqual(12);

    // Prove the temporary password is real (not a placeholder) by actually logging in with it.
    const login = await request<LoginResponseBody>(testApp, {
      method: "POST",
      url: "/auth/login",
      body: { username, password: res.json.temporaryPassword },
    });
    expect(login.status).toBe(200);
    expect(login.json.username).toBe(username);
    expect(login.json.roles).toEqual(["pharmacy_manager"]);
    expect(login.json.mustChangePassword).toBe(true);
  });

  it("a non-admin role gets 403 attempting to create a user (identity.user:create is owner/sys_admin only)", async () => {
    const owner = await loginAsOwner(testApp);
    // pharmacy_manager holds broad operational grants but NOT identity.user:create (seed.ts's
    // PERMISSIONS: that row's roles are exactly ["owner", "sys_admin"]).
    const manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);

    const res = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: "/users",
      token: manager.token,
      body: { username: uniqueUsername("blocked"), displayName: "Should Not Be Created", roles: ["sales_officer"] },
    });

    expect(res.status).toBe(403);
    expect(res.json.code).toBe("AUTHZ.FORBIDDEN");
  });

  it("PUTs a user's roles (replace, not delta) and a subsequent login reflects the new role set", async () => {
    const owner = await loginAsOwner(testApp);
    const username = uniqueUsername("reroll");

    const created = await request<CreateUserResponse>(testApp, {
      method: "POST",
      url: "/users",
      token: owner.token,
      body: { username, displayName: "Reroll Roles User", roles: ["sales_officer"] },
    });
    expect(created.status).toBe(201);
    const userId = created.json.userId;
    const temporaryPassword = created.json.temporaryPassword;

    const loginBefore = await request<LoginResponseBody>(testApp, {
      method: "POST",
      url: "/auth/login",
      body: { username, password: temporaryPassword },
    });
    expect(loginBefore.status).toBe(200);
    expect(loginBefore.json.roles).toEqual(["sales_officer"]);

    const putRes = await request<{ roles: string[] }>(testApp, {
      method: "PUT",
      url: `/users/${userId}/roles`,
      token: owner.token,
      body: { roles: ["purchase_officer", "shift_incharge"] },
    });
    expect(putRes.status).toBe(200);
    expect([...putRes.json.roles].sort()).toEqual(["purchase_officer", "shift_incharge"].sort());

    // Same password, same session mechanism -- only the role grant changed server-side. A fresh
    // login (not the old token, which never carried roles itself -- SessionGuard re-derives them
    // from `user_session`/`user_role` on every request) must reflect the new set.
    const loginAfter = await request<LoginResponseBody>(testApp, {
      method: "POST",
      url: "/auth/login",
      body: { username, password: temporaryPassword },
    });
    expect(loginAfter.status).toBe(200);
    expect([...loginAfter.json.roles].sort()).toEqual(["purchase_officer", "shift_incharge"].sort());
  });

  it("deactivates a user: they can no longer log in (401), while their historical data/audit trail is untouched", async () => {
    const owner = await loginAsOwner(testApp);
    const username = uniqueUsername("deactivate");

    const created = await request<CreateUserResponse>(testApp, {
      method: "POST",
      url: "/users",
      token: owner.token,
      body: { username, displayName: "Deactivate Me", roles: ["accountant"] },
    });
    expect(created.status).toBe(201);
    const userId = created.json.userId;
    const temporaryPassword = created.json.temporaryPassword;

    // Proves the account genuinely works BEFORE deactivation (so the 401 below is caused by the
    // deactivation, not by a bad fixture).
    const loginBefore = await request<LoginResponseBody>(testApp, {
      method: "POST",
      url: "/auth/login",
      body: { username, password: temporaryPassword },
    });
    expect(loginBefore.status).toBe(200);

    const patchRes = await request<void>(testApp, {
      method: "PATCH",
      url: `/users/${userId}`,
      token: owner.token,
      body: { isActive: false },
    });
    expect(patchRes.status).toBe(200);

    // AuthService.login rejects a deactivated account with the SAME generic invalid-credentials
    // response as a wrong password (auth.service.ts's own comment: don't leak account existence).
    const loginAfter = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: "/auth/login",
      body: { username, password: temporaryPassword },
    });
    expect(loginAfter.status).toBe(401);
    expect(loginAfter.json.code).toBe("AUTH.INVALID_CREDENTIALS");

    // Historical data untouched: there is no hard-delete of a user (users.controller.ts's own
    // comment -- audit trail, posted documents reference created_by/posted_by). The row must still
    // be listed, with its username/roles preserved, only `isActive` flipped.
    const list = await request<AdminUser[]>(testApp, { method: "GET", url: "/users", token: owner.token });
    expect(list.status).toBe(200);
    const found = list.json.find((u) => u.userId === userId);
    expect(found).toBeDefined();
    expect(found?.username).toBe(username);
    expect(found?.isActive).toBe(false);
    expect(found?.roles).toEqual(["accountant"]);

    // Audit trail untouched: the create + deactivate(edit) mutations are still queryable, not
    // erased or rewritten by the deactivation itself.
    const events = await waitForAuditActions(testApp, owner.token, Number(userId), ["create", "edit"]);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("create");
    expect(actions).toContain("edit");
  });

  it("GET /users returns real, current list/detail data for a just-created user", async () => {
    const owner = await loginAsOwner(testApp);
    const username = uniqueUsername("listdetail");

    const created = await request<CreateUserResponse>(testApp, {
      method: "POST",
      url: "/users",
      token: owner.token,
      body: { username, displayName: "List Detail User", roles: ["purchase_officer", "auditor"] },
    });
    expect(created.status).toBe(201);

    const list = await request<AdminUser[]>(testApp, { method: "GET", url: "/users", token: owner.token });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json)).toBe(true);
    // The seeded bootstrap fixture user must also be present -- proves this is real DB data, not
    // a stub that only echoes back what was just posted.
    expect(list.json.some((u) => u.username === "dev.owner")).toBe(true);

    const detail = list.json.find((u) => u.userId === created.json.userId);
    expect(detail).toBeDefined();
    expect(detail?.username).toBe(username);
    expect(detail?.displayName).toBe("List Detail User");
    expect(detail?.isActive).toBe(true);
    expect(detail?.mustChangePassword).toBe(true);
    expect([...(detail?.roles ?? [])].sort()).toEqual(["auditor", "purchase_officer"].sort());
  });

  describe("cross-cutting permission-matrix spot-check (real seed.ts PERMISSIONS grants, not guessed)", () => {
    it("shift_incharge can list sale invoices (sale.cash:list) but cannot create a manual accounting voucher (gl.voucher:create is accountant-only)", async () => {
      const owner = await loginAsOwner(testApp);
      const shiftIncharge = await createTestUser(testApp, owner.token, ["shift_incharge"]);

      const listSales = await request(testApp, { method: "GET", url: "/sale-invoices", token: shiftIncharge.token });
      expect(listSales.status).toBe(200);

      const createVoucher = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/gl/journal-entries",
        token: shiftIncharge.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(createVoucher.status).toBe(403);
      expect(createVoucher.json.code).toBe("AUTHZ.FORBIDDEN");
    });

    it("sales_officer cannot create a stock adjustment (inventory.adjustment:create is pharmacy_manager/shift_incharge only)", async () => {
      const owner = await loginAsOwner(testApp);
      const salesOfficer = await createTestUser(testApp, owner.token, ["sales_officer"]);

      const res = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/stock-adjustments",
        token: salesOfficer.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("AUTHZ.FORBIDDEN");
    });
  });
});
