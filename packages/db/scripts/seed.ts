// Dev-only seed data. Populates exactly enough of a fresh `pharmacy_platform` database for
// apps/api's identity/settings modules to run against real data instead of their in-memory
// fixtures (packages/db/client.ts's consumer), plus the docflow/GL/parties/catalog fixtures the
// inventory/purchasing/sales/payments/expenses posting flows need. Block 1 (tenant/roles/
// dev.owner/options) is guarded by the "dev" tenant existing -- an all-or-nothing guard, kept only
// because that block's own contents (roles, dev.owner) never grow wave-over-wave. Every block
// after it (1b permission catalogue + role_permission grants; 1c document types/series/counters;
// 1d the voucher_category option list; 1e the sales.doc_print_format option list; 2 docflow/GL
// chart/payment/purchase/sale categories/parties/items, guarded by the SALE document_type
// existing; 2b expense GL leaves + default expense_category rows) is per-row idempotent -- each
// individually existence-checks its own rows
// before insert, NEVER a single "does this table have any rows at all" guard. That per-row
// discipline is a hard-won lesson from two real bugs hit live in exactly this shape (Wave 2's
// all-or-nothing PERMISSIONS guard, Wave 4's all-or-nothing document-type guard) -- ANY block
// added to this file from now on must follow it from the start. Block 2's own early return was
// fixed for the same reason (Wave 5): it used to `pool.end(); return` as soon as its own guard
// found existing data, which silently skipped every block below it too, on any already-seeded
// database -- it now only skips its OWN transaction, so 2b (and any future always-runs block)
// still gets a chance to top up whatever it individually owns. Re-running against a fully seeded
// database is a no-op instead of duplicating rows (MySQL UNIQUE indexes treat every NULL as
// distinct, which would otherwise let the tenant_id-nullable `role` table's system rows re-insert
// on every run).
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { createDb, createDbPool } from "../client";
import {
  adjustmentReasons,
  appUsers,
  branches,
  cashBankAccounts,
  customers,
  docSeries,
  docSeriesCounters,
  documentTypes,
  expenseCategories,
  fiscalPeriods,
  fiscalYears,
  glAccountCategories,
  glAccountMains,
  glAccountSubs,
  glAccounts,
  items,
  optionItems,
  optionLists,
  paymentMethods,
  permissions,
  purchaseCategories,
  rolePermissions,
  roles,
  saleCategories,
  salesmen,
  suppliers,
  tenants,
  userRoles,
} from "../schema/index";

const ROLE_KEYS = [
  "owner",
  "sys_admin",
  "pharmacy_manager",
  "shift_incharge",
  "sales_officer",
  "purchase_officer",
  "accountant",
  "auditor",
] as const;
type RoleKeySeed = (typeof ROLE_KEYS)[number];

// 20 random bytes -> base64url (~27 chars, no padding): a strong, unguessable dev.owner
// password, generated fresh on every seed run rather than a hardcoded literal (09
// §I.5/§I.6 step 5: "do not migrate any password value" -- extends here to "never hardcode
// one either"). Printed once to stdout below; never written to a committed file.
function generateStrongPassword(): string {
  return randomBytes(20).toString("base64url");
}

