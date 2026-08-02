// Blueprint: docs/system-analysis/00b-owner-decisions-and-requirements.md P1 ("offer every
// option, let the user choose, let the admin curate") and D9 (the originating decision: supplier
// payment methods must never be hardcoded); docs/system-analysis/19-mysql-schema-blueprint.md
// §T02-T03 (`option_list`/`option_item`) and §4.3 (pack LK) and §8.3 (how P1 is actually
// enforced, table-by-table); docs/system-analysis/17-technical-blueprint.md §2.3 module #13
// (`settings` -- "Every other module reads options from here; none defines its own enum.").
//
// This is the ONE generic options-as-data pair every P1 option list uses: payment methods,
// expense categories, adjustment reasons, return reasons, cancel reasons, print formats, and any
// future admin-curatable pick-list all become `option_item` rows under a distinct `option_list`,
// never a bespoke table and never a hardcoded TS enum. §19 gives a handful of these (payment
// method, cash/bank/etc.) their own dedicated tables with extra behavioural columns (GL bindings,
// requires-reference flags); that specialisation is deliberately out of scope here -- the task
// for this package is the generic P1 mechanism itself, grounded in §T02-T03/§4.3/§8.3.
import { sql } from "drizzle-orm";
import { boolean, index, mysqlTable, smallint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, fkBigInt, fkBigIntNotNull, idPk, softDeleteColumns } from "./_shared";
import { tenants } from "./tenant";

/**
 * A named pick-list, e.g. `payment_method`, `expense_category`, `stock_adjustment_reason`,
 * `sale_return_reason`, `cancel_reason`, `doc_print_format` (§19 §T02, §T03's seed list). Scoped
 * per tenant per D16/R6 and per the task's explicit instruction ("each scoped per tenant and
 * admin-toggleable").
 */
export const optionLists = mysqlTable(
  "option_list",
  {
    optionListId: idPk("option_list_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    listCode: varchar("list_code", { length: 48 }).notNull(), // stable, machine-readable, e.g. `payment_method`
    name: varchar("name", { length: 120 }).notNull(),
    description: varchar("description", { length: 255 }), // R1.10 plain-English explanation
    // P1.4: "Adding a new payment method, expense category, or adjustment reason must be an
    // admin action, never a developer deployment." A list with is_admin_extensible = 0 is one of
    // the handful the platform defines the shape of (rare) but still stores as data.
    isAdminExtensible: boolean("is_admin_extensible").notNull().default(true),
    allowsDisable: boolean("allows_disable").notNull().default(true),
    ...auditColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_option_list_tenant_code").on(table.tenantId, table.listCode),
  }),
);

/**
 * One selectable value within an `option_list`. Implements pack `LK` (§4.3) column-for-column:
 * every P1 rule maps directly onto a column here (see the table in §8.3).
 *
 * - **P1.2** "Sensible default, always changeable" -> `isDefault` + the functional unique index
 *   below (`uk_option_item_default`), so the *database* -- not a hopeful application check --
 *   guarantees at most one default per list.
 * - **P1.3** "Admin can disable what is unused" -> `isEnabled`; disabling never deletes the row,
 *   so historical documents that used a since-disabled option keep resolving and displaying
 *   correctly.
 * - **P1.6** "Clean UI despite many options" -> `sortOrder` + `description`, grouped by
 *   `optionListId`.
 * - **P1.7** "Every option is audited" -> the chosen `option_item_id` is stored as an FK on the
 *   transaction that used it (by the consuming module, out of scope here); every change to the
 *   option *itself* is covered by the audit pack (`createdBy`/`updatedBy`) plus `audit.ts`'s
 *   generic `audit_log`, exactly as §8.3 specifies ("every change to the option itself writes an
 *   audit_event").
 */
export const optionItems = mysqlTable(
  "option_item",
  {
    optionItemId: idPk("option_item_id"),
    optionListId: fkBigIntNotNull("option_list_id").references(() => optionLists.optionListId),
    // Denormalised from optionLists for direct tenant-scoped queries/isolation without a join --
    // same D16 "isolation ... even through a bug" defence-in-depth reasoning applied elsewhere in
    // this package (see identity.ts user_session, catalog.ts item_visibility).
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    code: varchar("code", { length: 32 }).notNull(), // stable; never renamed. Display name may change freely
    name: varchar("name", { length: 120 }).notNull(),
    nameUr: varchar("name_ur", { length: 120 }), // D15: bilingual English/Urdu
    description: varchar("description", { length: 255 }),
    isEnabled: boolean("is_enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    isSystem: boolean("is_system").notNull().default(false), // seeded rows the application depends on
    sortOrder: smallint("sort_order", { unsigned: true }).notNull().default(100),
    legacyId: varchar("legacy_id", { length: 32 }), // the source *Code this row was migrated from, if any
    // §4.3: "The functional unique index is the concrete mechanism that guarantees P1.2 ('every
    // option list has one pre-selected default') at the database level: a second is_default = 1
    // row is rejected by the engine, not by a hopeful application check." Implemented as a real
    // STORED generated column rather than a raw-SQL functional index -- see catalog.ts stockLots
    // for why (drizzle-kit 0.28's `.on(sql\`...\`)` renderer corrupts SQL fragments containing
    // commas, which `IF(a, b, c)` always does).
    defaultListKey: fkBigInt("default_list_key").generatedAlwaysAs(
      sql`if(\`is_default\` = 1, \`option_list_id\`, null)`,
      { mode: "stored" },
    ),
    ...auditColumns(),
    ...softDeleteColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_option_item_list_code").on(table.optionListId, table.code),
    enabledIdx: index("ix_option_item_enabled").on(table.optionListId, table.isEnabled, table.sortOrder),
    defaultUnique: uniqueIndex("uk_option_item_default").on(table.defaultListKey),
  }),
);
