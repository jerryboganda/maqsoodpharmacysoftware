// Wave 10c (`/admin/visibility/*` + `/items/:id/visibility`, R1 --
// 00b-owner-decisions-and-requirements.md D7) integration tests: per-scope override (isVisible:
// true deletes the redundant row, R1.2), the R1.7 `scope`/`includeHidden`/`meta.hiddenByVisibility`
// contract on GET /items, bulk apply (dryRun writes nothing) + single-click undo (real-time,
// 422 on a second undo), the "why hidden" explainer, and the MGR/SYS/OWN/AUD vs MGR/SYS role
// split 18-api-plan.md's own table specifies. Mirrors controlled-drug-compliance.test.ts's fixture
// conventions -- PARA500 is a real seeded item, restored to its default (no override) state in
// afterAll.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, items } from "@pharmacy/db";

import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, newIdempotencyKey, request, type TestApp } from "./support/test-app.js";

interface ItemVisibilityScopeJson {
  scope: string;
  isVisible: boolean;
  source: string;
}
interface SetVisibilityResponse {
  itemId: number;
  scopes: ItemVisibilityScopeJson[];
}
interface WorkbenchRow {
  itemId: number;
  scope: string;
  isVisible: boolean;
  source: string;
  bulkOperationId: number | null;
}
interface WorkbenchResponse {
  data: WorkbenchRow[];
  meta: { hiddenCount: number; visibleCount: number };
}
interface ItemsListResponse {
  items: { itemId: number }[];
  meta: { hiddenByVisibility: number };
}
interface BulkApplyResponse {
  affectedCount: number;
  bulkOperationId?: number;
}
interface UndoResponse {
  bulkOperationId: number;
  reversedCount: number;
}
interface EffectiveResponse {
  isVisible: boolean;
  decidedBy: string;
}

