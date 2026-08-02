// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.3 (module list), §9.2
// (resource x action grid); docs/system-analysis/09-roles-permissions.md §I.2-I.4.
//
// The resource x action grid. `resource` names mirror the module catalogue (§2.3) so a
// permission reads like the module it protects: "sale.cash", "purchase", "item", "gl.voucher".
// Full catalogue seeding (486 legacy rights mapped 09 §I.6) happens once `settings`/`access`
// own real tables; this is the typed vocabulary application code is written against today.
export { ROLE_KEYS, type RoleKey } from "../auth/actor.js";

/** The explicit verb axis the legacy system lacked (09 §I.2 `action` table). */
export const ACTION_KEYS = [
  "view",
  "list",
  "create",
  "edit",
  "delete",
  "post",
  "unpost",
  "approve",
  "export",
  "print",
  "reprice",
  "discount",
  "override",
] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];

/** `resource_key` values seeded so far, per module (§2.3). Extend as modules are built --
 *  this is intentionally not exhaustive in Phase 1. */
export const RESOURCE_KEYS = ["identity.user", "settings.option"] as const;

export type ResourceKey = (typeof RESOURCE_KEYS)[number] | (string & {});

export function permissionKey(resource: ResourceKey, action: ActionKey): string {
  return `${resource}:${action}`;
}
