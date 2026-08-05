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
  // Wave 5 (GL/payments/expenses foundation): distinct from "cancel" -- cancel voids a document
  // before/without a GL impact being relied on elsewhere, reverse writes a compensating balanced
  // journal entry against one that already posted (journal_entry/journal_line are append-only,
  // §T91/§T92 ledger.ts -- corrections are audited reversals, never an in-place edit or delete).
  // Several Wave 5 endpoints (gl.voucher, payment, expense, cash_bank) need to grant this
  // independently of "cancel" and "post" per 18-api-plan.md Part 5's reversal endpoints
  // (`/payments/{id}/reverse`, `/expenses/{id}/reverse`, `/gl/journal-entries/{id}/reverse`).
  "reverse",
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
  // Stock-lot lifecycle (post-audit addition, 18-api-plan.md §2.5 documents these as `lot.hold`/
  // `lot.release` on a distinct `stock_lot` resource key -- this codebase's `inventory.stock_lot`
  // resource key groups them instead; see seed.ts's PERMISSIONS block comment for the
  // reconciliation note). "hold" quarantines a lot (excludes it from FEFO); "release" reverses
  // that, only from a held state.
  "hold",
  "release",
  // R4.2 expiry dashboard read (post-audit addition) -- distinct verb from plain "view" since it
  // is a cross-item reporting surface, not a single record.
  "view_dashboard",
  // Stock-take module verbs. "count" gates `PUT /stock-takes/:id/lines` (recording counted
  // quantities) -- distinct from "edit" because entering a count is a narrower, staff-level
  // action than editing the take's own header fields (which this Phase 1 API does not even
  // expose, matching the "no PATCH" endpoint list). "generate_adjustments" gates the one step
  // that actually produces posted `stock_adjustment` documents from a take's variance -- kept
  // distinct from "post" (which stock-take itself never does, see inventory.ts's stockTakes doc
  // comment) and from "close" (the take's own terminal-state transition, mirroring
  // `purchase.order`'s existing close/cancel split above).
  "count",
  "generate_adjustments",
  // Wave 9 (R-013): `accounting.fiscal_period:reopen` -- the inverse of the already-existing
  // "close" verb. Distinct from "cancel"/"reverse" (this isn't undoing a document, it's flipping
  // a period's own status back), and distinct from a generic "edit" (a period's dates/key are not
  // editable via either action -- only the status transition is).
  "reopen",
  // Wave 9 (R4.5): `inventory.stock_lot:recall_trace` -- distinct from plain "view" because a
  // recall trace surfaces customer identity/contact info across every invoice that ever drew from
  // a lot, a materially broader disclosure than one lot's own fields.
  "recall_trace",
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
  "inventory.stock_lot",
  "inventory.expiry",
  "inventory.stock_take",
  "purchase",
  "purchase.supplier",
  "purchase.order",
  "purchase.return",
  "sale.customer",
  "sale.cash",
  "sale.return",
  // Wave 5: GL/chart-of-accounts, manual accounting vouchers, payments, cash-bank, expenses --
  // this file's own header comment predicted "gl.voucher" as a future example. See seed.ts's
  // PERMISSIONS block for the resource x action grid these resource keys are actually seeded
  // against, and docs/system-analysis/09-roles-permissions.md §I.4 for the role matrix each row
  // follows.
  "gl.account",
  "gl.ledger",
  "gl.voucher",
  "cash_bank",
  "payment",
  "payment_method",
  "expense",
  "expense_category",
  // Wave 6: reporting registry, real audit-log reads, in-app notifications, dashboard aggregate
  // endpoints -- the four "shared foundation" resources this wave lays for the reporting/audit/
  // notifications follow-up agents to build their own modules against. See seed.ts's PERMISSIONS
  // block for the resource x action grid seeded against each and
  // docs/system-analysis/09-roles-permissions.md §I.4 for the role matrix "report"/"audit" follow
  // (both have explicit rows there); "notification"/"dashboard" have no explicit §I.4 row -- see
  // seed.ts's own comment on those two for the judgement call made.
  "report",
  "audit",
  "notification",
  "dashboard",
] as const;

export type ResourceKey = (typeof RESOURCE_KEYS)[number] | (string & {});

export function permissionKey(resource: ResourceKey, action: ActionKey): string {
  return `${resource}:${action}`;
}
