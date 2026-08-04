// The public surface of `reporting` (§3.1, B4). Mirrors accounting/index.ts's convention.
export { ReportingModule } from "./reporting.module.js";
export { ReportsService } from "./application/reports.service.js";
export { DashboardService } from "./application/dashboard.service.js";
export type { ReportDefinition } from "./application/report-registry.js";
export { REPORT_DEFINITIONS } from "./application/report-registry.js";
export type { MetricDefinition } from "./application/metric-definitions.js";
export { METRIC_DEFINITIONS } from "./application/metric-definitions.js";
