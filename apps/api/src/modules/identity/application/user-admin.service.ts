// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Application" layer;
// 09-roles-permissions.md §I.5 ("force a password reset for all 9 users at cutover" -- the same
// must-change-password-on-creation pattern applies to every new user this endpoint creates).
import { Injectable } from "@nestjs/common";
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

  async listPermissions(): Promise<PermissionCatalogRow[]> {
    return this.users.listPermissionCatalog();
  }
}
