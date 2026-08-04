// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Controller (thin)" -- parses/
// validates DTO, resolves the actor, calls exactly one application service. §9.1 Authentication.
import { Body, Controller, Headers, HttpCode, Ip, Post } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { Public } from "../../../common/authz/public.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { AuthService } from "../application/auth.service.js";
import { ChangePasswordDto, LoginDto, LoginResponseDto } from "./dto/auth.dto.js";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** No session exists yet at login -- @Public() is the correct (and only) way to reach this
   *  handler: SessionGuard skips authentication and PermissionGuard skips the permission check
   *  it would otherwise deny-by-default for any non-@Public() route. */
  @Public()
  @HttpCode(200)
  @Post("login")
  async login(
    @Body() body: LoginDto,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
  ): Promise<LoginResponseDto> {
    const result = await this.auth.login(body.username, body.password, { ipAddress: ip, userAgent });
    return {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      userId: result.userId,
      username: result.username,
      displayName: result.displayName,
      roles: [...result.roles],
      mustChangePassword: result.mustChangePassword,
    };
  }

  /** Self-service: revokes only the CALLER's own session (never accepts a target session/user
   *  id), so the `identity.session:delete` permission this requires is safe to grant broadly --
   *  see seed.ts's role_permission grant table. */
  @RequirePermission("identity.session", "delete")
  @HttpCode(204)
  @Post("logout")
  async logout(@CurrentActor() actor: Actor): Promise<void> {
    await this.auth.logout(actor);
  }

  /** Self-service: always re-hashes onto the CALLER's own `app_user` row (there is no target
   *  user id in the request body), so `identity.credential:edit` is likewise safe to grant
   *  broadly -- distinct from the admin-only `identity.user:edit` used by `PATCH /users/:id`. */
  @RequirePermission("identity.credential", "edit")
  @HttpCode(204)
  @Post("password/change")
  async changePassword(@Body() body: ChangePasswordDto, @CurrentActor() actor: Actor): Promise<void> {
    await this.auth.changePassword(actor, body.currentPassword, body.newPassword);
  }
}
