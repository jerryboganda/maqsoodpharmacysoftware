// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.1 "Authentication";
// 09-roles-permissions.md §I.5 (lockout: "5 failed attempts -> 15-minute lock", "don't leak which
// of username/password was wrong", "reset failedLoginCount to 0 on any successful login").
//
// Exercises `modules/auth` (auth.controller.ts / auth.service.ts) end to end through the real
// Nest+Fastify pipeline, plus the lockout bookkeeping in `credentials.repository.ts` and the real
// session lifecycle in `common/auth/session.guard.ts` / `session.repository.ts`.
//
// Every test that needs a throwaway account uses `createTestUser` for a brand-new, uniquely-named
// user rather than the shared `dev.owner` fixture (test/support/auth.ts). This is deliberate, not
// just for the lockout test: ANY wrong-password attempt increments `app_user.failed_login_count`,
// so even a single bad login against `dev.owner` here would leave shared, cross-file state behind
// (or -- if some earlier run left `dev.owner` at 4 failed attempts -- lock it outright) and break
// every other test file that logs in as `dev.owner` via `loginAsOwner`. `loginAsOwner` is used
// exactly once below, in `beforeAll`, purely to mint an admin token for `createTestUser` -- a
// correct-password login, which resets `failed_login_count` to 0 rather than growing it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, request, type TestApp } from "./support/test-app.js";

interface LoginResponseBody {
  token: string;
  expiresAt: string;
  userId: string;
  username: string;
  displayName: string;
  roles: string[];
  mustChangePassword: boolean;
}

/** RFC 9457 problem+json shape every error response in this API uses
 *  (common/errors/problem-details.ts). */
interface ProblemResponseBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  traceId: string;
}

