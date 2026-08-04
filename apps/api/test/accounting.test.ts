// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.4 "Module `ledger`". Reads the
// accounting module's controllers/services fully before writing anything here:
// modules/accounting/api/{gl-accounts,journal-entries,cash-bank,cash-bank-accounts}.controller.ts,
// modules/accounting/application/{gl-account,journal-entry,cash-bank,ledger-query}.service.ts,
// common/ledger/journal.service.ts (JournalService.post()'s own Sigma-debit===Sigma-credit
// enforcement -- "the single most important constraint in this schema", per that file's own
// header comment), packages/db/scripts/seed.ts (GL chart, voucher_category option list, the
// MAIN_CASH/MAIN_BANK cash_bank_account rows bound to GL 1000/1100).
//
// These are REAL integration tests against a REAL MySQL instance (test/support/test-app.ts) --
// every assertion that matters (a running balance, Sigma-debit=Sigma-credit, a reversal's swapped
// legs, a cash/bank balance moving) is verified against real `journal_line`/`journal_entry`/
// `cash_bank_account` rows read directly via `getDb()`, independently re-derived in this file's
// own code -- never just a check of the HTTP response body's own numbers, and never by calling the
// same LedgerQueryService/JournalService code under test to "verify" itself.
//
// A brand-new, zero-history GL leaf account is inserted directly (there is no POST /gl/accounts
// create endpoint -- gl-accounts.controller.ts's own header comment: "chart-of-accounts admin
// writes... are out of scope for this task") so the running-balance arithmetic below is fully
// deterministic and not polluted by any other test file/run sharing this dev database -- the same
// reasoning purchasing.test.ts's own createFreshItem helper documents for items.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { appUsers, cashBankAccounts, getDb, glAccounts, journalEntries, journalLines, optionItems, optionLists } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

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

interface JournalEntryRow {
  journalEntryId: number;
  entryNo: string;
  documentTypeCode: string;
  sourceDocumentId: number | null;
  status: "draft" | "posted" | "reversed";
  totalDebit: string;
  totalCredit: string;
  reversalOfJournalId: number | null;
  reversalReason: string | null;
}

interface JournalLineRow {
  journalLineId: number;
  journalEntryId: number;
  lineNo: number;
  glAccountId: number;
  debitAmount: string;
  creditAmount: string;
  legRole: string;
}

interface CreateJournalEntryResponse {
  entry: JournalEntryRow;
  lines: JournalLineRow[];
  manualVoucher: { manualVoucherId: number; voucherCategoryId: number; categoryCode: string; categoryName: string; narration: string };
}

interface ReverseJournalEntryResponse {
  original: JournalEntryRow;
  reversal: JournalEntryRow;
  reversalLines: JournalLineRow[];
}

interface CashBankTransferResponse {
  entry: JournalEntryRow;
  lines: JournalLineRow[];
  from: { cashBankAccountId: number; glAccountId: number; isActive: boolean };
  to: { cashBankAccountId: number; glAccountId: number; isActive: boolean };
  amount: string;
}

interface GlAccountListItem {
  glAccountId: number;
  code: string;
  name: string;
  normalBalance: "debit" | "credit";
  isPostable: boolean;
  isActive: boolean;
}
interface GlAccountListResponse {
  data: GlAccountListItem[];
}
interface GlAccountByIdResponse {
  account: GlAccountListItem;
}

interface LedgerLineResponse {
  journalLineId: number;
  journalEntryId: number;
  debit: string;
  credit: string;
  runningBalance: string;
}
interface GlAccountLedgerResponse {
  account: { glAccountId: number; code: string; normalBalance: "debit" | "credit" };
  openingBalance: string;
  lines: LedgerLineResponse[];
  closingBalance: string;
  total: number;
}

/** A date safely inside the seeded FY2027 fiscal year (2026-07-01..2027-06-30, all months open --
 *  seed.ts FY_START/FY_END/FISCAL_MONTHS), independent of whatever "today" happens to be. Same
 *  constant purchasing.test.ts/sales.test.ts use for the identical reason. */
const DOC_DATE = "2026-08-15";

