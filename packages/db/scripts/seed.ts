// Dev-only seed data. Populates exactly enough of a fresh `pharmacy_platform` database for
// apps/api's identity/settings modules to run against real data instead of their in-memory
// fixtures (packages/db/client.ts's consumer). Idempotent: guarded by a single check for the
// "dev" tenant, so re-running this script against an already-seeded database is a no-op instead
// of duplicating rows (MySQL UNIQUE indexes treat every NULL as distinct, which would otherwise
// let the tenant_id-nullable `role` table's system rows re-insert on every run).
import { eq } from "drizzle-orm";
import { createDb, createDbPool } from "../client";
import { appUsers, branches, optionItems, optionLists, roles, tenants, userRoles } from "../schema/index";

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

async function main(): Promise<void> {
  const pool = createDbPool();
  const db = createDb(pool);

  const existing = await db.select({ tenantId: tenants.tenantId }).from(tenants).where(eq(tenants.code, "dev"));
  if (existing.length > 0) {
    console.log("Dev tenant already seeded -- nothing to do.");
    await pool.end();
    return;
  }

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
  await pool.end();
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
