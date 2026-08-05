// Blueprint: docs/system-analysis/09-roles-permissions.md Part I (RECOMMENDED RBAC MODEL FOR THE
// REBUILD) -- §I.2 proposed schema, §I.3 the eight-role set derived from the four real legacy
// groups plus separation of duties, §I.5 non-negotiable controls; reconciled with
// docs/system-analysis/19-mysql-schema-blueprint.md §T14-T19 (role/permission/role_permission/
// role_scope/role_policy/user_role) and 00b-owner-decisions-and-requirements.md D16/R6
// (tenant_id) and P1 (role-appropriate options, P1.5).
import { boolean, datetime, decimal, index, mysqlEnum, mysqlTable, primaryKey, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { appUsers } from "./identity";
import { auditColumns, fkBigInt, fkBigIntNotNull, idPk, softDeleteColumns, TIMESTAMP_FSP } from "./_shared";
import { tenants } from "./tenant";

/**
 * A named role. §T14: "Renamed from the legacy `Groups`, which is a reserved word in MySQL 8
 * (window-function keyword) and holds the role definitions plus 29 embedded business-policy
 * columns" -- those 29 columns are deliberately NOT reproduced here (P1.4: they are business
 * policy and belong in `role_policy`/`app_setting`/`option_item` rows, not schema columns; out of
 * scope for this Foundations package).
 *
 * `tenant_id` is nullable: `NULL` rows are the eight platform-seeded role templates from 09 §I.3
 * (`is_system = 1`), available to every tenant; a tenant admin may additionally define
 * tenant-specific roles (`tenant_id` set, per R6 "a tenant-level admin ... manages their own ...
 * options and settings").
 *
 * 09 §I.3 recommended role set (seeded from the four real legacy groups + separation of duties):
 * owner, sys_admin, pharmacy_manager, shift_incharge, sales_officer, purchase_officer,
 * accountant, auditor.
 */
export const roles = mysqlTable(
  "role",
  {
    roleId: idPk("role_id"),
    tenantId: fkBigInt("tenant_id").references(() => tenants.tenantId),
    roleKey: varchar("role_key", { length: 64 }).notNull(), // e.g. `owner`, `sales_officer`
    displayName: varchar("display_name", { length: 120 }).notNull(),
    // Wave 10b (`POST/PATCH /roles`, 18-api-plan.md §0.3): D15 bilingual English/Urdu pattern,
    // same pairing identity.ts's `appUsers.displayNameUr` already uses for its own `displayName`.
    displayNameUr: varchar("display_name_ur", { length: 120 }),
    description: varchar("description", { length: 255 }),
    isSystem: boolean("is_system").notNull().default(false), // system roles cannot be deleted (09 §I.2)
    isAdmin: boolean("is_admin").notNull().default(false),
    // Wave 10b: the real "remove" mechanism for an admin-created role (P1.3 -- disable, never
    // delete). Mirrors options.ts option_item's `isEnabled` pattern exactly, including its own
    // established rule (settings.service.ts's updateOptionItem): `isSystem` rows can never be
    // disabled through the admin endpoint -- 422 `ROLE.SYSTEM_ROLE_PROTECTED`.
    isEnabled: boolean("is_enabled").notNull().default(true),
    legacyGroupCode: varchar("legacy_group_code", { length: 16 }), // legacy Groups.GroupCode traceability
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    keyUnique: uniqueIndex("uk_role_tenant_key").on(table.tenantId, table.roleKey),
    tenantIdx: index("ix_role_tenant").on(table.tenantId, table.isSystem),
  }),
);

/**
 * The permission atom. §T15: legacy `Rights` holds 486 rows whose `LevelIndex`/`IndicesString`
 * encode a compiled PowerBuilder menu-tree path (06 §3.3, 09 §C.1, Verified) -- "that coupling is
 * dropped: permissions in the target name *capabilities*, not menu coordinates."
 *
 * NO `tenant_id` here, deliberately: the permission catalogue is a platform-wide capability list
 * (what the software CAN do), not tenant-owned data (D16 requires tenant_id on tenant-OWNED
 * tables; the set of capabilities the system exposes is platform metadata every tenant shares).
 * `role_permission` is what is tenant-scoped, transitively through `role`.
 */
export const permissions = mysqlTable(
  "permission",
  {
    permissionId: idPk("permission_id"),
    code: varchar("code", { length: 80 }).notNull(), // `sale.invoice.create`, `admin.item.visibility.bulk`
    name: varchar("name", { length: 160 }).notNull(),
    description: varchar("description", { length: 255 }),
    // Generalises the legacy Rights.Object split ('A' action = 322 rows, 'W' window = 164 rows,
    // 09 §C.1, Verified).
    permissionKind: mysqlEnum("permission_kind", ["action", "view", "field", "report", "admin"])
      .notNull()
      .default("action"),
    // Grant/revoke of a sensitive permission always raises an audit_event + owner notification
    // (§T15).
    isSensitive: boolean("is_sensitive").notNull().default(false),
    legacyRightCode: varchar("legacy_right_code", { length: 16 }), // legacy Rights.RightCode traceability
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_permission_code").on(table.code),
    legacyUnique: uniqueIndex("uk_permission_legacy").on(table.legacyRightCode),
  }),
);

