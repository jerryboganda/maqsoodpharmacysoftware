// Sale-invoice + sale-return lifecycle integration tests (src/modules/sales/**). Real Nest+Fastify
// app, real MySQL -- see test/support/test-app.ts's own header comment for why. Wave 7 added
// substantial new endpoints here (preview/cancel/reverse/print for invoices; lookup-invoice/
// cancel/reverse for returns) on top of the already-existing atomic create-and-post for both
// documents -- this file exists to cover that wave, read directly off sale-invoices.controller.ts/
// service.ts and sale-returns.controller.ts/service.ts in full before being written.
//
// Fixtures: this file never invents stock out of nothing -- there is no item-CREATE endpoint
// (catalog.item stays list/view/edit/deactivate only, see items.controller.ts's own header
// comment), and stock-adjustments can only move an EXISTING lot, never mint one. So every test
// that needs real stock posts a real `POST /purchase-invoices` first (P-1: the purchase invoice
// IS the goods receipt) against one of `packages/db/scripts/seed.ts`'s two DEV_ITEMS
// (ORS200/PARA500) and the seeded DEV_SUPPLIER -- exactly the "purchase -> stock -> sale
// round-trip" seed.ts's own comment says those two items exist for.
//
// Lot determinism: this suite deliberately never assumes WHICH stock_lot a sale/return actually
// draws from -- FEFO (StockService.allocateFefo) picks by (priority, expiry, smallest remaining
// qty) across every non-expired lot for the item, which on a shared/reused local dev database can
// include lots left behind by earlier runs of this very file. Every assertion that cares about a
// specific lot reads the REAL stockLotId(s) back off the API response that just posted (sale
// invoice lines / sale return lines) rather than guessing; every assertion about "how much stock
// moved" sums stock_balance.qty_on_hand across every lot for the item, which is correct regardless
// of how many lots FEFO actually touched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import {
  adjustmentReasons,
  customers,
  getDb,
  items,
  journalEntries,
  paymentMethods,
  saleInvoices,
  stockBalances,
  stockMovements,
  suppliers,
} from "@pharmacy/db";
import { costAmount, Money, Quantity } from "@pharmacy/money";

import { localToday } from "../src/common/dates/index.js";
import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

// ---- response-shape types (only the fields these tests actually assert on) -------------------

interface SaleInvoiceLineJson {
  saleInvoiceLineId: number;
  lineNo: number;
  itemId: number;
  stockLotId: number;
  qtyBase: string;
  unitSalePrice: string;
  lineGrossAmount: string;
  lineNetAmount: string;
}

interface SaleInvoicePaymentJson {
  saleInvoicePaymentId: number;
  paymentMethodId: number;
  amount: string;
  referenceNo: string | null;
  sequenceNo: number;
}

interface SaleInvoiceJson {
  saleInvoiceId: number;
  docNumber: string;
  documentTypeId: number;
  status: string;
  customerId: number;
  grossAmount: string;
  netAmount: string;
  invoiceTotal: string;
  cogsAmount: string;
  changeAmount: string;
  journalEntryId: number | null;
  cancelledAt: string | null;
  cancelledBy: number | null;
}

interface CreateSaleInvoiceResponse {
  saleInvoice: SaleInvoiceJson;
  lines: SaleInvoiceLineJson[];
  allocations: { itemId: number; stockLotId: number; qty: string; batchNo: string | null; expiryDate: string | null }[];
  changeAmount: string;
  journalEntryId: number;
}

interface VoidSaleInvoiceResponse {
  saleInvoice: SaleInvoiceJson;
  lines: SaleInvoiceLineJson[];
  payments: SaleInvoicePaymentJson[];
}

interface SaleInvoicePreviewResponse {
  customerId: number;
  saleCategoryId: number;
  lines: { lineNo: number; itemId: number; qty: string; lineGrossAmount: string; lineCostAmount: string; allocations: unknown[] }[];
  grossAmount: string;
  netAmount: string;
  invoiceTotal: string;
  totalQty: string;
  paidTotal: string;
  changeAmount: string;
}

interface SaleInvoicePrintResponse {
  printFormat: string;
  header: {
    saleInvoiceId: number;
    docNumber: string;
    status: string;
    customer: { customerId: number; name: string | null };
  };
  lines: {
    lineNo: number;
    itemId: number;
    itemName: string;
    itemCode: string;
    qty: string;
    unitSalePrice: string;
    lineGrossAmount: string;
    lineNetAmount: string;
  }[];
  taxBreakdown: { salesTaxAmount: string; advanceIncomeTaxAmount: string; fbrPosFeeAmount: string };
  grossAmount: string;
  netAmount: string;
  roundingAmount: string;
  invoiceTotal: string;
  payments: { paymentMethodId: number; methodName: string; amount: string; referenceNo: string | null }[];
  changeAmount: string;
}

