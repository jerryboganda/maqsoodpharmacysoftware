// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Infrastructure" layer;
// 09-roles-permissions.md §I.2 `app_user`, §I.5 (lockout policy).
//
// Reads/writes the credential-related columns of `app_user` (password hash, lockout counters,
// must-change-password flag) and resolves a user's roles. Deliberately separate from
// `modules/identity/infrastructure/user.repository.ts` (that repository's `User` domain shape is
// the public, credential-free view of a user other modules are allowed to see; this repository
// exists only for `auth`'s own login/logout/password-change use cases and is never exported past
// `modules/auth`).
import { Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { appUsers, getDb, roles, userRoles } from "@pharmacy/db";

import type { RoleKey } from "../../../common/auth/actor.js";

export interface UserCredentialsRow {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly isActive: boolean;
  readonly mustChangePassword: boolean;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly tenantId: number | null;
  readonly defaultBranchId: number | null;
}

@Injectable()
export class CredentialsRepository {
  async findByUsername(username: string): Promise<UserCredentialsRow | null> {
    const db = getDb();
    const [row] = await db.select().from(appUsers).where(and(eq(appUsers.username, username), isNull(appUsers.deletedAt)));
    return row ? toRow(row) : null;
  }

  async findById(userId: number): Promise<UserCredentialsRow | null> {
    const db = getDb();
    const [row] = await db.select().from(appUsers).where(and(eq(appUsers.userId, userId), isNull(appUsers.deletedAt)));
    return row ? toRow(row) : null;
  }

  /** Union-of-grants role set for this user (09 §I.1 principle 5) -- the exact same
   *  tenant-scoping shape as `session.repository.ts`'s `findActiveByTokenHash` and
   *  `modules/identity`'s `UserRepository.findById`. */
  async listRoles(userId: number, userTenantId: number | null): Promise<RoleKey[]> {
    const db = getDb();
    const tenantScope =
      userTenantId === null ? isNull(roles.tenantId) : or(isNull(roles.tenantId), eq(roles.tenantId, userTenantId));
    const rows = await db
      .select({ roleKey: roles.roleKey })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
      .where(and(eq(userRoles.userId, userId), tenantScope));
    return rows.map((r) => r.roleKey as RoleKey);
  }

  /** 09 §I.5 lockout bookkeeping: called on a failed attempt with the new count and (once the
   *  threshold is crossed) the lock expiry; the service layer decides both values. */
  async recordFailedLogin(userId: number, failedLoginCount: number, lockedUntil: Date | null): Promise<void> {
    const db = getDb();
    await db.update(appUsers).set({ failedLoginCount, lockedUntil }).where(eq(appUsers.userId, userId));
  }

  /** Any successful login clears the failure counter and any lock, regardless of how it got
   *  there (09 §I.5: "reset failedLoginCount to 0 on any successful login"). */
  async recordSuccessfulLogin(userId: number): Promise<void> {
    const db = getDb();
    await db.update(appUsers).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(appUsers.userId, userId));
  }

  async updatePassword(userId: number, passwordHash: string, mustChangePassword: boolean): Promise<void> {
    const db = getDb();
    await db
      .update(appUsers)
      .set({
        passwordHash,
        passwordAlgo: "argon2id",
        passwordChangedAt: new Date(),
        mustChangePassword,
        failedLoginCount: 0,
        lockedUntil: null,
      })
      .where(eq(appUsers.userId, userId));
  }
}

function toRow(row: typeof appUsers.$inferSelect): UserCredentialsRow {
  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    passwordHash: row.passwordHash,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    failedLoginCount: row.failedLoginCount,
    // `dateStrings: ["DATE","DATETIME"]` (packages/db/client.ts §5.6) means this column arrives
    // over the wire as a string despite drizzle's `Date`-typed column -- `new Date(...)` on
    // either shape (a Date or a MySQL datetime string) produces the right value either way.
    lockedUntil: row.lockedUntil ? new Date(row.lockedUntil) : null,
    tenantId: row.tenantId,
    defaultBranchId: row.defaultBranchId,
  };
}
