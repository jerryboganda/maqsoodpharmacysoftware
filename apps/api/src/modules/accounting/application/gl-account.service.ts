// Blueprint: 18-api-plan.md §5.4 -- GET /gl/accounts (flat + tree), GET /gl/accounts/{id},
// GET /gl/accounts/{id}/ledger. Read-only (resource "gl.account"/"gl.ledger" -- no POST/PATCH
// here per this task's exact scope: chart-of-accounts admin writes are out of scope).
import { Injectable } from "@nestjs/common";
import { and, asc, eq, like, or } from "drizzle-orm";
import { getDb, glAccountCategories, glAccountMains, glAccounts, glAccountSubs } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { AppException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { GlAccountLedgerQuery, ListGlAccountsQuery } from "../api/dto/gl-account.dto.js";
import { LedgerQueryService } from "./ledger-query.service.js";

@Injectable()
export class GlAccountService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ledgerQuery: LedgerQueryService,
  ) {}

  /** GET /gl/accounts -- flat list, or the 4-level tree when `tree=true`. */
  async list(params: ListGlAccountsQuery, actor: Actor) {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    if (params.tree === true) return this.getTree(tenantId);
    return this.getFlat(tenantId, params);
  }

  /** GET /gl/accounts/{id} -- one leaf account plus its full ancestry (sub/category/main). */
  async getById(glAccountId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [row] = await db
      .select({ account: glAccounts, sub: glAccountSubs, category: glAccountCategories, main: glAccountMains })
      .from(glAccounts)
      .innerJoin(glAccountSubs, eq(glAccounts.glAccountSubId, glAccountSubs.glAccountSubId))
      .innerJoin(glAccountCategories, eq(glAccountSubs.glAccountCategoryId, glAccountCategories.glAccountCategoryId))
      .innerJoin(glAccountMains, eq(glAccountCategories.glAccountMainId, glAccountMains.glAccountMainId))
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.glAccountId, glAccountId)));
    if (!row) throw accountNotFound(glAccountId);
    return { account: row.account, sub: row.sub, category: row.category, main: row.main };
  }

  /** GET /gl/accounts/{id}/ledger -- delegates the running-balance computation to the shared
   *  LedgerQueryService (also used by GET /cash-bank/book). */
  async getLedger(glAccountId: number, params: GlAccountLedgerQuery, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [account] = await db
      .select({
        glAccountId: glAccounts.glAccountId,
        code: glAccounts.code,
        name: glAccounts.name,
        normalBalance: glAccounts.normalBalance,
      })
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.glAccountId, glAccountId)));
    if (!account) throw accountNotFound(glAccountId);

    const ledger = await this.ledgerQuery.getAccountLedger(tenantId, glAccountId, account.normalBalance, params);
    return { account, ...ledger };
  }

  private async getFlat(tenantId: number, params: ListGlAccountsQuery) {
    const db = getDb();
    const conditions = [eq(glAccounts.tenantId, tenantId)];
    if (params.isPostable !== undefined) conditions.push(eq(glAccounts.isPostable, params.isPostable));
    if (params.isActive !== undefined) conditions.push(eq(glAccounts.isActive, params.isActive));
    if (params.q !== undefined) {
      const needle = `%${params.q}%`;
      const match = or(like(glAccounts.code, needle), like(glAccounts.name, needle));
      if (match) conditions.push(match);
    }

    const rows = await db
      .select({
        glAccountId: glAccounts.glAccountId,
        code: glAccounts.code,
        name: glAccounts.name,
        nameUr: glAccounts.nameUr,
        accountNature: glAccounts.accountNature,
        normalBalance: glAccounts.normalBalance,
        isContra: glAccounts.isContra,
        isPostable: glAccounts.isPostable,
        isSystem: glAccounts.isSystem,
        isActive: glAccounts.isActive,
        glAccountSubId: glAccountSubs.glAccountSubId,
        subCode: glAccountSubs.code,
        subName: glAccountSubs.name,
        subledgerKind: glAccountSubs.subledgerKind,
        glAccountCategoryId: glAccountCategories.glAccountCategoryId,
        categoryCode: glAccountCategories.code,
        categoryName: glAccountCategories.name,
        glAccountMainId: glAccountMains.glAccountMainId,
        mainCode: glAccountMains.code,
        mainName: glAccountMains.name,
      })
      .from(glAccounts)
      .innerJoin(glAccountSubs, eq(glAccounts.glAccountSubId, glAccountSubs.glAccountSubId))
      .innerJoin(glAccountCategories, eq(glAccountSubs.glAccountCategoryId, glAccountCategories.glAccountCategoryId))
      .innerJoin(glAccountMains, eq(glAccountCategories.glAccountMainId, glAccountMains.glAccountMainId))
      .where(and(...conditions))
      .orderBy(asc(glAccounts.code));

    return { data: rows };
  }

  private async getTree(tenantId: number) {
    const db = getDb();
    const [mains, categories, subs, accounts] = await Promise.all([
      db
        .select()
        .from(glAccountMains)
        .where(eq(glAccountMains.tenantId, tenantId))
        .orderBy(asc(glAccountMains.sortOrder), asc(glAccountMains.code)),
      db
        .select()
        .from(glAccountCategories)
        .where(eq(glAccountCategories.tenantId, tenantId))
        .orderBy(asc(glAccountCategories.presentationOrder), asc(glAccountCategories.code)),
      db.select().from(glAccountSubs).where(eq(glAccountSubs.tenantId, tenantId)).orderBy(asc(glAccountSubs.code)),
      db.select().from(glAccounts).where(eq(glAccounts.tenantId, tenantId)).orderBy(asc(glAccounts.code)),
    ]);

    const accountsBySub = groupBy(accounts, (a) => a.glAccountSubId);
    const subsByCategory = groupBy(subs, (s) => s.glAccountCategoryId);
    const categoriesByMain = groupBy(categories, (c) => c.glAccountMainId);

    const data = mains.map((main) => ({
      glAccountMainId: main.glAccountMainId,
      code: main.code,
      name: main.name,
      accountNature: main.accountNature,
      normalBalance: main.normalBalance,
      categories: (categoriesByMain.get(main.glAccountMainId) ?? []).map((category) => ({
        glAccountCategoryId: category.glAccountCategoryId,
        code: category.code,
        name: category.name,
        statementSection: category.statementSection,
        subs: (subsByCategory.get(category.glAccountCategoryId) ?? []).map((sub) => ({
          glAccountSubId: sub.glAccountSubId,
          code: sub.code,
          name: sub.name,
          subledgerKind: sub.subledgerKind,
          isControlAccount: sub.isControlAccount,
          accounts: (accountsBySub.get(sub.glAccountSubId) ?? []).map((account) => ({
            glAccountId: account.glAccountId,
            code: account.code,
            name: account.name,
            accountNature: account.accountNature,
            normalBalance: account.normalBalance,
            isContra: account.isContra,
            isPostable: account.isPostable,
            isActive: account.isActive,
          })),
        })),
      })),
    }));

    return { data };
  }
}

function accountNotFound(glAccountId: number): AppException {
  return new AppException({
    status: 404,
    code: "LEDGER.ACCOUNT_NOT_FOUND",
    title: "GL account not found",
    detail: `No GL account with id ${glAccountId} exists.`,
  });
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}
