// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.2, Decision D-02 (§4.3).
import { SetMetadata } from "@nestjs/common";

import type { ActionKey, ResourceKey } from "./permissions.js";
import { permissionKey } from "./permissions.js";

export const REQUIRE_PERMISSION_KEY = "pharmacy:requiredPermission";

export interface RequiredPermission {
  readonly resource: ResourceKey;
  readonly action: ActionKey;
  readonly key: string;
}

/** Declares the single permission required to reach this handler. `PermissionGuard` denies by
 *  default: no `@RequirePermission()` and no `@Public()` on a route is a deny, not an allow. */
export const RequirePermission = (resource: ResourceKey, action: ActionKey) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, { resource, action, key: permissionKey(resource, action) } satisfies RequiredPermission);