const VOUCHER_CATEGORY_LIST_CODE = "accounting.voucher_category";

async function getUserTenantId(userId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ tenantId: appUsers.tenantId }).from(appUsers).where(eq(appUsers.userId, userId));
  if (!row || row.tenantId === null) throw new Error(`user ${userId} has no tenant`);
  return row.tenantId;
}

async function getGlAccountIdByCode(tenantId: number, code: string): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ glAccountId: glAccounts.glAccountId }).from(glAccounts).where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, code)));
  if (!row) throw new Error(`seed gap: GL account "${code}" not found`);
  return row.glAccountId;
}

async function getVoucherCategoryId(tenantId: number, code: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ optionItemId: optionItems.optionItemId })
    .from(optionItems)
    .innerJoin(optionLists, eq(optionItems.optionListId, optionLists.optionListId))
    .where(and(eq(optionItems.tenantId, tenantId), eq(optionItems.code, code), eq(optionLists.listCode, VOUCHER_CATEGORY_LIST_CODE)));
  if (!row) throw new Error(`seed gap: voucher_category "${code}" not found`);
  return row.optionItemId;
}

/** Inserts a brand-new, zero-history, postable/active debit-normal GL leaf directly (no create
 *  endpoint exists -- see this file's header comment), parented under an existing, already-seeded
 *  sub (reuses GL 5000 "Purchases"'s own gl_account_sub_id -- any valid parent works, this test
 *  never exercises subledger-kind-specific behaviour on it). */
async function createFreshGlAccount(tenantId: number): Promise<number> {
  const db = getDb();
  const [parent] = await db
    .select({ glAccountSubId: glAccounts.glAccountSubId })
    .from(glAccounts)
    .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, "5000")));
  if (!parent) throw new Error('seed gap: GL account "5000" (Purchases) not found');

  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const code = `ACCTEST-${suffix}`;
  await db.insert(glAccounts).values({
    tenantId,
    glAccountSubId: parent.glAccountSubId,
    code,
    name: `Accounting Test Leaf ${suffix}`,
    accountNature: "expense",
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

async function getMainCashBankAccountId(tenantId: number, glAccountId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
    .from(cashBankAccounts)
    .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.glAccountId, glAccountId)));
  if (!row) throw new Error(`seed gap: no cash_bank_account bound to GL account ${glAccountId}`);
  return row.cashBankAccountId;
}

interface RawJournalLine {
  debitAmount: string;
  creditAmount: string;
}

/** Every real, non-draft journal_line row posted against `glAccountId`, in the same order
 *  LedgerQueryService itself orders by (entryDate, journalEntryId, lineNo) -- read directly via a
 *  raw query, not through LedgerQueryService. */
async function fetchRawPostedJournalLines(tenantId: number, glAccountId: number): Promise<RawJournalLine[]> {
  const db = getDb();
  return db
    .select({ debitAmount: journalLines.debitAmount, creditAmount: journalLines.creditAmount })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
    .where(and(eq(journalLines.glAccountId, glAccountId), eq(journalLines.tenantId, tenantId), ne(journalEntries.status, "draft")))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.journalEntryId), asc(journalLines.lineNo));
}

/** Independent verification #1: this file's OWN replay of the running-balance fold (same formula
 *  LedgerQueryService uses, but executed here against a raw query result, not by calling that
 *  service) -- one running Money total per line. */
function replayRunningBalances(rows: readonly RawJournalLine[], normalBalance: "debit" | "credit"): Money[] {
  let running = Money.zero();
  return rows.map((row) => {
    const debit = Money.fromDb(row.debitAmount);
    const credit = Money.fromDb(row.creditAmount);
    running = normalBalance === "debit" ? running.add(debit).sub(credit) : running.add(credit).sub(debit);
    return running;
  });
}

/** Independent verification #2: a completely different method from #1 above -- a single raw SQL
 *  SUM() aggregate over journal_line, not an iterative fold -- for cross-checking a final balance
 *  (used both for the fresh test account's closing balance and for the two real cash/bank GL
 *  accounts' before/after balances around the transfer test). */
