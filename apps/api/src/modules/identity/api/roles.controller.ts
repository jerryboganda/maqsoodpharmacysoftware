// Blueprint: 17-technical-blueprint.md §2.2 (thin controller); 09-roles-permissions.md §I.3
// (the seeded role catalogue); 18-api-plan.md §0.3 (Wave 10b -- POST/PATCH, "SYS" only, narrower
// than GET's "SYS OWN AUD": an owner can SEE the role catalogue but not create/edit rows in it --
// a deliberate design split this file follows exactly, not widened to owner the way this
// codebase's own judgement calls elsewhere (e.g. settings.branch:edit) have done in the ABSENCE
// of an explicit doc answer; here the doc gives one).
import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";

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
import { CreateRoleDto, RoleKeyParamDto, RoleResponseDto, UpdateRoleDto } from "./dto/user-admin.dto.js";

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
}
