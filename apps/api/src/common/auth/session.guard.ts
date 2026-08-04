// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.1 "Authentication";
// docs/system-analysis/09-roles-permissions.md §I.2 (`user_session` table), §I.5 (session
// policy).
//
// Real session authentication. Reads the `Authorization: Bearer <token>` header, hashes the
// presented token (SHA-256 -- the raw token is never stored, see session.repository.ts), looks up
// a live (not revoked, not expired) `user_session` row joined to `app_user`, and attaches the
// resulting `Actor` (real roles, real user id, `isDevStub: false`) to the request. Missing,
// malformed, unknown, revoked or expired credentials all throw `UnauthenticatedException` (401) --
// there is no fallback actor and no bypass. `@Public()` routes (identity/health, auth/login) skip
// authentication entirely, per the existing contract `PermissionGuard` also honours.
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";

import { IS_PUBLIC_KEY } from "../authz/public.decorator.js";
import { UnauthenticatedException } from "../errors/app.exception.js";
import type { Actor } from "./actor.js";
import { hashSessionToken, SessionRepository } from "./session.repository.js";

const BEARER_PREFIX = "Bearer ";

/** Extracts the token from `Authorization: Bearer <token>`; `undefined` for any other shape
 *  (missing header, wrong scheme, empty token). */
function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith(BEARER_PREFIX)) return undefined;
  const token = value.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Public routes (e.g. identity/health, auth/login) need no session at all -- nothing
    // downstream on a @Public() handler is expected to read `request.actor` (CurrentActor is for
    // authenticated routes only; using it on a @Public() route is a handler bug, not something
    // this guard should paper over with a fake actor).
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthenticatedException();
    }

    const tokenHash = hashSessionToken(token);
    const session = await this.sessions.findActiveByTokenHash(tokenHash);
    if (!session) {
      throw new UnauthenticatedException("Your session is invalid or has expired. Please sign in again.");
    }

    // Best-effort activity heartbeat ("who is logged in right now", identity.ts's user_session
    // header comment). Not on the critical path for the authorization decision above.
    void this.sessions.touchLastSeen(session.sessionId);

    request.actor = {
      userId: String(session.userId),
      username: session.username,
      displayName: session.displayName,
      roles: session.roles,
      sessionId: session.sessionId,
      tenantId: session.tenantId,
      branchId: session.branchId,
      isDevStub: false,
    };

    return true;
  }
}
