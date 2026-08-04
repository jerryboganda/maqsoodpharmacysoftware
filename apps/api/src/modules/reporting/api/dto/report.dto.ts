// Blueprint: docs/system-analysis/18-api-plan.md's reporting module row (GET /reports,
// POST /reports/{id}/run). Wire-level shape only, per 17-technical-blueprint.md §9.3 layer 1 --
// each report interprets its own `filters` object, so this DTO deliberately validates only the
// generic envelope (an object bag + offset/limit); the per-report filter shape is validated
// service-side (application/report-filters.ts) because a single Zod schema can't discriminate on
// `reportId` cleanly against a wire type this loose (nestjs-zod's `createZodDto` needs a concrete
// object schema, not a lookup keyed by a path param that isn't known until routing has already
// happened).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const ReportIdParamSchema = z.object({ reportId: z.string().min(1).max(64) });
export class ReportIdParamDto extends createZodDto(ReportIdParamSchema) {}

/**
 * POST /reports/{reportId}/run body. `filters` is an open bag on the wire (Rule M still applies
 * inside it -- money/qty filter values are decimal STRINGS, never numbers, enforced by each
 * report's own Zod schema in report-filters.ts). `offset`/`limit` are plain JSON numbers here
 * (not the `zIntString` query-param pattern used elsewhere) because this is a JSON POST body, not
 * a query string -- there is no wire-format reason to route pagination through a string.
 */
export const RunReportBodySchema = z.object({
  filters: z.record(z.string(), z.unknown()).default({}),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
export class RunReportBodyDto extends createZodDto(RunReportBodySchema) {}
export type RunReportBodyInput = z.infer<typeof RunReportBodySchema>;
