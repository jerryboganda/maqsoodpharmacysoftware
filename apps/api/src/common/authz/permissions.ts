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
  // Purchase-order terminal-state transitions (`purchase.order:close`/`:cancel`) -- distinct
  // verbs from `delete` (never a hard delete, N-3) and from `deactivate` (a master-data
  // retirement, not a document lifecycle transition).
  "close",
  "cancel",
  // `identity.user:edit` folds activate/deactivate into "edit" (see seed.ts's comment on that
  // row), but a party master (e.g. `purchase.supplier`) wants a permission distinct from ordinary
  // field edits for the same reason `identity.user_role:edit` is split from `identity.user:edit`
  // -- retiring a supplier/customer is a materially more consequential action than correcting its
  // phone number, and the two should be grantable independently.
  "deactivate",
  // Read access to a party's GL sub-ledger (e.g. `purchase.supplier:view_ledger`) is kept
  // separate from plain "view" of the master-data row: the API plan's required-role column widens
  // ACC/AUD in and narrows SHF back out relative to `view` (18-api-plan.md §4.1), so folding the
  // two into one permission would either over- or under-grant one of them.
  "view_ledger",
  "export",
  "print",
  "reprice",
  "discount",
  "override",
] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];

/** `resource_key` values seeded so far, per module (§2.3). Extend as modules are built --
 *  this is intentionally not exhaustive in Phase 1. */
export const RESOURCE_KEYS = [
  "identity.user",
  "identity.user_role",
  "identity.role",
  "identity.permission",
  "identity.credential",
  "identity.session",
  "settings.option",
  "catalog.item",
  "inventory.adjustment",
  "inventory.stock",
  "purchase",
  "purchase.supplier",
  "purchase.order",
  "purchase.return",
  "sale.customer",
  "sale.cash",
  "sale.return",
] as const;

export type ResourceKey = (typeof RESOURCE_KEYS)[number] | (string & {});

export function permissionKey(resource: ResourceKey, action: ActionKey): string {
  return `${resource}:${action}`;
}
