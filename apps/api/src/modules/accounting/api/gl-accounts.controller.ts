// Thin controller (§2.2), mirroring purchase-returns.controller.ts's shape. Read-only --
// chart-of-accounts admin writes (POST/PATCH /gl/accounts) are out of scope for this task.
import { Controller, Get, Param, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { GlAccountService } from "../application/gl-account.service.js";
import { GlAccountIdParamDto, GlAccountLedgerQueryDto, ListGlAccountsQueryDto } from "./dto/gl-account.dto.js";

@Controller("gl/accounts")
export class GlAccountsController {
  constructor(private readonly glAccountService: GlAccountService) {}

  @RequirePermission("gl.account", "list")
  @Get()
  async list(@Query() query: ListGlAccountsQueryDto, @CurrentActor() actor: Actor) {
    return this.glAccountService.list(query, actor);
  }

  @RequirePermission("gl.account", "view")
  @Get(":id")
  async getById(@Param() params: GlAccountIdParamDto, @CurrentActor() actor: Actor) {
    return this.glAccountService.getById(params.id, actor);
  }

  /** Resource "gl.ledger", action "view_ledger" -- per this task's exact instruction. See the
   *  final report: no seed.ts row currently grants `gl.ledger:view_ledger` to any role (only
   *  `gl.ledger:list`/`gl.ledger:view` are seeded), so this route 403s for everyone until a
   *  follow-up seed update adds it -- flagged, not silently worked around by substituting a
   *  different action key. */
  @RequirePermission("gl.ledger", "view_ledger")
  @Get(":id/ledger")
  async getLedger(@Param() params: GlAccountIdParamDto, @Query() query: GlAccountLedgerQueryDto, @CurrentActor() actor: Actor) {
    return this.glAccountService.getLedger(params.id, query, actor);
  }
}
