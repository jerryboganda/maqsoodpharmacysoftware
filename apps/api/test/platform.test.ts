// Wave 10a (18-api-plan.md §1.3/§1.4) integration tests: /health, /ready, and the D1
// feature-capability register (list + record-a-decision). Mirrors
// controlled-drug-compliance.test.ts's own fixture/cleanup conventions -- this suite mutates two
// of the real seeded register rows (tax_engine, drap_controlled_drug_compliance) and restores
// both in `afterAll`, same "leave the shared local dev DB exactly as this suite found it"
// discipline every prior wave's test file already follows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestUser, loginAsOwner, type LoggedInUser } from "./support/auth.js";
import { createTestApp, request, type TestApp } from "./support/test-app.js";

interface HealthResponse {
  status: string;
  version: string;
  uptimeSeconds: number;
}

interface ReadyResponse {
  db: boolean;
  migrations: boolean;
  requiredBindingsSatisfied: boolean;
  fbrReachable: boolean;
}

interface FeatureCapabilityJson {
  code: string;
  status: string;
  decidedOn: string | null;
  rationale: string | null;
}

describe("Wave 10a: platform module (health/ready + D1 feature-capability register)", () => {
  let testApp: TestApp;
  let owner: LoggedInUser;
  let manager: LoggedInUser; // pharmacy_manager -- must NOT reach platform.feature_capability:edit

  // The exact seeded values (packages/db/scripts/seed.ts FEATURE_CAPABILITIES) -- restored in
  // afterAll so this suite never leaves the shared register mutated for the next run/wave.
  const TAX_ENGINE_ORIGINAL = {
    status: "excluded",
    rationale: "Task #28: rates/exemptions are unknown and cannot be inferred from analysis alone -- needs accountant/tax-adviser sign-off.",
  };

  beforeAll(async () => {
    testApp = await createTestApp();
    owner = await loginAsOwner(testApp);
    manager = await createTestUser(testApp, owner.token, ["pharmacy_manager"]);
  });

  afterAll(async () => {
    await request(testApp, {
      method: "PATCH",
      url: "/admin/feature-capabilities/tax_engine",
      token: owner.token,
      body: TAX_ENGINE_ORIGINAL,
    });
    await testApp.close();
  });

  it("1. GET /health is public (no token) and reports ok", async () => {
    const res = await request<HealthResponse>(testApp, { method: "GET", url: "/health" });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("ok");
    expect(typeof res.json.version).toBe("string");
    expect(res.json.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("2. GET /ready is public and reports a live DB against the real migrated dev database", async () => {
    const res = await request<ReadyResponse>(testApp, { method: "GET", url: "/ready" });
    expect(res.status).toBe(200);
    expect(res.json.db).toBe(true);
    expect(res.json.migrations).toBe(true);
    expect(res.json.requiredBindingsSatisfied).toBe(true);
    // FBR fiscalization does not exist in this codebase (task #28, blocked) -- must never be
    // reported true.
    expect(res.json.fbrReachable).toBe(false);
  });

  it("3. GET /admin/feature-capabilities as owner lists the real seeded D1 register, denied to pharmacy_manager", async () => {
    const res = await request<FeatureCapabilityJson[]>(testApp, { method: "GET", url: "/admin/feature-capabilities", token: owner.token });
    expect(res.status).toBe(200);
    const codes = res.json.map((r) => r.code);
    expect(codes).toEqual(
      expect.arrayContaining(["non_pharmacy_verticals", "tax_engine", "fbr_fiscalization", "financial_statements", "drap_controlled_drug_compliance"]),
    );

    const denied = await request(testApp, { method: "GET", url: "/admin/feature-capabilities", token: manager.token });
    expect(denied.status).toBe(403);
  });

  it("4. PATCH records an owner decision (real row, real decidedOn stamp); denied to pharmacy_manager; 404 on an unknown code; 422 on a too-short rationale", async () => {
    const patched = await request<FeatureCapabilityJson>(testApp, {
      method: "PATCH",
      url: "/admin/feature-capabilities/tax_engine",
      token: owner.token,
      body: { status: "deferred", rationale: "Integration test 4 -- temporarily flipped to verify the PATCH round trip, restored in afterAll." },
    });
    expect(patched.status).toBe(200);
    expect(patched.json.status).toBe("deferred");
    expect(patched.json.decidedOn).toBe(new Date().toISOString().slice(0, 10));

    const denied = await request(testApp, {
      method: "PATCH",
      url: "/admin/feature-capabilities/tax_engine",
      token: manager.token,
      body: { status: "in_scope", rationale: "pharmacy_manager must not be able to record an owner decision here." },
    });
    expect(denied.status).toBe(403);

    const notFound = await request(testApp, {
      method: "PATCH",
      url: "/admin/feature-capabilities/does_not_exist",
      token: owner.token,
      body: { status: "in_scope", rationale: "this code was never seeded -- must 404, never silently create one." },
    });
    expect(notFound.status).toBe(404);

    const badRationale = await request(testApp, {
      method: "PATCH",
      url: "/admin/feature-capabilities/tax_engine",
      token: owner.token,
      body: { status: "in_scope", rationale: "too short" },
    });
    expect(badRationale.status).toBe(422);
  });
});
