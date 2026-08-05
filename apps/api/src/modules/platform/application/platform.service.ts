// Blueprint: docs/system-analysis/18-api-plan.md §1.3 "Module `platform`" (health/ready) and
// §1.4 (D1 feature-capabilities register, 00b-owner-decisions-and-requirements.md D1).
import { Injectable, NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { featureCapabilities, fiscalPeriods, getDb, glAccounts } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";

// Tracks apps/api/package.json's own "version" field. Not read from the file at runtime: this
// build's ESM loader chain (register-loader.mjs, ts-node/esm -- see
// pharmacy-rebuild-dev-environment memory) does not have a clean `import ... with { type: "json"
// }` story across both `tsx`/`ts-node` dev and the compiled `tsc` build, and a hardcoded constant
// with this comment is simpler and no less honest than a fragile runtime read. Bump by hand
// alongside package.json's version if that ever starts moving.
const APP_VERSION = "0.0.1";

const processStartedAt = Date.now();

@Injectable()
export class PlatformService {
  /** `GET /health` -- liveness. Deliberately does NOT touch the DB (a slow/down DB pool should
   *  fail `/ready`, not liveness -- a live-but-not-ready process must stay up so an orchestrator
   *  doesn't kill-and-restart-loop it while the DB recovers). */
  health(): { status: "ok"; version: string; uptimeSeconds: number } {
    return { status: "ok", version: APP_VERSION, uptimeSeconds: Math.floor((Date.now() - processStartedAt) / 1000) };
  }

  /** `GET /ready` -- readiness. Every field is checked independently and defensively: a failure
   *  in one check must not throw and take the whole readiness probe down with it (an orchestrator
   *  reading `503` vs. a hung/500'd probe behaves very differently). */
  async ready(): Promise<{ db: boolean; migrations: boolean; requiredBindingsSatisfied: boolean; fbrReachable: boolean }> {
    const db = await this.checkDb();
    const migrations = await this.checkMigrations();
    const requiredBindingsSatisfied = await this.checkRequiredBindings();
    return {
      db,
      migrations,
      requiredBindingsSatisfied,
      // FBR fiscalization does not exist anywhere in this codebase -- task #28, blocked pending
      // owner/tax-adviser sign-off (12-risks-gaps.md U-060). Reporting `true` here would be a
      // fabricated readiness signal; `false` is the honest answer until that module is built.
      fbrReachable: false,
    };
  }

  private async checkDb(): Promise<boolean> {
    try {
      await getDb().execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  private async checkMigrations(): Promise<boolean> {
    // drizzle-orm's migrator (packages/db/scripts/migrate.ts) creates and tops up
    // `__drizzle_migrations` itself on every successful `migrate()` call -- its presence with at
    // least one row is exactly "has this database ever had a migration applied", which is what
    // readiness needs (not "is it fully up to date with HEAD", which would require shipping the
    // migrations folder into the running API's deploy artifact just to count entries against it).
    //
    // `db.execute(sql...)` is the raw mysql2 driver shape here, NOT Drizzle's schema-aware
    // `.select()` mapping -- confirmed live (packages/db, a throwaway probe against the real dev
    // DB, deleted after use): it returns the mysql2 tuple `[rows, fields]`, so the row itself is
    // `result[0][0]`, not `result[0]`. Its `cnt` column also comes back as a STRING ("10"), the
    // same well-known mysql2 `COUNT(*)` gotcha already documented elsewhere in this codebase
    // (reports.service.ts's aging-report pivot) -- `Number(...)` at point of use, never trusted
    // as a number straight off the wire.
    try {
      const [rows] = await getDb().execute(sql`SELECT COUNT(*) AS cnt FROM __drizzle_migrations`);
      const row = (rows as unknown as Array<{ cnt: string }>)[0];
      return Number(row?.cnt ?? 0) > 0;
    } catch {
      return false;
    }
  }

  private async checkRequiredBindings(): Promise<boolean> {
    // "Required GL bindings" interpreted narrowly and honestly: is the platform minimally
    // provisioned to post anything at all (a chart of accounts exists, a fiscal period exists) --
    // NOT a claim that every tenant's individual cash-bank-account/payment-method/voucher-category
    // row has its own `gl_account_id` populated, which is already a NOT NULL DB constraint on
    // every one of those tables (payments.ts/parties.ts/expenses.ts/inventory.ts) and therefore
    // cannot be false for any row that exists at all.
    try {
      const db = getDb();
      const [account] = await db.select({ id: glAccounts.glAccountId }).from(glAccounts).limit(1);
      const [period] = await db.select({ id: fiscalPeriods.fiscalPeriodId }).from(fiscalPeriods).limit(1);
      return account !== undefined && period !== undefined;
    } catch {
      return false;
    }
  }

  /** `GET /admin/feature-capabilities` -- the D1 register, every row. */
  async listFeatureCapabilities() {
    const db = getDb();
    return db.select().from(featureCapabilities).then((rows) => rows.map(shapeFeatureCapability));
  }

  /** `PATCH /admin/feature-capabilities/:code` -- record an owner decision on an EXISTING
   *  register row (404 on an unknown code -- this endpoint records a decision about a capability
   *  someone already catalogued, it does not let a typo silently create a new one). */
  async updateFeatureCapability(code: string, input: { status: string; rationale: string }, actor: Actor) {
    const db = getDb();
    const [existing] = await db.select().from(featureCapabilities).where(eq(featureCapabilities.code, code));
    if (!existing) throw new NotFoundException(`No feature-capability register entry "${code}". Seed it before recording a decision on it.`);

    const actorId = Number(actor.userId);
    await db
      .update(featureCapabilities)
      .set({
        status: input.status as typeof existing.status,
        rationale: input.rationale,
        decisionRef: existing.decisionRef ?? `owner:${code}`,
        decidedOn: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00`),
        updatedBy: actorId,
      })
      .where(eq(featureCapabilities.code, code));

    const [updated] = await db.select().from(featureCapabilities).where(eq(featureCapabilities.code, code));
    if (!updated) throw new Error(`feature_capability "${code}" vanished immediately after its own update`); // unreachable; defensive
    return shapeFeatureCapability(updated);
  }
}

function shapeFeatureCapability<T extends { decidedOn: Date | null }>(row: T): Omit<T, "decidedOn"> & { decidedOn: string | null } {
  // Same Date-mode-column-read-back-as-full-ISO-timestamp bug class documented in
  // settings.service.ts's `toDateOnlyOrNull` -- a `date()`-mode column comes back from a plain
  // `.select()` as a JS Date, which JSON.stringify renders as a full timestamp, not `YYYY-MM-DD`.
  return { ...row, decidedOn: row.decidedOn === null ? null : row.decidedOn.toISOString().slice(0, 10) };
}
