// The public surface of `auth` (§3.1). Other modules that need auth data import from here --
// never from `./infrastructure/*` or `./domain/*` directly (B4).
export { AuthModule } from "./auth.module.js";
export { AuthService } from "./application/auth.service.js";
export type { LoginResult } from "./domain/session.js";
