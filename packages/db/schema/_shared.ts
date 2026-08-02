// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §2.1 (naming), §2.2 (storage/
// collation), §4 (cross-cutting column packs AP/SD), reconciled against 17-technical-blueprint.md
// §6.2 (the money/quantity/rate precision archetypes) and packages/money/src/{Money,Quantity,
// Percent}.ts (the already-built value objects those archetypes must round-trip through).
//
// Reusable pieces referenced by every schema/*.ts file, so §4's "packs" only need to be defined
// once instead of re-typed on every one of the ~20 tables in this package.
//
// KNOWN GAP -- collation. §2.2 specifies per-column collation overrides: `utf8mb4_0900_as_cs`
// (accent-/case-sensitive) on every identity/code column (item.name, gl_account.code, etc.), and
// `utf8mb4_bin` on machine-exact columns (password_hash, barcode values, batch numbers). Drizzle
// ORM 0.36's mysql-core column builders (checked against the installed
// node_modules/drizzle-orm/mysql-core/columns/*.d.ts) expose no `.collate()`/`collation` option
// on `varchar`/`char`. Every table default to `utf8mb4_0900_ai_ci` (the schema's declared default,
// §2.2) as a result. Per §5.4's "drizzle-kit generate -> hand-review -> commit" workflow, the
// per-column `COLLATE utf8mb4_0900_as_cs` / `utf8mb4_bin` overrides must be added by hand to the
// generated migration SQL before it is committed -- this is a tooling limitation, not a decision
// to skip §2.2.
import { sql } from "drizzle-orm";
import { bigint, datetime, int, mysqlEnum, varchar } from "drizzle-orm/mysql-core";

// Blueprint §2.1 S7 / task instruction: "prefer bigint unsigned auto_increment ... use bigint
// unsigned auto_increment and note the choice in a comment". §19 S7 itself: "Surrogate keys
// internally ... BIGINT UNSIGNED AUTO_INCREMENT for internal identity (gaps irrelevant)". The
// table catalogue in §6 narrows individual lookup tables to SMALLINT/INT UNSIGNED as a space
// optimisation (e.g. role_id SMALLINT, item_id INT) -- this package does not replicate that
// per-table narrowing and standardises on BIGINT UNSIGNED for every primary key instead. That
// costs a few bytes/row on small lookup tables; it buys one less per-table decision and zero risk
// of hitting a ceiling as the platform grows across tenants (D16).
export function idPk(columnName: string) {
  return bigint(columnName, { mode: "number", unsigned: true }).autoincrement().primaryKey();
}

/** A nullable foreign-key-shaped column, same width as every primary key (`idPk`). */
export function fkBigInt(columnName: string) {
  return bigint(columnName, { mode: "number", unsigned: true });
}

/** A required (NOT NULL) foreign-key-shaped column. */
export function fkBigIntNotNull(columnName: string) {
  return bigint(columnName, { mode: "number", unsigned: true }).notNull();
}

