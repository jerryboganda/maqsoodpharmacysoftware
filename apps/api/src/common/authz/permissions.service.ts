// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.2; 09-roles-permissions.md §I.4
// (target matrix), §I.1 principle 2 ("deny by default") and principle 5 ("union-of-permissions
// semantics, never MIN()").
//
// Real authorization decision: `required.key` (`${resource}:${action}`, permissions.ts) must have
// a `role_permission` grant on at least one of the actor's roles. `permission.code` in
// packages/db/schema/access.ts is exactly that `resource:action` string (permissionKey() in
// permissions.ts builds it the same way the seed script's permission rows are written), so no
// resource/action -> id translation table is needed beyond the `permission` row itself.
//
// Resolved against `Actor.roles` (the role-key array `SessionGuard`/`session.repository.ts`
// already computed once for this request with real union-of-grants semantics) rather than
// re-deriving `user_role` for `actor.userId` here -- the schema comment on this file's header
// calls out either approach as acceptable; reading `Actor.roles` avoids a second per-request
// membership query on every single permission check.
//
// KNOWN GAP (documented, not silently skipped): `role_scope`/`role_limit` (09 §I.2's row-level
// scope and numeric-limit tables, e.g. "sales_officer can discount <= 2%", "purchase_officer
// cannot post") are not modelled in packages/db/schema/access.ts yet -- this resolves
// resource+action grant/deny only. Scope/limit enforcement is real follow-up work, not assumed
// away; see 09 §I.4's "◐ conditional" cells for what is still owed.
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, permissions, rolePermissions, roles } from "@pharmacy/db";

import type { Actor } from "../auth/actor.js";
import type { RequiredPermission } from "./require-permission.decorator.js";

@Injectable()
export class PermissionsService {
  /**
   * True iff at least one of `actor.roles` carries a `role_permission` grant for
   * `required.key`. Positive-grant-only (access.ts `rolePermissions`' own header: "matching the
   * verified legacy semantics -- there is no deny rule, no precedence and no inheritance") and
   * union-of-grants across roles (09 §I.1 principle 5): a single granting role is enough.
   */
  async can(actor: Actor, required: RequiredPermission): Promise<boolean> {
    if (actor.roles.length === 0) return false;

    const db = getDb();
    const [grant] = await db
      .select({ permissionId: permissions.permissionId })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.permissionId))
      .innerJoin(roles, eq(rolePermissions.roleId, roles.roleId))
      .where(
        and(
          eq(permissions.code, required.key),
          isNull(permissions.deletedAt),
          isNull(roles.deletedAt),
          // Wave 10b: `roles.isEnabled` is the real "remove" mechanism for an admin-created role
          // (P1.3 -- disable, never delete) -- a disabled role must stop granting immediately,
          // not just on next login, since this check re-runs on every single request. System
          // roles cannot be disabled at all through the admin endpoint (roles.dto.ts's
          // updateRole -- 422 ROLE.SYSTEM_ROLE_PROTECTED), so this never affects the eight seeded
          // roles in practice.
          eq(roles.isEnabled, true),
          // Platform-wide roles only (tenant_id NULL) -- both the eight seeded system roles AND
          // Wave 10b's admin-created custom roles (POST /roles always creates tenantId=NULL rows,
          // see roles.dto.ts's own header comment for why a further per-tenant increment is
          // deliberately out of scope for this wave). TODO(tenant-scoped custom roles): a FUTURE
          // increment that lets a tenant admin define a role visible only to their own tenant
          // would need this to also match `roles.tenantId = <actor's tenant>` for those rows.
          isNull(roles.tenantId),
          inArray(roles.roleKey, [...actor.roles]),
        ),
      )
      .limit(1);

    return grant !== undefined;
  }
}
