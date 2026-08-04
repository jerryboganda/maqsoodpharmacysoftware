// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Infrastructure" layer;
// 09-roles-permissions.md §I.2 (`app_user`, `role`, `permission`, `user_role`), §I.6 step 4
// ("re-derive the four groups as eight roles ... have the owner sign it").
//
// Backs the owner/sys_admin-only user/role administration endpoints (`UsersController`,
// `RolesController`, `PermissionsController`) -- the minimal admin surface the real RBAC system
// needs to be usable by a human instead of only enforced. Separate from
// `user.repository.ts` (that one is the public, credential-free `User` shape other modules read);
// this repository owns the admin-facing CRUD and is never exported past `modules/identity`.
import { Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { appUsers, getDb, permissions, roles, userRoles } from "@pharmacy/db";

import type { RoleKey } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { BusinessRuleException } from "../../../common/errors/index.js";

export interface AdminUserRow {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly isActive: boolean;
  readonly mustChangePassword: boolean;
  readonly roles: RoleKey[];
}

export interface RoleCatalogRow {
  readonly roleId: number;
  readonly roleKey: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly isSystem: boolean;
}

export interface PermissionCatalogRow {
  readonly permissionId: number;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly permissionKind: string;
  readonly isSensitive: boolean;
}

@Injectable()
export class UserAdminRepository {
  /**
   * Phase 1 has exactly one tenant in practice (options.repository.ts's header comment makes the
   * same call for the same reason) and this endpoint is owner/sys_admin-only already, so listing
   * every non-deleted user platform-wide -- rather than filtering by the caller's own tenant -- is
   * the correct behaviour today. TODO(multi-tenant): scope this to the caller's tenant (D21: a
   * NULL-tenant caller is the platform-level owner and legitimately sees every tenant; a
   * tenant-scoped caller should not) once more than one tenant exists to make the distinction
   * observable.
   */
  async listUsers(): Promise<AdminUserRow[]> {
    const db = getDb();
    const userRows = await db
      .select({
        userId: appUsers.userId,
        username: appUsers.username,
        displayName: appUsers.displayName,
        isActive: appUsers.isActive,
        mustChangePassword: appUsers.mustChangePassword,
      })
      .from(appUsers)
      .where(isNull(appUsers.deletedAt));

    const roleRows = await db
      .select({ userId: userRoles.userId, roleKey: roles.roleKey })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.roleId));
    const rolesByUser = new Map<number, RoleKey[]>();
    for (const row of roleRows) {
      const list = rolesByUser.get(row.userId) ?? [];
      list.push(row.roleKey as RoleKey);
      rolesByUser.set(row.userId, list);
    }

    return userRows.map((row) => ({
      userId: String(row.userId),
      username: row.username,
      displayName: row.displayName,
      isActive: row.isActive,
      mustChangePassword: row.mustChangePassword,
      roles: rolesByUser.get(row.userId) ?? [],
    }));
  }

  /** The creating actor's own tenant/branch -- new staff accounts are provisioned into the
   *  admin's own tenant (D21: staff are per-tenant). */
  async resolveActorTenancy(actorUserId: number): Promise<{ tenantId: number | null; defaultBranchId: number | null }> {
    const db = getDb();
    const [row] = await db
      .select({ tenantId: appUsers.tenantId, defaultBranchId: appUsers.defaultBranchId })
      .from(appUsers)
      .where(eq(appUsers.userId, actorUserId));
    if (!row) {
      throw new BusinessRuleException("IDENTITY.ACTOR_UNRESOLVED", "Unknown actor", "The current actor has no usable user id.");
    }
    return row;
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    const db = getDb();
    const [row] = await db.select({ userId: appUsers.userId }).from(appUsers).where(eq(appUsers.username, username));
    return row !== undefined;
  }

  async createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    tenantId: number | null;
    defaultBranchId: number | null;
    roles: readonly RoleKey[];
    createdBy: number;
  }): Promise<AdminUserRow> {
    const db = getDb();
    return db.transaction(async (tx) => {
      await tx.insert(appUsers).values({
        tenantId: input.tenantId,
        defaultBranchId: input.defaultBranchId,
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        passwordAlgo: "argon2id",
        mustChangePassword: true,
        createdBy: input.createdBy,
        createdSource: "api",
      });
      const [created] = await tx.select().from(appUsers).where(eq(appUsers.username, input.username));
      if (!created) throw new Error("app_user insert did not land"); // unreachable; defensive

      const roleIds = await this.resolveRoleIds(tx, input.roles);
      if (roleIds.length > 0) {
        const now = new Date();
        await tx.insert(userRoles).values(
          roleIds.map((roleId) => ({ userId: created.userId, roleId, assignedAt: now, assignedBy: input.createdBy })),
        );
      }

      return {
        userId: String(created.userId),
        username: created.username,
        displayName: created.displayName,
        isActive: created.isActive,
        mustChangePassword: created.mustChangePassword,
        roles: [...input.roles],
      };
    });
  }

  async setActive(userId: number, isActive: boolean, updatedBy: number): Promise<void> {
    const db = getDb();
    const result = await db.select({ userId: appUsers.userId }).from(appUsers).where(eq(appUsers.userId, userId));
    if (result.length === 0) {
      throw new BusinessRuleException("IDENTITY.USER_NOT_FOUND", "User not found", `No user with id ${userId} exists.`);
    }
    await db.update(appUsers).set({ isActive, updatedBy }).where(eq(appUsers.userId, userId));
  }

  /** Replaces the user's ENTIRE role assignment (PUT semantics -- 09 §I.1 principle 5's
   *  union-of-grants still applies across whatever roles remain after the replace). */
  async replaceRoles(userId: number, roleKeys: readonly RoleKey[], assignedBy: number): Promise<RoleKey[]> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [user] = await tx.select({ userId: appUsers.userId }).from(appUsers).where(eq(appUsers.userId, userId));
      if (!user) {
        throw new BusinessRuleException("IDENTITY.USER_NOT_FOUND", "User not found", `No user with id ${userId} exists.`);
      }

      await tx.delete(userRoles).where(eq(userRoles.userId, userId));

      const roleIds = await this.resolveRoleIds(tx, roleKeys);
      if (roleIds.length > 0) {
        const now = new Date();
        await tx.insert(userRoles).values(roleIds.map((roleId) => ({ userId, roleId, assignedAt: now, assignedBy })));
      }
      return [...roleKeys];
    });
  }

  async listRoleCatalog(): Promise<RoleCatalogRow[]> {
    const db = getDb();
    const rows = await db
      .select({
        roleId: roles.roleId,
        roleKey: roles.roleKey,
        displayName: roles.displayName,
        description: roles.description,
        isSystem: roles.isSystem,
      })
      .from(roles)
      .where(and(isNull(roles.tenantId), isNull(roles.deletedAt)));
    return rows;
  }

  async listPermissionCatalog(): Promise<PermissionCatalogRow[]> {
    const db = getDb();
    const rows = await db
      .select({
        permissionId: permissions.permissionId,
        code: permissions.code,
        name: permissions.name,
        description: permissions.description,
        permissionKind: permissions.permissionKind,
        isSensitive: permissions.isSensitive,
      })
      .from(permissions)
      .where(isNull(permissions.deletedAt));
    return rows;
  }

  /** Resolves role keys to role ids against the seeded system-role catalogue (tenant_id NULL --
   *  the only kind `RoleKey` can represent today, same reasoning as permissions.service.ts's
   *  header comment). Throws on any key that isn't a known system role rather than silently
   *  dropping it -- a typo'd role key must fail loudly, not grant one fewer role than requested. */
  private async resolveRoleIds(tx: Tx, roleKeys: readonly RoleKey[]): Promise<number[]> {
    if (roleKeys.length === 0) return [];
    const rows = await tx.select({ roleId: roles.roleId, roleKey: roles.roleKey }).from(roles).where(isNull(roles.tenantId));
    const byKey = new Map(rows.map((r) => [r.roleKey, r.roleId]));
    return roleKeys.map((key) => {
      const roleId = byKey.get(key);
      if (roleId === undefined) {
        throw new BusinessRuleException("IDENTITY.UNKNOWN_ROLE", "Unknown role", `Role "${key}" is not a known system role.`);
      }
      return roleId;
    });
  }
}
