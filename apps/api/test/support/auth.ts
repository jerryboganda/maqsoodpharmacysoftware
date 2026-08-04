// Auth helpers for integration tests. Every test needs a real bearer token from a real
// POST /auth/login call -- there is no dev-stub auth bypass in this codebase (that stub was
// removed in Wave 1; see docs/system-analysis or this project's own memory for the history), so
// tests authenticate exactly the way a real client does.
import type { RoleKey } from "../../src/common/authz/permissions.js";
import type { TestApp } from "./test-app.js";
import { newIdempotencyKey, request } from "./test-app.js";

export interface LoggedInUser {
  userId: number;
  username: string;
  roles: string[];
  token: string;
  /** The raw password this user last logged in with -- exposed so tests can prove negative cases
   *  (e.g. "the OLD password no longer works after a change", "a correct password is still
   *  rejected while locked") against a real, known credential instead of an arbitrary string. */
  password: string;
}

interface LoginResponseBody {
  token: string;
  userId: string;
  username: string;
  roles: string[];
  mustChangePassword: boolean;
}

/** Logs in as the single bootstrap fixture user `packages/db/scripts/seed.ts` creates
 *  deterministically (Block 1, always present on any migrated+seeded database). The password is
 *  NOT a secret worth protecting in test source -- it only ever works against a local, gitignored
 *  `.env`-configured dev database (see this project's own memory) OR a throwaway CI-ephemeral
 *  MySQL container that's destroyed at the end of the job; CI sets `TEST_DEV_OWNER_PASSWORD`
 *  explicitly (captured from that run's own `pnpm run seed` output, since a FRESH database mints
 *  a fresh random password -- see seed.ts's own "DEV OWNER PASSWORD" console.log), and this
 *  fallback only ever fires for a local `vitest run` against the shared local dev database, whose
 *  password is already recorded in this project's own memory anyway. */
export async function loginAsOwner(testApp: TestApp): Promise<LoggedInUser> {
  const username = process.env["TEST_DEV_OWNER_USERNAME"] ?? "dev.owner";
  const password = process.env["TEST_DEV_OWNER_PASSWORD"] ?? "ahQ69JoN5tg4VVrqRgW627g8x4c";
  const res = await request<LoginResponseBody>(testApp, { method: "POST", url: "/auth/login", body: { username, password } });
  if (res.status !== 200) {
    throw new Error(
      `loginAsOwner: POST /auth/login returned ${res.status} for username "${username}" -- ` +
        `is the test database migrated+seeded? Body: ${JSON.stringify(res.json)}`,
    );
  }
  return { userId: Number(res.json.userId), username: res.json.username, roles: res.json.roles, token: res.json.token, password };
}

let userCounter = 0;

/** Creates a genuinely fresh, uniquely-named user with the given role(s) via the real
 *  `POST /users` admin endpoint (using an already-authenticated owner session -- `owner` holds
 *  `identity.user:create`), then logs in as that new user to get a real, independently-scoped
 *  bearer token. This is the mechanism every test needing a NON-owner role uses (`owner`
 *  explicitly cannot post transactions, see 09-roles-permissions.md §I.3 -- most of this
 *  business's actual create/post/cancel/reverse grants belong to `pharmacy_manager`/
 *  `accountant`/etc, not `owner`) -- no CI-only credential plumbing needed beyond the one owner
 *  bootstrap above, since `POST /users`' response includes a real `temporaryPassword` in
 *  plaintext (by design, shown exactly once) that this helper reads directly. Backend does not
 *  gate any other endpoint on `mustChangePassword` (confirmed by reading every guard in
 *  src/common/auth/ -- it's informational response data only, not enforced), so the returned
 *  token is immediately usable everywhere, no password-change round trip required. */
export async function createTestUser(testApp: TestApp, ownerToken: string, roles: RoleKey[]): Promise<LoggedInUser> {
  userCounter += 1;
  const suffix = `${Date.now().toString(36)}${userCounter}`;
  const username = `test.${roles[0]}.${suffix}`;
  const createRes = await request<{ temporaryPassword: string }>(testApp, {
    method: "POST",
    url: "/users",
    token: ownerToken,
    idempotencyKey: newIdempotencyKey(),
    body: { username, displayName: `Test ${roles[0]} ${suffix}`, roles },
  });
  if (createRes.status !== 201) {
    throw new Error(`createTestUser: POST /users returned ${createRes.status} for roles ${JSON.stringify(roles)}. Body: ${JSON.stringify(createRes.json)}`);
  }
  const loginRes = await request<LoginResponseBody>(testApp, {
    method: "POST",
    url: "/auth/login",
    body: { username, password: createRes.json.temporaryPassword },
  });
  if (loginRes.status !== 200) {
    throw new Error(`createTestUser: login as freshly-created user "${username}" returned ${loginRes.status}. Body: ${JSON.stringify(loginRes.json)}`);
  }
  return {
    userId: Number(loginRes.json.userId),
    username: loginRes.json.username,
    roles: loginRes.json.roles,
    token: loginRes.json.token,
    password: createRes.json.temporaryPassword,
  };
}