describe("auth module", () => {
  let testApp: TestApp;
  let ownerToken: string;

  beforeAll(async () => {
    testApp = await createTestApp();
    const owner = await loginAsOwner(testApp);
    ownerToken = owner.token;
  });

  afterAll(async () => {
    await testApp.close();
  });

  async function freshUser(role: "sales_officer" | "pharmacy_manager" | "purchase_officer" = "sales_officer"): Promise<LoggedInUser> {
    return createTestUser(testApp, ownerToken, [role]);
  }

  describe("POST /auth/login", () => {
    it("on success returns a real bearer token and a real user profile, and the token actually authenticates", async () => {
      const user = await freshUser();

      const res = await request<LoginResponseBody>(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: user.username, password: user.password },
      });

      expect(res.status).toBe(200);
      // Real, usable token -- not a placeholder/echo of the request.
      expect(typeof res.json.token).toBe("string");
      expect(res.json.token.length).toBeGreaterThan(20);
      expect(res.json.token).not.toBe(user.password);
      // Real profile, matching the just-created user, not stub/dev data.
      expect(res.json.userId).toBe(String(user.userId));
      expect(res.json.username).toBe(user.username);
      expect(res.json.displayName).toEqual(expect.any(String));
      expect(res.json.displayName.length).toBeGreaterThan(0);
      expect(res.json.roles).toContain("sales_officer");
      expect(typeof res.json.mustChangePassword).toBe("boolean");
      expect(new Date(res.json.expiresAt).getTime()).toBeGreaterThan(Date.now());

      // The token is a REAL, working session -- prove it against a real protected route.
      const me = await request<{ username: string }>(testApp, {
        method: "GET",
        url: "/identity/me",
        token: res.json.token,
      });
      expect(me.status).toBe(200);
      expect(me.json.username).toBe(user.username);
    });

    it("rejects a wrong password, and rejects an unknown username the SAME way (no user-enumeration oracle)", async () => {
      const user = await freshUser();

      const wrongPassword = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: user.username, password: "definitely-the-wrong-password" },
      });
      const unknownUsername = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: `no.such.user.${Date.now().toString(36)}`, password: "whatever-password" },
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownUsername.status).toBe(401);
      // Same code, same title, same detail message for both -- an attacker gets nothing to
      // distinguish "wrong password" from "no such account" (auth.service.ts's own header comment
      // on this exact point).
      expect(wrongPassword.json.code).toBe("AUTH.INVALID_CREDENTIALS");
      expect(unknownUsername.json.code).toBe("AUTH.INVALID_CREDENTIALS");
      expect(wrongPassword.json.title).toBe(unknownUsername.json.title);
      expect(wrongPassword.json.detail).toBe(unknownUsername.json.detail);
    });
  });

  describe("lockout (09 §I.5: 5 failed attempts -> lock)", () => {
    it("locks the account after 5 consecutive failed attempts, and a 6th attempt with the CORRECT password still fails while locked", async () => {
      // A fresh, disposable user -- never the shared dev.owner fixture (see file header comment).
      const user = await freshUser();

      // Attempts 1-4: ordinary "wrong password" rejections, account not yet locked.
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const res = await request<ProblemResponseBody>(testApp, {
          method: "POST",
          url: "/auth/login",
          body: { username: user.username, password: "wrong-password-attempt" },
        });
        expect(res.status, `attempt ${attempt} should be a plain invalid-credentials rejection`).toBe(401);
        expect(res.json.code).toBe("AUTH.INVALID_CREDENTIALS");
      }

      // Attempt 5: the failure that trips the lock. auth.service.ts's real behaviour is 423
      // Locked / AUTH.ACCOUNT_LOCKED (app.exception.ts's AccountLockedException) -- NOT 429.
      const fifth = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: user.username, password: "wrong-password-attempt" },
      });
      expect(fifth.status).toBe(423);
      expect(fifth.json.code).toBe("AUTH.ACCOUNT_LOCKED");

      // Attempt 6: the CORRECT password. Still rejected, and rejected the SAME way -- the service
      // checks the lock before it ever verifies the password, so a locked account can't be used
      // as a correct-password oracle either.
      const sixth = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: user.username, password: user.password },
      });
      expect(sixth.status).toBe(423);
      expect(sixth.json.code).toBe("AUTH.ACCOUNT_LOCKED");
    });
  });

  describe("POST /auth/logout", () => {
    it("revokes the caller's session -- a subsequent request with the same (now-revoked) token 401s", async () => {
      const user = await freshUser();

      // Prove the token works before logout.
      const before = await request(testApp, { method: "GET", url: "/identity/me", token: user.token });
      expect(before.status).toBe(200);

      const logoutRes = await request(testApp, { method: "POST", url: "/auth/logout", token: user.token });
      expect(logoutRes.status).toBe(204);

      const after = await request<ProblemResponseBody>(testApp, { method: "GET", url: "/identity/me", token: user.token });
      expect(after.status).toBe(401);
      expect(after.json.code).toBe("AUTH.UNAUTHENTICATED");
    });
  });

  describe("POST /auth/password/change", () => {
    it("rejects the wrong current password", async () => {
      const user = await freshUser();

      const res = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/auth/password/change",
        token: user.token,
        body: { currentPassword: "not-the-real-current-password", newPassword: "a-brand-new-p4ssword!" },
      });

      // auth.service.ts's changePassword throws the same InvalidCredentialsException as login on
      // a current-password mismatch -- 401 AUTH.INVALID_CREDENTIALS, not a 422 (checked against
      // source, not assumed).
      expect(res.status).toBe(401);
      expect(res.json.code).toBe("AUTH.INVALID_CREDENTIALS");

      // The password must NOT have changed -- the original password still works.
      const stillWorks = await request(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: user.username, password: user.password },
      });
      expect(stillWorks.status).toBe(200);
    });

    it("with the right current password succeeds, and afterwards the OLD password fails while the NEW password works", async () => {
      const user = await freshUser();
      const newPassword = "a-brand-new-p4ssword!";

      const changeRes = await request(testApp, {
        method: "POST",
        url: "/auth/password/change",
        token: user.token,
        body: { currentPassword: user.password, newPassword },
      });
      expect(changeRes.status).toBe(204);

      const oldPasswordLogin = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: user.username, password: user.password },
      });
      expect(oldPasswordLogin.status).toBe(401);
      expect(oldPasswordLogin.json.code).toBe("AUTH.INVALID_CREDENTIALS");

      const newPasswordLogin = await request<LoginResponseBody>(testApp, {
        method: "POST",
        url: "/auth/login",
        body: { username: user.username, password: newPassword },
      });
      expect(newPasswordLogin.status).toBe(200);
      expect(newPasswordLogin.json.username).toBe(user.username);
    });
  });
});