async function rawAccountBalance(tenantId: number, glAccountId: number, normalBalance: "debit" | "credit"): Promise<Money> {
  const db = getDb();
  const [agg] = await db
    .select({
      debitSum: sql<string>`coalesce(sum(${journalLines.debitAmount}), '0.00')`,
      creditSum: sql<string>`coalesce(sum(${journalLines.creditAmount}), '0.00')`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
    .where(and(eq(journalLines.glAccountId, glAccountId), eq(journalLines.tenantId, tenantId), ne(journalEntries.status, "draft")));
  const debit = Money.fromDb(agg?.debitSum ?? "0.00");
  const credit = Money.fromDb(agg?.creditSum ?? "0.00");
  return normalBalance === "debit" ? debit.sub(credit) : credit.sub(debit);
}

async function sumJournalLegs(journalEntryId: number): Promise<{ debit: Money; credit: Money; legCount: number }> {
  const db = getDb();
  const rows = await db
    .select({ debitAmount: journalLines.debitAmount, creditAmount: journalLines.creditAmount })
    .from(journalLines)
    .where(eq(journalLines.journalEntryId, journalEntryId));
  let debit = Money.zero();
  let credit = Money.zero();
  for (const row of rows) {
    debit = debit.add(Money.fromDb(row.debitAmount));
    credit = credit.add(Money.fromDb(row.creditAmount));
  }
  return { debit, credit, legCount: rows.length };
}

interface RawFullJournalLine {
  glAccountId: number;
  debitAmount: string;
  creditAmount: string;
}
async function fetchJournalLinesRaw(journalEntryId: number): Promise<RawFullJournalLine[]> {
  const db = getDb();
  return db
    .select({ glAccountId: journalLines.glAccountId, debitAmount: journalLines.debitAmount, creditAmount: journalLines.creditAmount })
    .from(journalLines)
    .where(eq(journalLines.journalEntryId, journalEntryId))
    .orderBy(asc(journalLines.lineNo));
}

/** mysql2's `bigNumberStrings: true` means COUNT(*) comes back as a numeric string -- same
 *  established pattern sales.test.ts's own countRows helper documents. */
async function countTenantJournalEntries(tenantId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(journalEntries).where(eq(journalEntries.tenantId, tenantId));
  return Number(row?.n ?? 0);
}

// ---- suite --------------------------------------------------------------------------------

describe("accounting module: GL chart of accounts, manual vouchers, cash & bank", () => {
  let testApp: TestApp;
  let accountant: LoggedInUser; // holds gl.account/gl.ledger view+list, gl.voucher create/reverse, cash_bank create (seed.ts's §I.4 grants) -- see this file's header comment
  let tenantId: number;
  let cashGlAccountId: number; // GL 1000 "Cash in Hand", debit-normal, bound to MAIN_CASH
  let bankGlAccountId: number; // GL 1100 "Bank", debit-normal, bound to MAIN_BANK
  let testGlAccountId: number; // freshly inserted, zero-history leaf -- see createFreshGlAccount
  let jvCategoryId: number; // voucher_category option_item "JV" -- unrestricted (headerSide/detailSide/requiredCashBankAccountKind all null)
  let mainCashBankAccountId: number;
  let mainBankBankAccountId: number;
  let voucher1JournalEntryId: number; // Dr testGlAccount 500.00 / Cr Cash 500.00 -- reversed later in this suite

  beforeAll(async () => {
    testApp = await createTestApp();
    const owner = await loginAsOwner(testApp);
    accountant = await createTestUser(testApp, owner.token, ["accountant"]);
    tenantId = await getUserTenantId(accountant.userId);

    cashGlAccountId = await getGlAccountIdByCode(tenantId, "1000");
    bankGlAccountId = await getGlAccountIdByCode(tenantId, "1100");
    testGlAccountId = await createFreshGlAccount(tenantId);
    jvCategoryId = await getVoucherCategoryId(tenantId, "JV");
    mainCashBankAccountId = await getMainCashBankAccountId(tenantId, cashGlAccountId);
    mainBankBankAccountId = await getMainCashBankAccountId(tenantId, bankGlAccountId);
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. creates two balanced manual vouchers (JV) against a real GL account -- each posts, and Sigma-debit === Sigma-credit on the real journal_line rows", async () => {
    const v1 = await request<CreateJournalEntryResponse>(testApp, {
      method: "POST",
      url: "/gl/journal-entries",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        voucherCategoryId: jvCategoryId,
        documentDate: DOC_DATE,
        postingDate: DOC_DATE,
        narration: "Accounting test voucher 1",
        lines: [
          { glAccountId: testGlAccountId, debit: "500.00" },
          { glAccountId: cashGlAccountId, credit: "500.00" },
        ],
      },
    });
    expect(v1.status, JSON.stringify(v1.json)).toBe(201);
    expect(v1.json.entry.status).toBe("posted");
    expect(v1.json.entry.documentTypeCode).toBe("JV");
    expect(v1.json.lines).toHaveLength(2);
    voucher1JournalEntryId = v1.json.entry.journalEntryId;

    // Real journal_line rows for this entry -- independently summed, not the response's own totals.
    const v1Legs = await sumJournalLegs(voucher1JournalEntryId);
    expect(v1Legs.legCount).toBe(2);
    expect(v1Legs.debit.compare(v1Legs.credit)).toBe(0);
    expect(v1Legs.debit.toDb()).toBe("500.00");

    const v2 = await request<CreateJournalEntryResponse>(testApp, {
      method: "POST",
      url: "/gl/journal-entries",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        voucherCategoryId: jvCategoryId,
        documentDate: DOC_DATE,
        postingDate: DOC_DATE,
        narration: "Accounting test voucher 2",
        lines: [
          { glAccountId: cashGlAccountId, debit: "200.00" },
          { glAccountId: testGlAccountId, credit: "200.00" },
        ],
      },
    });
    expect(v2.status, JSON.stringify(v2.json)).toBe(201);
    expect(v2.json.entry.status).toBe("posted");
    const v2Legs = await sumJournalLegs(v2.json.entry.journalEntryId);
    expect(v2Legs.debit.compare(v2Legs.credit)).toBe(0);
    expect(v2Legs.debit.toDb()).toBe("200.00");
  });

  it("2. GET /gl/accounts lists the real account; GET /gl/accounts/:id/ledger's running balance matches two independently-computed sums of the real journal_line rows", async () => {
    const listRes = await request<GlAccountListResponse>(testApp, { method: "GET", url: "/gl/accounts", token: accountant.token });
    expect(listRes.status, JSON.stringify(listRes.json)).toBe(200);
    const listed = listRes.json.data.find((a) => a.glAccountId === testGlAccountId);
    expect(listed, "freshly-created test GL account not found in GET /gl/accounts").toBeDefined();
    expect(listed?.normalBalance).toBe("debit");
    expect(listed?.isPostable).toBe(true);
    expect(listed?.isActive).toBe(true);

    const getByIdRes = await request<GlAccountByIdResponse>(testApp, { method: "GET", url: `/gl/accounts/${testGlAccountId}`, token: accountant.token });
    expect(getByIdRes.status, JSON.stringify(getByIdRes.json)).toBe(200);
    expect(getByIdRes.json.account.glAccountId).toBe(testGlAccountId);

    const ledgerRes = await request<GlAccountLedgerResponse>(testApp, { method: "GET", url: `/gl/accounts/${testGlAccountId}/ledger`, token: accountant.token });
    expect(ledgerRes.status, JSON.stringify(ledgerRes.json)).toBe(200);
    expect(ledgerRes.json.account.glAccountId).toBe(testGlAccountId);
    // Fresh account, zero prior history -- the only lines that can possibly exist are the two this
    // suite's own test 1 just posted.
    expect(ledgerRes.json.lines).toHaveLength(2);
    expect(ledgerRes.json.total).toBe(2);

    // -- Independent verification #1: replay the running-balance fold ourselves, against a RAW
    // query of journal_line (not LedgerQueryService, not the HTTP response's own numbers), and
    // compare line-by-line.
    const rawLines = await fetchRawPostedJournalLines(tenantId, testGlAccountId);
    expect(rawLines).toHaveLength(2);
    const independentRunning = replayRunningBalances(rawLines, "debit");
    ledgerRes.json.lines.forEach((line, i) => {
      expect(line.runningBalance).toBe(independentRunning[i]!.toDb());
    });
    expect(ledgerRes.json.closingBalance).toBe(independentRunning[independentRunning.length - 1]!.toDb());
    expect(ledgerRes.json.closingBalance).toBe("300.00"); // hand-verifiable: +500.00 (v1, debit) - 200.00 (v2, credit)

    // -- Independent verification #2: a totally different method -- a raw SQL SUM() aggregate, not
    // an iterative replay -- must land on the exact same closing balance.
    const aggregateBalance = await rawAccountBalance(tenantId, testGlAccountId, "debit");
    expect(aggregateBalance.toDb()).toBe(ledgerRes.json.closingBalance);
  });

  it("3. rejects an unbalanced set of lines with a real 422 LEDGER.UNBALANCED (JournalService.post()'s own Sigma-debit===Sigma-credit enforcement) and persists nothing", async () => {
    const beforeCount = await countTenantJournalEntries(tenantId);

    // DTO-level validation only requires "exactly one of debit/credit per line" -- nothing stops a
    // caller from submitting mismatched totals across lines, so this reaches JournalService.post()'s
    // own aggregate check, not a field-level 422.
    const res = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: "/gl/journal-entries",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        voucherCategoryId: jvCategoryId,
        documentDate: DOC_DATE,
        postingDate: DOC_DATE,
        narration: "Deliberately unbalanced test voucher",
        lines: [
          { glAccountId: testGlAccountId, debit: "100.00" },
          { glAccountId: cashGlAccountId, credit: "50.00" },
        ],
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(res.json.code).toBe("LEDGER.UNBALANCED");

    // Real DB: the whole transaction rolled back -- no new journal_entry row landed for this tenant
    // (the doc-number allocation and the manual_voucher header insert that happen before
    // JournalService.post() is even called are rolled back along with it).
    const afterCount = await countTenantJournalEntries(tenantId);
    expect(afterCount).toBe(beforeCount);
  });

  it("4. reverses the posted voucher from test 1: a real reversing entry with swapped debit/credit legs and reversalOfJournalId set correctly; reversing it again is rejected", async () => {
    const originalLinesBefore = await fetchJournalLinesRaw(voucher1JournalEntryId); // real DB rows, pre-reversal
    expect(originalLinesBefore).toHaveLength(2);

    const res = await request<ReverseJournalEntryResponse>(testApp, {
      method: "POST",
      url: `/gl/journal-entries/${voucher1JournalEntryId}/reverse`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { reason: "Accounting test reversal", postingDate: DOC_DATE },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.original.journalEntryId).toBe(voucher1JournalEntryId);
    expect(res.json.original.status).toBe("reversed");
    expect(res.json.reversal.status).toBe("posted");
    expect(res.json.reversal.reversalOfJournalId).toBe(voucher1JournalEntryId);
    expect(res.json.reversal.documentTypeCode).toBe("JV");

    // Real DB, not the response body's own echo: the original really is 'reversed'...
    const db = getDb();
    const [originalRow] = await db.select().from(journalEntries).where(eq(journalEntries.journalEntryId, voucher1JournalEntryId));
    expect(originalRow?.status).toBe("reversed");
    // ...and the reversal row really does carry reversalOfJournalId back to it.
    const [reversalRow] = await db.select().from(journalEntries).where(eq(journalEntries.journalEntryId, res.json.reversal.journalEntryId));
    expect(reversalRow?.status).toBe("posted");
    expect(reversalRow?.reversalOfJournalId).toBe(voucher1JournalEntryId);

    // Every original leg reappears in the reversal against the SAME account with the SAME amount,
    // but debit and credit swapped -- real rows, not the response body's own echo.
    const reversalLines = await fetchJournalLinesRaw(res.json.reversal.journalEntryId);
    expect(reversalLines).toHaveLength(originalLinesBefore.length);
    for (const originalLine of originalLinesBefore) {
      const swapped = reversalLines.find((l) => l.glAccountId === originalLine.glAccountId);
      expect(swapped, `no reversal leg found for GL account ${originalLine.glAccountId}`).toBeDefined();
      expect(swapped!.debitAmount).toBe(originalLine.creditAmount);
      expect(swapped!.creditAmount).toBe(originalLine.debitAmount);
    }

    // The reversal itself still balances (Sigma-debit === Sigma-credit), independently summed.
    const reversalLegs = await sumJournalLegs(res.json.reversal.journalEntryId);
    expect(reversalLegs.debit.compare(reversalLegs.credit)).toBe(0);
    expect(reversalLegs.debit.toDb()).toBe("500.00");

    // Reversing an already-reversed entry is rejected, not a silent no-op / a second reversal.
    const secondReverse = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: `/gl/journal-entries/${voucher1JournalEntryId}/reverse`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { reason: "second attempt", postingDate: DOC_DATE },
    });
    expect(secondReverse.status).toBe(422);
    expect(secondReverse.json.code).toBe("LEDGER.ALREADY_REVERSED");
  });

  it("5. cash-bank transfer between two real accounts moves both real balances by exactly the transferred amount in opposite directions, and the journal balances", async () => {
    // Snapshot both real accounts' balances immediately around the transfer (delta, not absolute --
    // this dev database is shared across every test file, so either account may already carry
    // history from elsewhere; the delta this transfer itself causes is what must be exact).
    const beforeCash = await rawAccountBalance(tenantId, cashGlAccountId, "debit");
    const beforeBank = await rawAccountBalance(tenantId, bankGlAccountId, "debit");

    const transferAmount = "321.00";
    const res = await request<CashBankTransferResponse>(testApp, {
      method: "POST",
      url: "/cash-bank/transfers",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        fromCashBankAccountId: mainCashBankAccountId,
        toCashBankAccountId: mainBankBankAccountId,
        amount: transferAmount,
        transferDate: DOC_DATE,
        memo: "accounting test transfer",
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.from.cashBankAccountId).toBe(mainCashBankAccountId);
    expect(res.json.to.cashBankAccountId).toBe(mainBankBankAccountId);
    expect(res.json.amount).toBe(transferAmount);

    const afterCash = await rawAccountBalance(tenantId, cashGlAccountId, "debit");
    const afterBank = await rawAccountBalance(tenantId, bankGlAccountId, "debit");

    // The FROM account (cash) moved DOWN by exactly the transferred amount -- real GL rows,
    // independently summed via a raw SQL aggregate, not the response body's own numbers.
    expect(beforeCash.sub(afterCash).toDb()).toBe(transferAmount);
    // The TO account (bank) moved UP by exactly the same amount -- the opposite direction.
    expect(afterBank.sub(beforeBank).toDb()).toBe(transferAmount);

    // The journal itself balances: exactly 2 legs, Sigma-debit === Sigma-credit === the transferred amount.
    const legs = await sumJournalLegs(res.json.entry.journalEntryId);
    expect(legs.legCount).toBe(2);
    expect(legs.debit.compare(legs.credit)).toBe(0);
    expect(legs.debit.toDb()).toBe(transferAmount);

    const db = getDb();
    const [journalRow] = await db.select().from(journalEntries).where(eq(journalEntries.journalEntryId, res.json.entry.journalEntryId));
    expect(journalRow?.status).toBe("posted");
    expect(journalRow?.documentTypeCode).toBe("CBT");
  });

  it("6. a same-account transfer is rejected with a real 422 before touching the ledger", async () => {
    const beforeCount = await countTenantJournalEntries(tenantId);
    const res = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: "/cash-bank/transfers",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { fromCashBankAccountId: mainCashBankAccountId, toCashBankAccountId: mainCashBankAccountId, amount: "10.00", transferDate: DOC_DATE },
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("CASH_BANK.SAME_ACCOUNT");
    expect(await countTenantJournalEntries(tenantId)).toBe(beforeCount);
  });
});
