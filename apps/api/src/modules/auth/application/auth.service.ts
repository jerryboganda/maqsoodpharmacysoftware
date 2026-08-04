// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Application" layer;
// §9.1 "Authentication"; 09-roles-permissions.md §I.5 (lockout policy: "5 failed attempts ->
// 15-minute lock ... all attempts written to security_audit" -- the security_audit sink itself
// does not exist yet, see events/index.ts).
import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";

import type { Actor } from "../../../common/auth/actor.js";
import { SessionRepository } from "../../../common/auth/session.repository.js";
import { AccountLockedException, InvalidCredentialsException } from "../../../common/errors/index.js";
import type { LoginResult } from "../domain/session.js";
import { CredentialsRepository } from "../infrastructure/credentials.repository.js";

/** 09 §I.5: "5 failed attempts -> 15-minute lock". */
const FAILED_LOGIN_LOCK_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface LoginRequestMeta {
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly credentials: CredentialsRepository,
    private readonly sessions: SessionRepository,
  ) {}

  async login(username: string, password: string, meta: LoginRequestMeta): Promise<LoginResult> {
    const user = await this.credentials.findByUsername(username);

    // Unknown username or deactivated account: the SAME generic failure as a wrong password.
    // 09 §I.5's "don't leak which of username/password was wrong" extends to "whether the
    // account exists at all" -- there is nothing here for an attacker to distinguish.
    if (!user || !user.isActive) {
      throw new InvalidCredentialsException();
    }

    // Locked accounts are rejected before the password is even checked -- a locked user gets
    // the SAME "account locked" response regardless of whether they typed the right password,
    // so the lock state itself can't be probed for a correct-password oracle.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AccountLockedException(user.lockedUntil);
    }

    const passwordOk = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!passwordOk) {
      const failedLoginCount = user.failedLoginCount + 1;
      if (failedLoginCount >= FAILED_LOGIN_LOCK_THRESHOLD) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        await this.credentials.recordFailedLogin(user.userId, failedLoginCount, lockedUntil);
        throw new AccountLockedException(lockedUntil);
      }
      await this.credentials.recordFailedLogin(user.userId, failedLoginCount, null);
      throw new InvalidCredentialsException();
    }

    // 09 §I.5: "reset failedLoginCount to 0 on any successful login."
    await this.credentials.recordSuccessfulLogin(user.userId);
    const roles = await this.credentials.listRoles(user.userId, user.tenantId);

    // meta.ipAddress is accepted from the controller for a future audit trail (security_audit,
    // 09 §I.2) but not persisted onto the session row yet -- see session.repository.ts's `create`
    // for why (`ip_address` is packed-binary and drizzle 0.36's `varbinary()` typing has no safe
    // Buffer insert path to verify against without a live database).
    void meta.ipAddress;
    const session = await this.sessions.create({
      userId: user.userId,
      tenantId: user.tenantId,
      branchId: user.defaultBranchId,
      userAgent: meta.userAgent ?? null,
    });

    return {
      token: session.rawToken,
      expiresAt: session.expiresAt,
      userId: String(user.userId),
      username: user.username,
      displayName: user.displayName,
      roles,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /** Revokes exactly the session the caller authenticated with -- never any other user's. */
  async logout(actor: Actor): Promise<void> {
    await this.sessions.revokeBySessionId(actor.sessionId, Number(actor.userId));
  }

  async changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    const userId = Number(actor.userId);
    const user = await this.credentials.findById(userId);
    if (!user) {
      throw new InvalidCredentialsException();
    }
    const currentOk = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!currentOk) {
      throw new InvalidCredentialsException();
    }
    const newHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.credentials.updatePassword(userId, newHash, false);
  }
}
