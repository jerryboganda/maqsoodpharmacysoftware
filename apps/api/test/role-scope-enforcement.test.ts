// Wave 10f (R-007 CRITICAL, follow-on to Wave 10e's role_scope/role_limit schema+admin surface):
// integration tests for role_scope ENFORCEMENT actually wired into the repository layer for the
// two scope types this wave covers -- cash_bank_account and voucher_category (see
// common/authz/scope.service.ts's own header comment for why warehouse/price_type/
// supplier_category are deliberately NOT enforced yet: no per-request branch-operation model,
// price-tier system, or supplier-categorisation concept exists to meaningfully enforce them).
//
// Uses TWO fresh custom roles cloned from real seeded roles (Wave 10b's `clonedFromRoleKey`),
// mirroring role-scope-limit.test.ts's own "never mutate a SHARED role's scope/limit -- other
// test files' fixtures hold that same role key concurrently" discipline:
//   - cloned from "pharmacy_manager" (holds cash_bank:list/view + sale.cash:create, NOT
//     cash_bank:create) -- tests cash_bank_account list-filtering/read-masking and the POS cash
//     sale's own settlement-leg write-scope check (18-api-plan.md's own "SLS/pharmacy_manager
//     own till" scope example).
//   - cloned from "accountant" (holds cash_bank:create + gl.voucher:create/list) -- tests
//     cash_bank_account write-scope on a transfer, and voucher_category write-scope + read-mask
//     on manual vouchers.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { cashBankAccounts, getDb, glAccounts, optionItems, optionLists, suppliers } from "@pharmacy/db";
import { costAmount } from "@pharmacy/money";

import { localToday } from "../src/common/dates/index.js";
import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

const VOUCHER_CATEGORY_LIST_CODE = "accounting.voucher_category";

interface RoleJson {
  roleKey: string;
}
interface ScopeEntry {
  scopeType: string;
  scopeValues: number[];
}
interface CashBankAccountsListResponse {
  cashBankAccounts: { cashBankAccountId: number }[];
}
interface JournalEntryResponse {
  entry: { journalEntryId: number };
}
interface JournalEntriesListResponse {
  journalEntries: { journalEntryId: number }[];
}
interface PurchaseInvoiceResponse {
  purchaseInvoice: { purchaseInvoiceId: number };
}

async function getGlAccountIdByCode(tenantId: number, code: string): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ glAccountId: glAccounts.glAccountId }).from(glAccounts).where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, code)));
  if (!row) throw new Error(`seed gap: GL account "${code}" not found`);
  return row.glAccountId;
}

async function getCashBankAccountIdByGlAccountId(tenantId: number, glAccountId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ cashBankAccountId: cashBankAccounts.cashBankAccountId }).from(cashBankAccounts).where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.glAccountId, glAccountId)));
  if (!row) throw new Error(`seed gap: no cash_bank_account bound to GL account ${glAccountId}`);
  return row.cashBankAccountId;
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

/** Fresh, zero-history postable/active debit-normal GL leaf (no create endpoint exists), parented
 *  under the seeded "5000" Purchases sub -- mirrors accounting.test.ts's own identically-named
 *  helper (not imported from there; each test file owns its own fixture helpers per this
 *  project's established convention). */
