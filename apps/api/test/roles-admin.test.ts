// Wave 10b (18-api-plan.md §0.3) integration tests: POST/PATCH /roles -- custom role creation
// (including clonedFromRoleKey actually copying role_permission grants, not just the row),
// rename/describe, and isEnabled as the real "remove" mechanism (P1.3) enforced in REAL TIME by
// permissions.service.ts's own query, not just at next-login. Mirrors identity-users.test.ts's
// own `createTestUser`/permission-matrix-spot-check conventions.
//
// Role keys are unique per run (`Date.now().toString(36)`) -- there is no DELETE endpoint for
// roles (deliberately, per P1.3), so a fixed literal key would collide on a second local run
// against the same shared dev database. Same "never assume a fixture is fresh on a reused local
// DB" discipline sales.test.ts's own `freshBatch()` already documents.
import { beforeAll, describe, expect, it } from "vitest";

import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

interface RoleJson {
  roleId: number;
  roleKey: string;
  displayName: string;
  displayNameUr: string | null;
  description: string | null;
  isSystem: boolean;
  isEnabled: boolean;
}

interface LoginResponseBody {
  token: string;
  userId: string;
  username: string;
  roles: string[];
}

describe("Wave 10b: POST/PATCH /roles", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let sysAdmin: LoggedInUser; // identity.role:create/edit is SYS only, not owner
  // Role keys must satisfy `/^[a-z_]{3,32}$/` (CreateRoleSchema -- no digits allowed), so a plain
  // `Date.now().toString(36)` suffix (base36 -- DOES contain digit characters) would violate the
  // very regex this suite exists to exercise. Pure lowercase letters only.
  const suffix = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
  const customRoleKey = `wavetenb_custom_${suffix}`;
  const cloneRoleKey = `wavetenb_clone_${suffix}`;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    sysAdmin = await createTestUser(testApp, owner.token, ["sys_admin"]);
  });

  it("1. GET /roles lists the seeded catalogue with the new isEnabled/displayNameUr fields; owner can list but cannot create", async () => {
    const listRes = await request<RoleJson[]>(testApp, { method: "GET", url: "/roles", token: owner.token });
    expect(listRes.status).toBe(200);
    const ownerRow = listRes.json.find((r) => r.roleKey === "owner");
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.isSystem).toBe(true);
    expect(ownerRow!.isEnabled).toBe(true);

    const deniedCreate = await request(testApp, {
      method: "POST",
      url: "/roles",
      token: owner.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: `should_never_exist_${suffix}`, name: "Should 403", description: "18-api-plan.md §0.3: POST /roles is SYS only, owner is denied by design." },
    });
    expect(deniedCreate.status).toBe(403);
  });

  it("2. sys_admin creates a custom role; duplicate key is rejected; an unresolvable clonedFromRoleKey is rejected", async () => {
    const created = await request<RoleJson>(testApp, {
      method: "POST",
      url: "/roles",
      token: sysAdmin.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: customRoleKey, name: "Wave 10b Custom Role", nameUr: "ویو 10b کسٹم رول", description: "Integration test fixture -- created fresh, never deleted (no DELETE endpoint exists by design)." },
    });
    expect(created.status).toBe(201);
    expect(created.json.roleKey).toBe(customRoleKey);
    expect(created.json.displayNameUr).toBe("ویو 10b کسٹم رول");
    expect(created.json.isSystem).toBe(false);
    expect(created.json.isEnabled).toBe(true);

    const dup = await request(testApp, {
      method: "POST",
      url: "/roles",
      token: sysAdmin.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: customRoleKey, name: "Duplicate", description: "This key was already taken by the previous assertion in this same test." },
    });
    // BusinessRuleException is a flat 422 everywhere in this codebase (see roles.controller.ts's
    // own comment) -- not the 409 the doc's table literally names.
    expect(dup.status).toBe(422);

    const badClone = await request(testApp, {
      method: "POST",
      url: "/roles",
      token: sysAdmin.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: `bad_clone_${suffix}`, name: "Bad Clone", description: "clonedFromRoleKey points at a role that has never existed.", clonedFromRoleKey: `does_not_exist_${suffix}` },
    });
    expect(badClone.status).toBe(422);
  });

  it("3. clonedFromRoleKey actually copies role_permission grants -- a user assigned ONLY the clone can reach an endpoint the source role grants", async () => {
    const cloned = await request<RoleJson>(testApp, {
      method: "POST",
      url: "/roles",
      token: sysAdmin.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: cloneRoleKey, name: "Wave 10b Sales Clone", description: "Clones sales_officer's grants -- proves clonedFromRoleKey copies real role_permission rows, not just the role row itself.", clonedFromRoleKey: "sales_officer" },
    });
    expect(cloned.status).toBe(201);

    const cloneUserRes = await request<{ temporaryPassword: string }>(testApp, {
      method: "POST",
      url: "/users",
      token: owner.token,
      idempotencyKey: newIdempotencyKey(),
      body: { username: `wave10b.cloneuser.${suffix}`, displayName: "Wave10b Clone User", roles: [cloneRoleKey] },
    });
    expect(cloneUserRes.status).toBe(201);
    const cloneLogin = await request<LoginResponseBody>(testApp, {
      method: "POST",
      url: "/auth/login",
      body: { username: `wave10b.cloneuser.${suffix}`, password: cloneUserRes.json.temporaryPassword },
    });
    expect(cloneLogin.status).toBe(200);
    const cloneUserToken = cloneLogin.json.token;

    // sale.cash:list is one of sales_officer's real seeded grants (identity-users.test.ts's own
    // permission-matrix spot-check already exercises this exact grant for a different role).
    const before = await request(testApp, { method: "GET", url: "/sale-invoices", token: cloneUserToken });
    expect(before.status).toBe(200);
  });

  it("4. PATCH renames/redescribes; 422 ROLE.SYSTEM_ROLE_PROTECTED on disabling a system role; 404 on an unknown role; owner is denied", async () => {
    const rename = await request<RoleJson>(testApp, {
      method: "PATCH",
      url: `/roles/${customRoleKey}`,
      token: sysAdmin.token,
      body: { name: "Wave 10b Custom Role (renamed)", description: "Renamed by test 4." },
    });
    expect(rename.status).toBe(200);
    expect(rename.json.displayName).toBe("Wave 10b Custom Role (renamed)");

    const protectedRes = await request(testApp, {
      method: "PATCH",
      url: "/roles/accountant",
      token: sysAdmin.token,
      body: { isEnabled: false },
    });
    expect(protectedRes.status).toBe(422);

    const notFound = await request(testApp, {
      method: "PATCH",
      url: `/roles/never_existed_${suffix}`,
      token: sysAdmin.token,
      body: { description: "must 404" },
    });
    expect(notFound.status).toBe(404);

    const deniedForOwner = await request(testApp, {
      method: "PATCH",
      url: `/roles/${customRoleKey}`,
      token: owner.token,
      body: { description: "owner must not be able to do this either" },
    });
    expect(deniedForOwner.status).toBe(403);
  });

  it("5. disabling a custom role revokes its grants in REAL TIME -- the same already-issued bearer token is denied on the very next request, no re-login", async () => {
    const userRes = await request<{ temporaryPassword: string }>(testApp, {
      method: "POST",
      url: "/users",
      token: owner.token,
      idempotencyKey: newIdempotencyKey(),
      body: { username: `wave10b.disabletest.${suffix}`, displayName: "Wave10b Disable Test", roles: [cloneRoleKey] },
    });
    const login = await request<LoginResponseBody>(testApp, {
      method: "POST",
      url: "/auth/login",
      body: { username: `wave10b.disabletest.${suffix}`, password: userRes.json.temporaryPassword },
    });
    const token = login.json.token;

    const before = await request(testApp, { method: "GET", url: "/sale-invoices", token });
    expect(before.status).toBe(200);

    const disable = await request<RoleJson>(testApp, {
      method: "PATCH",
      url: `/roles/${cloneRoleKey}`,
      token: sysAdmin.token,
      body: { isEnabled: false },
    });
    expect(disable.status).toBe(200);
    expect(disable.json.isEnabled).toBe(false);

    const after = await request(testApp, { method: "GET", url: "/sale-invoices", token });
    expect(after.status).toBe(403);

    // re-enable, leaving the role in the same state test 3 left it -- harmless either way since
    // nothing else in this shared dev database depends on this throwaway role, but consistent
    // with this suite's own "leave things as found" discipline elsewhere.
    const reEnable = await request<RoleJson>(testApp, {
      method: "PATCH",
      url: `/roles/${cloneRoleKey}`,
      token: sysAdmin.token,
      body: { isEnabled: true },
    });
    expect(reEnable.status).toBe(200);
  });
});
