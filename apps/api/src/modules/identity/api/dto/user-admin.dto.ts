// Blueprint: docs/system-analysis/17-technical-blueprint.md §4.3 "Zod as the single validation
// source"; 09-roles-permissions.md §I.2/§I.3 (role catalogue), §I.6 (migration/admin plan).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

import { ROLE_KEYS, type RoleKey } from "../../../../common/auth/actor.js";

// Cast to a `RoleKey` (not `string`) tuple so `z.enum(...)`'s inferred TS type stays the literal
// union -- CreateUserDto.roles/ReplaceUserRolesDto.roles feed straight into
// UserAdminService methods typed `readonly RoleKey[]`, so a widened-to-`string` inference here
// would fail to typecheck at every call site.
const ROLE_KEY_TUPLE = [...ROLE_KEYS] as [RoleKey, ...RoleKey[]];

export const UserIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export class UserIdParamDto extends createZodDto(UserIdParamSchema) {}

export const AdminUserResponseSchema = z.object({
  userId: z.string(),
  username: z.string(),
  displayName: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  roles: z.array(z.enum(ROLE_KEY_TUPLE)),
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
  roles: z.array(z.enum(ROLE_KEY_TUPLE)).min(1),
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
  roles: z.array(z.enum(ROLE_KEY_TUPLE)).min(1),
});
export class ReplaceUserRolesDto extends createZodDto(ReplaceUserRolesSchema) {}

export const RoleResponseSchema = z.object({
  roleId: z.number().int(),
  roleKey: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
});
export class RoleResponseDto extends createZodDto(RoleResponseSchema) {}

export const PermissionResponseSchema = z.object({
  permissionId: z.number().int(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  permissionKind: z.string(),
  isSensitive: z.boolean(),
});
export class PermissionResponseDto extends createZodDto(PermissionResponseSchema) {}
