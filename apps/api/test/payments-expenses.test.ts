// Blueprint: payments/application/payment.service.ts (R2.1: create-and-post-in-one-tx supplier
// payment / customer receipt, partial allocation against outstanding purchase/sale documents,
// allocation reversal restores the target's own paidAmount, cancel only reachable with zero
// active allocations); expenses/application/expense.service.ts (R2.2: draft-then-post workflow,
// N-debit/1-credit journal shape keyed off each line's own expense_category.glAccountId, reverse()
// posts a real swapped-leg reversing journal_entry via the shared JournalService). packages/db/
// schema/payments.ts (`payment` / `payment_allocation`), packages/db/schema/expenses.ts
// (`expense` / `expense_line`).
//
// These are REAL integration tests against a REAL MySQL instance (test/support/test-app.ts) --
// every assertion that matters is a direct DB read via getDb() + the real @pharmacy/db schema
// (purchase_invoice.paid_amount/balance_amount, payment_allocation.reversed_at, journal_line rows
// queried directly), not just the HTTP response body -- mirroring purchasing.test.ts/sales.test.ts's
// own established practice.
//
// Sale invoices can NEVER be a real "outstanding" allocation target in this codebase's current
// state: sale-invoices.service.ts rejects any tender less than the invoice total (every sale is
// fully paid at creation -- see payment.service.ts's own header comment), and every posted
// sale_return already self-settles its own cash-refund leg synchronously (credit refunds are not
// implemented yet). The only genuine outstanding-invoice allocation target reachable through the
// real API today is a posted purchase_invoice -- paidAmount starts at 0 regardless of
// purchaseCategoryId (a category's cash/credit label is purely informational this wave; only a
// real Payment ever moves purchase_invoice.paidAmount) -- so the "real outstanding invoice"
// scenario below is a supplier payment against two credit purchase invoices.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appUsers,
  cashBankAccounts,
  customers,
  documentTypes,
  expenseCategories,
  expenses,
  getDb,
  glAccounts,
  items,
  journalEntries,
  journalLines,
  paymentAllocations,
  paymentMethods,
  payments,
  purchaseCategories,
  purchaseInvoices,
} from "@pharmacy/db";
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

interface SupplierResponseBody {
  supplierId: number;
  glAccountId: number;
  name: string;
  isActive: boolean;
}

interface PurchaseInvoiceHeaderResponse {
  purchaseInvoiceId: number;
  status: string;
  invoiceTotal: string;
}
interface CreatePurchaseInvoiceResponse {
  purchaseInvoice: PurchaseInvoiceHeaderResponse;
  journalEntryId: number;
}

interface PaymentAllocationResponse {
  paymentAllocationId: number;
  targetDocumentTypeId: number;
  targetDocumentId: number;
  allocatedAmount: string;
  reversedAt: string | null;
}
interface PaymentHeaderResponse {
  paymentId: number;
  docNumber: string;
  status: string;
  direction: string;
  partyKind: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  journalEntryId: number | null;
}
interface PaymentResponse {
  payment: PaymentHeaderResponse;
  allocations: PaymentAllocationResponse[];
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

/** A date safely inside the seeded FY2027 fiscal year (2026-07-01..2027-06-30, all months open --
 *  seed.ts FY_START/FY_END/FISCAL_MONTHS), independent of whatever "today" happens to be. Same
 *  constant purchasing.test.ts/sales.test.ts use. */
const DOC_DATE = "2026-08-15";

async function getUserTenantId(userId: number): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ tenantId: appUsers.tenantId }).from(appUsers).where(eq(appUsers.userId, userId));
  if (!row || row.tenantId === null) throw new Error(`user ${userId} has no tenant`);
  return row.tenantId;
}

/** Inserts a brand-new item directly (no create endpoint exists yet -- mirrors
 *  purchasing.test.ts's own createFreshItem). packUnits=1 keeps qtyBase===qtyPack and
 *  unitCostIn===unitPurchasePrice, so invoice totals are exactly qtyPack x unitPurchasePrice with
 *  no packing arithmetic to replay. */
async function createFreshItem(tenantId: number): Promise<{ itemId: number }> {
  const db = getDb();
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const customCode = `PAYEXPTEST-${suffix}`;
  await db.insert(items).values({
    tenantId,
    customCode,
    name: `Payments/Expenses Test Item ${suffix}`,
    packUnits: 1,
    salePrice: "10.0000",
    purchasePrice: "5.0000",
    hasExpiry: false,
    createdSource: "api",
  });
  const [row] = await db
    .select({ itemId: items.itemId })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.customCode, customCode)));
  if (!row) throw new Error("test item insert did not land");
  return { itemId: row.itemId };
}

