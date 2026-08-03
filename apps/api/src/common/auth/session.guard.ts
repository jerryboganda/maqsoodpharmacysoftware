// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.1 "Authentication";
// docs/system-analysis/09-roles-permissions.md §I.2 (`user_session` table), §I.5 (session
// policy: 15 min access token + rotating refresh, 20 min idle timeout for counter roles).
//
// ============================================================================================
// DEV-MODE STUB. This guard does NOT authenticate anyone yet. It always attaches a fixed
// "owner" actor and allows every request through. It exists so the rest of the API (guards,
// decorators, controllers) can be written against the *real* shape of an authenticated
// request today, and swapped for a real implementation without touching call sites.
//
// TODO(real auth): once @pharmacy/db lands, replace `resolveDevActor` with:
//   1. read the session cookie / `Authorization: Bearer <token>` header,
//   2. look up `user_session` (09 §I.2), reject if missing/expired/revoked,
//   3. load `user_role` -> `role` for the session's user (union semantics, 09 §I.1 principle 5),
//   4. attach the resulting `Actor` to the request.
// ============================================================================================
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { IS_PUBLIC_KEY } from "../authz/public.decorator.js";
import type { Actor } from "./actor.js";

let hasWarned = false;

function resolveDevActor(): Actor {
  if (!hasWarned) {
    // eslint-disable-next-line no-console
    new Logger("SessionGuard").warn(
      "DEV-MODE AUTH STUB ACTIVE -- every request is authenticated as a fixed 'owner' actor. " +
        "This MUST be replaced before any non-development deployment. See session.guard.ts.",
    );
    hasWarned = true;
  }
  return {
    // Matches packages/db/scripts/seed.ts's dev.owner row (user_id=1, deterministic on a
    // freshly-migrated + freshly-seeded database -- that script is the only writer to app_user
    // in dev). UserRepository resolves this id for real against @pharmacy/db.
    userId: "1",
    username: "dev.owner",
    displayName: "Dev Owner (stub)",
    roles: ["owner"],
    sessionId: "dev-session",
    isDevStub: true,
  };
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();

    // Even public routes get an actor attached (as an anonymous/dev stub) so downstream code
    // that reads `request.actor` never has to null-check -- only PermissionGuard treats
    // "public" specially.
    request.actor = resolveDevActor();

    if (isPublic) return true;

    // Dev-mode stub never rejects. A real implementation returns false / throws
    // UnauthenticatedException here when no valid session is present.
    return true;
  }
}