interface SaleReturnJson {
  saleReturnId: number;
  docNumber: string;
  status: string;
  saleInvoiceId: number;
  journalEntryId: number | null;
}

interface SaleReturnLineJson {
  saleReturnLineId: number;
  lineNo: number;
  itemId: number;
  stockLotId: number;
  qtyBase: string;
  saleInvoiceLineId: number;
}

interface CreateSaleReturnResponse {
  saleReturn: SaleReturnJson;
  lines: SaleReturnLineJson[];
  journalEntryId: number;
}

interface VoidSaleReturnResponse {
  saleReturn: SaleReturnJson;
  lines: SaleReturnLineJson[];
}

interface LookupInvoiceResponse {
  invoice: { saleInvoiceId: number; docNumber: string; status: string };
  lines: { saleInvoiceLineId: number; itemId: number; qtyBase: string; qtyAlreadyReturned: string; qtyReturnable: string }[];
}

interface PurchaseInvoiceLineJson {
  purchaseInvoiceLineId: number;
  itemId: number;
  stockLotId: number;
  qtyBase: string;
}

interface CreatePurchaseInvoiceResponse {
  purchaseInvoice: { purchaseInvoiceId: number; docNumber: string; status: string };
  lines: PurchaseInvoiceLineJson[];
  journalEntryId: number;
}

interface StockAdjustmentJson {
  stockAdjustmentId: number;
  status: string;
}

interface ProblemResponseBody {
  code: string;
  title: string;
  detail: string;
  status: number;
  [key: string]: unknown;
}

// ---- fixtures (real seeded rows -- packages/db/scripts/seed.ts) -------------------------------

interface Fixtures {
  readonly tenantId: number;
  readonly supplierId: number;
  readonly orsItemId: number;
  readonly orsSalePrice: string;
  readonly orsName: string;
  readonly orsCode: string;
  readonly paraItemId: number;
  readonly paraName: string;
  readonly paraCode: string;
  readonly cashPaymentMethodId: number;
  readonly countCorrectionReasonId: number;
  readonly walkInCustomerId: number;
}

async function loadFixtures(): Promise<Fixtures> {
  const db = getDb();

  const [supplier] = await db
    .select({ supplierId: suppliers.supplierId, tenantId: suppliers.tenantId })
    .from(suppliers)
    .where(eq(suppliers.code, "DEV_SUPPLIER"));
  if (!supplier) throw new Error('loadFixtures: seeded supplier "DEV_SUPPLIER" not found -- is the test database migrated+seeded?');
  const tenantId = supplier.tenantId;

  const [ors] = await db
    .select({ itemId: items.itemId, salePrice: items.salePrice, name: items.name, customCode: items.customCode })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.customCode, "ORS200")));
  if (!ors) throw new Error('loadFixtures: seeded dev item "ORS200" not found.');

  const [para] = await db
    .select({ itemId: items.itemId, name: items.name, customCode: items.customCode })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.customCode, "PARA500")));
  if (!para) throw new Error('loadFixtures: seeded dev item "PARA500" not found.');

  const [cash] = await db
    .select({ paymentMethodId: paymentMethods.paymentMethodId })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.code, "CASH")));
  if (!cash) throw new Error('loadFixtures: seeded payment method "CASH" not found.');

  const [reason] = await db
    .select({ adjustmentReasonId: adjustmentReasons.adjustmentReasonId })
    .from(adjustmentReasons)
    .where(and(eq(adjustmentReasons.tenantId, tenantId), eq(adjustmentReasons.code, "COUNT_CORRECTION")));
  if (!reason) throw new Error('loadFixtures: seeded adjustment reason "COUNT_CORRECTION" not found.');

  const [walkIn] = await db
    .select({ customerId: customers.customerId })
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), eq(customers.isWalkIn, true)));
  if (!walkIn) throw new Error("loadFixtures: seeded walk-in customer not found.");

  return {
    tenantId,
    supplierId: supplier.supplierId,
    orsItemId: ors.itemId,
    orsSalePrice: ors.salePrice,
    orsName: ors.name,
    orsCode: ors.customCode,
    paraItemId: para.itemId,
    paraName: para.name,
    paraCode: para.customCode,
    cashPaymentMethodId: cash.paymentMethodId,
    countCorrectionReasonId: reason.adjustmentReasonId,
    walkInCustomerId: walkIn.customerId,
  };
}

