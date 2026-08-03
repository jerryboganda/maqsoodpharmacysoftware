// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T04 (`document_type`), §T05
// (`doc_series`), §T06 (`doc_series_counter`), §T23 (`fiscal_year`), §T24 (`fiscal_period`);
// docs/system-analysis/17-technical-blueprint.md §7.6 (document numbering MR-1/MR-2 -- the
// transactional counter with FOR UPDATE, allocate-last, never-reuse rules N-1..N-7) and §7.8
// (posting_period control: posting into a closed period requires audited break-glass permission).
//
// This file is the DOC-pack dependency root: every transactional document header (purchasing.ts,
// sales.ts, inventory.ts) soft-references these tables via _shared.ts docColumns().
import { boolean, date, datetime, decimal, index, mysqlEnum, mysqlTable, smallint, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { auditColumns, DOCUMENT_AMOUNT, fkBigInt, fkBigIntNotNull, idPk, TIMESTAMP_FSP } from "./_shared";
import { tenants } from "./tenant";

/**
 * §T04 -- one row per document kind (SALE, SALE_RETURN, PURCHASE, PURCHASE_RETURN,
 * PURCHASE_ORDER, ADJUSTMENT, STOCK_TAKE, SUPPLIER_PAYMENT, EXPENSE, JOURNAL). Platform-defined
 * (not admin-extensible -- new document kinds are a deployment), but behavioural knobs
 * (approvalThresholdAmount) are runtime-editable per P1.
 */
export const documentTypes = mysqlTable(
  "document_type",
  {
    documentTypeId: idPk("document_type_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    code: varchar("code", { length: 32 }).notNull(), // e.g. `SALE`, `PURCHASE_RETURN`
    name: varchar("name", { length: 120 }).notNull(),
    // §T61/18-api-plan §2.6: adjustments above this amount require a second-person approval
    // before /post. NULL = never requires approval.
    approvalThresholdAmount: decimal("approval_threshold_amount", DOCUMENT_AMOUNT),
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...auditColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_document_type_tenant_code").on(table.tenantId, table.code),
  }),
);

/**
 * §T05 -- a user-visible numbering series for one document type (prefix + zero-padded counter,
 * e.g. SV-000123). §7.6 N-4: period reset is a P1 option, default never-reset.
 */
export const docSeries = mysqlTable(
  "doc_series",
  {
    docSeriesId: idPk("doc_series_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    documentTypeId: fkBigIntNotNull("document_type_id").references(() => documentTypes.documentTypeId),
    code: varchar("code", { length: 32 }).notNull(),
    prefix: varchar("prefix", { length: 16 }).notNull().default(""),
    padWidth: smallint("pad_width", { unsigned: true }).notNull().default(6),
    resetPolicy: mysqlEnum("reset_policy", ["never", "yearly", "monthly"]).notNull().default("never"), // §7.6 N-4
    isEnabled: boolean("is_enabled").notNull().default(true),
    ...auditColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_doc_series_tenant_code").on(table.tenantId, table.code),
  }),
);

/**
 * §T06 / §7.6 -- THE transactional allocator. One row per (series, period_key); `SELECT ...
 * FOR UPDATE` on this row, increment, use, commit -- allocated as late as possible inside the
 * business transaction (N-1), never held across user interaction (N-2). `period_key` is
 * `'*'` under the default never-reset policy, `'2026'`/`'2026-08'` under yearly/monthly.
 * Counter is BIGINT (N-6) via the standard idPk-width columns.
 */
export const docSeriesCounters = mysqlTable(
  "doc_series_counter",
  {
    docSeriesId: fkBigIntNotNull("doc_series_id").references(() => docSeries.docSeriesId),
    periodKey: varchar("period_key", { length: 8 }).notNull().default("*"),
    nextValue: fkBigIntNotNull("next_value"), // bigint unsigned NOT NULL -- next number to hand out
    updatedAt: datetime("updated_at", { fsp: TIMESTAMP_FSP }),
  },
  (table) => ({
    pk: uniqueIndex("uk_doc_series_counter").on(table.docSeriesId, table.periodKey),
  }),
);

/** §T23 -- fiscal year header (Pakistan FY, but dates are data, not rules). */
export const fiscalYears = mysqlTable(
  "fiscal_year",
  {
    fiscalYearId: idPk("fiscal_year_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    code: varchar("code", { length: 16 }).notNull(), // e.g. `FY2026`
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: mysqlEnum("status", ["open", "closed"]).notNull().default("open"),
    ...auditColumns(),
  },
  (table) => ({
    codeUnique: uniqueIndex("uk_fiscal_year_tenant_code").on(table.tenantId, table.code),
  }),
);

/**
 * §T24 + 17§7.8 period control -- posting periods (monthly). Every DOC header carries
 * `fiscal_period_id`; posting resolves the period from posting_date and rejects with
 * `422 PERIOD.CLOSED` unless status is `open` (or `soft_closed` + break-glass permission,
 * audited).
 */
export const fiscalPeriods = mysqlTable(
  "fiscal_period",
  {
    fiscalPeriodId: idPk("fiscal_period_id"),
    tenantId: fkBigIntNotNull("tenant_id").references(() => tenants.tenantId),
    fiscalYearId: fkBigIntNotNull("fiscal_year_id").references(() => fiscalYears.fiscalYearId),
    periodKey: varchar("period_key", { length: 8 }).notNull(), // `2026-08`
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: mysqlEnum("status", ["open", "soft_closed", "closed"]).notNull().default("open"),
    closedAt: datetime("closed_at", { fsp: TIMESTAMP_FSP }),
    closedBy: fkBigInt("closed_by"),
    ...auditColumns(),
  },
  (table) => ({
    keyUnique: uniqueIndex("uk_fiscal_period_tenant_key").on(table.tenantId, table.periodKey),
    dateIdx: index("ix_fiscal_period_dates").on(table.tenantId, table.startDate, table.endDate),
  }),
);
