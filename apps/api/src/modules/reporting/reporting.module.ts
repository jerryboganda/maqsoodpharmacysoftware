// Blueprint: docs/system-analysis/18-api-plan.md's reporting module row. Owns the reporting
// registry (GET /reports), the report-run dispatcher (POST /reports/{id}/run), the dashboard
// summary aggregate (GET /dashboards/summary), and the metric-definitions catalogue
// (GET /metrics/definitions).
//
// TenantContextService has no constructor dependencies of its own (a dev-mode tenancy stub, see
// its own header comment) and InventoryModule does not export it, so -- mirroring accounting.
// module.ts's/purchasing.module.ts's identical reasoning -- it is provided directly here rather
// than importing the whole InventoryModule for a service this module does not otherwise need
// anything else from.
import { Module } from "@nestjs/common";

import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { DashboardsController } from "./api/dashboards.controller.js";
import { MetricsController } from "./api/metrics.controller.js";
import { ReportsController } from "./api/reports.controller.js";
import { DashboardService } from "./application/dashboard.service.js";
import { ReportsService } from "./application/reports.service.js";

@Module({
  controllers: [ReportsController, DashboardsController, MetricsController],
  providers: [ReportsService, DashboardService, TenantContextService],
  exports: [ReportsService, DashboardService],
})
export class ReportingModule {}
