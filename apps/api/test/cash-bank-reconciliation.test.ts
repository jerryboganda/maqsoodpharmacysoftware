// Wave 10d (`/cash-bank/reconciliations`, R2.3) integration tests: start (candidate lines exclude
// anything already matched by a COMPLETED reconciliation), complete only when the matched lines'
// net effect exactly equals the statement closing balance (422 RECON.UNEXPLAINED_DIFFERENCE
// otherwise -- this wave never posts an adjustment, see cash-bank-reconciliation.service.ts's own
// header comment), 422 RECON.ALREADY_COMPLETED on a second complete, 422
// RECON.NOT_A_BANK_ACCOUNT for a non-bank account, and the accountant-only role gate (reuses the
// already-seeded cash_bank:create/post grants -- no new permission rows needed, see
// cash-bank.controller.ts's own comment on why).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { cashBankAccounts, getDb } from "@pharmacy/db";
import { costAmount } from "@pharmacy/money";

import { localToday } from "../src/common/dates/index.js";
import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

interface TransferResponse {
  entry: { journalEntryId: number };
  lines: { journalLineId: number; glAccountId: number; debitAmount: string; creditAmount: string }[];
}
interface ReconciliationJson {
  reconciliationId: number;
  status: string;
  differenceAmount: string | null;
  statementClosingBalance: string;
}
interface StartReconciliationResponse {
  reconciliation: ReconciliationJson;
  unreconciledLines: { journalLineId: number }[];
}
interface CompleteReconciliationResponse {
  reconciliation: ReconciliationJson;
  journalEntry: null;
}