// ---- small helpers --------------------------------------------------------------------------

let batchCounter = 0;
/** A fresh batch number per purchase -- `stock_lot` identity is (item, batchKey, expiryKey), so a
 *  unique batch here always mints a brand-new lot rather than reusing one another test (or an
 *  earlier run of this file, on a shared local dev database) already touched. */
function freshBatch(label: string): string {
  batchCounter += 1;
  return `T-${label}-${Date.now().toString(36)}-${batchCounter}`;
}

/** A stable, far-future expiry -- past the test's own `documentDate` (today) so FEFO never excludes
 *  it (allocateFefo drops lots whose expiryDate is strictly before asOfDate). */
const FAR_FUTURE_EXPIRY = "2030-06-30";

/** Sum of `stock_balance.qty_on_hand` across EVERY lot for one item -- the item-level invariant
 *  these tests check against, robust regardless of which specific lot(s) FEFO actually touched. */
async function sumItemStockBalance(itemId: number): Promise<Quantity> {
  const db = getDb();
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${stockBalances.qtyOnHand}), '0.0000')` })
    .from(stockBalances)
    .where(eq(stockBalances.itemId, itemId));
  return Quantity.fromDb(row?.total ?? "0.0000");
}

/** Global row count for a table -- used by the preview "zero real database writes" test. mysql2's
 *  `bigNumberStrings: true` (packages/db/client.ts) means COUNT(*) comes back as a numeric STRING,
 *  same as every other count in this codebase (e.g. sale-invoices.service.ts's own
 *  `Number(activeReturns?.n ?? 0)`) -- `Number(...)` here mirrors that established pattern. */
async function countRows(table: MySqlTable): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(table);
  return Number(row?.n ?? 0);
}

async function purchase(
  testApp: TestApp,
  token: string,
  fixtures: Fixtures,
  params: { itemId: number; qtyPack: string; unitPurchasePrice: string; batchNo: string },
): Promise<CreatePurchaseInvoiceResponse> {
  const res = await request<CreatePurchaseInvoiceResponse>(testApp, {
    method: "POST",
    url: "/purchase-invoices",
    token,
    idempotencyKey: newIdempotencyKey(),
    body: {
      supplierId: fixtures.supplierId,
      documentDate: localToday(),
      lines: [
        {
          itemId: params.itemId,
          qtyPack: params.qtyPack,
          unitPurchasePrice: params.unitPurchasePrice,
          batchNo: params.batchNo,
          expiryDate: FAR_FUTURE_EXPIRY,
        },
      ],
    },
  });
  if (res.status !== 201) {
    throw new Error(`fixture purchase: POST /purchase-invoices returned ${res.status}: ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

// ---- suite ------------------------------------------------------------------------------------

