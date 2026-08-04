// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.2 "Domain (pure, no I/O)".
// Pure TypeScript -- no framework imports, no database imports (§2.2).
import type { RoleKey } from "../../../common/auth/actor.js";

/** The result of a successful `POST /auth/login`. `token` is the RAW bearer token -- returned
 *  exactly once here; only its hash is ever persisted (session.repository.ts). */
export interface LoginResult {
  readonly token: string;
  readonly expiresAt: Date;
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly RoleKey[];
  readonly mustChangePassword: boolean;
}
