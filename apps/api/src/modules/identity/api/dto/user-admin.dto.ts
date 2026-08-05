// Blueprint: docs/system-analysis/17-technical-blueprint.md §4.3 "Zod as the single validation
// source"; 09-roles-permissions.md §I.2/§I.3 (role catalogue), §I.6 (migration/admin plan).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

// Wave 10b: role-ASSIGNMENT input (`CreateUserSchema.roles`, `ReplaceUserRolesSchema.roles`) is
// no longer restricted to the eight seeded keys via `z.enum` -- since `POST /roles` (this file's
// own `CreateRoleSchema` below) can mint new ones, a closed enum here would make a freshly
// created custom role permanently unassignable. `ROLE_KEY_REGEX` still validates SHAPE (matches
// `CreateRoleSchema.key`'s own rule); real EXISTENCE validation happens where it always has --
// `UserAdminRepository.resolveRoleIds` throws `IDENTITY.UNKNOWN_ROLE` on any key that isn't an
// actual row, loudly, never silently dropped.
const ROLE_KEY_REGEX = /^[a-z_]{3,32}$/;
const RoleKeySchema = z.string().regex(ROLE_KEY_REGEX, "role key must be 3-32 lowercase letters/underscores");

export const UserIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export class UserIdParamDto extends createZodDto(UserIdParamSchema) {}

export const AdminUserResponseSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  roles: z.array(z.string()),
});
export class AdminUserResponseDto extends createZodDto(AdminUserResponseSchema) {}

export const CreateUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, "username may only contain letters, numbers, dot, underscore and hyphen"),
  displayName: z.string().min(1).max(120),
  // At least one role -- an admin-created user with zero roles could be created but could never
  // reach ANY permission-gated route, including the self-service ones (identity.credential:edit,
  // identity.session:delete) -- an unusable, effectively locked account by construction.
  roles: z.array(RoleKeySchema).min(1),
});
export class CreateUserDto extends createZodDto(CreateUserSchema) {}

export const CreateUserResponseSchema = AdminUserResponseSchema.extend({
  /** Shown exactly once, here. `mustChangePassword` is always `true` on the created user. */
  temporaryPassword: z.string(),
});
export class CreateUserResponseDto extends createZodDto(CreateUserResponseSchema) {}

export const PatchUserSchema = z.object({
  /** Deactivate/reactivate (there is no other mutable field on this endpoint yet). */
  isActive: z.boolean(),
});
export class PatchUserDto extends createZodDto(PatchUserSchema) {}

export const ReplaceUserRolesSchema = z.object({
  // Same "never leave a user with zero reachable permissions" reasoning as CreateUserSchema.
  roles: z.array(RoleKeySchema).min(1),
});
export class ReplaceUserRolesDto extends createZodDto(ReplaceUserRolesSchema) {}

