// Wave 10g (R2.4) integration tests: the full open/count/close/approve/z-report lifecycle.
// RS-3 means this wave never posts a GL journal entry for the variance -- see
// packages/db/schema/payments.ts's cashierShifts class comment and cashier-shift.service.ts's own
// header comment for the full writeup. To keep this file hermetic against other concurrently-
// running test files (which post real cash sales into the SHARED seeded MAIN_CASH till), every
// test here opens its shift against a FRESH, dedicated till (a brand-new cash_bank_account on a
// brand-new GL leaf) and simulates "cash moving through the till" via a manual JV -- never a real
// POS cash sale, which has no client-facing way to redirect its settlement account away from
// MAIN_CASH.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { cashBankAccounts, getDb, glAccounts } from "@pharmacy/db";

import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

interface CashBankAccountResponse {
  cashBankAccountId: number;
  glAccountId: number;
}
interface CashierShiftJson {
  cashierShiftId: number;
  status: string;
  openingFloatAmount: string;
  countedCashAmount: string | null;
  expectedCashAmount: string | null;
  varianceAmount: string | null;
  varianceReason: string | null;
  userId: number;
}
interface CountResponse {
  countedTotal: string;
  expectedCash: string;
  variance: string;
}
interface CloseResponse {
  cashierShift: CashierShiftJson;
}
interface ZReportResponse {
  shift: CashierShiftJson;
  salesByMethod: { paymentMethodId: number; total: string }[];
  returns: string;
  expensesPaid: string;
  openingFloat: string;
  expectedCash: string;
  countedCash: string | null;
  variance: string | null;
  invoiceCount: number;
}
interface JournalEntryResponse {
  entry: { journalEntryId: number };
}

async function getGlAccountIdByCode(tenantId: number, code: string): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ glAccountId: glAccounts.glAccountId }).from(glAccounts).where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, code)));
  if (!row) throw new Error(`seed gap: GL account "${code}" not found`);
  return row.glAccountId;
}

/** Fresh, zero-history postable/active debit-normal GL leaf, parented under MAIN_CASH's own
 *  gl_account_sub (subledgerKind='cash_bank', per that sub's own seed row) so it's eligible to
 *  become a cash_bank_account. Mirrors accounting.test.ts's identically-named helper (own copy --
 *  each test file owns its own fixture helpers per this project's established convention). */
async function createFreshCashBankGlAccount(tenantId: number): Promise<number> {
  const db = getDb();
  const [parent] = await db.select({ glAccountSubId: glAccounts.glAccountSubId }).from(glAccounts).where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, "1000")));
  if (!parent) throw new Error('seed gap: GL account "1000" (MAIN_CASH) not found');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const code = `SHIFTTEST-${suffix}`;
  await db.insert(glAccounts).values({
    tenantId,
    glAccountSubId: parent.glAccountSubId,
    code,
    name: `Cashier Shift Test Leaf ${suffix}`,
    accountNature: "asset",
    normalBalance: "debit",
    isContra: false,
    isPostable: true,
    isSystem: false,
    isActive: true,
    createdSource: "api",
  });
  const [row] = await db.select({ glAccountId: glAccounts.glAccountId }).from(glAccounts).where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, code)));
  if (!row) throw new Error("test GL account insert did not land");
  return row.glAccountId;
}

async function getUserTenantId(userId: number): Promise<number> {
  const db = getDb();
  const { appUsers } = await import("@pharmacy/db");
  const [row] = await db.select({ tenantId: appUsers.tenantId }).from(appUsers).where(eq(appUsers.userId, userId));
  if (!row || row.tenantId === null) throw new Error(`user ${userId} has no tenant`);
  return row.tenantId;
}

