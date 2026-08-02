// The public surface of `identity` (§3.1). Other modules that need identity data import from
// here -- never from `./infrastructure/*` or `./domain/*` directly (B4).
export { IdentityModule } from "./identity.module.js";
export { IdentityService } from "./application/identity.service.js";
export type { User } from "./domain/user.js";