export const RoleResponseSchema = z.object({
  roleId: z.number().int(),
  roleKey: z.string(),
  displayName: z.string(),
  displayNameUr: z.string().nullable(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  isEnabled: z.boolean(),
});
export class RoleResponseDto extends createZodDto(RoleResponseSchema) {}

// ---- Wave 10b: POST/PATCH /roles (18-api-plan.md §0.3) -----------------------------------------
//
// Always creates/edits a PLATFORM-WIDE role (`tenantId` NULL) -- the same kind the eight seeded
// system roles already are. A FURTHER increment (a tenant admin defining a role visible only to
// their own tenant, `tenantId` set -- access.ts `roles`' own header comment already anticipates
// this) is deliberately out of scope here: `Actor`/`TenantContextService` have no per-request
// "acting tenant" concept threaded through the permission-check path yet (permissions.service.ts
// today matches `isNull(roles.tenantId)` unconditionally), and building that properly is exactly
// the kind of "deserves its own dedicated wave" item this project's Wave 10 backlog reasoning
// (task #39/#40's own framing) already applies elsewhere -- not silently dropped, just not
// bundled into this endpoint's first cut.
export const CreateRoleSchema = z.object({
  key: RoleKeySchema,
  name: z.string().min(1).max(120),
  nameUr: z.string().min(1).max(120).optional(),
  // R1.10's plain-language-description rule (already applied to settings.branch/platform.
  // feature_capability elsewhere in this codebase) -- mandatory, not optional.
  description: z.string().min(1).max(255),
  /** If given, copy the source role's CURRENT `role_permission` grants onto the new role (a
   *  starting point, not a live link -- editing one afterward never affects the other). */
  clonedFromRoleKey: z.string().min(1).max(64).optional(),
});
export class CreateRoleDto extends createZodDto(CreateRoleSchema) {}

export const RoleKeyParamSchema = z.object({ roleKey: z.string().min(1).max(64) });
export class RoleKeyParamDto extends createZodDto(RoleKeyParamSchema) {}

export const UpdateRoleSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    nameUr: z.string().min(1).max(120).nullable().optional(),
    description: z.string().min(1).max(255).optional(),
    /** `false` on an `isSystem` role is rejected -- 422 `ROLE.SYSTEM_ROLE_PROTECTED`, same
     *  "isEnabled is the real delete-equivalent, system rows are exempt" rule
     *  settings.service.ts's `updateOptionItem` already establishes for option_item. */
    isEnabled: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.nameUr !== undefined || v.description !== undefined || v.isEnabled !== undefined, {
    message: "at least one field (name, nameUr, description, isEnabled) must be provided",
  });
export class UpdateRoleDto extends createZodDto(UpdateRoleSchema) {}

// ---- Wave 10e: GET/PUT /roles/:roleKey/scopes and /limits (R-007 CRITICAL) --------------------

const SCOPE_TYPES = ["warehouse", "cash_bank_account", "price_type", "supplier_category", "voucher_category"] as const;
export const RoleScopeEntrySchema = z.object({
  scopeType: z.enum(SCOPE_TYPES),
  scopeValues: z.array(z.number().int().positive()),
});
export const RoleScopeResponseSchema = z.array(RoleScopeEntrySchema);
export class RoleScopeResponseDto extends createZodDto(RoleScopeResponseSchema) {}

export const PutRoleScopesSchema = z.object({ scopes: z.array(RoleScopeEntrySchema) });
export class PutRoleScopesDto extends createZodDto(PutRoleScopesSchema) {}

// 18-api-plan.md §0.13.3's own five limit keys. A closed enum here (not a free string) --
// role-limit.service.ts is the one place that actually EVALUATES a limitKey against a real
// attempted value, and it can only evaluate keys it has real code for; accepting an arbitrary
// string here would let an admin "set" a limit that silently never does anything, which is worse
// than rejecting it at the DTO boundary.
export const LIMIT_KEYS = ["max_txn_value", "max_qty", "max_line_disc_pct", "max_inv_flat_disc", "max_price_delta_pct"] as const;
export const RoleLimitEntrySchema = z.object({
  limitKey: z.enum(LIMIT_KEYS),
  limitValue: z.string().regex(/^\d+(\.\d{1,4})?$/, "limitValue must be a non-negative decimal string"),
});
export const RoleLimitResponseSchema = z.array(RoleLimitEntrySchema);
export class RoleLimitResponseDto extends createZodDto(RoleLimitResponseSchema) {}

export const PutRoleLimitsSchema = z.object({ limits: z.array(RoleLimitEntrySchema) });
export class PutRoleLimitsDto extends createZodDto(PutRoleLimitsSchema) {}

export type PutRoleScopesInput = z.infer<typeof PutRoleScopesSchema>;
export type PutRoleLimitsInput = z.infer<typeof PutRoleLimitsSchema>;

export const PermissionResponseSchema = z.object({
  permissionId: z.number().int(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  permissionKind: z.string(),
  isSensitive: z.boolean(),
});
export class PermissionResponseDto extends createZodDto(PermissionResponseSchema) {}
