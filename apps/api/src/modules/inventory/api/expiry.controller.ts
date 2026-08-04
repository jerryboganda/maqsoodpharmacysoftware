// R4.2 expiry dashboard (post-audit addition). 18-api-plan.md §2.5 documents this feature as
// `GET /api/v1/expiry/dashboard` with a richer contract (30/60/90/180-day bucket arrays,
// cost/retail value, topItems, CSV export). This task's explicit instruction scoped it down to a
// plain READ/reporting endpoint at `GET /inventory/expiry-dashboard` with no GL/value fields --
// implemented verbatim per that instruction; see StockQueryService.expiryDashboard's header
// comment for the full reconciliation note on the response-shape choice.
import { Controller, Get, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { StockQueryService } from "../application/stock-query.service.js";
import { TenantContextService } from "../infrastructure/tenant-context.service.js";
import { ExpiryDashboardQueryDto } from "./dto/stock.dto.js";

@Controller("inventory")
export class ExpiryController {
  constructor(
    private readonly stockQueries: StockQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** GET /inventory/expiry-dashboard -- lots with stock on hand expiring within 90 days. */
  @RequirePermission("inventory.expiry", "view_dashboard")
  @Get("expiry-dashboard")
  async expiryDashboard(@Query() query: ExpiryDashboardQueryDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockQueries.expiryDashboard(scope, query);
  }
}