describe("Wave 10g: cashier shifts (R2.4)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let accountant: LoggedInUser; // cash_bank:create + gl.voucher:create -- sets up the fresh till + simulates cash movement
  let cashier: LoggedInUser; // pharmacy_manager -- opens/counts/closes the shift
  let approver: LoggedInUser; // a DIFFERENT pharmacy_manager -- approves
  let salesOfficer: LoggedInUser; // bare sales_officer -- own-shift-only z-report/getById check
  let tenantId: number;
  let tillId: number;
  let tillGlAccountId: number;
  let bankAccountId: number; // an existing seeded "bank"-kind account -- used for the not-a-till 422
  let testGlAccountId: number; // the JV's other leg
  let jvCategoryId: number;
  let shiftId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    accountant = await createTestUser(testApp, owner.token, ["accountant"]);
    cashier = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    approver = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    salesOfficer = await createTestUser(testApp, owner.token, ["sales_officer"]);

    tenantId = await getUserTenantId(owner.userId);
    tillGlAccountId = await createFreshCashBankGlAccount(tenantId);
    testGlAccountId = await getGlAccountIdByCode(tenantId, "5000"); // seeded "Purchases" leaf -- the JV's other leg

    const createTill = await request<CashBankAccountResponse>(testApp, {
      method: "POST",
      url: "/cash-bank-accounts",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { glAccountId: tillGlAccountId, accountKind: "cash_drawer" },
    });
    expect(createTill.status).toBe(201);
    tillId = createTill.json.cashBankAccountId;

    const db = getDb();
    const [bank] = await db.select({ cashBankAccountId: cashBankAccounts.cashBankAccountId }).from(cashBankAccounts).where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.accountKind, "bank")));
    if (!bank) throw new Error('seed gap: no "bank"-kind cash_bank_account found');
    bankAccountId = bank.cashBankAccountId;

    const { optionItems, optionLists } = await import("@pharmacy/db");
    const [jv] = await db
      .select({ optionItemId: optionItems.optionItemId })
      .from(optionItems)
      .innerJoin(optionLists, eq(optionItems.optionListId, optionLists.optionListId))
      .where(and(eq(optionItems.tenantId, tenantId), eq(optionItems.code, "JV"), eq(optionLists.listCode, "accounting.voucher_category")));
    if (!jv) throw new Error('seed gap: voucher_category "JV" not found');
    jvCategoryId = jv.optionItemId;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. open 201s, a second open on the SAME till 409s, and a non-till account 422s", async () => {
    const open = await request<CashierShiftJson>(testApp, {
      method: "POST",
      url: "/cashier-shifts",
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: tillId, openingFloatAmount: "1000.00" },
    });
    expect(open.status).toBe(201);
    expect(open.json.status).toBe("open");
    expect(open.json.openingFloatAmount).toBe("1000.00");
    shiftId = open.json.cashierShiftId;

    const dupe = await request(testApp, {
      method: "POST",
      url: "/cashier-shifts",
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: tillId, openingFloatAmount: "500.00" },
    });
    expect(dupe.status).toBe(409);
    expect(dupe.json).toMatchObject({ code: "SHIFT.ALREADY_OPEN" });

    const notATill = await request(testApp, {
      method: "POST",
      url: "/cashier-shifts",
      token: approver.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: bankAccountId, openingFloatAmount: "0.00" },
    });
    expect(notATill.status).toBe(422);
    expect(notATill.json).toMatchObject({ code: "SHIFT.NOT_A_TILL" });
  });

  it("2. count is blind (returns countedTotal/expectedCash/variance together), an invalid denomination 422s, close requires a reason on a non-zero variance, and approval cannot be the cashier themselves", async () => {
    // Simulate PKR 500 moving through the till during the shift -- a manual JV (accountant-only),
    // never a real POS cash sale (which has no client-facing way to redirect its settlement
    // account off the shared seeded MAIN_CASH till -- see this file's own header comment).
    const jv = await request<JournalEntryResponse>(testApp, {
      method: "POST",
      url: "/gl/journal-entries",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        voucherCategoryId: jvCategoryId,
        documentDate: new Date().toISOString().slice(0, 10),
        postingDate: new Date().toISOString().slice(0, 10),
        narration: "Wave 10g simulated cash movement",
        lines: [
          { glAccountId: tillGlAccountId, debit: "500.00" },
          { glAccountId: testGlAccountId, credit: "500.00" },
        ],
      },
    });
    expect(jv.status).toBe(201);

    // Invalid denomination -- not a real PKR value.
    const badDenom = await request(testApp, {
      method: "POST",
      url: `/cashier-shifts/${shiftId}/count`,
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: { counts: [{ denominationAmount: "37.50", denominationCount: 1 }] },
    });
    expect(badDenom.status).toBe(422);
    expect(badDenom.json).toMatchObject({ code: "SHIFT.INVALID_DENOMINATION" });

    // Expected = 1000.00 (float) + 500.00 (the JV) = 1500.00. Counted intentionally short by 50.
    const count = await request<CountResponse>(testApp, {
      method: "POST",
      url: `/cashier-shifts/${shiftId}/count`,
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        counts: [
          { denominationAmount: "1000.00", denominationCount: 1 },
          { denominationAmount: "500.00", denominationCount: 0 },
          { denominationAmount: "100.00", denominationCount: 4 },
          { denominationAmount: "50.00", denominationCount: 1 },
        ],
      },
    });
    expect(count.status).toBe(200);
    expect(count.json.countedTotal).toBe("1450.00");
    expect(count.json.expectedCash).toBe("1500.00");
    expect(count.json.variance).toBe("-50.00");

    const closeNoReason = await request(testApp, {
      method: "POST",
      url: `/cashier-shifts/${shiftId}/close`,
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(closeNoReason.status).toBe(422);
    expect(closeNoReason.json).toMatchObject({ code: "SHIFT.VARIANCE_REASON_REQUIRED" });

    const closed = await request<CloseResponse>(testApp, {
      method: "POST",
      url: `/cashier-shifts/${shiftId}/close`,
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: { varianceReason: "Till was short -- under investigation" },
    });
    expect(closed.status).toBe(200);
    expect(closed.json.cashierShift.status).toBe("closed");
    expect((closed.json as unknown as Record<string, unknown>)["journalEntry"]).toBeUndefined(); // RS-3 -- never posted

    const selfApprove = await request(testApp, {
      method: "POST",
      url: `/cashier-shifts/${shiftId}/approve`,
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(selfApprove.status).toBe(422);
    expect(selfApprove.json).toMatchObject({ code: "APPROVAL.SELF_APPROVAL_FORBIDDEN" });

    const approved = await request<CashierShiftJson>(testApp, {
      method: "POST",
      url: `/cashier-shifts/${shiftId}/approve`,
      token: approver.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(approved.status).toBe(200);
    expect(approved.json.status).toBe("approved");

    // z-report reflects the same persisted figures; the cashier can see their own shift, a bare
    // sales_officer who is NOT the cashier cannot (18-api-plan.md's own "SLS own" z-report note).
    const zReport = await request<ZReportResponse>(testApp, { method: "GET", url: `/cashier-shifts/${shiftId}/z-report`, token: cashier.token });
    expect(zReport.status).toBe(200);
    expect(zReport.json.openingFloat).toBe("1000.00");
    expect(zReport.json.expectedCash).toBe("1500.00");
    expect(zReport.json.countedCash).toBe("1450.00");
    expect(zReport.json.variance).toBe("-50.00");

    const zReportDenied = await request(testApp, { method: "GET", url: `/cashier-shifts/${shiftId}/z-report`, token: salesOfficer.token });
    expect(zReportDenied.status).toBe(403);
    expect(zReportDenied.json).toMatchObject({ code: "AUTHZ.OWN_SHIFT_ONLY" });

    // count() is only reachable while a shift is open -- this one is now approved.
    const countAfterApprove = await request(testApp, {
      method: "POST",
      url: `/cashier-shifts/${shiftId}/count`,
      token: cashier.token,
      idempotencyKey: newIdempotencyKey(),
      body: { counts: [{ denominationAmount: "100.00", denominationCount: 1 }] },
    });
    expect(countAfterApprove.status).toBe(422);
    expect(countAfterApprove.json).toMatchObject({ code: "SHIFT.NOT_OPEN" });
  });
});
