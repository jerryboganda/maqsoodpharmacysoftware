// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.5 [BINDING] (the algorithm) --
// common/idempotency/idempotency.interceptor.ts (enforcement + the four `begin()` outcome
// branches -> HTTP status mapping) and idempotency-store.ts (the durable MySQL-backed state
// machine those outcomes come from).
//
// Cross-cutting coverage of the Idempotency-Key MECHANISM ITSELF -- not of any one module's
// business logic (payments-expenses.test.ts etc. already cover that). Exercised end-to-end
// against ONE real, simple, cheap-to-create mutating route: `POST /expenses`
// (expenses.controller.ts:38, confirmed `@RequireIdempotencyKey()`-decorated by reading the
// controller directly before writing this file), plus `POST /expenses/:id/post`
// (expenses.controller.ts:57, also `@RequireIdempotencyKey()`-decorated) for the bodyless
// regression case below -- both real integration tests against the real MySQL instance
// (test/support/test-app.ts), same convention every other file in this suite uses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appUsers, cashBankAccounts, expenseCategories, expenses, getDb, glAccounts } from "@pharmacy/db";

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

interface ExpenseLineResponse {
  expenseLineId: number;
  expenseCategoryId: number;
  amount: string;
  memo: string | null;
}
interface ExpenseHeaderResponse {
  expenseId: number;
  docNumber: string;
  status: string;
  totalAmount: string;
  cashBankAccountId: number;
  journalEntryId: number | null;
}
interface ExpenseResponse {
  expense: ExpenseHeaderResponse;
  lines: ExpenseLineResponse[];
}
interface ExpensePostResponse extends ExpenseResponse {
  journalEntryId: number;
}

/** A date safely inside the seeded FY2027 fiscal year (2026-07-01..2027-06-30) -- same constant
 *  payments-expenses.test.ts/purchasing.test.ts/sales.test.ts all use. */
const DOC_DATE = "2026-08-15";

async function getUserTenantId(userId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ tenantId: appUsers.tenantId }).from(appUsers).where(eq(appUsers.userId, userId));
  if (!row || row.tenantId === null) throw new Error(`user ${userId} has no tenant`);
  return row.tenantId;
}

/** Counts real `expense` rows matching a unique marker planted in `description` -- the actual DB
 *  side effect, not the HTTP response. This is the whole point of proving idempotency: a replayed
 *  request must not be able to fool a test that only looks at the response body. */
async function countExpensesByDescription(description: string): Promise<number> {
  const db = getDb();
  const rows = await db.select({ expenseId: expenses.expenseId }).from(expenses).where(eq(expenses.description, description));
  return rows.length;
}

