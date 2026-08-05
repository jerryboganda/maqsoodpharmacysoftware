// Blueprint: 17-technical-blueprint.md §2.2 (thin controller); 09-roles-permissions.md §I.3
// (the seeded role catalogue); 18-api-plan.md §0.3 (Wave 10b -- POST/PATCH, "SYS" only, narrower
// than GET's "SYS OWN AUD": an owner can SEE the role catalogue but not create/edit rows in it --
// a deliberate design split this file follows exactly, not widened to owner the way this
// codebase's own judgement calls elsewhere (e.g. settings.branch:edit) have done in the ABSENCE
// of an explicit doc answer; here the doc gives one).
import { Body, Controller, Get, Param, Patch, Post, Put } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { UserAdminService } from "../application/user-admin.service.js";
// REGULAR (not `import type`) import, deliberately: `emitDecoratorMetadata` only captures a
// parameter's real class for `design:paramtypes` (what `ZodValidationPipe`'s nestjs-zod machinery
// keys its lookup off of) when the class is imported as a VALUE -- `import type` erases it at
// compile time, silently degrading the reflected type to `Object` and skipping validation
// entirely rather than throwing. Found live: an obviously-invalid `POST /roles` body (spaces,
// symbols, and even a missing required `description`) was accepted with a real 201 before this
// fix -- confirmed empirically, not by code review alone. `users.controller.ts`'s own DTO import
// already follows this correctly; this file did not, until now.
import {
  CreateRoleDto,
  PutRoleLimitsDto,
  PutRoleScopesDto,
  RoleKeyParamDto,
  RoleLimitResponseDto,
  RoleResponseDto,
  RoleScopeResponseDto,
  UpdateRoleDto,
} from "./dto/user-admin.dto.js";

@Controller("roles")
export class RolesController {
  constructor(private readonly userAdmin: UserAdminService) {}

  /** Lists the role catalogue (owner/sys_admin/auditor) -- what `PUT /users/:id/roles` can assign
   *  from, and what an admin UI needs to build that picker. */
  @RequirePermission("identity.role", "list")
  @Get()
  async list(): Promise<RoleResponseDto[]> {
    return this.userAdmin.listRoles();
  }

  /** `POST /roles` -- create a custom role (sys_admin only). `ROLE.KEY_TAKEN` on a duplicate key
   *  and `ROLE.CLONE_SOURCE_NOT_FOUND` on an unresolvable `clonedFromRoleKey` are both 422, not
   *  the 409 18-api-plan.md's own doc table suggests -- `BusinessRuleException` is a flat 422 for
   *  every business-rule violation everywhere in this codebase (see e.g. `IDENTITY.USERNAME_TAKEN`
   *  in user-admin.service.ts, an identically-shaped "already taken" case), and this follows that
   *  established, consistent convention rather than introducing a one-off 409. */
  @RequirePermission("identity.role", "create")
  @Post()
  async create(@Body() body: CreateRoleDto, @CurrentActor() actor: Actor): Promise<RoleResponseDto> {
    return this.userAdmin.createRole(body, Number(actor.userId));
  }

  /** `PATCH /roles/:roleKey` -- rename/describe/disable (sys_admin only). 404 on an unknown
   *  role, 422 `ROLE.SYSTEM_ROLE_PROTECTED` on `isEnabled: false` against a seeded system role. */
  @RequirePermission("identity.role", "edit")
  @Patch(":roleKey")
  async update(@Param() params: RoleKeyParamDto, @Body() body: UpdateRoleDto, @CurrentActor() actor: Actor): Promise<RoleResponseDto> {
    return this.userAdmin.updateRole(params.roleKey, body, Number(actor.userId));
  }

  // ---- Wave 10e: role_scope / role_limit (R-007 CRITICAL) -- same resource, same read/write role
  // split as the rest of this controller (identity.role:list to view, :edit to change -- these are
  // just more fields of the same role-administration resource, not a reason to mint new
  // permission rows).

  /** `GET /roles/:roleKey/scopes`. 404 on an unknown role. */
  @RequirePermission("identity.role", "list")
  @Get(":roleKey/scopes")
  async getScopes(@Param() params: RoleKeyParamDto): Promise<RoleScopeResponseDto> {
    return this.userAdmin.getRoleScopes(params.roleKey);
  }

  /** `PUT /roles/:roleKey/scopes` -- replaces each SUPPLIED scopeType's whole value set (see
   *  user-admin.repository.ts's `putRoleScopes` for why a scopeType absent from the body is left
   *  untouched rather than cleared). */
  @RequirePermission("identity.role", "edit")
  @Put(":roleKey/scopes")
  async putScopes(@Param() params: RoleKeyParamDto, @Body() body: PutRoleScopesDto, @CurrentActor() actor: Actor): Promise<RoleScopeResponseDto> {
    return this.userAdmin.putRoleScopes(params.roleKey, body.scopes, Number(actor.userId));
  }

  /** `GET /roles/:roleKey/limits`. */
  @RequirePermission("identity.role", "list")
  @Get(":roleKey/limits")
  async getLimits(@Param() params: RoleKeyParamDto): Promise<RoleLimitResponseDto> {
    return this.userAdmin.getRoleLimits(params.roleKey);
  }

  /** `PUT /roles/:roleKey/limits` -- full replace of this role's entire limit set. */
  @RequirePermission("identity.role", "edit")
  @Put(":roleKey/limits")
  async putLimits(@Param() params: RoleKeyParamDto, @Body() body: PutRoleLimitsDto, @CurrentActor() actor: Actor): Promise<RoleLimitResponseDto> {
    return this.userAdmin.putRoleLimits(params.roleKey, body.limits, Number(actor.userId));
  }
}