/**
 * §T16 `role_permission`. **Positive-grant only, matching the verified legacy semantics** --
 * legacy `GroupRights.Status` is `1` in every one of its 726 rows; there is no deny rule, no
 * precedence and no inheritance (09 §C.1, Verified). Keeping that model avoids inventing a
 * precedence system nobody asked for.
 */
export const rolePermissions = mysqlTable(
  "role_permission",
  {
    roleId: fkBigIntNotNull("role_id").references(() => roles.roleId),
    permissionId: fkBigIntNotNull("permission_id").references(() => permissions.permissionId),
    grantedAt: datetime("granted_at", { fsp: TIMESTAMP_FSP }).notNull(),
    grantedBy: fkBigInt("granted_by").references(() => appUsers.userId),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
    permIdx: index("ix_role_permission_perm").on(table.permissionId),
  }),
);

/**
 * §T19 `user_role`. **Multiple roles are permitted and are resolved as the union of grants.** The
 * legacy `fn_GetGroupCode` collapses membership with `SELECT MIN(GroupCode)`, which silently
 * discards multi-group membership -- and because `ADMINISTRATOR` is `GroupCode 2`, the lowest in
 * use, adding a user to ADMINISTRATOR *plus* a restricted group would silently grant full admin
 * server-side (09 §C.1, Verified, Broken/Incomplete). Union-of-grants (no MIN(), no collapsing)
 * makes that failure mode structurally impossible in the target.
 */
export const userRoles = mysqlTable(
  "user_role",
  {
    userId: fkBigIntNotNull("user_id").references(() => appUsers.userId),
    roleId: fkBigIntNotNull("role_id").references(() => roles.roleId),
    assignedAt: datetime("assigned_at", { fsp: TIMESTAMP_FSP }).notNull(),
    assignedBy: fkBigInt("assigned_by").references(() => appUsers.userId),
    validFrom: datetime("valid_from", { fsp: TIMESTAMP_FSP }),
    validTo: datetime("valid_to", { fsp: TIMESTAMP_FSP }), // supports temporary elevation
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
    roleIdx: index("ix_user_role_role").on(table.roleId),
  }),
);

/**
 * Wave 10e (R-007 CRITICAL, 12-risks-gaps.md): "row-level scope" -- `permissions.service.ts`'s own
 * header comment has documented this exact gap since Wave 1 ("role_scope/role_limit ... are not
 * modelled in access.ts yet -- real follow-up work, not assumed away"). One row per
 * (role, scopeType, a single allowed value) -- `PUT /roles/:roleKey/scopes` replaces a scopeType's
 * whole row set atomically (delete-then-insert, same "replace, not delta" semantics
 * user-admin.repository.ts's `replaceRoles` already establishes for `user_role`), so "this role
 * can touch warehouses 3 and 7" is two rows, not one row with an embedded array.
 *
 * `scopeRefId` is a deliberately POLYMORPHIC soft reference (no single `.references()` target is
 * possible since it points at a different table depending on `scopeType`) -- `warehouse` ->
 * `branch.branch_id` (D17/tenant.ts: "warehouse_id is branch_id in this package, no separate
 * warehouse table"), `cash_bank_account` -> `cash_bank_account.cash_bank_account_id`,
 * `voucher_category` -> `option_item.option_item_id` (the seeded `accounting.voucher_category`
 * list). `price_type` and `supplier_category` are accepted by the schema/enum (18-api-plan.md
 * §0.13.3 names both) but have no corresponding table to reference AT ALL yet in this codebase (no
 * price-tier system, no supplier-categorisation concept beyond `purchase_category` which classifies
 * DOCUMENTS not suppliers) -- see role-scope.service.ts's own header comment for why enforcement
 * of those two scope types is honestly deferred, not silently faked.
 */
export const roleScopes = mysqlTable(
  "role_scope",
  {
    roleId: fkBigIntNotNull("role_id").references(() => roles.roleId),
    scopeType: mysqlEnum("scope_type", ["warehouse", "cash_bank_account", "price_type", "supplier_category", "voucher_category"]).notNull(),
    scopeRefId: fkBigIntNotNull("scope_ref_id"),
    ...auditColumns(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.scopeType, table.scopeRefId] }),
    roleIdx: index("ix_role_scope_role").on(table.roleId, table.scopeType),
  }),
);

/**
 * Wave 10e (R-007 CRITICAL): numeric per-role posting limits, evaluated INSIDE the write
 * transaction (18-api-plan.md §0.13.3 -- "returning 403 AUTHZ.LIMIT_EXCEEDED ... and no database
 * side effect"), never at the permission-check layer alone (a limit needs the actual attempted
 * value, which only the write handler has). `limitKey` is a free-standing string, not an enum --
 * 18-api-plan.md names `max_txn_value`/`max_qty`/`max_line_disc_pct`/`max_inv_flat_disc`/
 * `max_price_delta_pct`; see role-limit.service.ts's own header comment for exactly which of these
 * this wave actually wires into a real write path (the discount-percentage ones have no live
 * caller yet -- sale-invoices.service.ts 422s any non-zero discount input at all, M-5, blocked).
 */
export const roleLimits = mysqlTable(
  "role_limit",
  {
    roleId: fkBigIntNotNull("role_id").references(() => roles.roleId),
    limitKey: varchar("limit_key", { length: 64 }).notNull(),
    limitValue: decimal("limit_value", { precision: 18, scale: 4 }).notNull(),
    ...auditColumns(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.limitKey] }),
  }),
);
