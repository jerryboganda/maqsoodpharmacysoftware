// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Controller (thin)";
// 09-roles-permissions.md §I.6 (owner/sys_admin user administration). Thin controller: validate,
// resolve the actor, call exactly one application service.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";

import type { Actor, RoleKey } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { UserAdminService } from "../application/user-admin.service.js";
import {
  AdminUserResponseDto,
  CreateUserDto,
  CreateUserResponseDto,
  PatchUserDto,
  ReplaceUserRolesDto,
  UserIdParamDto,
} from "./dto/user-admin.dto.js";

@Controller("users")
export class UsersController {
  constructor(private readonly userAdmin: UserAdminService) {}

  @RequirePermission("identity.user", "list")
  @Get()
  async list(): Promise<AdminUserResponseDto[]> {
    return this.userAdmin.listUsers();
  }

  /** Generates a random temporary password (never a caller-supplied one), returned exactly
   *  once here. The created user has `mustChangePassword: true`. */
  @RequirePermission("identity.user", "create")
  @HttpCode(201)
  @Post()
  async create(@Body() body: CreateUserDto, @CurrentActor() actor: Actor): Promise<CreateUserResponseDto> {
    return this.userAdmin.createUser(body, Number(actor.userId));
  }

  /** Deactivate/reactivate. There is no hard-delete of a user (audit trail, posted documents
   *  reference `created_by`/`posted_by`, 09 §I.1). */
  @RequirePermission("identity.user", "edit")
  @Patch(":id")
  async patch(@Param() params: UserIdParamDto, @Body() body: PatchUserDto, @CurrentActor() actor: Actor): Promise<void> {
    await this.userAdmin.setActive(params.id, body.isActive, Number(actor.userId));
  }

  /** Replaces the user's entire role assignment (PUT, not a delta) -- 09 §I.2's `user_role` is
   *  many-to-many with union-of-grants semantics across whatever roles remain. Distinct
   *  `identity.user_role:edit` permission (not `identity.user:edit`) because reassigning roles is
   *  a materially more sensitive action than editing profile fields. */
  @RequirePermission("identity.user_role", "edit")
  @Put(":id/roles")
  async replaceRoles(
    @Param() params: UserIdParamDto,
    @Body() body: ReplaceUserRolesDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ roles: RoleKey[] }> {
    const roles = await this.userAdmin.replaceRoles(params.id, body.roles, Number(actor.userId));
    return { roles };
  }
}
