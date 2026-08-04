// Wave 7 option-list/option-item admin CRUD (src/modules/settings/**, specifically
// option-lists.controller.ts / settings.service.ts / options.repository.ts). Real Nest+Fastify
// app, real MySQL -- see test/support/test-app.ts's own header comment for why.
//
// Fixtures: this file never invents an option LIST -- every list it touches is one of
// packages/db/scripts/seed.ts's own `OPTION_LISTS` (Block 1, `sale.tender_method`, admin-
// extensible + disable-allowed) or its Block 1e `sales.doc_print_format` (fixed/system,
// `isAdminExtensible: false` + `allowsDisable: false`). Every item it CREATES goes into
// `sale.tender_method` (the one admin-extensible list this suite exercises) with a fresh,
// timestamp-suffixed `code` so repeated runs against the shared local dev database never collide
// with a previous run's leftovers -- same "never assume, mint a fresh identifier" discipline
// sales.test.ts's own `freshBatch` helper documents. Per the task's own instruction, nothing
// created here is ever deleted (no DELETE endpoint exists by design -- `isEnabled` is the only
// "remove" mechanism this module has, per options.repository.ts's header comment); leaving
// created option-items in the shared dev DB is expected, matching every other test file in this
// suite.
//
// set-default is the one place this file deliberately touches EXISTING seeded state (flipping
// `sale.tender_method`'s default off `CASH` and onto a freshly-defaulted item) rather than only
// adding new rows -- see that test's own comment for why it restores the original default before
// finishing, unlike the create-only tests above it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, optionItems, optionLists } from "@pharmacy/db";

import { loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

// ---- response-shape types (only the fields these tests actually assert on) -------------------

interface OptionListSummaryJson {
  optionListId: number;
  listCode: string;
  name: string;
  description: string | null;
  isAdminExtensible: boolean;
  allowsDisable: boolean;
  itemCount: number;
}

interface OptionItemJson {
  optionItemId: number;
  optionListId: number;
  code: string;
  name: string;
  nameUr: string | null;
  description: string | null;
  groupLabel: string | null;
  sortOrder: number;
  isEnabled: boolean;
  isDefault: boolean;
  isSystem: boolean;
}

interface ProblemResponseBody {
  code: string;
  title: string;
  detail: string;
  status: number;
  [key: string]: unknown;
}

// ---- real seeded list codes (packages/db/scripts/seed.ts) -------------------------------------

/** Admin-extensible (`isAdminExtensible: true`), disable-allowed (`allowsDisable: true`) --
 *  seeded with CASH (default, isSystem), CARD/MOBILE_WALLET/MIXED (isSystem, enabled),
 *  CREDIT (isSystem, seeded DISABLED per D5 "walk-in cash only today"). */
const TENDER_LIST_CODE = "sale.tender_method";

/** Fixed/system (`isAdminExtensible: false`, `allowsDisable: false`), Wave 7 Block 1e -- exactly
 *  one item (`standard_receipt`, isSystem, isDefault, enabled) and by design can never gain a
 *  second, since creation is blocked. */
const PRINT_FORMAT_LIST_CODE = "sales.doc_print_format";

// ---- small helpers ----------------------------------------------------------------------------

let codeCounter = 0;
/** A fresh, collision-proof `option_item.code` -- mirrors sales.test.ts's `freshBatch` reasoning:
 *  a shared/reused local dev database may already carry codes this file minted on an earlier
 *  run, so never reuse a fixed literal. */
function freshCode(prefix: string): string {
  codeCounter += 1;
  return `${prefix}${Date.now().toString(36)}${codeCounter}`.toUpperCase().slice(0, 32);
}

/** Direct-DB row count of non-deleted `option_item` rows for one list -- used to prove a rejected
 *  write really did not land, independent of the HTTP response. mysql2's `bigNumberStrings: true`
 *  (packages/db/client.ts) means `count(*)` comes back as a numeric STRING (same convention
 *  sales.test.ts's own `countRows` documents) -- `Number(...)` here mirrors that. */
async function countActiveItems(optionListId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(optionItems)
    .where(and(eq(optionItems.optionListId, optionListId), isNull(optionItems.deletedAt)));
  return Number(row?.n ?? 0);
}

/** Direct-DB row count of `is_default = 1` rows for one list -- the real atomicity check the task
 *  calls for: `uk_option_item_default` (options.ts) only guarantees "at most one"; this proves
 *  the actual count, not just that the DB didn't throw. */
async function countDefaults(optionListId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(optionItems)
    .where(and(eq(optionItems.optionListId, optionListId), eq(optionItems.isDefault, true), isNull(optionItems.deletedAt)));
  return Number(row?.n ?? 0);
}

/** One `option_item` row, read directly off the DB (not the API response) -- used to confirm a
 *  rejected/atomic mutation's real, persisted state. */
async function findItemRow(optionItemId: number) {
  const db = getDb();
  const [row] = await db.select().from(optionItems).where(eq(optionItems.optionItemId, optionItemId));
  return row;
}

// -------------------------------------------------------------------------------------------

describe("settings: option-list / option-item admin CRUD (option-lists.controller.ts)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let tenderListId: number;
  let printFormatListId: number;
  /** Set by the "creates a real item" test; reused by the "edits an item" test right after it. */
  let createdItemId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
  });

  afterAll(async () => {
    await testApp.close();
  });

  it("GET /option-lists returns real lists with real item counts, cross-checked against a direct DB query", async () => {
    const res = await request<OptionListSummaryJson[]>(testApp, { method: "GET", url: "/option-lists", token: owner.token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);

    const tenderList = res.json.find((l) => l.listCode === TENDER_LIST_CODE);
    const printFormatList = res.json.find((l) => l.listCode === PRINT_FORMAT_LIST_CODE);
    expect(tenderList).toBeDefined();
    expect(printFormatList).toBeDefined();
    tenderListId = tenderList!.optionListId;
    printFormatListId = printFormatList!.optionListId;

    // The business-rule flags this whole file depends on -- confirmed against the real seeded
    // rows, not assumed from reading seed.ts.
    expect(tenderList!.isAdminExtensible).toBe(true);
    expect(tenderList!.allowsDisable).toBe(true);
    expect(printFormatList!.isAdminExtensible).toBe(false);
    expect(printFormatList!.allowsDisable).toBe(false);

    // Real item counts -- computed by a DIRECT query against option_item, not trusted from the
    // endpoint's own arithmetic.
    const tenderCount = await countActiveItems(tenderListId);
    expect(tenderList!.itemCount).toBe(tenderCount);
    expect(tenderCount).toBeGreaterThanOrEqual(5); // CASH/CARD/MOBILE_WALLET/MIXED/CREDIT, seed.ts

    const printFormatCount = await countActiveItems(printFormatListId);
    expect(printFormatList!.itemCount).toBe(printFormatCount);
    expect(printFormatCount).toBe(1); // `standard_receipt` -- creation is blocked on this list, so this can never drift
  });

  it("creates a real item in an admin-extensible list, and it is returned by a subsequent GET .../items", async () => {
    const code = freshCode("TND");
    const before = await countActiveItems(tenderListId);

    const createRes = await request<OptionItemJson>(testApp, {
      method: "POST",
      url: `/option-lists/${TENDER_LIST_CODE}/items`,
      token: owner.token,
      idempotencyKey: newIdempotencyKey(),
      body: { code, name: "Test Tender Method", description: "created by settings-options.test.ts", sortOrder: 900 },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.json.code).toBe(code);
    expect(createRes.json.name).toBe("Test Tender Method");
    expect(createRes.json.isSystem).toBe(false); // API-created rows can never claim to be seed rows
    expect(createRes.json.isDefault).toBe(false); // only set-default ever flips this
    expect(createRes.json.isEnabled).toBe(true);
    createdItemId = createRes.json.optionItemId;

    // Real DB effect: the list actually grew by exactly one row.
    expect(await countActiveItems(tenderListId)).toBe(before + 1);

    const itemsRes = await request<OptionItemJson[]>(testApp, {
      method: "GET",
      url: `/option-lists/${TENDER_LIST_CODE}/items`,
      token: owner.token,
    });
    expect(itemsRes.status).toBe(200);
    const found = itemsRes.json.find((i) => i.optionItemId === createdItemId);
    expect(found).toBeDefined();
    expect(found!.code).toBe(code);
    expect(found!.name).toBe("Test Tender Method");
    expect(found!.description).toBe("created by settings-options.test.ts");
  });

  it("rejects creating an item in a NON-admin-extensible list with a real 422 OPTION_LIST.NOT_ADMIN_EXTENSIBLE", async () => {
    const before = await countActiveItems(printFormatListId);

    const res = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: `/option-lists/${PRINT_FORMAT_LIST_CODE}/items`,
      token: owner.token,
      idempotencyKey: newIdempotencyKey(),
      body: { code: freshCode("PF"), name: "Should never be created" },
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("OPTION_LIST.NOT_ADMIN_EXTENSIBLE");

    // Real DB effect: nothing landed.
    expect(await countActiveItems(printFormatListId)).toBe(before);
  });

  it("edits an item's fields, and the change persists across a fresh GET", async () => {
    expect(createdItemId).toBeDefined(); // depends on the "creates a real item" test above

    const patchRes = await request<OptionItemJson>(testApp, {
      method: "PATCH",
      url: `/option-lists/${TENDER_LIST_CODE}/items/${createdItemId}`,
      token: owner.token,
      body: { name: "Renamed Tender Method", description: "edited by settings-options.test.ts", groupLabel: "Test group", sortOrder: 950 },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.json.name).toBe("Renamed Tender Method");

    // Re-fetch via a completely separate GET -- proves persistence, not just an echoed response.
    const refetch = await request<OptionItemJson[]>(testApp, {
      method: "GET",
      url: `/option-lists/${TENDER_LIST_CODE}/items`,
      token: owner.token,
    });
    const found = refetch.json.find((i) => i.optionItemId === createdItemId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Renamed Tender Method");
    expect(found!.description).toBe("edited by settings-options.test.ts");
    expect(found!.groupLabel).toBe("Test group");
    expect(found!.sortOrder).toBe(950);
  });

  it("rejects disabling a system-seeded item with a real 422 OPTION_ITEM.SYSTEM_ITEM_CANNOT_BE_DISABLED", async () => {
    // `CARD` -- a real seeded row in `sale.tender_method`: isSystem (every OPTION_LISTS item is
    // seeded isSystem: true, seed.ts), enabled, and NOT the default (so this can never be
    // confused with the set-default tests below). NOTE on the sibling guard
    // (OPTION_LIST.DISABLE_NOT_ALLOWED, allowsDisable=false): every seeded list with
    // allowsDisable=false (`sales.doc_print_format`, `accounting.voucher_category`) is ALSO
    // isAdminExtensible=false, so it can only ever contain isSystem=true rows -- there is no real
    // row in this database where the allowsDisable guard fires without the isSystem guard firing
    // first (SettingsService.updateOptionItem checks isSystem before allowsDisable). This test
    // covers the guard that real data can actually isolate.
    const itemsRes = await request<OptionItemJson[]>(testApp, {
      method: "GET",
      url: `/option-lists/${TENDER_LIST_CODE}/items`,
      token: owner.token,
    });
    const card = itemsRes.json.find((i) => i.code === "CARD");
    expect(card).toBeDefined();
    expect(card!.isSystem).toBe(true);
    expect(card!.isEnabled).toBe(true);

    const res = await request<ProblemResponseBody>(testApp, {
      method: "PATCH",
      url: `/option-lists/${TENDER_LIST_CODE}/items/${card!.optionItemId}`,
      token: owner.token,
      body: { isEnabled: false },
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("OPTION_ITEM.SYSTEM_ITEM_CANNOT_BE_DISABLED");

    // Real DB effect: CARD is still enabled -- the rejected patch never landed.
    const cardRow = await findItemRow(card!.optionItemId);
    expect(cardRow?.isEnabled).toBe(true);
  });

  it("set-default is atomic: a direct DB query shows exactly one is_default=1 row in the list, both before and after", async () => {
    // Baseline: seed.ts defaults `sale.tender_method` to CASH, and nothing before this test ever
    // permanently changes it (this test restores it at the end -- see below) -- so this is a real
    // fact about the current DB state, not an assumption.
    const before = await countDefaults(tenderListId);
    expect(before).toBe(1);

    const itemsRes = await request<OptionItemJson[]>(testApp, {
      method: "GET",
      url: `/option-lists/${TENDER_LIST_CODE}/items`,
      token: owner.token,
    });
    const originalDefault = itemsRes.json.find((i) => i.isDefault === true);
    expect(originalDefault).toBeDefined(); // CASH
    const card = itemsRes.json.find((i) => i.code === "CARD");
    expect(card).toBeDefined();
    expect(card!.isEnabled).toBe(true);
    expect(card!.isDefault).toBe(false);

    const setRes = await request<OptionItemJson>(testApp, {
      method: "POST",
      url: `/option-lists/${TENDER_LIST_CODE}/items/${card!.optionItemId}/set-default`,
      token: owner.token,
    });
    expect(setRes.status).toBe(200);
    expect(setRes.json.isDefault).toBe(true);

    // The real atomicity proof: a DIRECT query, not the 200 response, shows exactly one default.
    const afterSet = await countDefaults(tenderListId);
    expect(afterSet).toBe(1);

    const cardRowAfterSet = await findItemRow(card!.optionItemId);
    expect(cardRowAfterSet?.isDefault).toBe(true);
    const originalRowAfterSet = await findItemRow(originalDefault!.optionItemId);
    expect(originalRowAfterSet?.isDefault).toBe(false); // the old default was really unset, not just left stale

    // Restore the original default -- this test deliberately mutates EXISTING seeded state
    // (unlike every create-only test above it), so it puts it back rather than leaving the
    // shared dev DB's live tender-method default permanently switched to a test row. This
    // restore call is itself one more real, atomicity-proving set-default -- checked the same way.
    const restoreRes = await request<OptionItemJson>(testApp, {
      method: "POST",
      url: `/option-lists/${TENDER_LIST_CODE}/items/${originalDefault!.optionItemId}/set-default`,
      token: owner.token,
    });
    expect(restoreRes.status).toBe(200);

    const afterRestore = await countDefaults(tenderListId);
    expect(afterRestore).toBe(1);
    const cardRowAfterRestore = await findItemRow(card!.optionItemId);
    expect(cardRowAfterRestore?.isDefault).toBe(false);
    const originalRowAfterRestore = await findItemRow(originalDefault!.optionItemId);
    expect(originalRowAfterRestore?.isDefault).toBe(true);
  });

  it("rejects set-default on a disabled item with a real 422 OPTION_ITEM.CANNOT_DEFAULT_DISABLED", async () => {
    // `CREDIT` -- seed.ts ships it disabled (D5: "walk-in cash only today"; the switch exists,
    // the option is simply off).
    const itemsRes = await request<OptionItemJson[]>(testApp, {
      method: "GET",
      url: `/option-lists/${TENDER_LIST_CODE}/items`,
      token: owner.token,
    });
    const credit = itemsRes.json.find((i) => i.code === "CREDIT");
    expect(credit).toBeDefined();
    expect(credit!.isEnabled).toBe(false);
    expect(credit!.isDefault).toBe(false);

    const before = await countDefaults(tenderListId);

    const res = await request<ProblemResponseBody>(testApp, {
      method: "POST",
      url: `/option-lists/${TENDER_LIST_CODE}/items/${credit!.optionItemId}/set-default`,
      token: owner.token,
    });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("OPTION_ITEM.CANNOT_DEFAULT_DISABLED");

    // Real DB effect: the default did not move to CREDIT (and didn't move at all).
    const after = await countDefaults(tenderListId);
    expect(after).toBe(before);
    const creditRow = await findItemRow(credit!.optionItemId);
    expect(creditRow?.isDefault).toBe(false);
  });
});