async function loadPurchaseInvoice(purchaseInvoiceId: number) {
  const db = getDb();
  const [row] = await db
    .select({
      status: purchaseInvoices.status,
      invoiceTotal: purchaseInvoices.invoiceTotal,
      paidAmount: purchaseInvoices.paidAmount,
      balanceAmount: purchaseInvoices.balanceAmount,
    })
    .from(purchaseInvoices)
    .where(eq(purchaseInvoices.purchaseInvoiceId, purchaseInvoiceId));
  if (!row) throw new Error(`purchase invoice ${purchaseInvoiceId} vanished`);
  return row;
}

async function loadJournalLegs(journalEntryId: number) {
  const db = getDb();
  return db
    .select({
      glAccountId: journalLines.glAccountId,
      debitAmount: journalLines.debitAmount,
      creditAmount: journalLines.creditAmount,
      legRole: journalLines.legRole,
    })
    .from(journalLines)
    .where(eq(journalLines.journalEntryId, journalEntryId));
}

function sumLegs(legs: { debitAmount: string; creditAmount: string }[]): { debit: Money; credit: Money } {
  let debit = Money.zero();
  let credit = Money.zero();
  for (const leg of legs) {
    debit = debit.add(Money.fromDb(leg.debitAmount));
    credit = credit.add(Money.fromDb(leg.creditAmount));
  }
  return { debit, credit };
}

