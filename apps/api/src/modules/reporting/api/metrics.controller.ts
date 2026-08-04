// GET /metrics/definitions -- a small static catalogue (metric-definitions.ts); no service layer
// needed for a static array (would be over-engineering for ~8 fixed rows -- task's own "low
// effort, real value" instruction).
//
// Permission (judgement call, documented): there is no dedicated "metrics" resource key seeded
// (permissions.ts's RESOURCE_KEYS has no `metrics` entry, and this task's scope forbids adding
// one -- YOUR SCOPE said not to touch permissions.ts/seed.ts). Metric definitions are read-only
// metadata that explains the reports built in this same module, so this endpoint is gated behind
// the least-privileged report permission ("report:list", already granted to 7 of 8 roles) rather
// than left unguarded or piggy-backed on a resource it isn't part of.
import { Controller, Get } from "@nestjs/common";

import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { METRIC_DEFINITIONS } from "../application/metric-definitions.js";

@Controller("metrics")
export class MetricsController {
  @RequirePermission("report", "list")
  @Get("definitions")
  list() {
    return { data: METRIC_DEFINITIONS };
  }
}
