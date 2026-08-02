// Blueprint: docs/system-analysis/17-technical-blueprint.md §4.3 -- "a @RequirePermission()
// guard applied by default and an explicit @Public() opt-out". Both SessionGuard and
// PermissionGuard read this marker: a public route needs neither authentication nor
// authorization (e.g. a liveness/health endpoint).
import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "pharmacy:isPublic";

/** Marks a route as requiring no authentication and no permission check. Use sparingly and
 *  explicitly -- the release-gate test (§4.3) fails the build for any mutating route that has
 *  neither this nor `@RequirePermission()`. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
