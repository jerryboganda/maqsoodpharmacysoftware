// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Domain (pure, no I/O)";
// §2.3 module #1 `identity` (owns app_user, user_session, credentials, MFA).
// Pure TypeScript. No framework imports, no database imports (§2.2).
import type { RoleKey } from "../../../common/auth/actor.js";

/** The minimal user representation for Phase 1. Extend as `identity` grows (09 §I.2
 *  `app_user`: password hash, MFA secret, lockout state, ... belong to infrastructure, not
 *  this domain shape, which is what the rest of the system is allowed to see). */
export interface User {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly RoleKey[];
  readonly isActive: boolean;
}