// 09-roles-permissions.md §I.4 "Recommended target matrix (starting configuration)", mapped onto
// the actual resource:action pairs apps/api's controllers declare via @RequirePermission() today
// (grep "RequirePermission(" across apps/api/src/modules). `permission.code` (access.ts) IS this
// "resource:action" string -- common/authz/permissions.ts's permissionKey() builds the same
// value app-side, so PermissionsService.can() matches on it directly, no id-translation table
// needed. KNOWN GAP (see common/authz/permissions.service.ts's header): this grants whole
// resource+action pairs only -- §I.4's "◐ conditional" (scope/limit-bound) cells are collapsed to
// a plain grant here; row-level scope and numeric limits (role_scope/role_limit, not yet modelled
// in access.ts) are real follow-up work, not silently assumed away.
const PERMISSIONS: ReadonlyArray<{
  readonly resource: string;
  readonly action: string;
  readonly name: string;
  readonly isSensitive?: boolean;
  readonly roles: readonly RoleKeySeed[];
}> = [
  // -- Self-service (every role needs to be able to see its own profile, change its own
  // password, and sign itself out) -- distinct resource keys from the admin-only identity.user.*
  // rows below so granting these broadly can never unlock admin user management (see
  // apps/api/src/modules/auth/api/auth.controller.ts's header comments on this exact point).
  { resource: "identity.user", action: "view", name: "View own profile", roles: ROLE_KEYS },
  { resource: "identity.credential", action: "edit", name: "Change own password", roles: ROLE_KEYS },
  { resource: "identity.session", action: "delete", name: "Sign out (revoke own session)", roles: ROLE_KEYS },
  { resource: "settings.option", action: "list", name: "List option-set values", roles: ROLE_KEYS },

  // -- Owner/sys_admin-only platform administration --
  { resource: "identity.user", action: "list", name: "List users", isSensitive: true, roles: ["owner", "sys_admin"] },
  { resource: "identity.user", action: "create", name: "Create a user", isSensitive: true, roles: ["owner", "sys_admin"] },
  { resource: "identity.user", action: "edit", name: "Edit a user (activate/deactivate)", isSensitive: true, roles: ["owner", "sys_admin"] },
  {
    resource: "identity.user_role",
    action: "edit",
    name: "Assign roles to a user",
    isSensitive: true,
    roles: ["owner", "sys_admin"],
  },
  { resource: "identity.role", action: "list", name: "List roles", roles: ["owner", "sys_admin"] },
  { resource: "identity.permission", action: "list", name: "List permissions", roles: ["owner", "sys_admin"] },

  // -- Item catalogue (browsing; §I.4's "item view cost/margin" row narrows further once
  // field-level permission exists -- see permissions.service.ts's known-gap note) --
  {
    resource: "catalog.item",
    action: "list",
    name: "List items",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "catalog.item",
    action: "view",
    name: "View an item",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },
  // 09 §I.4's target matrix has no dedicated "item edit"/"item deactivate" row (only "item
  // create" -- pharmacy_manager/shift_incharge ●, purchase_officer ◐ from PO -- and "item
  // reprice" -- pharmacy_manager ●, shift_incharge ◐ ≤ limit -- neither of which is "edit any
  // field" or "deactivate"). Per this task's explicit fallback instruction, granted to
  // owner/sys_admin/pharmacy_manager as a reasonable default pending an owner sign-off on the
  // real matrix (same "diff report, have the owner sign it" process 09 §I.6 step 4 describes).
  {
    resource: "catalog.item",
    action: "edit",
    name: "Edit an item's own fields (name, pricing, etc)",
    isSensitive: true,
    roles: ["owner", "sys_admin", "pharmacy_manager"],
  },
  {
    resource: "catalog.item",
    action: "deactivate",
    name: "Deactivate an item",
    isSensitive: true,
    roles: ["owner", "sys_admin", "pharmacy_manager"],
  },

  // -- Inventory / stock adjustments --
  {
    resource: "inventory.adjustment",
    action: "list",
    name: "List stock adjustments",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "accountant", "auditor"],
  },
  {
    resource: "inventory.adjustment",
    action: "view",
    name: "View a stock adjustment",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "accountant", "auditor"],
  },
  {
    resource: "inventory.adjustment",
    action: "create",
    name: "Create a stock adjustment",
    roles: ["pharmacy_manager", "shift_incharge"],
  },
  {
    resource: "inventory.adjustment",
    action: "post",
    name: "Post a stock adjustment",
    roles: ["pharmacy_manager", "shift_incharge"],
  },
  {
    resource: "inventory.adjustment",
    action: "approve",
    name: "Approve a stock adjustment",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },
  {
    resource: "inventory.stock",
    action: "list",
    name: "View stock levels",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },

  // -- Inventory / stock takes (physical counts). list/view/create mirror `inventory.adjustment`'s
  // own role sets exactly (same read/write split: owner+pharmacy_manager+shift_incharge+
  // accountant+auditor read, pharmacy_manager+shift_incharge write); "count" (recording counted
  // quantities) is granted to the same operational role set as "create" -- the staff who run a
  // count are the staff who enter it. "generate_adjustments" and "close" mirror
  // `inventory.adjustment:approve` exactly (owner/pharmacy_manager only, isSensitive) -- both are
  // the moment a count's variance becomes a real, posted GL-affecting document (or, for close,
  // the point after which it cannot be revisited), the same seriousness this task's own
  // instruction draws between approving vs. merely creating an adjustment.
  {
    resource: "inventory.stock_take",
    action: "list",
    name: "List stock takes",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "accountant", "auditor"],
  },
  {
    resource: "inventory.stock_take",
    action: "view",
    name: "View a stock take (detail, variance)",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "accountant", "auditor"],
  },
  {
    resource: "inventory.stock_take",
    action: "create",
    name: "Create a stock take and generate its count sheet",
    roles: ["pharmacy_manager", "shift_incharge"],
  },
  {
    resource: "inventory.stock_take",
    action: "count",
    name: "Record counted quantities on a stock take",
    roles: ["pharmacy_manager", "shift_incharge"],
  },
  {
    resource: "inventory.stock_take",
    action: "generate_adjustments",
    name: "Turn a stock take's variance into posted stock adjustments",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },
  {
    resource: "inventory.stock_take",
    action: "close",
    name: "Close a stock take",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },

  // -- Inventory / stock lots + expiry dashboard (post-audit addition: the FEFO expiry fix,
  // GET /stock-lots/{id}, POST /stock-lots/{id}/hold|release, GET /inventory/expiry-dashboard).
  // 18-api-plan.md §2.5 documents this feature under a *different* scheme -- a `stock_lot`
  // resource key with `lot.hold`/`lot.release`/`lot.view` verbs, hold granted to MGR/SHF, release
  // to MGR only -- but this task's explicit instruction was to key these under `inventory.stock_lot`
  // (view/hold/release) and `inventory.expiry` (view_dashboard), with hold/release restricted
  // exactly like `inventory.adjustment:approve` (owner/pharmacy_manager only). Followed verbatim
  // per that explicit instruction, same "diff report, have the owner sign it" reconciliation this
  // file's other explicit-fallback rows (catalog.item:edit/:deactivate, purchase.order:close/
  // :cancel) already flag pending a real matrix sign-off.
  {
    resource: "inventory.stock_lot",
    action: "view",
    name: "View a stock lot's detail",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "inventory.stock_lot",
    action: "hold",
    name: "Hold (quarantine) a stock lot",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },
  {
    resource: "inventory.stock_lot",
    action: "release",
    name: "Release a held stock lot back to available",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },
  {
    resource: "inventory.expiry",
    action: "view_dashboard",
    name: "View the expiry dashboard",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },

  // -- Purchasing (§I.3: purchase_officer creates/edits but per §I.4 does NOT post unaided --
  // this Phase 1 API has a single combined create-and-post endpoint, so `purchase:create` is the
  // whole capability until create/post split into separate endpoints; tracked as a follow-up, not
  // silently narrowed) --
  {
    resource: "purchase",
    action: "list",
    name: "List purchase invoices",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase",
    action: "view",
    name: "View a purchase invoice",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase",
    action: "create",
    name: "Create + post a purchase invoice",
    roles: ["pharmacy_manager", "shift_incharge", "purchase_officer"],
  },
  {
    resource: "purchase.supplier",
    action: "list",
    name: "List suppliers",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase.supplier",
    action: "view",
    name: "View a supplier",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase.supplier",
    action: "create",
    name: "Create a supplier",
    roles: ["pharmacy_manager", "shift_incharge", "purchase_officer"],
  },
  {
    resource: "purchase.supplier",
    action: "edit",
    name: "Edit a supplier's own fields",
    roles: ["pharmacy_manager", "shift_incharge", "purchase_officer"],
  },
  {
    resource: "purchase.supplier",
    action: "deactivate",
    name: "Deactivate a supplier",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },
  {
    resource: "purchase.supplier",
    action: "view_ledger",
    name: "View a supplier's AP sub-ledger",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager", "purchase_officer", "accountant", "auditor"],
  },

  // -- Purchase orders (commitment/intent documents -- never touch stock or the GL, see
  // purchase-order.service.ts's header comment). list/view/create mirror `purchase`/
  // `purchase.supplier`'s existing role sets exactly; `approve` mirrors
  // `inventory.adjustment:approve` exactly (owner/pharmacy_manager only, isSensitive) per this
  // task's explicit instruction. `close`/`cancel` are given no such explicit precedent to mirror
  // -- granted to the same operational role set as `create` (the people who actually manage a
  // PO's lifecycle day to day), pending an owner sign-off on the real matrix, same fallback
  // convention catalog.item:edit/:deactivate above already documents.
  {
    resource: "purchase.order",
    action: "list",
    name: "List purchase orders",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase.order",
    action: "view",
    name: "View a purchase order",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase.order",
    action: "create",
    name: "Create a purchase order",
    roles: ["pharmacy_manager", "shift_incharge", "purchase_officer"],
  },
  {
    resource: "purchase.order",
    action: "approve",
    name: "Approve a purchase order",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },
  {
    resource: "purchase.order",
    action: "close",
    name: "Close a purchase order",
    roles: ["pharmacy_manager", "shift_incharge", "purchase_officer"],
  },
  {
    resource: "purchase.order",
    action: "cancel",
    name: "Cancel a purchase order",
    roles: ["pharmacy_manager", "shift_incharge", "purchase_officer"],
  },

  // -- Purchase returns (goods back to a supplier -- touches stock AND the GL, same seriousness
  // as `purchase`, just the reverse direction; see purchase-return.service.ts's header comment).
  // Per this task's explicit instruction: purchase_officer/pharmacy_manager/shift_incharge
  // create; owner/pharmacy_manager/purchase_officer/accountant/auditor view (list mirrors view).
  {
    resource: "purchase.return",
    action: "list",
    name: "List purchase returns",
    roles: ["owner", "pharmacy_manager", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase.return",
    action: "view",
    name: "View a purchase return",
    roles: ["owner", "pharmacy_manager", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "purchase.return",
    action: "create",
    name: "Create + post a purchase return",
    roles: ["purchase_officer", "pharmacy_manager", "shift_incharge"],
  },

  // -- Sales (cash-only this increment, 00b D5) --
  {
    resource: "sale.customer",
    action: "list",
    name: "List customers",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "accountant", "auditor"],
  },
  {
    resource: "sale.customer",
    action: "view",
    name: "View a customer",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "accountant", "auditor"],
  },
  {
    resource: "sale.customer",
    action: "create",
    name: "Create a customer",
    roles: ["pharmacy_manager", "shift_incharge", "sales_officer"],
  },
  {
    resource: "sale.customer",
    action: "edit",
    name: "Edit a customer's own fields",
    roles: ["pharmacy_manager", "shift_incharge", "sales_officer"],
  },
  {
    resource: "sale.customer",
    action: "deactivate",
    name: "Deactivate a customer",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager"],
  },
  {
    resource: "sale.customer",
    action: "view_ledger",
    name: "View a customer's AR sub-ledger",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "sale.cash",
    action: "list",
    name: "List cash sale invoices",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "accountant", "auditor"],
  },
  {
    resource: "sale.cash",
    action: "view",
    name: "View a cash sale invoice",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "accountant", "auditor"],
  },
  {
    resource: "sale.cash",
    action: "create",
    name: "Create a cash sale",
    roles: ["pharmacy_manager", "shift_incharge", "sales_officer"],
  },

  // -- Sale returns (goods back from a customer -- touches stock AND the GL, same seriousness as
  // `sale.cash`, just the reverse direction; see sale-returns.service.ts's header comment).
  // Role sets mirror `purchase.return`'s exact pattern (this task's explicit instruction),
  // swapped onto the sales-side role names: sales_officer/pharmacy_manager/shift_incharge create;
  // owner/pharmacy_manager/sales_officer/accountant/auditor view (list mirrors view).
  {
    resource: "sale.return",
    action: "list",
    name: "List sale returns",
    roles: ["owner", "pharmacy_manager", "sales_officer", "accountant", "auditor"],
  },
  {
    resource: "sale.return",
    action: "view",
    name: "View a sale return",
    roles: ["owner", "pharmacy_manager", "sales_officer", "accountant", "auditor"],
  },
  {
    resource: "sale.return",
    action: "create",
    name: "Create + post a sale return",
    roles: ["sales_officer", "pharmacy_manager", "shift_incharge"],
  },

  // -- Wave 5: GL/chart-of-accounts, manual accounting vouchers, payments, cash-bank, expenses --
  // shared foundation only (schema/permissions/seed/module skeletons); the posting services
  // themselves are built by three follow-up agents. Role grants below follow
  // docs/system-analysis/09-roles-permissions.md §I.4's explicit matrix where a row exists
  // (`gl.voucher create/post` -> accountant only; `gl.ledger view` -> owner/pharmacy_manager/
  // accountant/auditor), and this task's own documented fallback everywhere else §I.4 is silent:
  // accountant gets full access (view/list/create/edit/post/cancel/reverse as applicable);
  // owner/pharmacy_manager/auditor get view/list only; purchase_officer/sales_officer get
  // `create` (never `post`) on `payment`/`expense` only -- money-out/expense entry tied to their
  // own domain, mirroring how `purchase:create` already means "the whole capability" pending a
  // real create/post split (see that resource's own comment above) while `purchase post` itself
  // stays owner/pharmacy_manager-only per §I.4; sys_admin gets none of these (financial data, not
  // system administration) even though 18-api-plan.md Part 5 sometimes annotates its own SYS role
  // on config-table endpoints (payment-methods, gl main/category/sub-accounts) -- §I.4 is the
  // authoritative source per this task's own instruction and it has no gl.*/payment*/expense*
  // row granting sys_admin anything, so the fallback (sys_admin: none) wins. 18-api-plan.md §5.2
  // additionally suggests shift_incharge get conditional expense-create access "below a
  // configurable ceiling" -- not granted here since the role_limit/ceiling machinery this would
  // need does not exist yet (same KNOWN GAP this file's own header comment already documents for
  // every other "◐ conditional" cell); a follow-up once role_limit lands, not silently assumed.

  // -- gl.account: chart of accounts (levels 1-4). No explicit §I.4 row -> fallback.
  {
    resource: "gl.account",
    action: "list",
    name: "List chart-of-accounts entries",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "gl.account",
    action: "view",
    name: "View a chart-of-accounts entry",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  { resource: "gl.account", action: "create", name: "Add a GL account", isSensitive: true, roles: ["accountant"] },
  { resource: "gl.account", action: "edit", name: "Rename / re-point a GL account", isSensitive: true, roles: ["accountant"] },
  {
    resource: "gl.account",
    action: "deactivate",
    name: "Deactivate a GL account",
    isSensitive: true,
    roles: ["accountant"],
  },

  // -- gl.ledger: journal-entry browsing / account ledger, read-only. §I.4 explicit row: "gl.ledger
  // view" -> owner/pharmacy_manager/accountant/auditor.
  {
    resource: "gl.ledger",
    action: "list",
    name: "Browse journal entries",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "gl.ledger",
    action: "view",
    name: "View one journal entry / an account's ledger",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  // Distinct action from "view" -- GET /gl/accounts/:id/ledger and GET /cash-bank/book
  // (apps/api/src/modules/accounting) check this action specifically, not "view". Same role
  // grant as "view"/"list" per the identical §I.4 cell; added post-hoc during Wave 5 integration
  // after live verification surfaced the accounting module built against "view_ledger" (matching
  // its own task instruction) while this block only ever seeded "list"/"view".
  {
    resource: "gl.ledger",
    action: "view_ledger",
    name: "View an account's running-balance ledger",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },

  // -- gl.voucher: manual accounting vouchers (JV/CP/CR/BP/BR). §I.4 explicit row: "gl.voucher
  // create/post" -> accountant ONLY, every other role denied. cancel/reverse follow the same cell
  // (fallback) since the ledger's own append-only rule means a wrong voucher is undone by the
  // identical accountant-only reversal path, never a plain edit.
  {
    resource: "gl.voucher",
    action: "list",
    name: "List manual vouchers",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "gl.voucher",
    action: "view",
    name: "View a manual voucher",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  { resource: "gl.voucher", action: "create", name: "Create a manual voucher", isSensitive: true, roles: ["accountant"] },
  { resource: "gl.voucher", action: "post", name: "Post a manual voucher", isSensitive: true, roles: ["accountant"] },
  { resource: "gl.voucher", action: "cancel", name: "Cancel a manual voucher", isSensitive: true, roles: ["accountant"] },
  { resource: "gl.voucher", action: "reverse", name: "Reverse a posted manual voucher", isSensitive: true, roles: ["accountant"] },

  // -- cash_bank: cash/bank accounts, cash & bank book, transfers, reconciliations. No explicit
  // §I.4 row -> fallback (not a `payment`/`expense` document, so no purchase/sales-officer grant).
  {
    resource: "cash_bank",
    action: "list",
    name: "List cash/bank accounts and their books",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "cash_bank",
    action: "view",
    name: "View a cash/bank account's book",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "cash_bank",
    action: "create",
    name: "Open a cash/bank account or record a transfer",
    isSensitive: true,
    roles: ["accountant"],
  },
  {
    resource: "cash_bank",
    action: "post",
    name: "Post a transfer or complete a reconciliation",
    isSensitive: true,
    roles: ["accountant"],
  },
  {
    resource: "cash_bank",
    action: "reverse",
    name: "Reverse a cash/bank transfer",
    isSensitive: true,
    roles: ["accountant"],
  },

  // -- payment: supplier/customer/other-party payments and receipts (R2.1). No explicit §I.4 row
  // -> fallback, including the purchase_officer/sales_officer `create`-not-`post` grant.
  {
    resource: "payment",
    action: "list",
    name: "List payments",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "payment",
    action: "view",
    name: "View a payment and its allocations",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "payment",
    action: "create",
    name: "Record a payment or receipt",
    roles: ["accountant", "purchase_officer", "sales_officer"],
  },
  { resource: "payment", action: "edit", name: "Edit / (re)allocate a payment", roles: ["accountant"] },
  { resource: "payment", action: "post", name: "Post a payment", isSensitive: true, roles: ["accountant"] },
  { resource: "payment", action: "cancel", name: "Cancel a payment", isSensitive: true, roles: ["accountant"] },
  { resource: "payment", action: "reverse", name: "Reverse a posted payment", isSensitive: true, roles: ["accountant"] },

  // -- payment_method: the D9 lookup table itself (Cash/Bank transfer/Cheque/...). No explicit
  // §I.4 row -> fallback; this is shared config, not a purchase/sales-officer-owned document, so
  // no create grant for those two roles here (unlike `payment` above).
  {
    resource: "payment_method",
    action: "list",
    name: "List payment methods",
    // shift_incharge/sales_officer added post-hoc during Wave 5 integration: the payments module
    // agent's own report flagged that its canonical `GET /payment-methods` route collided with and
    // replaced an older sale-module lookups route (gated on `sale.cash:list`, which those two
    // roles already held) that POS/checkout used to pick a payment method at sale time. Without
    // this grant those roles would regress -- lose a capability they had before this wave -- not
    // gain nothing.
    roles: ["owner", "pharmacy_manager", "accountant", "auditor", "shift_incharge", "sales_officer"],
  },
  {
    resource: "payment_method",
    action: "view",
    name: "View a payment method",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "payment_method",
    action: "create",
    name: "Add a payment method",
    isSensitive: true,
    roles: ["accountant"],
  },
  {
    resource: "payment_method",
    action: "edit",
    name: "Edit / enable / disable a payment method",
    isSensitive: true,
    roles: ["accountant"],
  },

  // -- expense: business expenses (R2.2). No explicit §I.4 row -> fallback, mirroring `payment`.
  {
    resource: "expense",
    action: "list",
    name: "List expenses",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "expense",
    action: "view",
    name: "View an expense",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "expense",
    action: "create",
    name: "Record an expense",
    roles: ["accountant", "purchase_officer", "sales_officer"],
  },
  { resource: "expense", action: "edit", name: "Edit a draft expense", roles: ["accountant"] },
  { resource: "expense", action: "post", name: "Post an expense", isSensitive: true, roles: ["accountant"] },
  { resource: "expense", action: "cancel", name: "Cancel an expense", isSensitive: true, roles: ["accountant"] },
  { resource: "expense", action: "reverse", name: "Reverse a posted expense", isSensitive: true, roles: ["accountant"] },

  // -- expense_category: the taxonomy table (glAccountId NOT NULL, §5.2). No explicit §I.4 row ->
  // fallback; shared config, same reasoning as `payment_method` above.
  {
    resource: "expense_category",
    action: "list",
    name: "List expense categories",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "expense_category",
    action: "view",
    name: "View an expense category",
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },
  {
    resource: "expense_category",
    action: "create",
    name: "Add an expense category",
    isSensitive: true,
    roles: ["accountant"],
  },
  {
    resource: "expense_category",
    action: "edit",
    name: "Edit an expense category",
    isSensitive: true,
    roles: ["accountant"],
  },

  // -- Wave 6: reporting registry, real audit-log reads, in-app notifications, dashboard
  // aggregates -- the four resources this wave's permissions.ts RESOURCE_KEYS addition lays down.
  // These rows are appended to the SAME `PERMISSIONS` array block 1b already walks per-row
  // (existence-checked by `code`, grants existence-checked by role) -- no new guard needed; that
  // is exactly what "per-row idempotent from day one" buys a later wave.
  //
  // `report` -- 09 §I.4's explicit row (~line 1152-1179): "report view/print" -> owner(full)
  // pharmacy_manager(full) shift_incharge/sales_officer/purchase_officer(◐ own-scope only)
  // accountant(full) auditor(full) sys_admin(none). The ◐ "own scope" cells are collapsed to a
  // plain grant here, same documented KNOWN GAP as every other ◐ cell in this file (row-level
  // scope isn't modelled yet, see this block's own header comment above PERMISSIONS) -- the three
  // "own scope" roles are still granted list/view, just not (yet) narrowed to their own records.
  // "report export(logged)" -> owner/pharmacy_manager/accountant(full), auditor(◐ logged/partial),
  // others none.
  {
    resource: "report",
    action: "list",
    name: "List available reports",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "report",
    action: "view",
    name: "Run / view a report",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },
  {
    resource: "report",
    action: "export",
    name: "Export a report (logged)",
    isSensitive: true,
    roles: ["owner", "pharmacy_manager", "accountant", "auditor"],
  },

  // `audit` -- 09 §I.4's explicit row: "audit.read" -> owner/sys_admin/auditor(full),
  // pharmacy_manager/accountant(◐ partial), others none. There is no separate "read" verb in this
  // file's ACTION_KEYS -- per this task's explicit instruction, split into "list" (browsing the
  // trail) for the coarser action and "view" (single-event detail) for the finer one, both
  // granted to the same role set (the §I.4 cell does not distinguish list vs. view granularity).
  {
    resource: "audit",
    action: "list",
    name: "Browse the audit trail",
    isSensitive: true,
    roles: ["owner", "sys_admin", "auditor", "pharmacy_manager", "accountant"],
  },
  {
    resource: "audit",
    action: "view",
    name: "View a single audit event's detail",
    isSensitive: true,
    roles: ["owner", "sys_admin", "auditor", "pharmacy_manager", "accountant"],
  },

  // `notification` -- 09 §I.4 has NO explicit row for this (a Wave 6 addition, not part of the
  // original blueprint's role matrix). Judgement call, per this task's explicit instruction:
  // notifications are per-user data -- a user only ever lists/views/marks-read notifications
  // addressed to THEM (recipientUserId) or broadcast to a role they hold (recipientRoleKey), so
  // the resource+action pair itself is not privileged the way e.g. `identity.user:list` is; the
  // real privilege boundary is "is this notification actually addressed to me", which the
  // notifications module's service layer enforces per-row, not this permission grant. Granted to
  // ALL 8 roles including sys_admin (unlike `dashboard` below) -- sys_admin is still a person who
  // can receive e.g. a system-class notification and needs to be able to read/dismiss their own.
  {
    resource: "notification",
    action: "list",
    name: "List my notifications",
    roles: ROLE_KEYS,
  },
  {
    resource: "notification",
    action: "view",
    name: "View a notification's detail",
    roles: ROLE_KEYS,
  },
  {
    resource: "notification",
    action: "edit",
    name: "Mark my notification(s) read",
    roles: ROLE_KEYS,
  },

  // `dashboard` -- 09 §I.4 has no explicit row either. Judgement call, per this task's explicit
  // instruction: dashboard summary content is read-only OPERATIONAL/FINANCIAL visibility (stock
  // levels, sales/purchase totals, AP/AR aging, expiry risk -- the same data `inventory.expiry:
  // view_dashboard` already exposes a slice of), not system administration, so it follows that
  // resource's exact existing role set (owner/pharmacy_manager/shift_incharge/sales_officer/
  // purchase_officer/accountant/auditor) rather than ROLE_KEYS -- sys_admin is deliberately
  // excluded, same reasoning §I.4 already gives sys_admin "none" on every operational/financial
  // resource in this file (report, gl.ledger, sale.*, purchase.*, etc.) and reserves sys_admin for
  // platform administration (identity.*, settings.*) instead.
  {
    resource: "dashboard",
    action: "view_dashboard",
    name: "View the operational dashboard",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "purchase_officer", "accountant", "auditor"],
  },

  // -- Wave 7: option-list/option-item admin CRUD (`settings.option`), plus the `sale.cash`/
  // `sale.return` cancel/reverse/print lifecycle actions. Appended as its own wave-labelled block
  // (not spliced into the original "Self-service"/"Sales" sections above) -- the same convention
  // Wave 5 and Wave 6 already established for this array: keep each wave's additions together
  // under their own header comment so the wave history stays visible in a diff, rather than
  // scattering new rows across old domain groupings. Every row below is existence-checked by the
  // SAME per-row block 1b loop above (by resource+action `code`, grants by role) -- no new guard
  // needed, exactly what "per-row idempotent from day one" buys a later wave.
  //
  // `settings.option` create/edit -- a new admin CRUD surface this wave for actually authoring
  // option lists/items (previously only `settings.option:list` existed -- read-only, granted to
  // every role above under "Self-service"). No explicit 09 §I.4 row exists for option-list
  // administration (checked the full matrix in I.4: no "option"/"lookup"/"basic data" row at all;
  // the nearest neighbour, `admin.preferences`, only covers sys_admin (full) / pharmacy_manager
  // (◐ business prefs) and is about global preferences, not this resource). This task's suggested
  // precedent, `payment_method:create`/`:edit` (accountant-only, isSensitive, see above), does NOT
  // transfer directly: payment_method is a single-domain config table with one obvious functional
  // owner (accountant owns payment methods end to end). `settings.option` is the opposite -- a
  // generic, cross-cutting mechanism whose existing lists already span sales
  // (`sale.tender_method`), inventory (`stock_adjustment.reason`), accounting
  // (`accounting.voucher_category`) and now sales print-format (below) -- no single domain role
  // owns it. The closer precedent already in this file is `catalog.item:edit`/`:deactivate`
  // (above, in the item-catalogue section): also a broad, cross-cutting resource with no explicit
  // §I.4 row, resolved there to owner/sys_admin/pharmacy_manager as a reasonable admin default
  // pending a real matrix sign-off -- followed here for the identical reason.
  {
    resource: "settings.option",
    action: "create",
    name: "Create an option list or option item",
    isSensitive: true,
    roles: ["owner", "sys_admin", "pharmacy_manager"],
  },
  {
    resource: "settings.option",
    action: "edit",
    name: "Edit an option list or option item",
    isSensitive: true,
    roles: ["owner", "sys_admin", "pharmacy_manager"],
  },

  // `sale.cash`/`sale.return` cancel/reverse -- undoing a posted cash sale or sale return. 09
  // §I.4 has no row literally named "cancel"/"reverse" for either resource, but it DOES have the
  // closest real analogue: `sale.cash` "unpost / edit-posted" is the only row in the whole matrix
  // that covers touching an already-posted sale document, and it is explicit and narrow: owner ○,
  // sys_admin ○, pharmacy_manager ◐ break-glass, shift_incharge ○, sales_officer ○,
  // purchase_officer ○, accountant ◐ break-glass, auditor ○. Mirrored onto both new verbs on both
  // resources (collapsing the ◐ break-glass qualifier to a plain grant -- the same documented
  // KNOWN GAP as every other ◐ cell in this file): roles = pharmacy_manager, accountant only.
  // Notably NOT owner -- consistent with 09 §I.3's own description of the `owner` role ("Sees all
  // financials + reports; **cannot** post transactions"), which this exact table row already
  // reflects (owner is ○ here even though owner gets full view/list access to the same resource
  // elsewhere in the matrix). This also widens this file's own established convention for
  // cancel/reverse by exactly one role: `gl.voucher`/`payment`/`expense` cancel+reverse are all
  // accountant-only, isSensitive (see those resources above) because they are purely-accounting
  // documents; a cash sale or sale return, by contrast, is a business-side document
  // pharmacy_manager already has full create/edit/post authority over (see `sale.cash:create`/
  // `sale.return:create` above), so its reversal authority tracks that same business-side
  // ownership rather than narrowing to the accounting-only role. `print` mirrors `sale.cash:view`'s
  // exact role set per this task's explicit instruction (reading a document already viewable is
  // not a new privilege boundary) -- not isSensitive, unlike cancel/reverse.
  //
  // No `sale.cash:post` row is added, and none should be: this codebase's sale-invoice/purchase-
  // invoice/payment/expense creation flows are ALL atomic create-and-post in a single transaction
  // (confirmed by reading purchase-invoice.service.ts lines ~195-225 and ~355-380 -- a "draft"
  // status is written as an internal same-transaction placeholder, then the SAME request closes it
  // out to "posted" before the response returns). There is no real, persisted, separately-editable
  // draft state anywhere in this codebase today, for any document type, so "post" as a standalone
  // lifecycle verb for sale-invoices is a no-op this wave -- creation already IS create+post
  // (`POST /sale-invoices`, matching `sale.cash:create`'s own existing name "Create a cash sale",
  // which already covers posting). There is no code path that would ever check a `sale.cash:post`
  // permission, so seeding one would be dead data nobody's endpoint reads -- documented here so
  // whoever reads this later (including the two sibling module-builder agents building on top of
  // this wave) doesn't mistake the omission for something forgotten.
  {
    resource: "sale.cash",
    action: "cancel",
    name: "Cancel a posted cash sale invoice",
    isSensitive: true,
    roles: ["pharmacy_manager", "accountant"],
  },
  {
    resource: "sale.cash",
    action: "reverse",
    name: "Reverse a posted cash sale invoice",
    isSensitive: true,
    roles: ["pharmacy_manager", "accountant"],
  },
  {
    resource: "sale.cash",
    action: "print",
    name: "Print a cash sale invoice",
    roles: ["owner", "pharmacy_manager", "shift_incharge", "sales_officer", "accountant", "auditor"],
  },
  {
    resource: "sale.return",
    action: "cancel",
    name: "Cancel a posted sale return",
    isSensitive: true,
    roles: ["pharmacy_manager", "accountant"],
  },
  {
    resource: "sale.return",
    action: "reverse",
    name: "Reverse a posted sale return",
    isSensitive: true,
    roles: ["pharmacy_manager", "accountant"],
  },
];

// Mirrors apps/api/src/modules/settings/infrastructure/options.repository.ts's former in-memory
// SEED, so swapping the repository to real queries preserves the exact same API responses.
const OPTION_LISTS = [
  {
    listCode: "supplier_payment.method",
    name: "Supplier payment method",
    items: [
      { code: "CASH", name: "Cash", isDefault: true, groupLabel: "Cash", sortOrder: 10 },
      { code: "BANK_TRANSFER", name: "Bank transfer", groupLabel: "Bank", sortOrder: 20, metaJson: { requiresReference: true } },
      { code: "CHEQUE", name: "Cheque", groupLabel: "Bank", sortOrder: 30, metaJson: { requiresReference: true } },
      { code: "BANK_DRAFT", name: "Bank draft / pay order", groupLabel: "Bank", sortOrder: 40, metaJson: { requiresReference: true } },
      { code: "IBFT", name: "Online / IBFT", groupLabel: "Digital wallet", sortOrder: 50 },
      { code: "EASYPAISA", name: "Easypaisa", groupLabel: "Digital wallet", sortOrder: 60 },
      { code: "JAZZCASH", name: "JazzCash", groupLabel: "Digital wallet", sortOrder: 70 },
      { code: "CREDIT_NOTE", name: "Credit-note adjustment", groupLabel: "Adjustment", sortOrder: 80 },
    ],
  },
  {
    listCode: "sale.tender_method",
    name: "Sale tender method",
    items: [
      { code: "CASH", name: "Cash", isDefault: true, sortOrder: 10 },
      { code: "CARD", name: "Card", sortOrder: 20 },
      { code: "MOBILE_WALLET", name: "Mobile wallet", sortOrder: 30 },
      { code: "MIXED", name: "Mixed / split", sortOrder: 40 },
      // Credit ships disabled -- walk-in cash only today (D5); the switch exists, the option is
      // simply off, not removed (P1.3).
      { code: "CREDIT", name: "Credit", sortOrder: 50, isEnabled: false },
    ],
  },
  {
    listCode: "stock_adjustment.reason",
    name: "Stock adjustment reason",
    items: [
      { code: "DAMAGE", name: "Damage", sortOrder: 10 },
      { code: "EXPIRY", name: "Expiry", sortOrder: 20 },
      { code: "THEFT_SHRINKAGE", name: "Theft / shrinkage", sortOrder: 30 },
      { code: "COUNT_CORRECTION", name: "Count correction", sortOrder: 40 },
      { code: "SAMPLE_DONATION", name: "Sample / donation", sortOrder: 50 },
      { code: "BREAKAGE", name: "Breakage", sortOrder: 60 },
      // Deliberately no default (§10.5): a defaulted reason would perpetuate the legacy's
      // unexplained-shrinkage problem (03 T1-31).
      { code: "OTHER", name: "Other", sortOrder: 70 },
    ],
  },
] as const;

// ---------------------------------------------------------------------------------------------
// Block 2 fixture data -- the docflow/GL/parties/catalog rows the posting flows need.
// ---------------------------------------------------------------------------------------------

// §T04-§T06: one document_type per document kind, one doc_series (never-reset, pad 6) per type,
// one '*' counter row per series primed at 1. Seeded by Block 1c below, per-row idempotent --
// this array is safe to extend in a future wave and re-seed against an already-seeded database
// (this was a real gap, hit live: STOCK_TAKE/STK below wasn't seeded on an already-seeded dev DB
// until Block 1c was added specifically to fix it, same shape as block 1b's own earlier fix).
const DOC_TYPES = [
  { code: "SALE", name: "Sale invoice", seriesCode: "SV", prefix: "SV-" },
  { code: "SALE_RETURN", name: "Sale return", seriesCode: "SR", prefix: "SR-" },
  { code: "PURCHASE", name: "Purchase invoice", seriesCode: "PV", prefix: "PV-" },
  { code: "PURCHASE_RETURN", name: "Purchase return", seriesCode: "PR", prefix: "PR-" },
  { code: "PURCHASE_ORDER", name: "Purchase order", seriesCode: "PO", prefix: "PO-" },
  { code: "ADJUSTMENT", name: "Stock adjustment", seriesCode: "ADJ", prefix: "ADJ-" },
  { code: "STOCK_TAKE", name: "Stock take", seriesCode: "STK", prefix: "STK-" },
  // Wave 5 (GL/payments/expenses foundation). Document-type `code` follows the existing
  // full-word convention (SALE, PURCHASE_RETURN, ...); `seriesCode`/`prefix` are the short codes
  // this task's own instruction names verbatim ("JV", "PMT", "EXP", "CBT") -- these are the values
  // that actually flow through the system at runtime: DocNumberService.allocate(tx, tenantId,
  // seriesCode) and JournalService.post's documentTypeCode both key off seriesCode, not this
  // table's own `code` column (see purchase-invoice.service.ts: `docNumbers.allocate(tx,
  // tenantId, "PV")` and `documentTypeCode: "PV"`, both the series code, never "PURCHASE").
  // JV covers ALL manual voucher categories (CP/CR/BP/BR/JV) -- voucher_category is a business
  // classification captured via the option_list seeded below, not a separate document type/series
  // per category (task instruction).
  { code: "JOURNAL_VOUCHER", name: "Journal voucher", seriesCode: "JV", prefix: "JV-" },
  { code: "PAYMENT", name: "Payment / receipt", seriesCode: "PMT", prefix: "PMT-" },
  { code: "EXPENSE", name: "Expense", seriesCode: "EXP", prefix: "EXP-" },
  { code: "CASH_BANK_TRANSFER", name: "Cash/bank transfer", seriesCode: "CBT", prefix: "CBT-" },
] as const;

// §5 (option_list `voucher_category`, task instruction) -- the 22-legacy-category system
// collapses onto 5 fixed classifications for the single JV document type. Fixed system
// classification (`isAdminExtensible: false`), not admin-curatable like ordinary P1 option lists.
// headerSide/detailSide are "debit"/"credit" strings (07-accounting-logic.md §5.1's C/D columns,
// D=debit/C=credit): JV has no restriction (free-form, both sides chosen per line);
// CP/CR restrict the header leg's cash-bank account to accountKind in (cash_drawer, petty_cash);
// BP/BR restrict it to accountKind = bank (07 §5.1's VocherCategoryHeader SubAccCode restriction,
// Verified: "CP/CR -> SubAcc 2 CASH IN HAND, BP/BR -> SubAcc 4 CASH AT BANK").
// "accounting.voucher_category", not bare "voucher_category" -- the generic settings/options
// admin endpoint (settings/api/dto/option-value.dto.ts) requires every list key to match
// /^[a-z0-9_]+(\.[a-z0-9_]+)+$/ ("module.concept", e.g. "sale.tender_method"); a bare code fails
// that regex and the list becomes unreachable through GET /settings/options/:key. Found and fixed
// during Wave 5 integration live-verification, before any consumer (frontend, other seed data)
// referenced the old bare code, so this is a rename, not a migration of live data.
const VOUCHER_CATEGORY_LIST_CODE = "accounting.voucher_category";
const VOUCHER_CATEGORIES = [
  {
    code: "JV",
    name: "Journal Voucher",
    sortOrder: 10,
    isDefault: true,
    metaJson: { headerSide: null, detailSide: null, requiredCashBankAccountKind: null },
  },
  {
    code: "CP",
    name: "Cash Payment",
    sortOrder: 20,
    isDefault: false,
    metaJson: { headerSide: "credit", detailSide: "debit", requiredCashBankAccountKind: ["cash_drawer", "petty_cash"] },
  },
  {
    code: "CR",
    name: "Cash Receipt",
    sortOrder: 30,
    isDefault: false,
    metaJson: { headerSide: "debit", detailSide: "credit", requiredCashBankAccountKind: ["cash_drawer", "petty_cash"] },
  },
  {
    code: "BP",
    name: "Bank Payment",
    sortOrder: 40,
    isDefault: false,
    metaJson: { headerSide: "credit", detailSide: "debit", requiredCashBankAccountKind: ["bank"] },
  },
  {
    code: "BR",
    name: "Bank Receipt",
    sortOrder: 50,
    isDefault: false,
    metaJson: { headerSide: "debit", detailSide: "credit", requiredCashBankAccountKind: ["bank"] },
  },
] as const;

// §5 (option_list `sales.doc_print_format`, Wave 7 task instruction) -- this wave implements
// exactly one sale-document print format: a receipt-shaped JSON payload (not a PDF), returned by
// the two sibling module-builder agents' preview/print endpoints this wave. Modelled as an
// option_list/option_item pair for the same P1 reason every other pick-list in this file is
// (never a hardcoded enum -- see options.ts's own header comment), even though today there is
// only one legal value: a second format becomes a second option_item row later, not a schema
// change. "sales.doc_print_format", not a bare code, for the same settings/api/dto/
// option-value.dto.ts regex reason VOUCHER_CATEGORY_LIST_CODE's own comment documents above
// (`/^[a-z0-9_]+(\.[a-z0-9_]+)+$/`, "module.concept").
const PRINT_FORMAT_LIST_CODE = "sales.doc_print_format";
const PRINT_FORMATS = [{ code: "standard_receipt", name: "Standard receipt", sortOrder: 10, isDefault: true }] as const;

// §T23/§T24: Pakistan fiscal year (July-June), all periods open. Dates constructed at UTC
// midnight -- Asia/Karachi is UTC+5 with no DST, so the DATE component never shifts.
const FY_CODE = "FY2027";
const FY_START = new Date(Date.UTC(2026, 6, 1));
const FY_END = new Date(Date.UTC(2027, 5, 30));
const FISCAL_MONTHS = Array.from({ length: 12 }, (_, i) => {
  const year = 2026 + Math.floor((6 + i) / 12);
  const month = ((6 + i) % 12) + 1; // 7..12, 1..6
  return {
    periodKey: `${year}-${String(month).padStart(2, "0")}`,
    startDate: new Date(Date.UTC(year, month - 1, 1)),
    endDate: new Date(Date.UTC(year, month, 0)), // day 0 of next month = last day of this month
  };
});

// §T85-§T88 minimal-but-correct chart, per 07-accounting-logic.md §1-2's legacy account list:
// five mains, one category + sub under each (two under assets/liabilities where the subledger
// kind differs), postable leaves below. Level-1 nature/normal-balance denormalises onto the leaf.
const GL_MAINS = [
  { code: "A", name: "Assets", accountNature: "asset", normalBalance: "debit", sortOrder: 10 },
  { code: "L", name: "Liabilities", accountNature: "liability", normalBalance: "credit", sortOrder: 20 },
  { code: "Q", name: "Equity", accountNature: "equity", normalBalance: "credit", sortOrder: 30 },
  { code: "I", name: "Income", accountNature: "revenue", normalBalance: "credit", sortOrder: 40 },
  { code: "E", name: "Expenses", accountNature: "expense", normalBalance: "debit", sortOrder: 50 },
] as const;

const GL_CATEGORIES = [
  { code: "CUR_ASSETS", name: "Current Assets", mainCode: "A", statementSection: "balance_sheet", presentationOrder: 10 },
  { code: "CUR_LIABILITIES", name: "Current Liabilities", mainCode: "L", statementSection: "balance_sheet", presentationOrder: 20 },
  { code: "CAPITAL", name: "Capital", mainCode: "Q", statementSection: "balance_sheet", presentationOrder: 30 },
  { code: "SALES_INCOME", name: "Revenue from Sales", mainCode: "I", statementSection: "income_statement", presentationOrder: 40 },
  { code: "DIRECT_EXPENSES", name: "Direct Expenses", mainCode: "E", statementSection: "income_statement", presentationOrder: 50 },
] as const;

const GL_SUBS = [
  { code: "CASH_BANK", name: "Cash and Bank", categoryCode: "CUR_ASSETS", subledgerKind: "cash_bank", isControlAccount: false },
  { code: "INVENTORY", name: "Inventory", categoryCode: "CUR_ASSETS", subledgerKind: "inventory", isControlAccount: false },
  { code: "TAX_RECEIVABLE", name: "Tax Receivables", categoryCode: "CUR_ASSETS", subledgerKind: "tax", isControlAccount: false },
  { code: "AR_CONTROL", name: "Accounts Receivable", categoryCode: "CUR_ASSETS", subledgerKind: "customer", isControlAccount: true },
  { code: "AP_CONTROL", name: "Accounts Payable", categoryCode: "CUR_LIABILITIES", subledgerKind: "supplier", isControlAccount: true },
  { code: "OTHER_PAYABLES", name: "Other Payables", categoryCode: "CUR_LIABILITIES", subledgerKind: "tax", isControlAccount: false },
  { code: "OWNER_CAPITAL", name: "Owner Capital", categoryCode: "CAPITAL", subledgerKind: "none", isControlAccount: false },
  { code: "SALES", name: "Sales", categoryCode: "SALES_INCOME", subledgerKind: "none", isControlAccount: false },
  { code: "COST_OF_SALES", name: "Cost of Sales", categoryCode: "DIRECT_EXPENSES", subledgerKind: "expense", isControlAccount: false },
] as const;

// Postable leaves (§T88). `isContra` per §T88's verbatim note: SALES RETURN sits under revenue
// with a debit balance, PURCHASES RETURNS under direct expenses with a credit balance. 2001/1501
// are the per-party control leaves the parties block below binds to (parties.ts Module D:
// a party IS a ledger account, one control account per party, UNIQUE).
const GL_LEAVES = [
  { code: "1000", name: "Cash in Hand", subCode: "CASH_BANK", accountNature: "asset", normalBalance: "debit", isContra: false },
  { code: "1100", name: "Bank", subCode: "CASH_BANK", accountNature: "asset", normalBalance: "debit", isContra: false },
  { code: "1200", name: "Inventory", subCode: "INVENTORY", accountNature: "asset", normalBalance: "debit", isContra: false },
  { code: "1300", name: "Sales Tax Receivable", subCode: "TAX_RECEIVABLE", accountNature: "asset", normalBalance: "debit", isContra: false },
  { code: "1400", name: "Advance Income Tax - Purchase", subCode: "TAX_RECEIVABLE", accountNature: "asset", normalBalance: "debit", isContra: false },
  { code: "1500", name: "Accounts Receivable Control", subCode: "AR_CONTROL", accountNature: "asset", normalBalance: "debit", isContra: false },
  { code: "1501", name: "Walk-in Customer", subCode: "AR_CONTROL", accountNature: "asset", normalBalance: "debit", isContra: false },
  { code: "2000", name: "Accounts Payable Control", subCode: "AP_CONTROL", accountNature: "liability", normalBalance: "credit", isContra: false },
  { code: "2001", name: "Dev Supplier", subCode: "AP_CONTROL", accountNature: "liability", normalBalance: "credit", isContra: false },
  { code: "2100", name: "FBR POS Fee Payable", subCode: "OTHER_PAYABLES", accountNature: "liability", normalBalance: "credit", isContra: false },
  { code: "3000", name: "Capital", subCode: "OWNER_CAPITAL", accountNature: "equity", normalBalance: "credit", isContra: false },
  { code: "4000", name: "Sales", subCode: "SALES", accountNature: "revenue", normalBalance: "credit", isContra: false },
  { code: "4100", name: "Sales Returns", subCode: "SALES", accountNature: "revenue", normalBalance: "debit", isContra: true },
  { code: "5000", name: "Purchases", subCode: "COST_OF_SALES", accountNature: "expense", normalBalance: "debit", isContra: false },
  { code: "5100", name: "Purchase Returns", subCode: "COST_OF_SALES", accountNature: "expense", normalBalance: "credit", isContra: true },
  { code: "5200", name: "COGS", subCode: "COST_OF_SALES", accountNature: "expense", normalBalance: "debit", isContra: false },
  { code: "5300", name: "Stock Adjustment Expense", subCode: "COST_OF_SALES", accountNature: "expense", normalBalance: "debit", isContra: false },
] as const;

// Wave 5 (GL/payments/expenses foundation) -- operating-expense leaves. The existing chart
// (GL_CATEGORIES/GL_SUBS/GL_LEAVES above) only has DIRECT_EXPENSES/COST_OF_SALES (5000-5300,
// Purchases/Purchase Returns/COGS/Stock Adjustment) under the "E" main -- no general operating
// expense (rent, utilities, payroll, ...) leaves exist yet for expense_category to bind to. Adds
// one new category + sub (mirroring the existing chart's own structure exactly) and six leaves in
// the next free 5xxx block (5400-5900) so this pass never collides with 5000-5300. Seeded by the
// always-runs, per-row-idempotent block near the end of main() (not Block 2's single-guard
// transaction) -- same reasoning as Block 1c/1d above.
const EXPENSE_GL_CATEGORY = {
  code: "OPERATING_EXPENSES",
  name: "Operating Expenses",
  mainCode: "E",
  statementSection: "income_statement",
  presentationOrder: 60,
} as const;
const EXPENSE_GL_SUB = {
  code: "OPERATING_EXP",
  name: "Operating Expenses",
  categoryCode: "OPERATING_EXPENSES",
  subledgerKind: "expense",
  isControlAccount: false,
} as const;
const EXPENSE_GL_LEAVES = [
  { code: "5400", name: "Rent Expense", accountNature: "expense", normalBalance: "debit", isContra: false },
  { code: "5500", name: "Utilities Expense", accountNature: "expense", normalBalance: "debit", isContra: false },
  { code: "5600", name: "Salaries and Wages", accountNature: "expense", normalBalance: "debit", isContra: false },
  { code: "5700", name: "Repairs and Maintenance", accountNature: "expense", normalBalance: "debit", isContra: false },
  { code: "5800", name: "Office Supplies Expense", accountNature: "expense", normalBalance: "debit", isContra: false },
  { code: "5900", name: "Miscellaneous Expense", accountNature: "expense", normalBalance: "debit", isContra: false },
] as const;

// Default expense_category rows (task instruction), each bound to a real leaf above.
const EXPENSE_CATEGORIES = [
  { code: "RENT", name: "Rent", glCode: "5400", sortOrder: 10, isDefault: false },
  { code: "UTILITIES", name: "Utilities", glCode: "5500", sortOrder: 20, isDefault: false },
  { code: "SALARIES_WAGES", name: "Salaries & Wages", glCode: "5600", sortOrder: 30, isDefault: false },
  { code: "REPAIRS_MAINTENANCE", name: "Repairs & Maintenance", glCode: "5700", sortOrder: 40, isDefault: false },
  { code: "OFFICE_SUPPLIES", name: "Office Supplies", glCode: "5800", sortOrder: 50, isDefault: false },
  { code: "MISCELLANEOUS", name: "Miscellaneous", glCode: "5900", sortOrder: 60, isDefault: true },
] as const;

// §T94 payment_method -- the D9 seed list, mirroring the supplier_payment.method option list
// above but as the dedicated behavioural table the payments module posts against.
const PAYMENT_METHODS = [
  { code: "CASH", name: "Cash", isDefault: true, isCounterMethod: true, requiresReference: false, requiresChequeDetails: false, sortOrder: 10 },
  { code: "BANK_TRANSFER", name: "Bank transfer", isDefault: false, isCounterMethod: false, requiresReference: true, requiresChequeDetails: false, sortOrder: 20 },
  { code: "CHEQUE", name: "Cheque", isDefault: false, isCounterMethod: false, requiresReference: true, requiresChequeDetails: true, sortOrder: 30 },
  { code: "BANK_DRAFT", name: "Bank draft / pay order", isDefault: false, isCounterMethod: false, requiresReference: true, requiresChequeDetails: false, sortOrder: 40 },
  { code: "IBFT", name: "Online / IBFT", isDefault: false, isCounterMethod: false, requiresReference: false, requiresChequeDetails: false, sortOrder: 50 },
  { code: "EASYPAISA", name: "Easypaisa", isDefault: false, isCounterMethod: false, requiresReference: false, requiresChequeDetails: false, sortOrder: 60 },
  { code: "JAZZCASH", name: "JazzCash", isDefault: false, isCounterMethod: false, requiresReference: false, requiresChequeDetails: false, sortOrder: 70 },
  { code: "CREDIT_NOTE", name: "Credit-note adjustment", isDefault: false, isCounterMethod: false, requiresReference: false, requiresChequeDetails: false, sortOrder: 80 },
  { code: "OTHER", name: "Other", isDefault: false, isCounterMethod: false, requiresReference: false, requiresChequeDetails: false, sortOrder: 90 },
] as const;

// §T84 purchase_category -- the legacy PurCategory seed, category-number rules as data (P1.1).
const PURCHASE_CATEGORIES = [
  { code: "NORMAL_CASH", name: "Normal Purchase Cash", isDefault: true, isReturn: false, isOpening: false, counterparty: "supplier", sortOrder: 10 },
  { code: "NORMAL_CREDIT", name: "Normal Purchase Credit", isDefault: false, isReturn: false, isOpening: false, counterparty: "supplier", sortOrder: 20 },
  // Legacy "opening purchase credits equity" branch (07 §4.2, Verified) -- counterparty as data.
  { code: "OPENING", name: "Opening Purchase", isDefault: false, isReturn: false, isOpening: true, counterparty: "equity", sortOrder: 30 },
  { code: "RETURN_CASH", name: "Purchase Return Cash", isDefault: false, isReturn: true, isOpening: false, counterparty: "supplier", sortOrder: 40 },
  { code: "RETURN_CREDIT", name: "Purchase Return Credit", isDefault: false, isReturn: true, isOpening: false, counterparty: "supplier", sortOrder: 50 },
] as const;

// §T74 sale_category -- counterparty encodes the legacy "cash category debits CashAccCode, else
// CustCode" stored-procedure rule as data (07 §4.1, Verified).
const SALE_CATEGORIES = [
  { code: "CASH_SALE", name: "Cash Sale", isDefault: true, isReturn: false, counterparty: "cash", sortOrder: 10 },
  { code: "CREDIT_SALE", name: "Credit Sale", isDefault: false, isReturn: false, counterparty: "customer_account", sortOrder: 20 },
  { code: "CASH_RETURN", name: "Cash Sale Return", isDefault: false, isReturn: true, counterparty: "cash", sortOrder: 30 },
  { code: "CREDIT_RETURN", name: "Credit Sale Return", isDefault: false, isReturn: true, counterparty: "customer_account", sortOrder: 40 },
] as const;

// §T63 adjustment_reason -- every reason posts (glAccountId NOT NULL -> 5300 Stock Adjustment
// Expense), fixing the legacy's 100%-invisible adjustments (07 §13.3). Default: COUNT_CORRECTION
// (P1.2) -- this dedicated table (unlike the display-only option list above) needs a posting
// default for the API flows.
const ADJUSTMENT_REASONS = [
  { code: "DAMAGE", name: "Damage", isDefault: false, sortOrder: 10 },
  { code: "EXPIRY", name: "Expiry", isDefault: false, sortOrder: 20 },
  // requiresApproval: theft/shrinkage is exactly the case the approval gate (18-api-plan.md
  // §2.6, packages/db/schema/inventory.ts's requiresApproval/approvedBy/approvedAt columns)
  // exists for -- invisible shrinkage with no human sign-off was the legacy defect (07 §13.3).
  { code: "THEFT", name: "Theft / shrinkage", isDefault: false, sortOrder: 30, requiresApproval: true },
  { code: "COUNT_CORRECTION", name: "Count correction", isDefault: true, sortOrder: 40 },
  { code: "BREAKAGE", name: "Breakage", isDefault: false, sortOrder: 50 },
  { code: "DATA_ENTRY_ERROR", name: "Data-entry error", isDefault: false, sortOrder: 60 },
  { code: "OTHER", name: "Other", isDefault: false, sortOrder: 70 },
] as const;

// §T31 item -- two dev items so a purchase -> stock -> sale round-trip has something to move.
// Money/qty as strings, per the repo-wide "never plain JS numbers" rule.
const DEV_ITEMS = [
  { customCode: "PARA500", name: "Paracetamol 500mg Tab", packUnits: 10, salePrice: "25.0000", purchasePrice: "18.0000", hasExpiry: true },
  { customCode: "ORS200", name: "ORS Sachet", packUnits: 1, salePrice: "30.0000", purchasePrice: "22.0000", hasExpiry: true },
] as const;

// Module-scoped (not a local `main()` const) so `main().catch()` below can close it on a throw
// too -- see that handler's comment for why this half of the fix matters as much as the block 2
// guard fix above did.
let pool: ReturnType<typeof createDbPool> | undefined;

async function main(): Promise<void> {
  pool = createDbPool();
  const db = createDb(pool);

  // ---- Block 1: tenant / branch / roles / dev.owner / option lists ----------------------------
  // Guarded by the dev tenant existing (the original single guard, unchanged in meaning).
  const existing = await db.select({ tenantId: tenants.tenantId }).from(tenants).where(eq(tenants.code, "dev"));
  if (existing.length > 0) {
    console.log("Dev tenant already seeded -- base block skipped.");
  } else {
    // Generated once, here, and never written to a committed file (17 §9.1; 09 §I.5/§I.6 step 5
    // "do not migrate any password value" -- extended here to "never hardcode one either"). This
    // is the ONLY point in the codebase that ever sees the plaintext; only its argon2id hash is
    // persisted, below.
    const devOwnerPassword = generateStrongPassword();
    const devOwnerPasswordHash = await argon2.hash(devOwnerPassword, { type: argon2.argon2id });

    await db.transaction(async (tx) => {
      await tx.insert(tenants).values({ code: "dev", name: "Dev Pharmacy", isActive: true });
      const [tenant] = await tx.select({ tenantId: tenants.tenantId }).from(tenants).where(eq(tenants.code, "dev"));
      if (!tenant) throw new Error("Failed to read back the just-inserted dev tenant.");

      await tx.insert(branches).values({ tenantId: tenant.tenantId, code: "main", name: "Main Branch", isDefault: true });
      const [branch] = await tx.select({ branchId: branches.branchId }).from(branches).where(eq(branches.tenantId, tenant.tenantId));
      if (!branch) throw new Error("Failed to read back the just-inserted dev branch.");

      // System roles (09-roles-permissions.md §I.3): tenant_id NULL, available to every tenant.
      await tx.insert(roles).values(
        ROLE_KEYS.map((roleKey) => ({
          roleKey,
          displayName: roleKey,
          isSystem: true,
          isAdmin: roleKey === "owner" || roleKey === "sys_admin",
        })),
      );
      const [ownerRole] = await tx.select({ roleId: roles.roleId }).from(roles).where(eq(roles.roleKey, "owner"));
      if (!ownerRole) throw new Error("Failed to read back the just-inserted owner role.");

      // username "dev.owner", real argon2id credential (generated + hashed above).
      await tx.insert(appUsers).values({
        tenantId: tenant.tenantId,
        defaultBranchId: branch.branchId,
        username: "dev.owner",
        displayName: "Dev Owner",
        passwordHash: devOwnerPasswordHash,
        passwordAlgo: "argon2id",
        mustChangePassword: false,
      });
      const [devOwner] = await tx.select({ userId: appUsers.userId }).from(appUsers).where(eq(appUsers.username, "dev.owner"));
      if (!devOwner) throw new Error("Failed to read back the just-inserted dev owner user.");

      await tx.insert(userRoles).values({ userId: devOwner.userId, roleId: ownerRole.roleId, assignedAt: new Date() });

      for (const list of OPTION_LISTS) {
        await tx.insert(optionLists).values({ tenantId: tenant.tenantId, listCode: list.listCode, name: list.name });
        const [row] = await tx.select({ optionListId: optionLists.optionListId }).from(optionLists).where(eq(optionLists.listCode, list.listCode));
        if (!row) throw new Error(`Failed to read back the just-inserted option list "${list.listCode}".`);

        await tx.insert(optionItems).values(
          list.items.map((item) => ({
            optionListId: row.optionListId,
            tenantId: tenant.tenantId,
            code: item.code,
            name: item.name,
            isSystem: true,
            isDefault: "isDefault" in item ? item.isDefault : false,
            isEnabled: "isEnabled" in item ? item.isEnabled : true,
            sortOrder: item.sortOrder,
            groupLabel: "groupLabel" in item ? item.groupLabel : null,
            metaJson: "metaJson" in item ? item.metaJson : null,
          })),
        );
      }
    });
    console.log("Seeded dev tenant, branch, roles, dev.owner user, and P1 option lists.");
    // Labelled, single-line, easy to grep for after a seed run -- the ONLY place this password is
    // ever printed. Save it now; it is not recoverable afterward (only the argon2id hash persists).
    console.log(`=== DEV OWNER PASSWORD (save this): ${devOwnerPassword} ===`);
  }

  // ---- Block 1b: permission catalogue + role_permission grants --------------------------------
  // Per-row idempotent (NOT a single all-or-nothing "does `permission` have any rows" guard --
  // that shape bit us for real: Wave 1's first seed run inserted the original catalogue, which
  // made every later wave's newly-added PERMISSIONS entries silently never get seeded on
  // subsequent `pnpm run seed` calls, since the block short-circuited before ever looking at
  // them). Every permission row and every role_permission grant is individually existence-checked
  // before inserting, so re-running this after PERMISSIONS grows (a new wave, a new resource, a
  // new role added to an existing permission's grant list) always tops up exactly what's missing
  // and never double-inserts what's already there.
  await db.transaction(async (tx) => {
    const roleRows = await tx.select({ roleId: roles.roleId, roleKey: roles.roleKey }).from(roles).where(eq(roles.isSystem, true));
    const roleIdByKey = new Map(roleRows.map((r) => [r.roleKey, r.roleId]));
    for (const roleKey of ROLE_KEYS) {
      if (!roleIdByKey.has(roleKey)) {
        throw new Error(`Role "${roleKey}" is not seeded yet -- block 1b must run after block 1's role insert.`);
      }
    }

    const now = new Date();
    let permissionsInserted = 0;
    let grantsInserted = 0;
    for (const permission of PERMISSIONS) {
      const code = `${permission.resource}:${permission.action}`;
      let [row] = await tx.select({ permissionId: permissions.permissionId }).from(permissions).where(eq(permissions.code, code));
      if (!row) {
        await tx.insert(permissions).values({
          code,
          name: permission.name,
          permissionKind: "action",
          isSensitive: permission.isSensitive ?? false,
        });
        [row] = await tx.select({ permissionId: permissions.permissionId }).from(permissions).where(eq(permissions.code, code));
        if (!row) throw new Error(`Failed to read back the just-inserted permission "${code}".`);
        permissionsInserted++;
      }

      const existingGrants = await tx
        .select({ roleId: rolePermissions.roleId })
        .from(rolePermissions)
        .where(eq(rolePermissions.permissionId, row.permissionId));
      const grantedRoleIds = new Set(existingGrants.map((g) => g.roleId));

      const missingRoles = permission.roles.filter((roleKey) => {
        const roleId = roleIdByKey.get(roleKey);
        if (roleId === undefined) throw new Error(`Role "${roleKey}" missing for permission "${code}".`); // unreachable; checked above
        return !grantedRoleIds.has(roleId);
      });
      if (missingRoles.length > 0) {
        await tx.insert(rolePermissions).values(
          missingRoles.map((roleKey) => ({
            roleId: roleIdByKey.get(roleKey)!,
            permissionId: row.permissionId,
            grantedAt: now,
          })),
        );
        grantsInserted += missingRoles.length;
      }
    }
    console.log(
      `Permission catalogue: ${permissionsInserted} new permission(s), ${grantsInserted} new role_permission grant(s) (${PERMISSIONS.length} permissions checked).`,
    );
  });

  // ---- Block 1c: document types / doc series / counters (per-row idempotent) -------------------
  // Independently guarded per docType.code (not a single "does DOC_TYPES exist" check) -- same
  // reason block 1b was fixed this way in an earlier wave. Block 2 below tops up everything IT
  // owns behind a single "does document_type SALE exist" guard, which means a DOC_TYPES entry
  // added after a database's first successful seed (this is exactly how this wave's own
  // STOCK_TAKE/STK addition was discovered broken -- POST /stock-takes 422'd
  // DOC.SERIES_MISSING against an already-seeded dev DB) would otherwise never get seeded on a
  // later `pnpm run seed` run. Pulled out of block 2's transaction into its own top-level,
  // always-runs step so every DOC_TYPES entry -- present today or added by a future wave -- gets
  // topped up on every run, regardless of whether the rest of block 2 already ran.
  const [tenantForDocTypes] = await db.select({ tenantId: tenants.tenantId }).from(tenants).where(eq(tenants.code, "dev"));
  if (!tenantForDocTypes) throw new Error("Dev tenant missing after block 1 -- cannot seed document types.");
  {
    const tenantId = tenantForDocTypes.tenantId;
    let docTypesInserted = 0;
    for (const docType of DOC_TYPES) {
      const [existingType] = await db
        .select({ documentTypeId: documentTypes.documentTypeId })
        .from(documentTypes)
        .where(and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.code, docType.code)));
      if (existingType) continue;

      await db.transaction(async (tx) => {
        await tx.insert(documentTypes).values({ tenantId, code: docType.code, name: docType.name });
        const [typeRow] = await tx
          .select({ documentTypeId: documentTypes.documentTypeId })
          .from(documentTypes)
          .where(and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.code, docType.code)));
        if (!typeRow) throw new Error(`Failed to read back the just-inserted document type "${docType.code}".`);

        await tx.insert(docSeries).values({
          tenantId,
          documentTypeId: typeRow.documentTypeId,
          code: docType.seriesCode,
          prefix: docType.prefix,
          padWidth: 6,
          resetPolicy: "never", // §7.6 N-4 default
        });
        const [seriesRow] = await tx
          .select({ docSeriesId: docSeries.docSeriesId })
          .from(docSeries)
          .where(and(eq(docSeries.tenantId, tenantId), eq(docSeries.code, docType.seriesCode)));
        if (!seriesRow) throw new Error(`Failed to read back the just-inserted doc series "${docType.seriesCode}".`);

        await tx.insert(docSeriesCounters).values({ docSeriesId: seriesRow.docSeriesId, periodKey: "*", nextValue: 1 });
      });
      docTypesInserted++;
    }
    console.log(`Document types: ${docTypesInserted} new type(s)/series/counter(s) seeded (${DOC_TYPES.length} checked).`);
  }

  // ---- Block 1d: voucher_category option list (per-row idempotent) ----------------------------
  // Same shape/position/idempotency pattern as block 1c above -- an always-runs, per-row-checked
  // top-level step, NOT folded into block 1's single "does the dev tenant exist" all-or-nothing
  // guard (which would repeat the exact bug block 1b/1c were already fixed for: a list added after
  // a database's first successful seed would otherwise never get seeded on a later run). Fixed
  // system classification (isAdminExtensible=false) -- the 5-category (JV/CP/CR/BP/BR) business
  // classification manual vouchers post through; see the VOUCHER_CATEGORIES const above for the
  // exact metaJson shape and 07-accounting-logic.md §5.1 for the header/detail side semantics.
  {
    const tenantId = tenantForDocTypes.tenantId;
    let listInserted = 0;
    let itemsInserted = 0;

    let [listRow] = await db
      .select({ optionListId: optionLists.optionListId })
      .from(optionLists)
      .where(and(eq(optionLists.tenantId, tenantId), eq(optionLists.listCode, VOUCHER_CATEGORY_LIST_CODE)));
    if (!listRow) {
      await db.insert(optionLists).values({
        tenantId,
        listCode: VOUCHER_CATEGORY_LIST_CODE,
        name: "Voucher category",
        description: "Fixed classification for manual accounting vouchers (JV/CP/CR/BP/BR).",
        isAdminExtensible: false,
        allowsDisable: false,
      });
      [listRow] = await db
        .select({ optionListId: optionLists.optionListId })
        .from(optionLists)
        .where(and(eq(optionLists.tenantId, tenantId), eq(optionLists.listCode, VOUCHER_CATEGORY_LIST_CODE)));
      if (!listRow) throw new Error(`Failed to read back the just-inserted option list "${VOUCHER_CATEGORY_LIST_CODE}".`);
      listInserted++;
    }
    const optionListId = listRow.optionListId;

    for (const category of VOUCHER_CATEGORIES) {
      const [existingItem] = await db
        .select({ optionItemId: optionItems.optionItemId })
        .from(optionItems)
        .where(and(eq(optionItems.optionListId, optionListId), eq(optionItems.code, category.code)));
      if (existingItem) continue;

      await db.insert(optionItems).values({
        optionListId,
        tenantId,
        code: category.code,
        name: category.name,
        isSystem: true,
        isDefault: category.isDefault,
        isEnabled: true,
        sortOrder: category.sortOrder,
        metaJson: category.metaJson,
      });
      itemsInserted++;
    }
    console.log(
      `Voucher categories: ${listInserted} new option list(s), ${itemsInserted} new option item(s) ` +
        `(${VOUCHER_CATEGORIES.length} checked).`,
    );
  }

  // ---- Block 1e: sales.doc_print_format option list (per-row idempotent) -----------------------
  // Same shape/position/idempotency pattern as block 1d immediately above -- an always-runs,
  // per-row-checked top-level step, NOT folded into block 1's single "does the dev tenant exist"
  // all-or-nothing guard (same reason block 1d's own comment documents: a list added after a
  // database's first successful seed would otherwise never get seeded on a later run). Fixed
  // system classification (isAdminExtensible=false, allowsDisable=false) -- this wave implements
  // exactly one print format (see PRINT_FORMATS above); letting an admin add other format codes
  // today would be meaningless (no code path renders them yet), and disabling the only format
  // would leave the preview/print endpoints with zero valid formats to fall back to.
  {
    const tenantId = tenantForDocTypes.tenantId;
    let listInserted = 0;
    let itemsInserted = 0;

    let [printFormatListRow] = await db
      .select({ optionListId: optionLists.optionListId })
      .from(optionLists)
      .where(and(eq(optionLists.tenantId, tenantId), eq(optionLists.listCode, PRINT_FORMAT_LIST_CODE)));
    if (!printFormatListRow) {
      await db.insert(optionLists).values({
        tenantId,
        listCode: PRINT_FORMAT_LIST_CODE,
        name: "Sale document print format",
        description: "Output format for sale-document print/preview endpoints (receipt-shaped JSON this wave).",
        isAdminExtensible: false,
        allowsDisable: false,
      });
      [printFormatListRow] = await db
        .select({ optionListId: optionLists.optionListId })
        .from(optionLists)
        .where(and(eq(optionLists.tenantId, tenantId), eq(optionLists.listCode, PRINT_FORMAT_LIST_CODE)));
      if (!printFormatListRow) throw new Error(`Failed to read back the just-inserted option list "${PRINT_FORMAT_LIST_CODE}".`);
      listInserted++;
    }
    const printFormatOptionListId = printFormatListRow.optionListId;

    for (const format of PRINT_FORMATS) {
      const [existingItem] = await db
        .select({ optionItemId: optionItems.optionItemId })
        .from(optionItems)
        .where(and(eq(optionItems.optionListId, printFormatOptionListId), eq(optionItems.code, format.code)));
      if (existingItem) continue;

      await db.insert(optionItems).values({
        optionListId: printFormatOptionListId,
        tenantId,
        code: format.code,
        name: format.name,
        isSystem: true,
        isDefault: format.isDefault,
        isEnabled: true,
        sortOrder: format.sortOrder,
      });
      itemsInserted++;
    }
    console.log(
      `Sale document print formats: ${listInserted} new option list(s), ${itemsInserted} new option item(s) ` +
        `(${PRINT_FORMATS.length} checked).`,
    );
  }

  // ---- Block 2: docflow / GL chart / payments / categories / parties / items ------------------
  // Separately guarded so this block can top up a database that was seeded by the older,
  // block-1-only shape of this script. Document types/series/counters themselves are now seeded
  // by Block 1c above (per-row idempotent), not here -- everything else in this block (GL chart,
  // fiscal periods, parties, items, categories) is far less likely to grow incrementally
  // wave-over-wave than DOC_TYPES is, so widening this block's own guard to match is left as a
  // follow-up, not silently assumed unnecessary.
  const tenantId = tenantForDocTypes.tenantId;

  // Bug fix, found during Wave 5 integration by reproducing the CI job's fresh-database seed step
  // locally: this guard used to check `document_type` for code "SALE" -- but Block 1c (doc types)
  // now runs BEFORE this block and always inserts "SALE" itself, so the guard saw "already
  // seeded" on every run, including a genuinely FRESH database, and Block 2 (fiscal years/
  // periods, the GL chart of accounts, parties, items) silently never ran in CI since whatever
  // wave first reordered Block 1c ahead of this guard (Wave 4). This was invisible until Wave 5's
  // Block 2b started throwing on the missing GL chart it depends on -- and even then, the
  // resulting uncaught error hung the CI job indefinitely instead of failing fast, because
  // `pool.end()` (bottom of `main()`) is never reached on a throw; see main().catch() below for
  // that half of the fix. Guard on `fiscal_year` (this block's own first insert, at
  // `code: FY_CODE`, in the same transaction as everything else below) instead -- a table no
  // other block touches, so it can only be non-empty if this exact transaction already committed.
  const existingDocflow = await db.select({ fiscalYearId: fiscalYears.fiscalYearId }).from(fiscalYears).where(and(eq(fiscalYears.tenantId, tenantId), eq(fiscalYears.code, FY_CODE)));
  // Skip only Block 2's OWN transaction on a hit; execution -- and the pool -- stay alive so
  // later always-runs, per-row-idempotent blocks still get a chance to top up whatever they
  // individually own (same lesson as the block 1b/1c bug fixes referenced in this file's header).
  if (existingDocflow.length > 0) {
    console.log("Posting fixtures already seeded -- skipping block 2.");
  } else {
    await db.transaction(async (tx) => {
    // §T23/§T24: FY2027 (Pakistan FY: 2026-07-01 -> 2027-06-30, open) + 12 open monthly periods.
    await tx.insert(fiscalYears).values({ tenantId, code: FY_CODE, startDate: FY_START, endDate: FY_END, status: "open" });
    const [fyRow] = await tx
      .select({ fiscalYearId: fiscalYears.fiscalYearId })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.tenantId, tenantId), eq(fiscalYears.code, FY_CODE)));
    if (!fyRow) throw new Error(`Failed to read back the just-inserted fiscal year "${FY_CODE}".`);

    await tx.insert(fiscalPeriods).values(
      FISCAL_MONTHS.map((month) => ({
        tenantId,
        fiscalYearId: fyRow.fiscalYearId,
        periodKey: month.periodKey,
        startDate: month.startDate,
        endDate: month.endDate,
        status: "open" as const,
      })),
    );

    // §T85-§T88: the four-level chart. Insert each level, then reselect to build a code -> id map
    // (insert-then-reselect, matching the block-1 pattern).
    await tx.insert(glAccountMains).values(GL_MAINS.map((main) => ({ tenantId, ...main })));
    const mainRows = await tx
      .select({ glAccountMainId: glAccountMains.glAccountMainId, code: glAccountMains.code })
      .from(glAccountMains)
      .where(eq(glAccountMains.tenantId, tenantId));
    const mainByCode = new Map(mainRows.map((row) => [row.code, row.glAccountMainId]));

    await tx.insert(glAccountCategories).values(
      GL_CATEGORIES.map((category) => {
        const glAccountMainId = mainByCode.get(category.mainCode);
        if (!glAccountMainId) throw new Error(`GL main "${category.mainCode}" missing for category "${category.code}".`);
        const { mainCode: _mainCode, ...columns } = category;
        return { tenantId, glAccountMainId, ...columns };
      }),
    );
    const categoryRows = await tx
      .select({ glAccountCategoryId: glAccountCategories.glAccountCategoryId, code: glAccountCategories.code })
      .from(glAccountCategories)
      .where(eq(glAccountCategories.tenantId, tenantId));
    const categoryByCode = new Map(categoryRows.map((row) => [row.code, row.glAccountCategoryId]));

    await tx.insert(glAccountSubs).values(
      GL_SUBS.map((sub) => {
        const glAccountCategoryId = categoryByCode.get(sub.categoryCode);
        if (!glAccountCategoryId) throw new Error(`GL category "${sub.categoryCode}" missing for sub "${sub.code}".`);
        const { categoryCode: _categoryCode, ...columns } = sub;
        return { tenantId, glAccountCategoryId, ...columns };
      }),
    );
    const subRows = await tx
      .select({ glAccountSubId: glAccountSubs.glAccountSubId, code: glAccountSubs.code })
      .from(glAccountSubs)
      .where(eq(glAccountSubs.tenantId, tenantId));
    const subByCode = new Map(subRows.map((row) => [row.code, row.glAccountSubId]));

    await tx.insert(glAccounts).values(
      GL_LEAVES.map((leaf) => {
        const glAccountSubId = subByCode.get(leaf.subCode);
        if (!glAccountSubId) throw new Error(`GL sub "${leaf.subCode}" missing for account "${leaf.code}".`);
        const { subCode: _subCode, ...columns } = leaf;
        return { tenantId, glAccountSubId, isPostable: true, isSystem: true, ...columns };
      }),
    );
    const leafRows = await tx
      .select({ glAccountId: glAccounts.glAccountId, code: glAccounts.code })
      .from(glAccounts)
      .where(eq(glAccounts.tenantId, tenantId));
    const glByCode = new Map(leafRows.map((row) => [row.code, row.glAccountId]));
    const mustGl = (code: string): number => {
      const glAccountId = glByCode.get(code);
      if (!glAccountId) throw new Error(`Failed to read back the just-inserted GL account "${code}".`);
      return glAccountId;
    };

    // §T90: the two money-holding accounts, 1:1 with their GL leaves (unique glAccountId is the
    // table's identity -- it has no code column of its own). MAIN_CASH is the sales default.
    await tx.insert(cashBankAccounts).values([
      { tenantId, glAccountId: mustGl("1000"), accountKind: "cash_drawer", isDefaultForSales: true },
      { tenantId, glAccountId: mustGl("1100"), accountKind: "bank", bankName: "Dev Bank" },
    ]);
    const [mainCash] = await tx
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.glAccountId, mustGl("1000"))));
    if (!mainCash) throw new Error("Failed to read back the just-inserted MAIN_CASH cash/bank account.");
    const [mainBank] = await tx
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.glAccountId, mustGl("1100"))));
    if (!mainBank) throw new Error("Failed to read back the just-inserted MAIN_BANK cash/bank account.");

    // §T94: the D9 payment-method seed. Cash settles into MAIN_CASH; bank-shaped methods into
    // MAIN_BANK; CREDIT_NOTE/OTHER move no money by themselves, so no default account.
    await tx.insert(paymentMethods).values(
      PAYMENT_METHODS.map((method) => ({
        tenantId,
        ...method,
        defaultCashBankAccountId:
          method.code === "CASH"
            ? mainCash.cashBankAccountId
            : ["BANK_TRANSFER", "CHEQUE", "BANK_DRAFT", "IBFT"].includes(method.code)
              ? mainBank.cashBankAccountId
              : null,
      })),
    );

    // §T84 / §T74 / §T63: the behavioural lookup seeds (pack LK).
    await tx.insert(purchaseCategories).values(PURCHASE_CATEGORIES.map((category) => ({ tenantId, ...category })));
    await tx.insert(saleCategories).values(
      SALE_CATEGORIES.map((category) => ({
        tenantId,
        ...category,
        defaultCashAccountId: category.counterparty === "cash" ? mainCash.cashBankAccountId : null,
      })),
    );
    await tx.insert(adjustmentReasons).values(
      ADJUSTMENT_REASONS.map((reason) => ({ tenantId, ...reason, glAccountId: mustGl("5300") })),
    );

    // §T26/§T28/§T30 dev parties -- each bound to its own control-account leaf (Module D:
    // party IS a ledger account, one control account per party).
    await tx.insert(suppliers).values({
      tenantId,
      code: "DEV_SUPPLIER",
      name: "Dev Supplier",
      glAccountId: mustGl("2001"),
    });
    await tx.insert(customers).values({
      tenantId,
      code: "WALK_IN",
      name: "Walk-in Customer",
      glAccountId: mustGl("1501"),
      isWalkIn: true, // D5: the walk-in cash model's seeded row
    });
    await tx.insert(salesmen).values({ tenantId, code: "DEV_SALESMAN", name: "Dev Salesman" });

    // §T31: two dev items so a purchase -> stock -> sale round-trip has something to move.
    await tx.insert(items).values(DEV_ITEMS.map((item) => ({ tenantId, ...item })));
    });

    console.log(
      "Seeded posting fixtures: document types/series/counters, FY2027 + 12 periods, GL chart, " +
        "cash/bank accounts, payment methods, purchase/sale categories, adjustment reasons, dev parties, dev items.",
    );
  }

  // ---- Block 2b: expense chart-of-accounts leaves + default expense categories -----------------
  // (per-row idempotent) -- placed AFTER block 2 so gl_account_main "E" (Expenses) is always
  // present by the time this runs, whether block 2 just seeded it above or it already existed from
  // an earlier wave's run; block 2's early-return was fixed above specifically so this block still
  // executes on an already-seeded database instead of being silently skipped (same bug class as
  // block 1b/1c, a third time -- see this file's header comment). Every level is individually
  // existence-checked before insert -- category, sub, each leaf, each expense_category row --
  // never a single "does this table have any rows" guard, per this file's hard-won lesson.
  {
    const [glMainE] = await db
      .select({ glAccountMainId: glAccountMains.glAccountMainId })
      .from(glAccountMains)
      .where(and(eq(glAccountMains.tenantId, tenantId), eq(glAccountMains.code, EXPENSE_GL_CATEGORY.mainCode)));
    if (!glMainE) {
      throw new Error(
        `GL main "${EXPENSE_GL_CATEGORY.mainCode}" (Expenses) is missing -- block 2 must run (or have already run) before block 2b.`,
      );
    }

    let [categoryRow] = await db
      .select({ glAccountCategoryId: glAccountCategories.glAccountCategoryId })
      .from(glAccountCategories)
      .where(and(eq(glAccountCategories.tenantId, tenantId), eq(glAccountCategories.code, EXPENSE_GL_CATEGORY.code)));
    if (!categoryRow) {
      await db.insert(glAccountCategories).values({
        tenantId,
        glAccountMainId: glMainE.glAccountMainId,
        code: EXPENSE_GL_CATEGORY.code,
        name: EXPENSE_GL_CATEGORY.name,
        statementSection: EXPENSE_GL_CATEGORY.statementSection,
        presentationOrder: EXPENSE_GL_CATEGORY.presentationOrder,
      });
      [categoryRow] = await db
        .select({ glAccountCategoryId: glAccountCategories.glAccountCategoryId })
        .from(glAccountCategories)
        .where(and(eq(glAccountCategories.tenantId, tenantId), eq(glAccountCategories.code, EXPENSE_GL_CATEGORY.code)));
      if (!categoryRow) throw new Error(`Failed to read back the just-inserted GL category "${EXPENSE_GL_CATEGORY.code}".`);
    }

    let [subRow] = await db
      .select({ glAccountSubId: glAccountSubs.glAccountSubId })
      .from(glAccountSubs)
      .where(and(eq(glAccountSubs.tenantId, tenantId), eq(glAccountSubs.code, EXPENSE_GL_SUB.code)));
    if (!subRow) {
      await db.insert(glAccountSubs).values({
        tenantId,
        glAccountCategoryId: categoryRow.glAccountCategoryId,
        code: EXPENSE_GL_SUB.code,
        name: EXPENSE_GL_SUB.name,
        subledgerKind: EXPENSE_GL_SUB.subledgerKind,
        isControlAccount: EXPENSE_GL_SUB.isControlAccount,
      });
      [subRow] = await db
        .select({ glAccountSubId: glAccountSubs.glAccountSubId })
        .from(glAccountSubs)
        .where(and(eq(glAccountSubs.tenantId, tenantId), eq(glAccountSubs.code, EXPENSE_GL_SUB.code)));
      if (!subRow) throw new Error(`Failed to read back the just-inserted GL sub "${EXPENSE_GL_SUB.code}".`);
    }
    const glAccountSubId = subRow.glAccountSubId;

    let leavesInserted = 0;
    for (const leaf of EXPENSE_GL_LEAVES) {
      const [existingLeaf] = await db
        .select({ glAccountId: glAccounts.glAccountId })
        .from(glAccounts)
        .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, leaf.code)));
      if (existingLeaf) continue;
      await db.insert(glAccounts).values({
        tenantId,
        glAccountSubId,
        code: leaf.code,
        name: leaf.name,
        accountNature: leaf.accountNature,
        normalBalance: leaf.normalBalance,
        isContra: leaf.isContra,
        isPostable: true,
        isSystem: true,
      });
      leavesInserted++;
    }

    const glLeafRows = await db
      .select({ glAccountId: glAccounts.glAccountId, code: glAccounts.code })
      .from(glAccounts)
      .where(eq(glAccounts.tenantId, tenantId));
    const glByCode = new Map(glLeafRows.map((row) => [row.code, row.glAccountId]));

    let categoriesInserted = 0;
    for (const category of EXPENSE_CATEGORIES) {
      const [existingCategory] = await db
        .select({ expenseCategoryId: expenseCategories.expenseCategoryId })
        .from(expenseCategories)
        .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, category.code)));
      if (existingCategory) continue;

      const glAccountId = glByCode.get(category.glCode);
      if (!glAccountId) throw new Error(`GL account "${category.glCode}" missing for expense category "${category.code}".`);

      await db.insert(expenseCategories).values({
        tenantId,
        code: category.code,
        name: category.name,
        glAccountId,
        isSystem: true,
        isDefault: category.isDefault,
        isEnabled: true,
        sortOrder: category.sortOrder,
      });
      categoriesInserted++;
    }

    console.log(
      `Expense chart of accounts: ${leavesInserted} new GL leaf account(s) (${EXPENSE_GL_LEAVES.length} checked), ` +
        `${categoriesInserted} new expense_category row(s) (${EXPENSE_CATEGORIES.length} checked).`,
    );
  }

  await pool.end();
}

main().catch(async (error: unknown) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
  // Bug fix, found during Wave 5 integration: `pool.end()` previously only ran at the very
  // bottom of `main()`'s success path, so any thrown error (like Block 2b's "GL main E is
  // missing" -- itself caused by the Block 2 guard bug fixed above) left the mysql2 pool's open
  // connections keeping the Node process alive forever instead of exiting with code 1. Locally
  // this meant the seed script hung until manually killed; in CI it hung the whole job until the
  // runner's own timeout, with no error visible in the log tail. Always close the pool on the
  // error path too, then exit explicitly so a real failure fails fast and loud.
  if (pool) await pool.end();
  process.exit(1);
});
