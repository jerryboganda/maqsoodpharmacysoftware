// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.8 period control -- every DOC
// header carries fiscal_period_id; posting resolves the period from posting_date and rejects
// `422 PERIOD.CLOSED` unless the period is open. (soft_closed + break-glass is deferred with
// real RBAC.)
import { Injectable } from "@nestjs/common";
import { and, eq, gte, lte } from "drizzle-orm";
import { fiscalPeriods } from "@pharmacy/db";

import type { DbOrTx } from "../db/index.js";
import { BusinessRuleException } from "../errors/index.js";

@Injectable()
export class FiscalPeriodService {
  /** Resolve the open fiscal period containing `postingDate` (a `YYYY-MM-DD` business date). */
  async resolveOpenPeriod(db: DbOrTx, tenantId: number, postingDate: string): Promise<number> {
    // Drizzle date() columns are JS-Date-mode; the API's business dates are `YYYY-MM-DD`
    // strings (§3.6 -- Asia/Karachi local dates). Convert at the boundary only.
    const dateValue = new Date(`${postingDate}T00:00:00`);
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
}
