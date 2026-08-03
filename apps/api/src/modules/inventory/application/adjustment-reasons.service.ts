// Read-only lookup so /stock-adjustments create forms have real, admin-curated reason choices
// instead of hardcoded ids (adjustment_reason, §T63 -- see stock-adjustment.service.ts for how
// requiresApproval/glAccountId on these rows drive the posting flow).
import { Injectable } from "@nestjs/common";
import { and, asc, eq, or } from "drizzle-orm";
import { adjustmentReasons, getDb } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { TenantContextService } from "../infrastructure/tenant-context.service.js";

@Injectable()
export class AdjustmentReasonsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(params: { direction?: "increase" | "decrease" | "both" | undefined }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(adjustmentReasons.tenantId, tenantId), eq(adjustmentReasons.isEnabled, true)];
    if (params.direction !== undefined) {
      conditions.push(or(eq(adjustmentReasons.direction, params.direction), eq(adjustmentReasons.direction, "both"))!);
    }
    const rows = await db
      .select({
        adjustmentReasonId: adjustmentReasons.adjustmentReasonId,
        code: adjustmentReasons.code,
        name: adjustmentReasons.name,
        description: adjustmentReasons.description,
        direction: adjustmentReasons.direction,
        isDefault: adjustmentReasons.isDefault,
        requiresApproval: adjustmentReasons.requiresApproval,
        requiresNote: adjustmentReasons.requiresNote,
        sortOrder: adjustmentReasons.sortOrder,
      })
      .from(adjustmentReasons)
      .where(and(...conditions))
      .orderBy(asc(adjustmentReasons.sortOrder));
    return { adjustmentReasons: rows };
  }
}
