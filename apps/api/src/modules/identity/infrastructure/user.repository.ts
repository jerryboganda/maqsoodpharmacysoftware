// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Infrastructure" layer;
// §3.1 (apps/api imports @pharmacy/db); 09-roles-permissions.md §I.2 `app_user`.
import { Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { appUsers, getDb, roles, userRoles } from "@pharmacy/db";

import type { RoleKey } from "../../../common/auth/actor.js";
import type { User } from "../domain/user.js";

@Injectable()
export class UserRepository {
  async findById(userId: string): Promise<User | null> {
    const id = Number(userId);
    if (!Number.isInteger(id)) return null;

    const db = getDb();
    const [row] = await db.select().from(appUsers).where(eq(appUsers.userId, id));
    if (!row) return null;

    // Union semantics (09 §I.1 principle 5): every role_key this user holds via user_role,
    // resolving both tenant-scoped and NULL-tenant (platform system role) rows. A platform-level
    // user (row.tenantId === null, D21) only ever resolves NULL-tenant system roles.
    const tenantScope =
      row.tenantId === null ? isNull(roles.tenantId) : or(isNull(roles.tenantId), eq(roles.tenantId, row.tenantId));
    const roleRows = await db
      .select({ roleKey: roles.roleKey })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
      .where(and(eq(userRoles.userId, id), tenantScope));

    return {
      userId: String(row.userId),
      username: row.username,
      displayName: row.displayName,
      roles: roleRows.map((r) => r.roleKey as RoleKey),
      isActive: row.isActive,
    };
  }
}