async function createFreshGlAccount(tenantId: number): Promise<number> {
  const db = getDb();
  const [parent] = await db.select({ glAccountSubId: glAccounts.glAccountSubId }).from(glAccounts).where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, "5000")));
  if (!parent) throw new Error('seed gap: GL account "5000" (Purchases) not found');
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const code = `SCOPETEST-${suffix}`;
  await db.insert(glAccounts).values({
    tenantId,
    glAccountSubId: parent.glAccountSubId,
    code,
    name: `Scope Enforcement Test Leaf ${suffix}`,
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

describe("Wave 10f: role_scope ENFORCEMENT (cash_bank_account, voucher_category)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let sysAdmin: LoggedInUser;
  let purchaser: LoggedInUser; // pharmacy_manager -- buys stock for the cash-sale scenario
  let realAccountant: LoggedInUser; // real, UNSCOPED accountant -- creates the "control" BR voucher
  let cloneMgrRoleKey: string;
  let cloneAcctRoleKey: string;
  let tenantId: number;
  let supplierId: number;
  let paraItemId: number;
  let cashPaymentMethodId: number;
  let mainCashAccountId: number; // GL 1000, isDefaultForSales -- every cash sale settles here by default
  let bankAccountId: number; // GL 1100 "Dev Bank"
  let bankGlAccountId: number;
  let cashGlAccountId: number;
  let testGlAccountId: number;
  let jvCategoryId: number;
  let brCategoryId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    sysAdmin = await createTestUser(testApp, owner.token, ["sys_admin"]);
    purchaser = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    realAccountant = await createTestUser(testApp, owner.token, ["accountant"]);

    const suffix = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
    cloneMgrRoleKey = `wavetenf_mgr_${suffix}`;
    cloneAcctRoleKey = `wavetenf_acct_${suffix}`;

    const cloneMgrRes = await request<RoleJson>(testApp, {
      method: "POST",
      url: "/roles",
      token: sysAdmin.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: cloneMgrRoleKey, name: "Wave 10f Scope Test (manager)", description: "Clones pharmacy_manager -- isolates cash_bank_account scope tests from the shared role.", clonedFromRoleKey: "pharmacy_manager" },
    });
    expect(cloneMgrRes.status).toBe(201);

    const cloneAcctRes = await request<RoleJson>(testApp, {
      method: "POST",
      url: "/roles",
      token: sysAdmin.token,
      idempotencyKey: newIdempotencyKey(),
      body: { key: cloneAcctRoleKey, name: "Wave 10f Scope Test (accountant)", description: "Clones accountant -- isolates cash_bank_account/voucher_category scope tests from the shared role.", clonedFromRoleKey: "accountant" },
    });
    expect(cloneAcctRes.status).toBe(201);

    const supplierRes = await request<{ suppliers: { supplierId: number; code: string; tenantId: number }[] }>(testApp, { method: "GET", url: "/suppliers?q=DEV_SUPPLIER", token: owner.token });
    const supplier = supplierRes.json.suppliers.find((s) => s.code === "DEV_SUPPLIER");
    if (!supplier) throw new Error('role-scope-enforcement.test.ts: seeded supplier "DEV_SUPPLIER" not found.');
    supplierId = supplier.supplierId;

    const db = getDb();
    const [supplierRow] = await db.select({ tenantId: suppliers.tenantId }).from(suppliers).where(eq(suppliers.supplierId, supplierId));
    if (!supplierRow) throw new Error("supplier vanished");
    tenantId = supplierRow.tenantId;

    const itemsRes = await request<{ items: { itemId: number; customCode: string }[] }>(testApp, { method: "GET", url: "/items?q=PARA500", token: owner.token });
    const para = itemsRes.json.items.find((i) => i.customCode === "PARA500");
    if (!para) throw new Error('role-scope-enforcement.test.ts: seeded item "PARA500" not found.');
    paraItemId = para.itemId;

    const pmRes = await request<{ paymentMethods: { paymentMethodId: number; code: string }[] }>(testApp, { method: "GET", url: "/payment-methods", token: owner.token });
    const cash = pmRes.json.paymentMethods.find((p) => p.code === "CASH");
    if (!cash) throw new Error('role-scope-enforcement.test.ts: seeded payment method "CASH" not found.');
    cashPaymentMethodId = cash.paymentMethodId;

    cashGlAccountId = await getGlAccountIdByCode(tenantId, "1000");
    bankGlAccountId = await getGlAccountIdByCode(tenantId, "1100");
    mainCashAccountId = await getCashBankAccountIdByGlAccountId(tenantId, cashGlAccountId);
    bankAccountId = await getCashBankAccountIdByGlAccountId(tenantId, bankGlAccountId);
    testGlAccountId = await createFreshGlAccount(tenantId);
    jvCategoryId = await getVoucherCategoryId(tenantId, "JV");
    brCategoryId = await getVoucherCategoryId(tenantId, "BR");
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. cash_bank_account scope: list-filters, 404-masks a single read, and 403s a transfer whose from-leg is out of scope", async () => {
    const put = await request<ScopeEntry[]>(testApp, {
      method: "PUT",
      url: `/roles/${cloneAcctRoleKey}/scopes`,
      token: sysAdmin.token,
      body: { scopes: [{ scopeType: "cash_bank_account", scopeValues: [bankAccountId] }] },
    });
    expect(put.status).toBe(200);

    const scopedAcctUser = await createTestUser(testApp, owner.token, [cloneAcctRoleKey]);

    const list = await request<CashBankAccountsListResponse>(testApp, { method: "GET", url: "/cash-bank-accounts", token: scopedAcctUser.token });
    expect(list.status).toBe(200);
    const ids = list.json.cashBankAccounts.map((a) => a.cashBankAccountId);
    expect(ids).toContain(bankAccountId);
    expect(ids).not.toContain(mainCashAccountId);

    const getInScope = await request(testApp, { method: "GET", url: `/cash-bank-accounts/${bankAccountId}`, token: scopedAcctUser.token });
    expect(getInScope.status).toBe(200);
    const getOutOfScope = await request(testApp, { method: "GET", url: `/cash-bank-accounts/${mainCashAccountId}`, token: scopedAcctUser.token });
    expect(getOutOfScope.status).toBe(404); // "invisible row on read" -- masked, not a 403

    const transferDenied = await request(testApp, {
      method: "POST",
      url: "/cash-bank/transfers",
      token: scopedAcctUser.token,
      idempotencyKey: newIdempotencyKey(),
      body: { fromCashBankAccountId: mainCashAccountId, toCashBankAccountId: bankAccountId, amount: "10.00", transferDate: localToday() },
    });
    expect(transferDenied.status).toBe(403);
    expect(transferDenied.json).toMatchObject({ code: "AUTHZ.SCOPE_DENIED" });

    await request(testApp, { method: "PUT", url: `/roles/${cloneAcctRoleKey}/scopes`, token: sysAdmin.token, body: { scopes: [{ scopeType: "cash_bank_account", scopeValues: [] }] } });
  });

  it("2. cash_bank_account scope: a POS cash sale 403s when it would settle outside scope, and succeeds once the default till is in scope", async () => {
    const purchase = await request<PurchaseInvoiceResponse>(testApp, {
      method: "POST",
      url: "/purchase-invoices",
      token: purchaser.token,
      idempotencyKey: newIdempotencyKey(),
      body: { supplierId, documentDate: localToday(), lines: [{ itemId: paraItemId, qtyPack: "50", unitPurchasePrice: "15.00", batchNo: `T-R10F-${Date.now().toString(36)}`, expiryDate: "2030-06-30" }] },
    });
    expect(purchase.status).toBe(201);

    const put = await request<ScopeEntry[]>(testApp, {
      method: "PUT",
      url: `/roles/${cloneMgrRoleKey}/scopes`,
      token: sysAdmin.token,
      body: { scopes: [{ scopeType: "cash_bank_account", scopeValues: [bankAccountId] }] }, // excludes mainCashAccountId
    });
    expect(put.status).toBe(200);

    const scopedMgrUser = await createTestUser(testApp, owner.token, [cloneMgrRoleKey]);

    // A cash sale settles into MAIN_CASH by default (payment_method.default_cash_bank_account_id,
    // or the isDefaultForSales fallback) -- out of this actor's scope.
    const denied = await request(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: scopedMgrUser.token,
      idempotencyKey: newIdempotencyKey(),
      body: { documentDate: localToday(), lines: [{ itemId: paraItemId, qty: "2", unitSalePrice: "25.00" }], payments: [{ paymentMethodId: cashPaymentMethodId, amount: costAmount("2", "25.00") }] },
    });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: "AUTHZ.SCOPE_DENIED" });

    // Widen scope to include the default till too -- the SAME sale now succeeds.
    const widen = await request<ScopeEntry[]>(testApp, {
      method: "PUT",
      url: `/roles/${cloneMgrRoleKey}/scopes`,
      token: sysAdmin.token,
      body: { scopes: [{ scopeType: "cash_bank_account", scopeValues: [bankAccountId, mainCashAccountId] }] },
    });
    expect(widen.status).toBe(200);

    const allowed = await request<{ saleInvoice: { status: string } }>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: scopedMgrUser.token,
      idempotencyKey: newIdempotencyKey(),
      body: { documentDate: localToday(), lines: [{ itemId: paraItemId, qty: "2", unitSalePrice: "25.00" }], payments: [{ paymentMethodId: cashPaymentMethodId, amount: costAmount("2", "25.00") }] },
    });
    expect(allowed.status).toBe(201);
    expect(allowed.json.saleInvoice.status).toBe("posted");

    await request(testApp, { method: "PUT", url: `/roles/${cloneMgrRoleKey}/scopes`, token: sysAdmin.token, body: { scopes: [{ scopeType: "cash_bank_account", scopeValues: [] }] } });
  });

  it("3. voucher_category scope: 403s creating an out-of-scope category, 404-masks an existing out-of-scope voucher (list + single GET), and allows an in-scope one", async () => {
    // A "control" BR voucher, created by the REAL unscoped accountant -- the entry the
    // scope-restricted clone below must NEVER see.
    const control = await request<JournalEntryResponse>(testApp, {
      method: "POST",
      url: "/gl/journal-entries",
      token: realAccountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        voucherCategoryId: brCategoryId,
        documentDate: localToday(),
        postingDate: localToday(),
        narration: "Wave 10f control BR voucher",
        lines: [
          { glAccountId: bankGlAccountId, debit: "100.00" },
          { glAccountId: testGlAccountId, credit: "100.00" },
        ],
      },
    });
    expect(control.status).toBe(201);
    const controlEntryId = control.json.entry.journalEntryId;

    const put = await request<ScopeEntry[]>(testApp, {
      method: "PUT",
      url: `/roles/${cloneAcctRoleKey}/scopes`,
      token: sysAdmin.token,
      body: { scopes: [{ scopeType: "voucher_category", scopeValues: [jvCategoryId] }] },
    });
    expect(put.status).toBe(200);

    const scopedAcctUser = await createTestUser(testApp, owner.token, [cloneAcctRoleKey]);

    const getControlDenied = await request(testApp, { method: "GET", url: `/gl/journal-entries/${controlEntryId}`, token: scopedAcctUser.token });
    expect(getControlDenied.status).toBe(404); // masked, not 403

    const list = await request<JournalEntriesListResponse>(testApp, { method: "GET", url: "/gl/journal-entries?limit=200", token: scopedAcctUser.token });
    expect(list.status).toBe(200);
    expect(list.json.journalEntries.map((e) => e.journalEntryId)).not.toContain(controlEntryId);

    const createDenied = await request(testApp, {
      method: "POST",
      url: "/gl/journal-entries",
      token: scopedAcctUser.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        voucherCategoryId: brCategoryId,
        documentDate: localToday(),
        postingDate: localToday(),
        narration: "Wave 10f should be denied",
        lines: [
          { glAccountId: bankGlAccountId, debit: "50.00" },
          { glAccountId: testGlAccountId, credit: "50.00" },
        ],
      },
    });
    expect(createDenied.status).toBe(403);
    expect(createDenied.json).toMatchObject({ code: "AUTHZ.SCOPE_DENIED" });

    const createAllowed = await request<JournalEntryResponse>(testApp, {
      method: "POST",
      url: "/gl/journal-entries",
      token: scopedAcctUser.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        voucherCategoryId: jvCategoryId,
        documentDate: localToday(),
        postingDate: localToday(),
        narration: "Wave 10f in-scope JV",
        lines: [
          { glAccountId: testGlAccountId, debit: "10.00" },
          { glAccountId: cashGlAccountId, credit: "10.00" },
        ],
      },
    });
    expect(createAllowed.status).toBe(201);

    const getAllowed = await request(testApp, { method: "GET", url: `/gl/journal-entries/${createAllowed.json.entry.journalEntryId}`, token: scopedAcctUser.token });
    expect(getAllowed.status).toBe(200);

    await request(testApp, { method: "PUT", url: `/roles/${cloneAcctRoleKey}/scopes`, token: sysAdmin.token, body: { scopes: [{ scopeType: "voucher_category", scopeValues: [] }] } });
  });
});
