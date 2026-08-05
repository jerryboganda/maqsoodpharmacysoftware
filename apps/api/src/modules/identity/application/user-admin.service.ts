// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Application" layer;
// 09-roles-permissions.md §I.5 ("force a password reset for all 9 users at cutover" -- the same
// must-change-password-on-creation pattern applies to every new user this endpoint creates).
import { Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";

import type { RoleKey } from "../../../common/auth/actor.js";
import { BusinessRuleException } from "../../../common/errors/index.js";
import type { AdminUserRow, PermissionCatalogRow, RoleCatalogRow } from "../infrastructure/user-admin.repository.js";
import { UserAdminRepository } from "../infrastructure/user-admin.repository.js";

export interface CreateUserResult extends AdminUserRow {
  /** Shown to the caller exactly once -- never persisted, never logged. */
  readonly temporaryPassword: string;
}

/** 20 random bytes -> base64url (~27 chars, no padding): well past the 12-char §I.5 floor,
 *  URL-safe so it round-trips cleanly through a JSON response body. */
function generateTemporaryPassword(): string {
  return randomBytes(20).toString("base64url");
}

@Injectable()
export class UserAdminService {
  constructor(private readonly users: UserAdminRepository) {}

  async listUsers(): Promise<AdminUserRow[]> {
    return this.users.listUsers();
  }

  async createUser(input: { username: string; displayName: string; roles: readonly RoleKey[] }, actorUserId: number): Promise<CreateUserResult> {
    if (await this.users.isUsernameTaken(input.username)) {
      throw new BusinessRuleException(
        "IDENTITY.USERNAME_TAKEN",
        "Username already used",
        `A user with username "${input.username}" already exists.`,
      );
    }

    const { tenantId, defaultBranchId } = await this.users.resolveActorTenancy(actorUserId);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await argon2.hash(temporaryPassword, { type: argon2.argon2id });

    const created = await this.users.createUser({
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      tenantId,
      defaultBranchId,
      roles: input.roles,
      createdBy: actorUserId,
    });

    return { ...created, temporaryPassword };
  }

  async setActive(userId: number, isActive: boolean, actorUserId: number): Promise<void> {
    await this.users.setActive(userId, isActive, actorUserId);
  }

  async replaceRoles(userId: number, roles: readonly RoleKey[], actorUserId: number): Promise<RoleKey[]> {
    return this.users.replaceRoles(userId, roles, actorUserId);
  }

  async listRoles(): Promise<RoleCatalogRow[]> {
    return this.users.listRoleCatalog();
  }

  /** `POST /roles`. See user-admin.repository.ts's `createRole` for the uniqueness/clone rules. */
  async createRole(
    input: { key: string; name: string; nameUr?: string | undefined; description: string; clonedFromRoleKey?: string | undefined },
    actorId: number,
  ): Promise<RoleCatalogRow> {
    return this.users.createRole(input, actorId);
  }

  /** `PATCH /roles/:roleKey`. The one business rule that lives here rather than the repository
   *  (see that method's own doc comment on why): `isEnabled: false` on an `isSystem` role is
   *  rejected -- 422 `ROLE.SYSTEM_ROLE_PROTECTED`, the exact "disable is the delete-equivalent,
   *  system rows are exempt" rule settings.service.ts's `updateOptionItem` already establishes
   *  for `option_item`. */
  async updateRole(
    roleKey: string,
    input: { name?: string | undefined; nameUr?: string | null | undefined; description?: string | undefined; isEnabled?: boolean | undefined },
    actorId: number,
  ): Promise<RoleCatalogRow> {
    const existing = await this.users.findRoleByKey(roleKey);
    if (!existing) throw new NotFoundException(`No role "${roleKey}".`);

    if (input.isEnabled === false && existing.isSystem) {
      throw new BusinessRuleException(
        "ROLE.SYSTEM_ROLE_PROTECTED",
        "System role cannot be disabled",
        `Role "${roleKey}" is one of the eight seeded system roles the application depends on and cannot be disabled. It may still be renamed or redescribed.`,
      );
    }

    return this.users.updateRole(roleKey, input, actorId);
  }

  // ---- Wave 10e: role_scope / role_limit (R-007 CRITICAL) ----------------------------------

  async getRoleScopes(roleKey: string) {
    return this.users.getRoleScopes(roleKey);
  }

  async putRoleScopes(roleKey: string, scopes: ReadonlyArray<{ scopeType: string; scopeValues: readonly number[] }>, actorId: number) {
    return this.users.putRoleScopes(roleKey, scopes, actorId);
  }

  async getRoleLimits(roleKey: string) {
    return this.users.getRoleLimits(roleKey);
  }

  async putRoleLimits(roleKey: string, limits: ReadonlyArray<{ limitKey: string; limitValue: string }>, actorId: number) {
    return this.users.putRoleLimits(roleKey, limits, actorId);
  }

  async listPermissions(): Promise<PermissionCatalogRow[]> {
    return this.users.listPermissionCatalog();
  }
}