describe("payments + expenses modules", () => {
  let testApp: TestApp;
  let ownerToken: string;
  let accountant: LoggedInUser;
  let purchaseOfficer: LoggedInUser;
  let tenantId: number;
  let supplier: SupplierResponseBody;
  let mainCashId: number;
  let mainBankId: number;
  let cashPaymentMethodId: number;
  let normalCreditCategoryId: number;
  let purchaseDocTypeId: number;
  let walkInCustomerId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    const owner = await loginAsOwner(testApp);
    ownerToken = owner.token;

    // accountant holds payment/expense create+edit+post+cancel+reverse (seed.ts: every
    // sensitive payment./expense. action is accountant-only); purchase_officer holds
    // purchase.supplier:create / purchase:create (mirrors purchasing.test.ts's own setup) --
    // used ONLY to stand up the two credit purchase invoices this file allocates payments against.
    [accountant, purchaseOfficer] = await Promise.all([
      createTestUser(testApp, ownerToken, ["accountant"]),
      createTestUser(testApp, ownerToken, ["purchase_officer"]),
    ]);
    tenantId = await getUserTenantId(accountant.userId);

    const supplierRes = await request<SupplierResponseBody>(testApp, {
      method: "POST",
      url: "/suppliers",
      token: purchaseOfficer.token,
      idempotencyKey: newIdempotencyKey(),
      body: { name: `Payments Test Supplier ${Date.now().toString(36)}` },
    });
    expect(supplierRes.status, JSON.stringify(supplierRes.json)).toBe(201);
    supplier = supplierRes.json;

    const db = getDb();
    const [mainCashRow] = await db
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
      .from(cashBankAccounts)
      .innerJoin(glAccounts, eq(cashBankAccounts.glAccountId, glAccounts.glAccountId))
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(glAccounts.code, "1000")));
    if (!mainCashRow) throw new Error("seed gap: MAIN_CASH cash/bank account (GL 1000) not found");
    mainCashId = mainCashRow.cashBankAccountId;

    const [mainBankRow] = await db
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
      .from(cashBankAccounts)
      .innerJoin(glAccounts, eq(cashBankAccounts.glAccountId, glAccounts.glAccountId))
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(glAccounts.code, "1100")));
    if (!mainBankRow) throw new Error("seed gap: MAIN_BANK cash/bank account (GL 1100) not found");
    mainBankId = mainBankRow.cashBankAccountId;

    const [cashMethod] = await db
      .select({ paymentMethodId: paymentMethods.paymentMethodId })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.code, "CASH")));
    if (!cashMethod) throw new Error("seed gap: CASH payment method not found");
    cashPaymentMethodId = cashMethod.paymentMethodId;

    const [creditCategory] = await db
      .select({ purchaseCategoryId: purchaseCategories.purchaseCategoryId })
      .from(purchaseCategories)
      .where(and(eq(purchaseCategories.tenantId, tenantId), eq(purchaseCategories.code, "NORMAL_CREDIT")));
    if (!creditCategory) throw new Error("seed gap: NORMAL_CREDIT purchase category not found");
    normalCreditCategoryId = creditCategory.purchaseCategoryId;

    const [purchaseDocType] = await db
      .select({ documentTypeId: documentTypes.documentTypeId })
      .from(documentTypes)
      .where(and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.code, "PURCHASE")));
    if (!purchaseDocType) throw new Error("seed gap: PURCHASE document type not found");
    purchaseDocTypeId = purchaseDocType.documentTypeId;

    const [walkIn] = await db
      .select({ customerId: customers.customerId })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.code, "WALK_IN")));
    if (!walkIn) throw new Error("seed gap: WALK_IN customer not found");
    walkInCustomerId = walkIn.customerId;

    // Fund MAIN_CASH and MAIN_BANK via real, posted customer receipts (direction "in", on
    // account -- no allocations) so the "out" supplier payments and the expense posting below
    // (both real cash-out movements, and neither cash/bank account allows negative -- seed.ts
    // never overrides allowNegative, schema default false) have real funds to draw down. This
    // file's own name sorts alphabetically before purchasing.test.ts/sales.test.ts, so it cannot
    // rely on either of those having posted anything into these accounts first -- fund
    // independently rather than assume execution order.
    const fundCash = await request<PaymentResponse>(testApp, {
      method: "POST",
      url: "/payments",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        direction: "in",
        partyKind: "customer",
        customerId: walkInCustomerId,
        paymentMethodId: cashPaymentMethodId,
        cashBankAccountId: mainCashId,
        amount: "5000.00",
        documentDate: DOC_DATE,
      },
    });
    expect(fundCash.status, JSON.stringify(fundCash.json)).toBe(201);

    const fundBank = await request<PaymentResponse>(testApp, {
      method: "POST",
      url: "/payments",
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        direction: "in",
        partyKind: "customer",
        customerId: walkInCustomerId,
        paymentMethodId: cashPaymentMethodId,
        cashBankAccountId: mainBankId,
        amount: "5000.00",
        documentDate: DOC_DATE,
      },
    });
    expect(fundBank.status, JSON.stringify(fundBank.json)).toBe(201);
  });

  afterAll(async () => {
    await testApp.close();
  });

  describe("payments: supplier payment with real allocations against real outstanding purchase invoices", () => {
    it("posts a balanced journal, moves each invoice's own paidAmount/balanceAmount by the real allocated amount, reverses ONE allocation without touching the other, and enforces the active-allocations cancel guard", async () => {
      const db = getDb();

      async function createCreditPurchaseInvoice(qtyPack: string, unitPrice: string): Promise<{ purchaseInvoiceId: number; invoiceTotal: string }> {
        const item = await createFreshItem(tenantId);
        const res = await request<CreatePurchaseInvoiceResponse>(testApp, {
          method: "POST",
          url: "/purchase-invoices",
          token: purchaseOfficer.token,
          idempotencyKey: newIdempotencyKey(),
          body: {
            supplierId: supplier.supplierId,
            purchaseCategoryId: normalCreditCategoryId,
            documentDate: DOC_DATE,
            lines: [{ itemId: item.itemId, qtyPack, unitPurchasePrice: unitPrice }],
          },
        });
        expect(res.status, JSON.stringify(res.json)).toBe(201);
        expect(res.json.purchaseInvoice.status).toBe("posted");
        return { purchaseInvoiceId: res.json.purchaseInvoice.purchaseInvoiceId, invoiceTotal: res.json.purchaseInvoice.invoiceTotal };
      }

      // ---- Two independent credit purchase invoices for the same supplier -- both posted with
      // paidAmount=0 (only a real Payment ever moves it, see this file's header comment) --------
      const invoice1 = await createCreditPurchaseInvoice("20", "50.0000"); // 20 x 50.00 = 1000.00
      const invoice2 = await createCreditPurchaseInvoice("10", "60.0000"); // 10 x 60.00 = 600.00
      expect(invoice1.invoiceTotal).toBe("1000.00");
      expect(invoice2.invoiceTotal).toBe("600.00");

      const before1 = await loadPurchaseInvoice(invoice1.purchaseInvoiceId);
      const before2 = await loadPurchaseInvoice(invoice2.purchaseInvoiceId);
      expect(before1.paidAmount).toBe("0.00");
      expect(before1.balanceAmount).toBe("1000.00");
      expect(before2.paidAmount).toBe("0.00");
      expect(before2.balanceAmount).toBe("600.00");

      // ---- One supplier payment, allocated across BOTH invoices in a single create-and-post ---
      const payRes = await request<PaymentResponse>(testApp, {
        method: "POST",
        url: "/payments",
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          direction: "out",
          partyKind: "supplier",
          supplierId: supplier.supplierId,
          paymentMethodId: cashPaymentMethodId,
          cashBankAccountId: mainCashId,
          amount: "700.00",
          documentDate: DOC_DATE,
          allocations: [
            { targetDocumentTypeId: purchaseDocTypeId, targetDocumentId: invoice1.purchaseInvoiceId, allocatedAmount: "400.00" },
            { targetDocumentTypeId: purchaseDocTypeId, targetDocumentId: invoice2.purchaseInvoiceId, allocatedAmount: "300.00" },
          ],
        },
      });
      expect(payRes.status, JSON.stringify(payRes.json)).toBe(201);
      expect(payRes.json.payment.status).toBe("posted");
      expect(payRes.json.payment.allocatedAmount).toBe("700.00");
      expect(payRes.json.payment.unallocatedAmount).toBe("0.00");
      expect(payRes.json.allocations).toHaveLength(2);
      const paymentId = payRes.json.payment.paymentId;
      const alloc1 = payRes.json.allocations.find((a) => a.targetDocumentId === invoice1.purchaseInvoiceId);
      const alloc2 = payRes.json.allocations.find((a) => a.targetDocumentId === invoice2.purchaseInvoiceId);
      if (!alloc1 || !alloc2) throw new Error("expected both allocations in the response");
      expect(alloc1.allocatedAmount).toBe("400.00");
      expect(alloc2.allocatedAmount).toBe("300.00");

      // Real DB: each invoice's OWN paidAmount/balanceAmount moved by exactly its own allocated
      // amount -- not the payment total, not the other invoice's amount.
      const after1 = await loadPurchaseInvoice(invoice1.purchaseInvoiceId);
      const after2 = await loadPurchaseInvoice(invoice2.purchaseInvoiceId);
      expect(after1.paidAmount).toBe("400.00");
      expect(after1.balanceAmount).toBe("600.00");
      expect(after2.paidAmount).toBe("300.00");
      expect(after2.balanceAmount).toBe("300.00");

      // Real DB: the journal entry balances -- Dr supplier AP 700.00, Cr cash 700.00.
      const legs = await loadJournalLegs(payRes.json.payment.journalEntryId!);
      expect(legs).toHaveLength(2);
      const totals = sumLegs(legs);
      expect(totals.debit.compare(totals.credit)).toBe(0);
      expect(totals.debit.toDb()).toBe("700.00");
      const supplierLeg = legs.find((l) => l.glAccountId === supplier.glAccountId);
      const cashLeg = legs.find((l) => l.glAccountId !== supplier.glAccountId);
      expect(supplierLeg?.debitAmount).toBe("700.00");
      expect(supplierLeg?.legRole).toBe("primary_debit");
      expect(cashLeg?.creditAmount).toBe("700.00");
      expect(cashLeg?.legRole).toBe("payment");

      // ---- Reverse ONLY invoice1's allocation --------------------------------------------------
      const reverseRes = await request<PaymentResponse>(testApp, {
        method: "POST",
        url: `/payments/${paymentId}/allocations/${alloc1.paymentAllocationId}/reverse`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(reverseRes.status, JSON.stringify(reverseRes.json)).toBe(200);
      const reversedAlloc1 = reverseRes.json.allocations.find((a) => a.paymentAllocationId === alloc1.paymentAllocationId);
      const untouchedAlloc2 = reverseRes.json.allocations.find((a) => a.paymentAllocationId === alloc2.paymentAllocationId);
      expect(reversedAlloc1?.reversedAt).not.toBeNull();
      expect(untouchedAlloc2?.reversedAt).toBeNull();
      expect(reverseRes.json.payment.allocatedAmount).toBe("300.00"); // 700 - 400
      expect(reverseRes.json.payment.unallocatedAmount).toBe("400.00"); // 700 - 300

      // Real DB (payment_allocation itself, queried directly): same story.
      const dbAllocs = await db
        .select({ paymentAllocationId: paymentAllocations.paymentAllocationId, reversedAt: paymentAllocations.reversedAt })
        .from(paymentAllocations)
        .where(eq(paymentAllocations.paymentId, paymentId));
      const dbAlloc1 = dbAllocs.find((a) => a.paymentAllocationId === alloc1.paymentAllocationId);
      const dbAlloc2 = dbAllocs.find((a) => a.paymentAllocationId === alloc2.paymentAllocationId);
      expect(dbAlloc1?.reversedAt).not.toBeNull();
      expect(dbAlloc2?.reversedAt).toBeNull();

      // Real DB: invoice1's effect is fully undone; invoice2 is completely untouched by the
      // reversal of a DIFFERENT allocation.
      const afterReverse1 = await loadPurchaseInvoice(invoice1.purchaseInvoiceId);
      const afterReverse2 = await loadPurchaseInvoice(invoice2.purchaseInvoiceId);
      expect(afterReverse1.paidAmount).toBe("0.00");
      expect(afterReverse1.balanceAmount).toBe("1000.00");
      expect(afterReverse2.paidAmount).toBe("300.00"); // unchanged from `after2` above
      expect(afterReverse2.balanceAmount).toBe("300.00"); // unchanged from `after2` above

      // Reversing an ALREADY-reversed allocation is rejected, not a silent no-op.
      const doubleReverse = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/payments/${paymentId}/allocations/${alloc1.paymentAllocationId}/reverse`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(doubleReverse.status).toBe(422);
      expect(doubleReverse.json.code).toBe("PAYMENT.ALLOCATION_ALREADY_REVERSED");

      // ---- Cancel: this payment still has ONE active allocation (invoice2's 300.00) -> real 422
      const blockedCancel = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/payments/${paymentId}/cancel`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(blockedCancel.status).toBe(422);
      expect(blockedCancel.json.code).toBe("PAYMENT.HAS_ACTIVE_ALLOCATIONS");

      // Real DB: the blocked cancel attempt changed nothing -- still posted.
      const [paymentRow] = await db.select({ status: payments.status }).from(payments).where(eq(payments.paymentId, paymentId));
      expect(paymentRow?.status).toBe("posted");

      // ---- Cancel: a SEPARATE payment with zero active allocations succeeds -------------------
      const onAccountRes = await request<PaymentResponse>(testApp, {
        method: "POST",
        url: "/payments",
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          direction: "out",
          partyKind: "supplier",
          supplierId: supplier.supplierId,
          paymentMethodId: cashPaymentMethodId,
          cashBankAccountId: mainCashId,
          amount: "50.00",
          documentDate: DOC_DATE,
        },
      });
      expect(onAccountRes.status, JSON.stringify(onAccountRes.json)).toBe(201);
      expect(onAccountRes.json.allocations).toHaveLength(0);
      const onAccountPaymentId = onAccountRes.json.payment.paymentId;

      const successfulCancel = await request<PaymentResponse>(testApp, {
        method: "POST",
        url: `/payments/${onAccountPaymentId}/cancel`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: { reason: "test cleanup" },
      });
      expect(successfulCancel.status, JSON.stringify(successfulCancel.json)).toBe(200);
      expect(successfulCancel.json.payment.status).toBe("cancelled");

      const [cancelledRow] = await db
        .select({ status: payments.status, cancelledBy: payments.cancelledBy })
        .from(payments)
        .where(eq(payments.paymentId, onAccountPaymentId));
      expect(cancelledRow?.status).toBe("cancelled");
      expect(cancelledRow?.cancelledBy).toBe(accountant.userId);

      // A second cancel of an already-cancelled payment is rejected, not a silent no-op.
      const doubleCancel = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/payments/${onAccountPaymentId}/cancel`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(doubleCancel.status).toBe(422);
      expect(doubleCancel.json.code).toBe("PAYMENT.ALREADY_CANCELLED");
    });
  });

  describe("expenses: multi-line draft -> post -> reverse a posted expense (real per-line GL, real reversal)", () => {
    it("posts a journal balanced across EVERY line's own GL account, rejects cancelling a posted expense, and reverses it with a real swapped-leg journal entry", async () => {
      const db = getDb();
      const [rentCategory, utilitiesCategory, officeSuppliesCategory] = await Promise.all([
        db
          .select({ expenseCategoryId: expenseCategories.expenseCategoryId, glAccountId: expenseCategories.glAccountId })
          .from(expenseCategories)
          .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, "RENT")))
          .then((rows) => rows[0]),
        db
          .select({ expenseCategoryId: expenseCategories.expenseCategoryId, glAccountId: expenseCategories.glAccountId })
          .from(expenseCategories)
          .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, "UTILITIES")))
          .then((rows) => rows[0]),
        db
          .select({ expenseCategoryId: expenseCategories.expenseCategoryId, glAccountId: expenseCategories.glAccountId })
          .from(expenseCategories)
          .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, "OFFICE_SUPPLIES")))
          .then((rows) => rows[0]),
      ]);
      if (!rentCategory || !utilitiesCategory || !officeSuppliesCategory) {
        throw new Error("seed gap: RENT/UTILITIES/OFFICE_SUPPLIES expense categories not found");
      }

      // ---- Create as DRAFT: three lines, three DIFFERENT GL accounts, no journal posting yet ---
      const createRes = await request<ExpenseResponse>(testApp, {
        method: "POST",
        url: "/expenses",
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          expenseDate: DOC_DATE,
          cashBankAccountId: mainBankId,
          description: "August operating expenses",
          lines: [
            { expenseCategoryId: rentCategory.expenseCategoryId, amount: "1000.00", memo: "August rent" },
            { expenseCategoryId: utilitiesCategory.expenseCategoryId, amount: "250.50" },
            { expenseCategoryId: officeSuppliesCategory.expenseCategoryId, amount: "75.25" },
          ],
        },
      });
      expect(createRes.status, JSON.stringify(createRes.json)).toBe(201);
      expect(createRes.json.expense.status).toBe("draft");
      expect(createRes.json.expense.totalAmount).toBe("1325.75"); // 1000.00 + 250.50 + 75.25
      expect(createRes.json.expense.journalEntryId).toBeNull();
      expect(createRes.json.lines).toHaveLength(3);
      const expenseId = createRes.json.expense.expenseId;

      // Real DB: still a draft -- no journal_entry exists for it yet.
      const [draftRow] = await db.select({ journalEntryId: expenses.journalEntryId, status: expenses.status }).from(expenses).where(eq(expenses.expenseId, expenseId));
      expect(draftRow?.status).toBe("draft");
      expect(draftRow?.journalEntryId).toBeNull();

      // ---- Post it: Dr each line's own category account, one aggregate Cr the cash/bank account
      const postRes = await request<ExpensePostResponse>(testApp, {
        method: "POST",
        url: `/expenses/${expenseId}/post`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(postRes.status, JSON.stringify(postRes.json)).toBe(200);
      expect(postRes.json.expense.status).toBe("posted");
      const originalJournalEntryId = postRes.json.journalEntryId;
      expect(typeof originalJournalEntryId).toBe("number");

      // Real DB, queried directly (journal_line): the journal balances across EVERY line's own GL
      // account -- not just a single aggregate total. Four legs: 3 per-category debits + 1
      // aggregate cash/bank credit.
      const legs = await loadJournalLegs(originalJournalEntryId);
      expect(legs).toHaveLength(4);
      const totals = sumLegs(legs);
      expect(totals.debit.compare(totals.credit)).toBe(0);
      expect(totals.debit.toDb()).toBe("1325.75");
      expect(totals.credit.toDb()).toBe("1325.75");

      const [mainBankGlRow] = await db.select({ glAccountId: cashBankAccounts.glAccountId }).from(cashBankAccounts).where(eq(cashBankAccounts.cashBankAccountId, mainBankId));
      const rentLeg = legs.find((l) => l.glAccountId === rentCategory.glAccountId);
      const utilitiesLeg = legs.find((l) => l.glAccountId === utilitiesCategory.glAccountId);
      const officeSuppliesLeg = legs.find((l) => l.glAccountId === officeSuppliesCategory.glAccountId);
      const cashLeg = legs.find((l) => l.glAccountId === mainBankGlRow?.glAccountId);

      // Each line's OWN GL account carries exactly its OWN amount -- not the aggregate total.
      expect(rentLeg?.debitAmount).toBe("1000.00");
      expect(rentLeg?.creditAmount).toBe("0.00");
      expect(rentLeg?.legRole).toBe("charge");
      expect(utilitiesLeg?.debitAmount).toBe("250.50");
      expect(utilitiesLeg?.legRole).toBe("charge");
      expect(officeSuppliesLeg?.debitAmount).toBe("75.25");
      expect(officeSuppliesLeg?.legRole).toBe("charge");
      expect(cashLeg?.creditAmount).toBe("1325.75");
      expect(cashLeg?.legRole).toBe("primary_credit");

      // ---- A POSTED expense cannot be cancel()'d -- must go through reverse() instead ----------
      const blockedCancel = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/expenses/${expenseId}/cancel`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(blockedCancel.status).toBe(422);
      expect(blockedCancel.json.code).toBe("EXPENSE.NOT_DRAFT");

      // ---- reverse(): posts a REAL reversing journal entry, every leg swapped ------------------
      const reverseRes = await request<ExpenseResponse>(testApp, {
        method: "POST",
        url: `/expenses/${expenseId}/reverse`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: { reason: "test reversal" },
      });
      expect(reverseRes.status, JSON.stringify(reverseRes.json)).toBe(200);
      expect(reverseRes.json.expense.status).toBe("reversed");
      // The ORIGINAL row keeps pointing at the ORIGINAL posting -- expense.service.ts's own header
      // comment ("CANCEL vs REVERSE"): no second `expense` row is created.
      expect(reverseRes.json.expense.journalEntryId).toBe(originalJournalEntryId);

      // Real DB: the ORIGINAL journal_entry is flipped to "reversed"...
      const [originalEntry] = await db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.journalEntryId, originalJournalEntryId));
      expect(originalEntry?.status).toBe("reversed");

      // ...and a DIFFERENT, NEW journal_entry exists, back-referencing it via reversalOfJournalId.
      const [reversingEntry] = await db
        .select({ journalEntryId: journalEntries.journalEntryId, status: journalEntries.status, reversalReason: journalEntries.reversalReason })
        .from(journalEntries)
        .where(eq(journalEntries.reversalOfJournalId, originalJournalEntryId));
      if (!reversingEntry) throw new Error("expected a reversing journal_entry back-referencing the original");
      expect(reversingEntry.journalEntryId).not.toBe(originalJournalEntryId);
      expect(reversingEntry.status).toBe("posted");
      expect(reversingEntry.reversalReason).toBe("test reversal");

      // Real DB, queried directly (journal_line): the reversal is REAL -- every leg swapped
      // (debit<->credit), same four GL accounts, still balanced.
      const reversingLegs = await loadJournalLegs(reversingEntry.journalEntryId);
      expect(reversingLegs).toHaveLength(4);
      const reversingTotals = sumLegs(reversingLegs);
      expect(reversingTotals.debit.compare(reversingTotals.credit)).toBe(0);
      expect(reversingTotals.debit.toDb()).toBe("1325.75");

      const reversedRentLeg = reversingLegs.find((l) => l.glAccountId === rentCategory.glAccountId);
      const reversedUtilitiesLeg = reversingLegs.find((l) => l.glAccountId === utilitiesCategory.glAccountId);
      const reversedOfficeSuppliesLeg = reversingLegs.find((l) => l.glAccountId === officeSuppliesCategory.glAccountId);
      const reversedCashLeg = reversingLegs.find((l) => l.glAccountId === mainBankGlRow?.glAccountId);

      expect(reversedRentLeg?.creditAmount).toBe("1000.00"); // was a debit on the original
      expect(reversedRentLeg?.debitAmount).toBe("0.00");
      expect(reversedRentLeg?.legRole).toBe("charge"); // role tag names WHAT the leg is -- stays put
      expect(reversedUtilitiesLeg?.creditAmount).toBe("250.50");
      expect(reversedOfficeSuppliesLeg?.creditAmount).toBe("75.25");
      expect(reversedCashLeg?.debitAmount).toBe("1325.75"); // was a credit on the original
      expect(reversedCashLeg?.legRole).toBe("primary_debit"); // position tag flips with the side

      // A second reverse() of an already-reversed expense is rejected, not a silent no-op.
      const doubleReverse = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/expenses/${expenseId}/reverse`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: { reason: "should not be reachable" },
      });
      expect(doubleReverse.status).toBe(422);
      expect(doubleReverse.json.code).toBe("EXPENSE.NOT_POSTED");
    });
  });
});
