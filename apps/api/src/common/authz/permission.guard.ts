// Blueprint: docs/system-analysis/17-technical-blueprint.md §4.3, §9.2 [BINDING].
// "With a @RequirePermission() guard applied by default and an explicit @Public() opt-out,
// forgetting a permission check becomes impossible rather than merely unlikely."
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import type { Actor } from "../auth/actor.js";
import { ForbiddenActionException } from "../errors/app.exception.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { PermissionsService } from "./permissions.service.js";
import type { RequiredPermission } from "./require-permission.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator.js";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Deny-by-default (09 §I.1 principle 2): no declared permission and no @Public() is a
    // deny, not an oversight that quietly passes through.
    if (!required) {
      throw new ForbiddenActionException(context.getClass().name, context.getHandler().name);
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const actor = request.actor;
    if (!actor) {
      throw new ForbiddenActionException(required.resource, required.action);
    }

    if (!(await this.permissions.can(actor, required))) {
      throw new ForbiddenActionException(required.resource, required.action);
    }

    return true;
  }
}
