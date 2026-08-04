// Thin controller (§2.2), mirroring expenses.controller.ts's shape. GET /reports is the static
// registry; POST /reports/{reportId}/run dispatches to ReportsService's per-report handler. No
// @RequireIdempotencyKey on either -- both are pure reads, never a write (task instruction: "must
// not open a write transaction").
import { Body, Controller, Get, Param, Post } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { ReportsService } from "../application/reports.service.js";
import { REPORT_DEFINITIONS } from "../application/report-registry.js";
import { ReportIdParamDto, RunReportBodyDto } from "./dto/report.dto.js";

@Controller()
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /** GET /reports -- the report registry. Permission-filtering simplification: see
   *  report-registry.ts's header comment for why this returns the full list to any caller who
   *  already cleared the route guard rather than filtering per-report. */
  @RequirePermission("report", "list")
  @Get("reports")
  list() {
    return { data: REPORT_DEFINITIONS };
  }

  @RequirePermission("report", "view")
  @Post("reports/:reportId/run")
  async run(@Param() params: ReportIdParamDto, @Body() body: RunReportBodyDto, @CurrentActor() actor: Actor) {
    return this.reportsService.run(params.reportId, body, actor);
  }
}
