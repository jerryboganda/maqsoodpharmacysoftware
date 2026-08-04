// Thin controller (§2.2). GET /dashboards/summary -- the one real aggregate call the dashboard
// frontend page uses instead of composing money totals client-side (Rule M).
import { Controller, Get } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { DashboardService } from "../application/dashboard.service.js";

@Controller("dashboards")
export class DashboardsController {
  constructor(private readonly dashboardService: DashboardService) {}

  @RequirePermission("dashboard", "view_dashboard")
  @Get("summary")
  async summary(@CurrentActor() actor: Actor) {
    return this.dashboardService.summary(actor);
  }
}
