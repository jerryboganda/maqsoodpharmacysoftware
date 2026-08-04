// Blueprint: 17-technical-blueprint.md §2.2 (thin controller); 09-roles-permissions.md §I.2
// (`permission` catalogue). Read-only -- lists what exists so an admin UI can show/audit
// `role_permission` grants; granting/revoking happens through role administration, not here.
import { Controller, Get } from "@nestjs/common";

import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { UserAdminService } from "../application/user-admin.service.js";
import type { PermissionResponseDto } from "./dto/user-admin.dto.js";

@Controller("permissions")
export class PermissionsController {
  constructor(private readonly userAdmin: UserAdminService) {}

  @RequirePermission("identity.permission", "list")
  @Get()
  async list(): Promise<PermissionResponseDto[]> {
    return this.userAdmin.listPermissions();
  }
}