// Blueprint §4.1 Pack AP -- audit pack, applied to every table unless stated otherwise.
//
// `created_by`/`updated_by` are declared here as bare, unconstrained BIGINT UNSIGNED columns
// (conceptually FK -> app_user.user_id, per §4.1) rather than real `.references()` foreign keys:
// this helper is imported by identity.ts itself (app_user carries the AP pack too), so a hard
// reference from here to identity.ts's `appUsers` table would be circular. Per-table FK
// constraints to `app_user` are added directly in the handful of tables where the reviewer wants
// it enforced at the database level; everywhere else the column is a soft reference, exactly as
// the legacy `SaleLedger.PostedBy` pattern already was before this rebuild made it typed.
//
// `updated_at`'s `ON UPDATE CURRENT_TIMESTAMP(3)` clause cannot be expressed through drizzle-orm
// 0.36's `datetime()` builder -- only `timestamp()` exposes `.onUpdateNow()` (see
// node_modules/drizzle-orm/mysql-core/columns/date.common.d.ts), and MySQL `TIMESTAMP` silently
// converts through the session time zone, which is precisely what §5.6 says to avoid for business
// data ("store DATETIME in Pakistan local time"). Add `ON UPDATE CURRENT_TIMESTAMP(3)` to this
// column by hand in the generated migration, per the documented generate -> review -> commit flow.
export function auditColumns() {
  return {
    createdAt: datetime("created_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    createdBy: fkBigInt("created_by"),
    createdSource: mysqlEnum("created_source", ["ui", "api", "migration", "system_job", "import"])
      .notNull()
      .default("ui"),
    updatedAt: datetime("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    updatedBy: fkBigInt("updated_by"),
    rowVersion: int("row_version", { unsigned: true }).notNull().default(1),
  };
}

// Blueprint §4.2 Pack SD -- soft-delete pack. Master/reference data ONLY (R1.1, P1.3) -- never
// applied to transactional documents (§4.4 pack DOC has no SD) or append-only ledger/movement
// rows (S2/S3): those use `status = 'cancelled'`/reversal rows instead, never a delete flag.
export function softDeleteColumns() {
  return {
    deletedAt: datetime("deleted_at", { fsp: 3 }),
    deletedBy: fkBigInt("deleted_by"),
    deleteReason: varchar("delete_reason", { length: 255 }),
  };
}

// Blueprint §3.1/§3.4 domain table, reconciled with 17-technical-blueprint.md §6.2 per the task
// instruction to use "the EXACT column type archetypes" that document defines. 17§6.2 and
// 19§3.1 disagree with each other (17: money DECIMAL(15,2)/(15,4)/(15,5), qty (15,4), pct (6,3);
// 19: money DECIMAL(18,4), qty (18,3), rate (18,6), pct (9,4)) -- 19 was written later and wider,
// but the task explicitly names 17§6.2 as the source of truth, and packages/money/src/Money.ts
// cites 17§6.2 by name (`Money.SCALE = 2`, "Document/GL scale (§6.2)"). This package follows
// 17§6.2 for every archetype it defines, with ONE documented exception:
//
// PERCENT deviates to DECIMAL(9,4) (19§3.1's archetype) instead of 17§6.2's DECIMAL(6,3).
// Reason: packages/money/src/Percent.ts fixes `MAX_SCALE = 4` and `toDb()` always emits a
// four-decimal string (`toFixed(4)`). Writing a four-decimal value into a three-decimal column
// silently rounds away the fourth digit on every insert/update -- exactly the float-shaped
// precision loss Rule M (17§6.1) exists to prevent, just moved into the DDL instead of the
// application. DECIMAL(9,4) is scale-compatible with the value object that is actually written;
// 17§6.2's other five archetypes all have >= the scale packages/money's Money/Quantity classes
// produce (Money.SCALE=2, Quantity default scale=3), so no other deviation is needed.
export const DOCUMENT_AMOUNT = { precision: 15, scale: 2 } as const; // §6.2 "Document total / GL amount" == Money.SCALE
export const UNIT_PRICE = { precision: 15, scale: 4 } as const; // §6.2 "Unit price / line amount"
export const AVG_COST = { precision: 15, scale: 5 } as const; // §6.2 "Weighted-average cost"
export const QUANTITY = { precision: 15, scale: 4 } as const; // §6.2 "Quantity"
export const PERCENT = { precision: 9, scale: 4 } as const; // deviation from §6.2 -- see block comment above
export const FX_RATE = { precision: 11, scale: 5 } as const; // §6.2 "FX rate" -- dormant per D4, single currency (PKR)

// PERCENT and FX_RATE are exported but not yet consumed by a column in this package: none of the
// seven required schema groups (tenant/identity/access/options/catalog/ledger/audit) has a
// percentage or exchange-rate field of its own -- those belong to the pricing/tax modules
// (discount_percent, tax rate schedules) that are out of scope for this Foundations step. Defined
// here now so the next module that needs them imports the archetype instead of re-deriving it.

// Blueprint §3.6 -- business dates are DATE, event timestamps are DATETIME(3), Asia/Karachi local
// time throughout (§5.6 -- Pakistan has no DST, so local-time storage is a deliberate, documented
// choice, not an oversight).
export const TIMESTAMP_FSP = 3 as const;