describe("Wave 10d: /cash-bank/reconciliations (R2.3)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let accountant: LoggedInUser;
  let cashDrawerAccountId: number;
  let bankAccountId: number;
  let bankGlAccountId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    accountant = await createTestUser(testApp, owner.token, ["accountant"]);

    // Real seeded fixtures (cash-bank.service.ts's own tests rely on the same two accounts) --
    // resolved by querying the real table, never a hardcoded id. Only one tenant exists in this
    // dev/test environment (same "resolve by a unique-enough column, tenant id not needed"
    // reasoning visibility.test.ts's own PARA500 lookup already uses), so accountKind alone is
    // enough to find each fixture.
    const db = getDb();
    const [drawer] = await db.select({ id: cashBankAccounts.cashBankAccountId }).from(cashBankAccounts).where(eq(cashBankAccounts.accountKind, "cash_drawer"));
    const [bank] = await db.select({ id: cashBankAccounts.cashBankAccountId, glAccountId: cashBankAccounts.glAccountId }).from(cashBankAccounts).where(eq(cashBankAccounts.accountKind, "bank"));
    if (!drawer || !bank) throw new Error("cash-bank-reconciliation.test.ts: seeded cash_drawer/bank cash_bank_account fixtures not found -- is the test database migrated+seeded?");
    cashDrawerAccountId = drawer.id;
    bankAccountId = bank.id;
    bankGlAccountId = bank.glAccountId;
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. start returns exactly the fresh transfer's own line as a candidate; complete with a matching balance succeeds with a zero difference", async () => {
    const amount = costAmount("1", "777.25"); // a distinctive amount unlikely to collide with pre-existing accumulated test data
    const transfer = await request<TransferResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/transfers",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { fromCashBankAccountId: cashDrawerAccountId, toCashBankAccountId: bankAccountId, amount, transferDate: localToday() },
    });
    expect(transfer.status).toBe(201);
    const bankLine = transfer.json.lines.find((l) => l.glAccountId === bankGlAccountId);
    expect(bankLine).toBeDefined();
    expect(bankLine!.debitAmount).toBe(amount);

    const start = await request<StartReconciliationResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: bankAccountId, statementDate: localToday(), statementClosingBalance: amount },
    });
    expect(start.status).toBe(201);
    expect(start.json.reconciliation.status).toBe("open");
    expect(start.json.unreconciledLines.some((l) => l.journalLineId === bankLine!.journalLineId)).toBe(true);

    const reconciliationId = start.json.reconciliation.reconciliationId;
    const complete = await request<CompleteReconciliationResponse>(testApp, {
      method: "POST",
      url: `/cash-bank/reconciliations/${reconciliationId}/complete`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { matchedLineIds: [bankLine!.journalLineId] },
    });
    expect(complete.status).toBe(201); // Nest's default POST status, no @HttpCode override
    expect(complete.json.reconciliation.status).toBe("completed");
    expect(complete.json.reconciliation.differenceAmount).toBe("0.00");
    expect(complete.json.journalEntry).toBeNull();

    // completing again -> 422 ALREADY_COMPLETED
    const again = await request(testApp, {
      method: "POST",
      url: `/cash-bank/reconciliations/${reconciliationId}/complete`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { matchedLineIds: [bankLine!.journalLineId] },
    });
    expect(again.status).toBe(422);

    // a NEW reconciliation's candidate list must exclude this now-completed-matched line
    const start2 = await request<StartReconciliationResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: bankAccountId, statementDate: localToday(), statementClosingBalance: "0.00" },
    });
    expect(start2.json.unreconciledLines.some((l) => l.journalLineId === bankLine!.journalLineId)).toBe(false);
  });

  it("2. a wrong statement balance 422s with the real numbers, and re-matching an already-reconciled line 422s too", async () => {
    const amount = costAmount("1", "412.50");
    const transfer = await request<TransferResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/transfers",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { fromCashBankAccountId: cashDrawerAccountId, toCashBankAccountId: bankAccountId, amount, transferDate: localToday() },
    });
    const bankLine = transfer.json.lines.find((l) => l.glAccountId === bankGlAccountId)!;

    const start = await request<StartReconciliationResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: bankAccountId, statementDate: localToday(), statementClosingBalance: "999999.99" },
    });
    const reconciliationId = start.json.reconciliation.reconciliationId;

    const wrongBalance = await request(testApp, {
      method: "POST",
      url: `/cash-bank/reconciliations/${reconciliationId}/complete`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { matchedLineIds: [bankLine.journalLineId] },
    });
    expect(wrongBalance.status).toBe(422);

    // now correctly complete it so the line is legitimately reconciled, then try to reuse it
    const correctStart = await request<StartReconciliationResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: bankAccountId, statementDate: localToday(), statementClosingBalance: amount },
    });
    await request(testApp, {
      method: "POST",
      url: `/cash-bank/reconciliations/${correctStart.json.reconciliation.reconciliationId}/complete`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { matchedLineIds: [bankLine.journalLineId] },
    });

    const reuseStart = await request<StartReconciliationResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: bankAccountId, statementDate: localToday(), statementClosingBalance: "0.00" },
    });
    const reuse = await request(testApp, {
      method: "POST",
      url: `/cash-bank/reconciliations/${reuseStart.json.reconciliation.reconciliationId}/complete`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { matchedLineIds: [bankLine.journalLineId] },
    });
    expect(reuse.status).toBe(422);
  });

  it("3. 422 RECON.NOT_A_BANK_ACCOUNT for a non-bank account; 403 for a non-accountant role; 404 on an unknown reconciliation id", async () => {
    const notBank = await request(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: cashDrawerAccountId, statementDate: localToday(), statementClosingBalance: "0.00" },
    });
    expect(notBank.status).toBe(422);

    const manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    const denied = await request(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: { cashBankAccountId: bankAccountId, statementDate: localToday(), statementClosingBalance: "0.00" },
    });
    expect(denied.status).toBe(403);

    const unknown = await request(testApp, {
      method: "POST",
      url: "/cash-bank/reconciliations/999999999/complete",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { matchedLineIds: [] },
    });
    expect(unknown.status).toBe(404);
  });
});