describe("Wave 10c: item-visibility curation (R1)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let manager: LoggedInUser; // pharmacy_manager -- catalog.visibility:list/edit
  let salesOfficer: LoggedInUser; // no catalog.visibility grants at all
  let paraItemId: number;

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
    salesOfficer = await createTestUser(testApp, owner.token, ["sales_officer"]);

    // Item codes are unique per-tenant, not globally -- find PARA500 by code alone (this test
    // suite doesn't otherwise need the tenant id), same "resolve fixtures via a real seeded row,
    // never invent an id" discipline every other test file already follows.
    const db = getDb();
    const [para] = await db.select({ itemId: items.itemId }).from(items).where(eq(items.customCode, "PARA500"));
    if (!para) throw new Error('visibility.test.ts: seeded item "PARA500" not found -- is the test database migrated+seeded?');
    paraItemId = para.itemId;
  });

  afterAll(async () => {
    // Leave PARA500 with no override on any scope, exactly as this suite found it.
    await request(testApp, {
      method: "PUT",
      url: `/items/${paraItemId}/visibility`,
      token: manager.token,
      body: { scopes: (["pos", "purchase", "reports", "stock_list"] as const).map((scope) => ({ scope, isVisible: true })) },
    });
    await testApp.close();
  });

  it("1. PUT sets a per-scope override; isVisible:true on an already-default scope is a no-op that deletes nothing extra", async () => {
    const hide = await request<SetVisibilityResponse>(testApp, {
      method: "PUT",
      url: `/items/${paraItemId}/visibility`,
      token: manager.token,
      body: { scopes: [{ scope: "pos", isVisible: false }], reason: "integration test" },
    });
    expect(hide.status).toBe(200);
    const posScope = hide.json.scopes.find((s) => s.scope === "pos");
    expect(posScope).toEqual({ scope: "pos", isVisible: false, source: "manual" });
    const otherScope = hide.json.scopes.find((s) => s.scope === "purchase");
    expect(otherScope).toEqual({ scope: "purchase", isVisible: true, source: "default" });

    const denied = await request(testApp, {
      method: "PUT",
      url: `/items/${paraItemId}/visibility`,
      token: salesOfficer.token,
      body: { scopes: [{ scope: "pos", isVisible: true }] },
    });
    expect(denied.status).toBe(403);
  });

  it("2. GET /items?scope=pos excludes the hidden item and reports meta.hiddenByVisibility; includeHidden=true always shows it (R1.7)", async () => {
    const excluded = await request<ItemsListResponse>(testApp, { method: "GET", url: `/items?scope=pos&q=PARA500`, token: owner.token });
    expect(excluded.status).toBe(200);
    expect(excluded.json.items.find((i) => i.itemId === paraItemId)).toBeUndefined();
    expect(excluded.json.meta.hiddenByVisibility).toBeGreaterThanOrEqual(1);

    const included = await request<ItemsListResponse>(testApp, { method: "GET", url: `/items?scope=pos&includeHidden=true&q=PARA500`, token: owner.token });
    expect(included.status).toBe(200);
    expect(included.json.items.find((i) => i.itemId === paraItemId)).toBeDefined();

    // no `scope` param -- exact prior behaviour, item still listed (it's isActive, only hidden
    // for the "pos" scope specifically).
    const noScope = await request<ItemsListResponse>(testApp, { method: "GET", url: `/items?q=PARA500`, token: owner.token });
    expect(noScope.json.items.find((i) => i.itemId === paraItemId)).toBeDefined();
  });

  it("3. GET .../effective explains the override; GET .../items (workbench) lists it; owner (list-only role) can view but sales_officer cannot", async () => {
    const effective = await request<EffectiveResponse>(testApp, { method: "GET", url: `/admin/visibility/effective/${paraItemId}?scope=pos`, token: owner.token });
    expect(effective.status).toBe(200);
    expect(effective.json.isVisible).toBe(false);
    expect(effective.json.decidedBy).toBe("override");

    const workbench = await request<WorkbenchResponse>(testApp, { method: "GET", url: `/admin/visibility/items?scope=pos`, token: owner.token });
    expect(workbench.status).toBe(200);
    expect(workbench.json.data.find((r) => r.itemId === paraItemId && r.scope === "pos" && !r.isVisible)).toBeDefined();

    const denied = await request(testApp, { method: "GET", url: `/admin/visibility/items`, token: salesOfficer.token });
    expect(denied.status).toBe(403);
  });

  it("4. isVisible:true DELETES the override (R1.2 -- no redundant 'true' row); GET .../effective falls back to 'default'", async () => {
    const restore = await request<SetVisibilityResponse>(testApp, {
      method: "PUT",
      url: `/items/${paraItemId}/visibility`,
      token: manager.token,
      body: { scopes: [{ scope: "pos", isVisible: true }] },
    });
    expect(restore.status).toBe(200);
    expect(restore.json.scopes.find((s) => s.scope === "pos")).toEqual({ scope: "pos", isVisible: true, source: "default" });

    const effective = await request<EffectiveResponse>(testApp, { method: "GET", url: `/admin/visibility/effective/${paraItemId}?scope=pos`, token: owner.token });
    expect(effective.json.decidedBy).toBe("default");

    const notFound = await request(testApp, { method: "PUT", url: `/items/999999999/visibility`, token: manager.token, body: { scopes: [{ scope: "pos", isVisible: false }] } });
    expect(notFound.status).toBe(404);
  });

  it("5. bulk apply: dryRun writes nothing and returns the live count; a real apply tags rows with one bulkOperationId; undo reverses in one shot and 422s on a second attempt", async () => {
    const dryRun = await request<BulkApplyResponse>(testApp, {
      method: "POST",
      url: "/admin/visibility/bulk",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: { itemIds: [paraItemId], scopes: ["pos", "purchase"], isVisible: false, reason: "bulk dry-run integration test", dryRun: true },
    });
    expect(dryRun.status).toBe(201); // Nest's default POST status, no @HttpCode override
    expect(dryRun.json.affectedCount).toBe(1);
    expect(dryRun.json.bulkOperationId).toBeUndefined();

    const afterDryRun = await request<WorkbenchResponse>(testApp, { method: "GET", url: "/admin/visibility/items", token: owner.token });
    expect(afterDryRun.json.data.find((r) => r.itemId === paraItemId)).toBeUndefined();

    const apply = await request<BulkApplyResponse>(testApp, {
      method: "POST",
      url: "/admin/visibility/bulk",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: { itemIds: [paraItemId], scopes: ["pos", "purchase"], isVisible: false, reason: "bulk real-apply integration test" },
    });
    expect(apply.status).toBe(201);
    expect(apply.json.affectedCount).toBe(1);
    const bulkOperationId = apply.json.bulkOperationId!;
    expect(bulkOperationId).toBeDefined();

    const afterApply = await request<WorkbenchResponse>(testApp, { method: "GET", url: "/admin/visibility/items", token: owner.token });
    const taggedRows = afterApply.json.data.filter((r) => r.itemId === paraItemId && r.bulkOperationId === bulkOperationId);
    expect(taggedRows).toHaveLength(2); // pos + purchase

    const undo = await request<UndoResponse>(testApp, {
      method: "POST",
      url: `/admin/visibility/bulk/${bulkOperationId}/undo`,
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(undo.status).toBe(201);
    expect(undo.json.reversedCount).toBe(2);

    const afterUndo = await request<WorkbenchResponse>(testApp, { method: "GET", url: "/admin/visibility/items", token: owner.token });
    expect(afterUndo.json.data.find((r) => r.itemId === paraItemId)).toBeUndefined();

    const undoAgain = await request(testApp, {
      method: "POST",
      url: `/admin/visibility/bulk/${bulkOperationId}/undo`,
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(undoAgain.status).toBe(422);

    const undoUnknown = await request(testApp, {
      method: "POST",
      url: `/admin/visibility/bulk/999999999/undo`,
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: {},
    });
    expect(undoUnknown.status).toBe(404);
  });

  it("6. bulk apply rejects a too-short reason (min 10 chars) and requires either itemIds or q", async () => {
    const shortReason = await request(testApp, {
      method: "POST",
      url: "/admin/visibility/bulk",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: { itemIds: [paraItemId], scopes: ["pos"], isVisible: false, reason: "short" },
    });
    expect(shortReason.status).toBe(422);

    const noSelection = await request(testApp, {
      method: "POST",
      url: "/admin/visibility/bulk",
      token: manager.token,
      idempotencyKey: newIdempotencyKey(),
      body: { scopes: ["pos"], isVisible: false, reason: "no itemIds and no q at all here" },
    });
    expect(noSelection.status).toBe(422);
  });
});
