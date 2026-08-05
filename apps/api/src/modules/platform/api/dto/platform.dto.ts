// Blueprint: docs/system-analysis/18-api-plan.md §1.3 "Module `platform`" (health/ready) and
// §1.4 (D1 feature-capabilities register). Zod as the single validation source, same convention
// as every other module's DTO file (identity/api/dto/user-admin.dto.ts).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
});
export class HealthResponseDto extends createZodDto(HealthResponseSchema) {}

export const ReadyResponseSchema = z.object({
  db: z.boolean(),
  migrations: z.boolean(),
  requiredBindingsSatisfied: z.boolean(),
  // FBR integration does not exist in this codebase (task #28 -- fiscalization is blocked
  // pending owner/tax-adviser input, 12-risks-gaps.md U-060). Always `false`, never a guess.
  fbrReachable: z.boolean(),
});
export class ReadyResponseDto extends createZodDto(ReadyResponseSchema) {}

const FEATURE_CAPABILITY_STATUSES = ["in_scope", "deferred", "excluded", "replaced"] as const;

export const FeatureCapabilityResponseSchema = z.object({
  code: z.string(),
  name: z.string(),
  module: z.string().nullable(),
  status: z.enum(FEATURE_CAPABILITY_STATUSES),
  legacyTableCount: z.number().int().nullable(),
  legacyEvidence: z.string().nullable(),
  decisionRef: z.string().nullable(),
  decidedOn: z.string().nullable(), // YYYY-MM-DD; date-mode column shaped per settings.service.ts's toDateOnlyOrNull convention
  rationale: z.string().nullable(),
});
export class FeatureCapabilityResponseDto extends createZodDto(FeatureCapabilityResponseSchema) {}

export const FeatureCapabilityCodeParamSchema = z.object({ code: z.string().min(1).max(64) });
export class FeatureCapabilityCodeParamDto extends createZodDto(FeatureCapabilityCodeParamSchema) {}

/** `PATCH /admin/feature-capabilities/:code` -- "Record an owner decision on a deferred
 *  vertical" (18-api-plan.md §1.4). `rationale >= 20 chars` is the doc's own explicit rule, same
 *  spirit as `roles.dto.ts`'s (Wave 10b) plain-language-description requirement. */
export const UpdateFeatureCapabilitySchema = z.object({
  status: z.enum(FEATURE_CAPABILITY_STATUSES),
  rationale: z.string().min(20, "rationale must be at least 20 characters -- a one-word status flip is not an audit trail"),
});
export class UpdateFeatureCapabilityDto extends createZodDto(UpdateFeatureCapabilitySchema) {}
