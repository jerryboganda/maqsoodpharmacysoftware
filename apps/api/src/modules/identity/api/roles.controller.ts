// Blueprint: 17-technical-blueprint.md §2.2 (thin controller); 09-roles-permissions.md §I.3
// (the seeded role catalogue). Read-only -- role creation/editing is out of scope for Phase 1
// (the eight seeded system roles are the whole catalogue today).
import { Controller, Get } from "@nestjs/common";

import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { UserAdminService } from "../application/user-admin.service.js";
import type { RoleResponseDto } from "./dto/user-admin.dto.js";

@Controller("roles")
export class RolesController {
  constructor(private readonly userAdmin: UserAdminService) {}

  /** Lists the role catalogue (owner/sys_admin only) -- what `PUT /users/:id/roles` can assign
   *  from, and what an admin UI needs to build that picker. */
  @RequirePermission("identity.role", "list")
  @Get()
  async list(): Promise<RoleResponseDto[]> {
    return this.userAdmin.listRoles();
  }
}
