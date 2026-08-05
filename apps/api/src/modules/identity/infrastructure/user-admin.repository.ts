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
import { appUsers, getDb, permissions, rolePermissions, roles, userRoles } from "@pharmacy/db";

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
  readonly displayNameUr: string | null;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly isEnabled: boolean;
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
        displayNameUr: roles.displayNameUr,
        description: roles.description,
        isSystem: roles.isSystem,
        isEnabled: roles.isEnabled,
      })
      .from(roles)
      .where(and(isNull(roles.tenantId), isNull(roles.deletedAt)));
    return rows;
  }

  /** `POST /roles` -- always a platform-wide role (`tenantId` NULL, see user-admin.dto.ts's
   *  header comment on `CreateRoleSchema` for why per-tenant custom roles are a further, deferred
   *  increment). 409 `ROLE.KEY_TAKEN` on a duplicate key (checked against platform-wide roles
   *  only -- the same scope `resolveRoleIds` resolves against, so a role this endpoint creates is
   *  guaranteed immediately assignable). */
  async createRole(
    input: { key: string; name: string; nameUr?: string | undefined; description: string; clonedFromRoleKey?: string | undefined },
    actorId: number,
  ): Promise<RoleCatalogRow> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [existing] = await tx.select({ roleId: roles.roleId }).from(roles).where(and(isNull(roles.tenantId), eq(roles.roleKey, input.key)));
      if (existing) {
        throw new BusinessRuleException("ROLE.KEY_TAKEN", "Role key already used", `A role with key "${input.key}" already exists.`);
      }

      let clonedFromRoleId: number | undefined;
      if (input.clonedFromRoleKey !== undefined) {
        const [source] = await tx
          .select({ roleId: roles.roleId })
          .from(roles)
          .where(and(isNull(roles.tenantId), isNull(roles.deletedAt), eq(roles.roleKey, input.clonedFromRoleKey)));
        if (!source) {
          throw new BusinessRuleException(
            "ROLE.CLONE_SOURCE_NOT_FOUND",
            "Clone source not found",
            `Role "${input.clonedFromRoleKey}" (clonedFromRoleKey) does not exist -- cannot clone its permission grants.`,
          );
        }
        clonedFromRoleId = source.roleId;
      }

      await tx.insert(roles).values({
        tenantId: null,
        roleKey: input.key,
        displayName: input.name,
        ...(input.nameUr !== undefined && { displayNameUr: input.nameUr }),
        description: input.description,
        isSystem: false,
        isAdmin: false,
        isEnabled: true,
        createdBy: actorId,
        createdSource: "api",
      });
      const [created] = await tx.select().from(roles).where(and(isNull(roles.tenantId), eq(roles.roleKey, input.key)));
      if (!created) throw new Error("role insert did not land"); // unreachable; defensive

      if (clonedFromRoleId !== undefined) {
        const sourceGrants = await tx.select({ permissionId: rolePermissions.permissionId }).from(rolePermissions).where(eq(rolePermissions.roleId, clonedFromRoleId));
        if (sourceGrants.length > 0) {
          const now = new Date();
          await tx.insert(rolePermissions).values(sourceGrants.map((g) => ({ roleId: created.roleId, permissionId: g.permissionId, grantedAt: now, grantedBy: actorId })));
        }
      }

      return {
        roleId: created.roleId,
        roleKey: created.roleKey,
        displayName: created.displayName,
        displayNameUr: created.displayNameUr,
        description: created.description,
        isSystem: created.isSystem,
        isEnabled: created.isEnabled,
      };
    });
  }

  /** `PATCH /roles/:roleKey` -- 404 if unknown (NotFoundException, matching every other admin
   *  PATCH endpoint's convention -- fiscal-period.service.ts's `requirePeriod`,
   *  settings.service.ts's branch update). 422 `ROLE.SYSTEM_ROLE_PROTECTED` is the caller's
   *  responsibility to check BEFORE calling this (UserAdminService.updateRole) -- kept out of the
   *  repository layer so the business rule lives with the other business rules, not buried in a
   *  data-access method. */
  async updateRole(
    roleKey: string,
    input: { name?: string | undefined; nameUr?: string | null | undefined; description?: string | undefined; isEnabled?: boolean | undefined },
    actorId: number,
  ): Promise<RoleCatalogRow> {
    const db = getDb();
    await db
      .update(roles)
      .set({
        ...(input.name !== undefined && { displayName: input.name }),
        ...(input.nameUr !== undefined && { displayNameUr: input.nameUr }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.isEnabled !== undefined && { isEnabled: input.isEnabled }),
        updatedBy: actorId,
      })
      .where(and(isNull(roles.tenantId), eq(roles.roleKey, roleKey)));

    const [updated] = await db.select().from(roles).where(and(isNull(roles.tenantId), eq(roles.roleKey, roleKey)));
    if (!updated) throw new Error(`role "${roleKey}" vanished immediately after its own update`); // unreachable; defensive -- existence already checked by the caller
    return {
      roleId: updated.roleId,
      roleKey: updated.roleKey,
      displayName: updated.displayName,
      displayNameUr: updated.displayNameUr,
      description: updated.description,
      isSystem: updated.isSystem,
      isEnabled: updated.isEnabled,
    };
  }

  /** Looked up by both `UserAdminService.updateRole` (existence + `isSystem` check before the
   *  update) and indirectly mirrors what `resolveRoleIds` already resolves against. */
  async findRoleByKey(roleKey: string): Promise<{ roleId: number; isSystem: boolean } | undefined> {
    const db = getDb();
    const [row] = await db
      .select({ roleId: roles.roleId, isSystem: roles.isSystem })
      .from(roles)
      .where(and(isNull(roles.tenantId), isNull(roles.deletedAt), eq(roles.roleKey, roleKey)));
    return row;
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

  /** Resolves role keys to role ids against every platform-wide role (tenant_id NULL) -- the
   *  eight seeded system roles AND any Wave 10b admin-created custom role (`POST /roles` always
   *  creates a tenantId=NULL row, same scope, so a freshly created role is immediately
   *  assignable here with no further wiring). Throws on any key that doesn't match a row rather
   *  than silently dropping it -- a typo'd role key must fail loudly, not grant one fewer role
   *  than requested. Deliberately does NOT filter `isEnabled` -- assigning a currently-disabled
   *  role to a user is allowed (it simply grants nothing until re-enabled, same as any other
   *  disabled role a user already holds); only the real-time permission CHECK
   *  (permissions.service.ts) enforces `isEnabled`. */
  private async resolveRoleIds(tx: Tx, roleKeys: readonly RoleKey[]): Promise<number[]> {
    if (roleKeys.length === 0) return [];
    const rows = await tx.select({ roleId: roles.roleId, roleKey: roles.roleKey }).from(roles).where(isNull(roles.tenantId));
    const byKey = new Map(rows.map((r) => [r.roleKey, r.roleId]));
    return roleKeys.map((key) => {
      const roleId = byKey.get(key);
      if (roleId === undefined) {
        throw new BusinessRuleException("IDENTITY.UNKNOWN_ROLE", "Unknown role", `Role "${key}" is not a known role.`);
      }
      return roleId;
    });
  }
}
