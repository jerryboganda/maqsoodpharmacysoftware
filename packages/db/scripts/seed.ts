// Dev-only seed data. Populates exactly enough of a fresh `pharmacy_platform` database for
// apps/api's identity/settings modules to run against real data instead of their in-memory
// fixtures (packages/db/client.ts's consumer), plus the docflow/GL/parties/catalog fixtures the
// inventory/purchasing/sales posting flows need. Idempotent in two independently guarded blocks:
// block 1 (tenant/roles/options) is guarded by the "dev" tenant existing; block 2 (docflow, GL
// chart, payment/purchase/sale categories, parties, items) is guarded by the SALE document_type
// existing for that tenant -- so block 2 can top up a database that was already seeded by the
// older, block-1-only shape of this script. Re-running against a fully seeded database is a no-op
// instead of duplicating rows (MySQL UNIQUE indexes treat every NULL as distinct, which would
// otherwise let the tenant_id-nullable `role` table's system rows re-insert on every run).
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
  purchaseCategories,
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
// one '*' counter row per series primed at 1.
const DOC_TYPES = [
  { code: "SALE", name: "Sale invoice", seriesCode: "SV", prefix: "SV-" },
  { code: "SALE_RETURN", name: "Sale return", seriesCode: "SR", prefix: "SR-" },
  { code: "PURCHASE", name: "Purchase invoice", seriesCode: "PV", prefix: "PV-" },
  { code: "PURCHASE_RETURN", name: "Purchase return", seriesCode: "PR", prefix: "PR-" },
  { code: "PURCHASE_ORDER", name: "Purchase order", seriesCode: "PO", prefix: "PO-" },
  { code: "ADJUSTMENT", name: "Stock adjustment", seriesCode: "ADJ", prefix: "ADJ-" },
] as const;

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

async function main(): Promise<void> {
  const pool = createDbPool();
  const db = createDb(pool);

  // ---- Block 1: tenant / branch / roles / dev.owner / option lists ----------------------------
  // Guarded by the dev tenant existing (the original single guard, unchanged in meaning).
  const existing = await db.select({ tenantId: tenants.tenantId }).from(tenants).where(eq(tenants.code, "dev"));
  if (existing.length > 0) {
    console.log("Dev tenant already seeded -- base block skipped.");
  } else {
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

      // Matches SessionGuard's dev-mode stub actor (apps/api/src/common/auth/session.guard.ts):
      // username "dev.owner". passwordHash is a placeholder -- the dev-mode auth stub never checks
      // it (real password auth is a separate, not-yet-built increment; see that file's header).
      await tx.insert(appUsers).values({
        tenantId: tenant.tenantId,
        defaultBranchId: branch.branchId,
        username: "dev.owner",
        displayName: "Dev Owner",
        passwordHash: "argon2id$unset$dev-mode-auth-stub-active",
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
  }

  // ---- Block 2: docflow / GL chart / payments / categories / parties / items ------------------
  // Separately guarded (document_type SALE for the dev tenant) so this block can top up a
  // database that was seeded by the older, block-1-only shape of this script.
  const [tenant] = await db.select({ tenantId: tenants.tenantId }).from(tenants).where(eq(tenants.code, "dev"));
  if (!tenant) throw new Error("Dev tenant missing after block 1 -- cannot seed posting fixtures.");
  const tenantId = tenant.tenantId;

  const existingDocflow = await db
    .select({ documentTypeId: documentTypes.documentTypeId })
    .from(documentTypes)
    .where(and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.code, "SALE")));
  if (existingDocflow.length > 0) {
    console.log("Posting fixtures already seeded -- nothing to do.");
    await pool.end();
    return;
  }

  await db.transaction(async (tx) => {
    // §T04-§T06: document types, numbering series (prefix + pad 6, never reset), '*' counters.
    for (const docType of DOC_TYPES) {
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
    }

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
  await pool.end();
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