describe("sales: sale-invoice + sale-return lifecycle (Wave 7)", () => {
  let testApp: TestApp;
  let manager: LoggedInUser; // pharmacy_manager -- every create/post/cancel/reverse action below
  let accountant: LoggedInUser; // also holds cancel/reverse (seed.ts's Wave 7 grants), used to vary the actor across a couple of tests
  let fx: Fixtures;

  beforeAll(async () => {
    testApp = await createTestApp();
    const owner = await loginAsOwner(testApp);
    manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    accountant = await createTestUser(testApp, owner.token, ["accountant"]);
    fx = await loadFixtures();
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("1. creates + posts a real cash sale invoice: real stock_balance decreases by exactly the sold qty, and the journal balances", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "20", unitPurchasePrice: "22.00", batchNo: freshBatch("t1") });
    const before = await sumItemStockBalance(fx.orsItemId);

    const expectedGross = costAmount("5", fx.orsSalePrice); // "150.00"
    const res = await request<CreateSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId: fx.walkInCustomerId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, qty: "5" }],
        payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: expectedGross }],
      },
    });

    expect(res.status).toBe(201);
    expect(res.json.saleInvoice.status).toBe("posted");
    expect(res.json.saleInvoice.invoiceTotal).toBe(expectedGross);
    expect(res.json.changeAmount).toBe("0.00");
    expect(res.json.lines.length).toBeGreaterThan(0);

    // -- real stock_balance decreased by exactly the sold quantity (sum across every lot) -------
    const after = await sumItemStockBalance(fx.orsItemId);
    expect(after.toDb()).toBe(before.sub(Quantity.fromDb("5")).toDb());

    // -- real stock_movement rows for this exact document net to -5 -----------------------------
    const db = getDb();
    const [movementSum] = await db
      .select({ total: sql<string>`coalesce(sum(${stockMovements.qtyDelta}), '0.0000')` })
      .from(stockMovements)
      .where(and(eq(stockMovements.documentTypeId, res.json.saleInvoice.documentTypeId), eq(stockMovements.sourceDocumentId, res.json.saleInvoice.saleInvoiceId)));
    expect(Quantity.fromDb(movementSum?.total ?? "0").toDb()).toBe(Quantity.fromDb("-5").toDb());

    // -- the real journal entry balances (Σdebit === Σcredit) and is posted ---------------------
    const [journal] = await db.select().from(journalEntries).where(eq(journalEntries.journalEntryId, res.json.journalEntryId));
    expect(journal).toBeDefined();
    expect(journal?.status).toBe("posted");
    expect(journal?.documentTypeCode).toBe("SV");
    expect(journal?.sourceDocumentId).toBe(res.json.saleInvoice.saleInvoiceId);
    expect(Money.fromDb(journal?.totalDebit ?? "0").isZero()).toBe(false);
    expect(Money.fromDb(journal?.totalDebit ?? "0").compare(Money.fromDb(journal?.totalCredit ?? "0"))).toBe(0);
  });

  it("2. POST /sale-invoices/preview returns the correct computed total and causes ZERO real database writes", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "15", unitPurchasePrice: "22.00", batchNo: freshBatch("t2") });

    const before = {
      saleInvoices: await countRows(saleInvoices),
      stockMovements: await countRows(stockMovements),
      journalEntries: await countRows(journalEntries),
    };

    const expectedGross = costAmount("6", fx.orsSalePrice); // "180.00"
    const res = await request<SaleInvoicePreviewResponse>(testApp, {
      method: "POST",
      url: "/sale-invoices/preview",
      token: manager.token,
      body: {
        customerId: fx.walkInCustomerId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, qty: "6" }],
        payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: expectedGross }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.json.invoiceTotal).toBe(expectedGross);
    expect(res.json.grossAmount).toBe(expectedGross);
    expect(res.json.totalQty).toBe("6.0000");
    expect(res.json.changeAmount).toBe("0.00");
    expect(res.json.lines[0]?.itemId).toBe(fx.orsItemId);
    expect(res.json.lines[0]?.lineGrossAmount).toBe(expectedGross);
    expect((res.json.lines[0]?.allocations.length ?? 0)).toBeGreaterThan(0);

    const after = {
      saleInvoices: await countRows(saleInvoices),
      stockMovements: await countRows(stockMovements),
      journalEntries: await countRows(journalEntries),
    };
    expect(after).toEqual(before);
  });

  it("3. cancels a posted invoice with no returns against it: real stock/GL reverse correctly and status flips to \"cancelled\"", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "20", unitPurchasePrice: "22.00", batchNo: freshBatch("t3") });
    const before = await sumItemStockBalance(fx.orsItemId);

    const expectedGross = costAmount("7", fx.orsSalePrice); // "210.00"
    const created = await request<CreateSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId: fx.walkInCustomerId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, qty: "7" }],
        payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: expectedGross }],
      },
    });
    expect(created.status).toBe(201);
    const invoiceId = created.json.saleInvoice.saleInvoiceId;
    const originalJournalId = created.json.journalEntryId;
    expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(before.sub(Quantity.fromDb("7")).toDb());

    // Cancelled by accountant (also holds sale.cash:cancel per seed.ts's Wave 7 grants) -- varies
    // the actor rather than every posting test in this file authenticating as the same role.
    const cancelled = await request<VoidSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: `/sale-invoices/${invoiceId}/cancel`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: { reason: "test: cancel with no returns" },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.saleInvoice.status).toBe("cancelled");
    expect(cancelled.json.saleInvoice.cancelledAt).not.toBeNull();
    expect(cancelled.json.saleInvoice.cancelledBy).toBe(accountant.userId);

    // -- stock: fully restored to the pre-sale level -------------------------------------------
    expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(before.toDb());

    // -- GL: the original entry is marked reversed, and a real balanced reversing entry exists --
    const db = getDb();
    const [original] = await db.select().from(journalEntries).where(eq(journalEntries.journalEntryId, originalJournalId));
    expect(original?.status).toBe("reversed");
    const [reversing] = await db.select().from(journalEntries).where(eq(journalEntries.reversalOfJournalId, originalJournalId));
    expect(reversing).toBeDefined();
    expect(reversing?.status).toBe("posted");
    expect(reversing?.entryNo).toBe(`${created.json.saleInvoice.docNumber}-CANCEL`);
    expect(Money.fromDb(reversing?.totalDebit ?? "0").compare(Money.fromDb(reversing?.totalCredit ?? "0"))).toBe(0);
    expect(Money.fromDb(reversing?.totalDebit ?? "0").compare(Money.fromDb(original?.totalDebit ?? "0"))).toBe(0);
  });

  it("4. REGRESSION (the actual bug this project found and fixed): reverse is blocked while a partial return is active, then succeeds once the return is reversed first -- stock lands EXACTLY back at the pre-sale baseline", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "40", unitPurchasePrice: "22.00", batchNo: freshBatch("t4") });
    // "before the original sale" -- the baseline this whole test proves stock returns to.
    const baseline = await sumItemStockBalance(fx.orsItemId);

    const soldGross = costAmount("10", fx.orsSalePrice); // "300.00"
    const invoiceRes = await request<CreateSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId: fx.walkInCustomerId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, qty: "10" }],
        payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: soldGross }],
      },
    });
    expect(invoiceRes.status).toBe(201);
    const invoiceId = invoiceRes.json.saleInvoice.saleInvoiceId;
    expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(baseline.sub(Quantity.fromDb("10")).toDb());

    // -- a PARTIAL return against it (4 of the 10 sold) ------------------------------------------
    const returnRes = await request<CreateSaleReturnResponse>(testApp, {
      method: "POST",
      url: "/sale-returns",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId: fx.walkInCustomerId,
        saleInvoiceId: invoiceId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, returnQty: "4" }],
      },
    });
    expect(returnRes.status).toBe(201);
    expect(returnRes.json.saleReturn.status).toBe("posted");
    const returnId = returnRes.json.saleReturn.saleReturnId;
    const afterPartialReturn = baseline.sub(Quantity.fromDb("10")).add(Quantity.fromDb("4"));
    expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(afterPartialReturn.toDb());

    // -- attempting to reverse the INVOICE now must be a real 422 SALES.HAS_ACTIVE_RETURNS -------
    const blockedReverse = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: `/sale-invoices/${invoiceId}/reverse`,
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(blockedReverse.status).toBe(422);
    expect(blockedReverse.json.code).toBe("SALES.HAS_ACTIVE_RETURNS");
    // Nothing moved -- the guard fired before any stock/GL write.
    expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(afterPartialReturn.toDb());

    // -- reverse the RETURN first (accountant, varying the actor) --------------------------------
    const returnReversed = await request<VoidSaleReturnResponse>(testApp, {
      method: "POST",
      url: `/sale-returns/${returnId}/reverse`,
      token: accountant.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    // sale-returns.controller.ts's reverse route carries no @HttpCode override (unlike
    // sale-invoices' own /reverse, which explicitly sets 200) -- Nest's default success status for
    // a POST is 201, confirmed against the real running app rather than assumed.
    expect(returnReversed.status).toBe(201);
    expect(returnReversed.json.saleReturn.status).toBe("reversed");
    const afterReturnReversed = baseline.sub(Quantity.fromDb("10"));
    expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(afterReturnReversed.toDb());

    // -- NOW reverse the invoice: must succeed, and must NOT double-credit the 4 units the return
    // already sent back (the actual bug: this used to restock the return's units a second time).
    const invoiceReversed = await request<VoidSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: `/sale-invoices/${invoiceId}/reverse`,
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(invoiceReversed.status).toBe(200);
    expect(invoiceReversed.json.saleInvoice.status).toBe("reversed");

    // -- stock is EXACTLY back to what it was before the original sale (query the real rows,
    // compute the delta -- not a placeholder assumption).
    const final = await sumItemStockBalance(fx.orsItemId);
    expect(final.toDb()).toBe(baseline.toDb());
    expect(final.sub(baseline).isZero()).toBe(true);
  });

  it("5. GET /sale-invoices/:id/print returns the real posted receipt payload (line/tax/payment data, not placeholders)", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "10", unitPurchasePrice: "22.00", batchNo: freshBatch("t5-ors") });
    await purchase(testApp, manager.token, fx, { itemId: fx.paraItemId, qtyPack: "5", unitPurchasePrice: "180.00", batchNo: freshBatch("t5-para") });

    const orsGross = costAmount("3", fx.orsSalePrice); // "90.00" (qty 3 @ 30.0000)
    const paraGross = costAmount("20", "3.5000"); // "70.00" (qty 20 @ 3.5000, explicit -- PARA500 is not pack-1)
    const total = Money.fromDb(orsGross).add(Money.fromDb(paraGross)).toDb(); // "160.00"

    const created = await request<CreateSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId: fx.walkInCustomerId,
        documentDate: localToday(),
        lines: [
          { itemId: fx.orsItemId, qty: "3" },
          { itemId: fx.paraItemId, qty: "20", unitSalePrice: "3.5000" },
        ],
        payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: total, referenceNo: "TESTREF-PRINT" }],
      },
    });
    expect(created.status).toBe(201);
    expect(created.json.saleInvoice.invoiceTotal).toBe(total);
    const invoiceId = created.json.saleInvoice.saleInvoiceId;

    const printed = await request<SaleInvoicePrintResponse>(testApp, {
      method: "GET",
      url: `/sale-invoices/${invoiceId}/print`,
      token: manager.token,
    });
    expect(printed.status).toBe(200);
    expect(printed.json.printFormat).toBe("standard_receipt");
    expect(printed.json.header.saleInvoiceId).toBe(invoiceId);
    expect(printed.json.header.docNumber).toBe(created.json.saleInvoice.docNumber);
    expect(printed.json.header.status).toBe("posted");
    expect(printed.json.header.customer.customerId).toBe(fx.walkInCustomerId);

    // Aggregate by item rather than assuming one persisted line per requested line: FEFO can slice
    // a single requested line across several lots (sale-invoices.service.ts's own "B-6 RowGroup"
    // comment -- "a requested line spanning multiple lots becomes multiple DB lines"), which this
    // shared dev item's stock (purchased and partially sold/returned by every earlier test in this
    // file) makes routine, not an edge case. Summing qty/lineGrossAmount per item is the correct,
    // slice-count-agnostic way to verify the real posted totals.
    const orsLines = printed.json.lines.filter((l) => l.itemId === fx.orsItemId);
    const paraLines = printed.json.lines.filter((l) => l.itemId === fx.paraItemId);
    expect(orsLines.length + paraLines.length).toBe(printed.json.lines.length); // only these two items appear
    expect(orsLines.length).toBeGreaterThan(0);
    expect(paraLines.length).toBeGreaterThan(0);

    const orsQty = orsLines.reduce((sum, l) => sum.add(Quantity.fromDb(l.qty)), Quantity.zero());
    const orsSum = orsLines.reduce((sum, l) => sum.add(Money.fromDb(l.lineGrossAmount)), Money.zero());
    expect(orsQty.toDb()).toBe("3.0000");
    expect(orsSum.toDb()).toBe(orsGross);
    for (const line of orsLines) {
      expect(line.itemName).toBe(fx.orsName);
      expect(line.itemCode).toBe(fx.orsCode);
      expect(line.unitSalePrice).toBe(fx.orsSalePrice);
    }

    const paraQty = paraLines.reduce((sum, l) => sum.add(Quantity.fromDb(l.qty)), Quantity.zero());
    const paraSum = paraLines.reduce((sum, l) => sum.add(Money.fromDb(l.lineGrossAmount)), Money.zero());
    expect(paraQty.toDb()).toBe("20.0000");
    expect(paraSum.toDb()).toBe(paraGross);
    for (const line of paraLines) {
      expect(line.itemName).toBe(fx.paraName);
      expect(line.itemCode).toBe(fx.paraCode);
      expect(line.unitSalePrice).toBe("3.5000");
    }

    expect(printed.json.taxBreakdown).toEqual({ salesTaxAmount: "0.00", advanceIncomeTaxAmount: "0.00", fbrPosFeeAmount: "0.00" });
    expect(printed.json.grossAmount).toBe(total);
    expect(printed.json.netAmount).toBe(total);
    expect(printed.json.invoiceTotal).toBe(total);
    expect(printed.json.roundingAmount).toBe("0.00");
    expect(printed.json.changeAmount).toBe("0.00");

    expect(printed.json.payments).toHaveLength(1);
    expect(printed.json.payments[0]?.paymentMethodId).toBe(fx.cashPaymentMethodId);
    expect(printed.json.payments[0]?.methodName).toBe("Cash");
    expect(printed.json.payments[0]?.amount).toBe(total);
    expect(printed.json.payments[0]?.referenceNo).toBe("TESTREF-PRINT");
  });

  it("6. POST /sale-returns/lookup-invoice by a real docNumber returns the real invoice plus correct qtyAlreadyReturned/qtyReturnable per line", async () => {
    await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "15", unitPurchasePrice: "22.00", batchNo: freshBatch("t6") });

    const gross = costAmount("8", fx.orsSalePrice); // "240.00"
    const invoiceRes = await request<CreateSaleInvoiceResponse>(testApp, {
      method: "POST",
      url: "/sale-invoices",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId: fx.walkInCustomerId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, qty: "8" }],
        payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: gross }],
      },
    });
    expect(invoiceRes.status).toBe(201);
    const docNumber = invoiceRes.json.saleInvoice.docNumber;
    const invoiceId = invoiceRes.json.saleInvoice.saleInvoiceId;

    const returnRes = await request<CreateSaleReturnResponse>(testApp, {
      method: "POST",
      url: "/sale-returns",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {
        customerId: fx.walkInCustomerId,
        saleInvoiceId: invoiceId,
        documentDate: localToday(),
        lines: [{ itemId: fx.orsItemId, returnQty: "3" }],
      },
    });
    expect(returnRes.status).toBe(201);

    const lookup = await request<LookupInvoiceResponse>(testApp, {
      method: "POST",
      url: "/sale-returns/lookup-invoice",
      token: manager.token,
      body: { docNumber },
    });
    // sale-returns.controller.ts's lookup-invoice route carries no @HttpCode override -- Nest's
    // default success status for a POST is 201, confirmed against the real running app.
    expect(lookup.status).toBe(201);
    expect(lookup.json.invoice.saleInvoiceId).toBe(invoiceId);
    expect(lookup.json.invoice.docNumber).toBe(docNumber);
    expect(lookup.json.invoice.status).toBe("posted");

    // Aggregate by item rather than assuming exactly one sale_invoice_line: FEFO can slice one
    // requested line across several lots (same "B-6 RowGroup" reasoning as the print test above),
    // and lookupInvoice reports per PERSISTED line, not per requested line -- every persisted line
    // for this item must still sum to the real sold/returned/returnable totals.
    const orsLines = lookup.json.lines.filter((l) => l.itemId === fx.orsItemId);
    expect(orsLines.length).toBeGreaterThan(0);
    expect(orsLines.length).toBe(lookup.json.lines.length); // only ORS200 was sold on this invoice
    const totalSold = orsLines.reduce((sum, l) => sum.add(Quantity.fromDb(l.qtyBase)), Quantity.zero());
    const totalReturned = orsLines.reduce((sum, l) => sum.add(Quantity.fromDb(l.qtyAlreadyReturned)), Quantity.zero());
    const totalReturnable = orsLines.reduce((sum, l) => sum.add(Quantity.fromDb(l.qtyReturnable)), Quantity.zero());
    expect(totalSold.toDb()).toBe("8.0000");
    expect(totalReturned.toDb()).toBe("3.0000");
    expect(totalReturnable.toDb()).toBe("5.0000");
  });

  describe("7. sale-return cancel-vs-reverse guard (sale-returns.service.ts's own \"was this lot touched since\" ledger-order check)", () => {
    /** Sells `qty` of ORS200, returns `returnQty` of it, and returns everything a sub-test needs to
     *  keep going: the return's own id/status, the REAL distinct stock lot(s) it posted into (read
     *  off the response, never assumed -- see this file's header comment), and the item-level
     *  stock_balance baseline measured right after THIS helper's own fixture purchase but before
     *  the sale -- callers must read the baseline off the return value rather than measuring it
     *  themselves beforehand, since it needs to include this helper's own purchase. */
    async function sellAndReturn(batchTag: string, qty: string, returnQty: string) {
      await purchase(testApp, manager.token, fx, { itemId: fx.orsItemId, qtyPack: "25", unitPurchasePrice: "22.00", batchNo: freshBatch(batchTag) });
      const baseline = await sumItemStockBalance(fx.orsItemId);
      const gross = costAmount(qty, fx.orsSalePrice);
      const invoiceRes = await request<CreateSaleInvoiceResponse>(testApp, {
        method: "POST",
        url: "/sale-invoices",
        token: manager.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          customerId: fx.walkInCustomerId,
          documentDate: localToday(),
          lines: [{ itemId: fx.orsItemId, qty }],
          payments: [{ paymentMethodId: fx.cashPaymentMethodId, amount: gross }],
        },
      });
      expect(invoiceRes.status).toBe(201);

      const returnRes = await request<CreateSaleReturnResponse>(testApp, {
        method: "POST",
        url: "/sale-returns",
        token: manager.token,
        idempotencyKey: newIdempotencyKey(),
        body: {
          customerId: fx.walkInCustomerId,
          saleInvoiceId: invoiceRes.json.saleInvoice.saleInvoiceId,
          documentDate: localToday(),
          lines: [{ itemId: fx.orsItemId, returnQty }],
        },
      });
      expect(returnRes.status).toBe(201);
      expect(returnRes.json.saleReturn.status).toBe("posted");

      const lotIds = [...new Set(returnRes.json.lines.map((l) => l.stockLotId))];
      return { saleReturnId: returnRes.json.saleReturn.saleReturnId, lotIds, baseline };
    }

    it("cancel succeeds when nothing else has touched the return's lot(s) since it posted", async () => {
      const { saleReturnId, baseline } = await sellAndReturn("t7a", "6", "2");
      const afterReturn = baseline.sub(Quantity.fromDb("6")).add(Quantity.fromDb("2"));
      expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(afterReturn.toDb());

      const cancelled = await request<VoidSaleReturnResponse>(testApp, {
        method: "POST",
        url: `/sale-returns/${saleReturnId}/cancel`,
        token: manager.token,
        idempotencyKey: newIdempotencyKey(),
        body: { reason: "test: clean cancel, nothing else touched the lot" },
      });
      // sale-returns.controller.ts's cancel route carries no @HttpCode override -- Nest's default
      // success status for a POST is 201, confirmed against the real running app.
      expect(cancelled.status).toBe(201);
      expect(cancelled.json.saleReturn.status).toBe("cancelled");

      // The return's own +2 contribution is taken back out -- nothing more, nothing less.
      const afterCancel = afterReturn.sub(Quantity.fromDb("2"));
      expect((await sumItemStockBalance(fx.orsItemId)).toDb()).toBe(afterCancel.toDb());
    });

    it("cancel 422s (SALE_RETURN.STOCK_ALREADY_MOVED, directing to reverse) once something else touches the same lot -- and reverse succeeds where cancel would not", async () => {
      const { saleReturnId, lotIds } = await sellAndReturn("t7b", "6", "2");
      expect(lotIds.length).toBeGreaterThan(0);

      // An unrelated stock adjustment against the SAME lot(s) the return posted into -- a real
      // later stock_movement row against that exact lot, which is precisely what
      // assertStockUntouchedSinceReturn checks for.
      for (const stockLotId of lotIds) {
        const adjCreated = await request<StockAdjustmentJson>(testApp, {
          method: "POST",
          url: "/stock-adjustments",
          token: manager.token,
          idempotencyKey: newIdempotencyKey(),
          body: {
            direction: "increase",
            adjustmentReasonId: fx.countCorrectionReasonId,
            documentDate: localToday(),
            lines: [{ itemId: fx.orsItemId, stockLotId, qty: "1" }],
          },
        });
        expect(adjCreated.status).toBe(201);
        const posted = await request<StockAdjustmentJson>(testApp, {
          method: "POST",
          url: `/stock-adjustments/${adjCreated.json.stockAdjustmentId}/post`,
          token: manager.token,
          idempotencyKey: newIdempotencyKey(),
          body: {},
        });
        expect(posted.status).toBe(200);
        expect(posted.json.status).toBe("posted");
      }

      const blockedCancel = await request<ProblemResponseBody>(testApp, {
        method: "POST",
        url: `/sale-returns/${saleReturnId}/cancel`,
        token: manager.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(blockedCancel.status).toBe(422);
      expect(blockedCancel.json.code).toBe("SALE_RETURN.STOCK_ALREADY_MOVED");
      expect(blockedCancel.json.detail.toLowerCase()).toContain("reverse");

      // The escape valve actually works: `reverse` is not held to `cancel`'s stricter guard, and
      // there is plainly enough stock on hand (only +1 was added since) for the outbound reversal
      // `StockService.applyMovement` still performs underneath either verb.
      const reversed = await request<VoidSaleReturnResponse>(testApp, {
        method: "POST",
        url: `/sale-returns/${saleReturnId}/reverse`,
        token: accountant.token,
        idempotencyKey: newIdempotencyKey(),
        body: {},
      });
      expect(reversed.status).toBe(201); // no @HttpCode override on this route either -- Nest's POST default
      expect(reversed.json.saleReturn.status).toBe("reversed");
    });
  });
});
