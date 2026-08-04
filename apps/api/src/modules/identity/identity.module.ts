// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.5 "NestJS module graph" --
// exports only the public surface; anything not exported is unreachable from other modules.
import { Module } from "@nestjs/common";

import { IdentityController } from "./api/identity.controller.js";
import { PermissionsController } from "./api/permissions.controller.js";
import { RolesController } from "./api/roles.controller.js";
import { UsersController } from "./api/users.controller.js";
import { IdentityService } from "./application/identity.service.js";
import { UserAdminService } from "./application/user-admin.service.js";
import { UserAdminRepository } from "./infrastructure/user-admin.repository.js";
import { UserRepository } from "./infrastructure/user.repository.js";

@Module({
  controllers: [IdentityController, UsersController, RolesController, PermissionsController],
  providers: [IdentityService, UserRepository, UserAdminService, UserAdminRepository],
  exports: [IdentityService],
})
export class IdentityModule {}
