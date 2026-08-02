// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Controller (thin)" --
// parses/validates DTO, resolves the actor, calls exactly one application service, maps the
// result. NO business logic. NO SQL. NO money maths.
import { Controller, Get, Param } from "@nestjs/common";

import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import type { Actor } from "../../../common/auth/actor.js";
import { Public } from "../../../common/authz/public.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { IdentityService } from "../application/identity.service.js";
import { HealthResponseDto, UserResponseDto } from "./dto/user.dto.js";

@Controller("identity")
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  /** Liveness/readiness probe. Deliberately @Public() -- no session, no permission. */
  @Public()
  @Get("health")
  health(): HealthResponseDto {
    return this.identity.health();
  }

  /** The signed-in user's own profile. */
  @RequirePermission("identity.user", "view")
  @Get("me")
  async me(@CurrentActor() actor: Actor): Promise<UserResponseDto> {
    const user = await this.identity.getUser(actor.userId);
    return {
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      roles: [...user.roles],
      isActive: user.isActive,
    };
  }
}
