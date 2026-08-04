// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.1 "Authentication";
// docs/system-analysis/09-roles-permissions.md §I.2 (`user_session`), §I.5 (session policy).
//
// Real server-side session storage backing `SessionGuard` (auth) and the `auth` module's
// login/logout/password-change flows. Opaque bearer tokens, NOT cookies -- the frontend is a
// static SPA calling this API cross-origin/cross-port, so a bearer header sidesteps
// cookie+CORS-credentials complexity. The raw token is returned to the client exactly once, at
// login; only its SHA-256 hex digest (`token_hash`, char(64) -- the same hash-storage shape
// `idempotency_key.request_hash` already uses in this codebase, see
// common/idempotency/idempotency.interceptor.ts) is ever persisted, so a database read alone can
// never hand out a working session.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { appUsers, getDb, roles, userRoles, userSessions } from "@pharmacy/db";

import type { RoleKey } from "./actor.js";

/** 12h bearer-token lifetime. Not the 09 §I.5 "15 min access + rotating refresh" target design
 *  (no refresh-token flow exists yet) -- a single reasonably-short-lived opaque token, matching
 *  the session mechanism this task specifies. Revisit once refresh tokens are built. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface CreateSessionInput {
  readonly userId: number;
  readonly tenantId: number | null;
  readonly branchId: number | null;
  readonly userAgent?: string | null;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly rawToken: string;
  readonly expiresAt: Date;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
  readonly mustChangePassword: boolean;
  readonly tenantId: number | null;
  readonly branchId: number | null;
  /** Union-of-grants role set (09 §I.1 principle 5), resolved once here so every downstream
   *  permission check (`PermissionsService.can`) reads `Actor.roles` instead of re-querying. */
  readonly roles: RoleKey[];
}

@Injectable()
export class SessionRepository {
  async create(input: CreateSessionInput): Promise<CreatedSession> {
    const db = getDb();
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const sessionId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    await db.insert(userSessions).values({
      sessionId,
      tokenHash,
      userId: input.userId,
      tenantId: input.tenantId,
      branchId: input.branchId,
      issuedAt: now,
      expiresAt,
      lastSeenAt: now,
      // `ip_address` is VARBINARY(16) (a packed address, MySQL's own INET6_ATON shape) but
      // drizzle-orm 0.36's `varbinary()` column type is fixed to a plain `string` at the type
      // level (checked against node_modules/drizzle-orm/mysql-core/columns/varbinary.d.ts --
      // no Buffer-typed insert path exists in this version, and no live database is available
      // here to verify a hand-rolled binary-string encoding actually round-trips through
      // mysql2's charset conversion correctly). Writing a wrong-but-plausible-looking packed
      // address would be worse than not recording one -- left null, tracked as a real gap
      // (same class of drizzle-0.36 limitation `_shared.ts` already documents for collations),
      // not silently faked.
      ipAddress: null,
      userAgent: input.userAgent ?? null,
    });

    return { sessionId, rawToken, expiresAt };
  }

  /**
   * Looks up a live (not revoked, not expired) session by the SHA-256 hash of the bearer token
   * presented on the request, joins to `app_user`, and resolves the union-of-grants role set --
   * the same tenant-scoping shape `modules/identity/infrastructure/user.repository.ts`'s
   * `findById` uses (NULL-tenant system roles always apply; a tenant-scoped user additionally
   * picks up that tenant's own roles). Mirrored here rather than imported so `common/auth` --
   * wired globally in app.module.ts, loaded before any feature module -- never depends on
   * `modules/identity`.
   */
  async findActiveByTokenHash(tokenHash: string): Promise<AuthenticatedSession | null> {
    const db = getDb();
    const now = new Date();

    const [row] = await db
      .select({
        sessionId: userSessions.sessionId,
        tenantId: userSessions.tenantId,
        branchId: userSessions.branchId,
        userId: appUsers.userId,
        username: appUsers.username,
        displayName: appUsers.displayName,
        isActive: appUsers.isActive,
        mustChangePassword: appUsers.mustChangePassword,
        userTenantId: appUsers.tenantId,
      })
      .from(userSessions)
      .innerJoin(appUsers, eq(userSessions.userId, appUsers.userId))
      .where(and(eq(userSessions.tokenHash, tokenHash), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, now)));

    if (!row || !row.isActive) return null;

    const tenantScope =
      row.userTenantId === null ? isNull(roles.tenantId) : or(isNull(roles.tenantId), eq(roles.tenantId, row.userTenantId));
    const roleRows = await db
      .select({ roleKey: roles.roleKey })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.roleId))
      .where(and(eq(userRoles.userId, row.userId), tenantScope));

    return {
      sessionId: row.sessionId,
      userId: row.userId,
      username: row.username,
      displayName: row.displayName,
      mustChangePassword: row.mustChangePassword,
      tenantId: row.tenantId,
      branchId: row.branchId,
      roles: roleRows.map((r) => r.roleKey as RoleKey),
    };
  }

  async touchLastSeen(sessionId: string): Promise<void> {
    const db = getDb();
    await db.update(userSessions).set({ lastSeenAt: new Date() }).where(eq(userSessions.sessionId, sessionId));
  }

  /** Logout: revokes the caller's own session by id (`Actor.sessionId`, already resolved by
   *  `SessionGuard` for this request -- no need to re-hash the bearer token). */
  async revokeBySessionId(sessionId: string, revokedBy: number): Promise<void> {
    const db = getDb();
    await db
      .update(userSessions)
      .set({ revokedAt: new Date(), revokedBy })
      .where(and(eq(userSessions.sessionId, sessionId), isNull(userSessions.revokedAt)));
  }
}
