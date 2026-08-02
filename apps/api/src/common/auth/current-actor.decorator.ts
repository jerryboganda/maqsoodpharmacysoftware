// Reads the `Actor` that `SessionGuard` attached to the request. Controllers use this instead
// of reaching into the raw request object.
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import type { Actor } from "./actor.js";

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
  if (!request.actor) {
    // SessionGuard runs before every handler (it is registered globally in main.ts) and always
    // attaches an actor or throws -- reaching here means a guard ordering bug, not a client error.
    throw new Error("CurrentActor used on a route with no actor attached -- is SessionGuard registered?");
  }
  return request.actor;
});
