// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.8 period control -- every DOC
// header carries fiscal_period_id; posting resolves the period from posting_date and rejects
// `422 PERIOD.CLOSED` unless the period is open. (soft_closed + break-glass is deferred with
// real RBAC.)
//
// Wave 9 (R-013, CRITICAL -- 12-risks-gaps.md): the enforcement half above already existed and
// worked; nothing anywhere in this codebase could ever actually CLOSE or REOPEN a period, which
// quietly defeated the control (every period seeds "open" and stays that way forever). `close`/
// `reopen` below are that missing admin half -- `soft_closed` (warn-but-allow-with-override) is
// deliberately NOT built here; this wave only wires the two states `resolveOpenPeriod` already
// enforces (open vs. anything-else-is-blocked), matching this file's own pre-existing "soft_closed
// deferred" note above. Tracked separately as a real follow-up (Wave 10 backlog), not silently
// assumed unnecessary.
import { Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { fiscalPeriods, getDb } from "@pharmacy/db";

import type { DbOrTx } from "../db/index.js";
import { businessDateParam } from "../dates/index.js";
import { BusinessRuleException } from "../errors/index.js";

@Injectable()
export class FiscalPeriodService {
  /** Resolve the open fiscal period containing `postingDate` (a `YYYY-MM-DD` business date). */
  async resolveOpenPeriod(db: DbOrTx, tenantId: number, postingDate: string): Promise<number> {
    // `businessDateParam`, NOT a plain `new Date(...)` -- real bug, see that function's own doc
    // comment: a JS Date fed into this gte/lte range query silently rejects a postingDate equal
    // to a fiscal period's own endDate (the last calendar day of every month).
    const dateValue = businessDateParam(postingDate);
    const [period] = await db
      .select()
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.tenantId, tenantId),
          lte(fiscalPeriods.startDate, dateValue),
          gte(fiscalPeriods.endDate, dateValue),
        ),
      );
    if (!period) {
      throw new BusinessRuleException(
        "PERIOD.NOT_CONFIGURED",
        "No fiscal period",
        `No fiscal period is configured for ${postingDate}. Ask an administrator to set up the fiscal calendar.`,
      );
    }
    if (period.status !== "open") {
      throw new BusinessRuleException(
        "PERIOD.CLOSED",
        "Period closed",
        `The fiscal period ${period.periodKey} is ${period.status}; documents cannot be posted into it.`,
      );
    }
    return period.fiscalPeriodId;
  }

  // ---- admin: list/close/reopen (Wave 9, R-013) ----------------------------------------------

  /** `GET /fiscal-periods` -- every period for the tenant, oldest first (the natural order an
   *  admin closing periods month-by-month would want to see them). */
  async listForTenant(tenantId: number) {
    const db = getDb();
    return db.select().from(fiscalPeriods).where(eq(fiscalPeriods.tenantId, tenantId)).orderBy(asc(fiscalPeriods.startDate));
  }

  /** `POST /fiscal-periods/:id/close` -- 404 if the period doesn't exist or belongs to a
   *  different tenant (D16 isolation). 422 `PERIOD.ALREADY_CLOSED` if it's already `closed`;
   *  `soft_closed` periods are also rejected here (this wave doesn't implement that state's own
   *  transition semantics -- see this file's header comment) rather than silently treated as
   *  `open`. No sequencing constraint (closing March before February is allowed) -- 18-api-plan.md
   *  doesn't specify one and this task's own instruction is "close/reopen admin endpoints", not a
   *  period-close wizard. */
  async close(tenantId: number, fiscalPeriodId: number, actorId: number) {
    const period = await this.requirePeriod(tenantId, fiscalPeriodId);
    if (period.status !== "open") {
      throw new BusinessRuleException(
        "PERIOD.ALREADY_CLOSED",
        "Period not open",
        `Fiscal period ${period.periodKey} is already "${period.status}"; only an "open" period can be closed.`,
      );
    }

    const db = getDb();
    const now = new Date();
    await db.update(fiscalPeriods).set({ status: "closed", closedAt: now, closedBy: actorId, updatedBy: actorId }).where(eq(fiscalPeriods.fiscalPeriodId, fiscalPeriodId));

    const [updated] = await db.select().from(fiscalPeriods).where(eq(fiscalPeriods.fiscalPeriodId, fiscalPeriodId));
    if (!updated) throw new Error(`fiscal_period ${fiscalPeriodId} vanished immediately after its own close`); // unreachable; defensive
    return updated;
  }

  /** `POST /fiscal-periods/:id/reopen` -- 422 `PERIOD.NOT_CLOSED` if the period isn't currently
   *  `closed` (reopening an already-open period is a caller bug, not a no-op -- same "state
   *  transition, not idempotent retry" reasoning cancel/reverse actions elsewhere in this codebase
   *  already follow). Clears `closedAt`/`closedBy` back to null -- they mean "closed at/by", not
   *  "last touched at/by" (that's `updatedAt`/`updatedBy`, already tracked separately). */
  async reopen(tenantId: number, fiscalPeriodId: number, actorId: number) {
    const period = await this.requirePeriod(tenantId, fiscalPeriodId);
    if (period.status !== "closed") {
      throw new BusinessRuleException(
        "PERIOD.NOT_CLOSED",
        "Period not closed",
        `Fiscal period ${period.periodKey} is "${period.status}", not "closed"; only a closed period can be reopened.`,
      );
    }

    const db = getDb();
    await db
      .update(fiscalPeriods)
      .set({ status: "open", closedAt: null, closedBy: null, updatedBy: actorId })
      .where(eq(fiscalPeriods.fiscalPeriodId, fiscalPeriodId));

    const [updated] = await db.select().from(fiscalPeriods).where(eq(fiscalPeriods.fiscalPeriodId, fiscalPeriodId));
    if (!updated) throw new Error(`fiscal_period ${fiscalPeriodId} vanished immediately after its own reopen`); // unreachable; defensive
    return updated;
  }

  private async requirePeriod(tenantId: number, fiscalPeriodId: number) {
    const db = getDb();
    const [period] = await db.select().from(fiscalPeriods).where(and(eq(fiscalPeriods.fiscalPeriodId, fiscalPeriodId), eq(fiscalPeriods.tenantId, tenantId)));
    if (!period) {
      throw new NotFoundException(`No fiscal period ${fiscalPeriodId} for this tenant.`);
    }
    return period;
  }
}
