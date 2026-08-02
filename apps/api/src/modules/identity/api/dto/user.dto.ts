// Blueprint: docs/system-analysis/17-technical-blueprint.md §4.3 "Zod as the single
// validation source"; §9.3 layer 1 (Edge). This module's DTOs -- consumed by nestjs-zod for
// OpenAPI generation and, on the frontend, by React Hook Form's zod resolver (§8.5) once
// `packages/contracts` exists to share them. No money/quantity fields here, so no
// `z.string().regex(DECIMAL_RE)` is needed -- see common/validation/money-schemas.ts for the
// pattern once this module gains one.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { ROLE_KEYS } from "../../../../common/auth/actor.js";

const ROLE_KEY_TUPLE = [...ROLE_KEYS] as [string, ...string[]];

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("identity"),
  time: z.string(),
});
export class HealthResponseDto extends createZodDto(HealthResponseSchema) {}

export const UserResponseSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  roles: z.array(z.enum(ROLE_KEY_TUPLE)),
  isActive: z.boolean(),
});
export class UserResponseDto extends createZodDto(UserResponseSchema) {}