describe("Idempotency-Key mechanism (cross-cutting)", () => {
  let testApp: TestApp;
  let accountant: LoggedInUser;
  let tenantId: number;
  let mainBankId: number;
  let rentCategoryId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    const owner = await loginAsOwner(testApp);
    accountant = await createTestUser(testApp, owner.token, ["accountant"]);
    tenantId = await getUserTenantId(accountant.userId);

    const db = getDb();
    const [mainBankRow] = await db
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
      .from(cashBankAccounts)
      .innerJoin(glAccounts, eq(cashBankAccounts.glAccountId, glAccounts.glAccountId))
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(glAccounts.code, "1100")));
    if (!mainBankRow) throw new Error("seed gap: MAIN_BANK cash/bank account (GL 1100) not found");
    mainBankId = mainBankRow.cashBankAccountId;

    const [rentCategory] = await db
      .select({ expenseCategoryId: expenseCategories.expenseCategoryId })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, "RENT")));
    if (!rentCategory) throw new Error("seed gap: RENT expense category not found");
    rentCategoryId = rentCategory.expenseCategoryId;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. rejects a mutating request on a @RequireIdempotencyKey() route with NO Idempotency-Key header -- real 400, IDEMPOTENCY.KEY_REQUIRED", async () => {
    const res = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: "/expenses",
      token: accountant.token,
      // No idempotencyKey passed -- request() only sets the header when one is given.
      body: {
        expenseDate: DOC_DATE,
        cashBankAccountId: mainBankId,
        description: `idem-test-missing-header-${Date.now().toString(36)}`,
        lines: [{ expenseCategoryId: rentCategoryId, amount: "42.00" }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("IDEMPOTENCY.KEY_REQUIRED");
  });

  it("2. the SAME body + SAME Idempotency-Key sent twice returns the SAME result both times, and only ONE row is ever actually created", async () => {
    const marker = `idem-test-replay-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const key = newIdempotencyKey();
    const body = {
      expenseDate: DOC_DATE,
      cashBankAccountId: mainBankId,
      description: marker,
      lines: [{ expenseCategoryId: rentCategoryId, amount: "42.00" }],
    };

    expect(await countExpensesByDescription(marker)).toBe(0);

    const first = await request<ExpenseResponse>(testApp, {
      method: "POST",
      url: "/expenses",
      token: accountant.token,
      idempotencyKey: key,
      body,
    });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.raw.headers["idempotency-replayed"]).toBeUndefined();

    // Real DB: exactly one row landed after the first (genuine) attempt.
    expect(await countExpensesByDescription(marker)).toBe(1);

    const second = await request<ExpenseResponse>(testApp, {
      method: "POST",
      url: "/expenses",
      token: accountant.token,
      idempotencyKey: key,
      body,
    });
    // Same status, replayed verbatim (§7.5 step 1's "succeeded -> replay verbatim" branch).
    expect(second.status).toBe(201);
    expect(second.raw.headers["idempotency-replayed"]).toBe("true");

    // Same response body -- same created entity, not a re-run that minted a second one.
    expect(second.json).toEqual(first.json);
    expect(second.json.expense.expenseId).toBe(first.json.expense.expenseId);
    expect(second.json.expense.docNumber).toBe(first.json.expense.docNumber);

    // The actual point of idempotency: exactly-once side effects against REAL state, not just a
    // cached-looking HTTP response. Only ONE row exists no matter how many times the same
    // request was sent.
    expect(await countExpensesByDescription(marker)).toBe(1);
  });

  it("3. the SAME Idempotency-Key with a DIFFERENT request body is rejected as a real conflict (422 idempotency_key_reuse), and creates no second row", async () => {
    const markerA = `idem-test-mismatch-a-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const markerB = `idem-test-mismatch-b-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const key = newIdempotencyKey();

    const first = await request<ExpenseResponse>(testApp, {
      method: "POST",
      url: "/expenses",
      token: accountant.token,
      idempotencyKey: key,
      body: {
        expenseDate: DOC_DATE,
        cashBankAccountId: mainBankId,
        description: markerA,
        lines: [{ expenseCategoryId: rentCategoryId, amount: "42.00" }],
      },
    });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(await countExpensesByDescription(markerA)).toBe(1);

    // SAME key, DIFFERENT body (different description AND different amount -> different request
    // hash under canonicalize()'s sorted-keys JSON hash).
    const second = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: "/expenses",
      token: accountant.token,
      idempotencyKey: key,
      body: {
        expenseDate: DOC_DATE,
        cashBankAccountId: mainBankId,
        description: markerB,
        lines: [{ expenseCategoryId: rentCategoryId, amount: "99.00" }],
      },
    });
    expect(second.status).toBe(422);
    expect(second.json.code).toBe("idempotency_key_reuse");

    // Real DB: the rejected/mismatched attempt created NOTHING under the new body's marker, and
    // did not touch the original row either.
    expect(await countExpensesByDescription(markerB)).toBe(0);
    expect(await countExpensesByDescription(markerA)).toBe(1);
  });

  it("4. REGRESSION: a BODYLESS mutating request carrying a real Idempotency-Key must NOT throw a 500 (canonicalize() used to crash on JSON.stringify(undefined))", async () => {
    // `POST /expenses/:id/post` (expenses.controller.ts) is `@RequireIdempotencyKey()`-decorated
    // AND takes no `@Body()` at all -- a real, live, currently-decorated bodyless mutating route,
    // so this is a genuine end-to-end reproduction of the historical bug, not a synthetic
    // workaround. (Confirmed the same live crash-then-fix shape is documented independently at
    // settings/api/option-lists.controller.ts's `setDefault` handler, which sidesteps the same
    // class of bug by simply not carrying `@RequireIdempotencyKey()` -- this route DOES carry it,
    // so it is the one that actually exercises `canonicalize(undefined)`.)
    const createRes = await request<ExpenseResponse>(testApp, {
      method: "POST",
      url: "/expenses",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        expenseDate: DOC_DATE,
        cashBankAccountId: mainBankId,
        description: `idem-test-bodyless-post-target-${Date.now().toString(36)}`,
        lines: [{ expenseCategoryId: rentCategoryId, amount: "10.00" }],
      },
    });
    expect(createRes.status, JSON.stringify(createRes.json)).toBe(201);
    const expenseId = createRes.json.expense.expenseId;

    // Deliberately NOT passing `body` -- the shared `request()` helper only sends a payload (and
    // a Content-Type header) when `opts.body !== undefined`, so this is a genuinely bodyless HTTP
    // request: Fastify parses no body at all and `request.body` is really `undefined` on the
    // server side, exactly the condition `canonicalize()`'s own header comment documents as the
    // historical crash trigger.
    const postRes = await request<ExpensePostResponse>(testApp, {
      method: "POST",
      url: `/expenses/${expenseId}/post`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
    });

    expect(postRes.status, JSON.stringify(postRes.json)).not.toBe(500);
    expect(postRes.status, JSON.stringify(postRes.json)).toBe(200);
    expect(postRes.json.expense.status).toBe("posted");
    expect(typeof postRes.json.journalEntryId).toBe("number");
  });
});
