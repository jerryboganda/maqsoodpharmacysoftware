// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.2; 09-roles-permissions.md §I.4
// (target matrix).
//
// TODO(real authz): replace this with a query against `role_permission` (joined through
// `user_role`, union semantics -- 09 §I.1 principle 5) once @pharmacy/db lands, plus
// `role_scope`/`role_limit` enforcement inside the transaction script (§7.2, §9.2). Today this
// is a minimal, explicitly-not-a-full-implementation resolver so `PermissionGuard` has a real
// deny-by-default decision to make rather than always returning true.
import { Injectable } from "@nestjs/common";

import type { Actor } from "../auth/actor.js";
import type { RequiredPermission } from "./require-permission.decorator.js";

@Injectable()
export class PermissionsService {
  /**
   * Dev-stub resolution: `owner` and `sys_admin` may reach any declared permission (they hold
   * the broadest read/admin surface in the §I.4 matrix); every other role is denied until the
   * real `role_permission` table is wired. This keeps the guard's deny-by-default contract
   * real -- an actor without an elevated role is actually rejected, not waved through.
   */
  can(actor: Actor, required: RequiredPermission): boolean {
    void required;
    return actor.roles.includes("owner") || actor.roles.includes("sys_admin");
  }
}
