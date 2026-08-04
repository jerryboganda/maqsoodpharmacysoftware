// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.2, row "GET/POST/PATCH
// /api/v1/expense-categories" (R2.2). Simple LK-pack CRUD, structural mirror of
// payment-method.service.ts (payments module, same Wave 5 shape) -- the two real behavioural
// differences are `glAccountId` (mandatory here, §5.2's own fix -- same bug class
// adjustment_reason.gl_account_id already fixes, inventory.ts) instead of an optional
// `defaultCashBankAccountId`, and the is_system usage guard on disable (this task's own
// instruction) instead of payment_method's "at most one default" guard (that one is kept too --
// see create()/update() below -- it's the LK pack's own documented P1.2 convention, not something
// this task asked for specifically, but every other LK-pack CRUD in this codebase enforces it).
import { Injectable } from "@nestjs/common";
import { and, asc, eq, ne } from "drizzle-orm";
import { expenseCategories, expenseLines, getDb, glAccounts } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import type { DbOrTx, Tx } from "../../../common/db/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateExpenseCategoryInput, UpdateExpenseCategoryInput } from "../api/dto/expense-category.dto.js";

type ExpenseCategoryRow = typeof expenseCategories.$inferSelect;

@Injectable()
export class ExpenseCategoryService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(params: { includeDisabled?: boolean | undefined }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(expenseCategories.tenantId, tenantId)];
    if (!params.includeDisabled) conditions.push(eq(expenseCategories.isEnabled, true));
    const rows = await db
      .select()
      .from(expenseCategories)
      .where(and(...conditions))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.name));
    return { expenseCategories: rows };
  }

  /** Not in the task's literal endpoint list (only GET list / POST / PATCH were named) -- added
   *  so PATCH has a way to fetch current state, same addition (and same justification)
   *  PaymentMethodsController's own GET /:id documents for its sibling module. */
  async getById(expenseCategoryId: number, actor: Actor): Promise<ExpenseCategoryRow> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    return this.loadHeader(db, tenantId, expenseCategoryId);
  }

  async create(input: CreateExpenseCategoryInput, actor: Actor): Promise<ExpenseCategoryRow> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const code = input.code.toUpperCase();

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ expenseCategoryId: expenseCategories.expenseCategoryId })
        .from(expenseCategories)
        .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, code)));
      if (existing) {
        throw new AppException({
          status: 409,
          code: "EXPENSE_CATEGORY.DUPLICATE_CODE",
          title: "Expense category code already used",
          detail: `An expense category with code "${code}" already exists.`,
        });
      }

      await this.assertGlAccountPostable(tx, tenantId, input.glAccountId);

      // P1.2: at most one default per tenant list -- same "unset any other default first"
      // discipline payment-method.service.ts's create() documents for the identical LK-pack rule.
      if (input.isDefault) {
        await tx.update(expenseCategories).set({ isDefault: false, updatedBy: actorId }).where(eq(expenseCategories.tenantId, tenantId));
      }

      await tx.insert(expenseCategories).values({
        tenantId,
        code,
        name: input.name,
        description: input.description ?? null,
        isEnabled: input.isEnabled,
        isDefault: input.isDefault,
        sortOrder: input.sortOrder,
        glAccountId: input.glAccountId,
        isSystem: false, // only the Wave 5 seed produces isSystem:true rows -- see the DTO's header comment
        remarks: input.remarks ?? null,
        createdBy: actorId,
        createdSource: "api",
      });

      const [row] = await tx.select().from(expenseCategories).where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, code)));
      if (!row) throw new Error("expense_category insert did not land"); // unreachable; defensive
      return row;
    });
  }

  async update(expenseCategoryId: number, input: UpdateExpenseCategoryInput, actor: Actor): Promise<ExpenseCategoryRow> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const existing = await this.loadHeader(tx, tenantId, expenseCategoryId);

      if (input.glAccountId !== undefined) {
        await this.assertGlAccountPostable(tx, tenantId, input.glAccountId);
      }

      // Task instruction: an `isSystem` row (one of the six Wave 5 seeded defaults -- RENT/
      // UTILITIES/SALARIES_WAGES/REPAIRS_MAINTENANCE/OFFICE_SUPPLIES/MISCELLANEOUS) cannot be
      // disabled once any expense_line already references it. Scoped to isSystem rows
      // specifically (the task's exact wording) rather than every category -- an ordinary,
      // operator-created category being disabled while in use is a narrower, lower-stakes
      // situation an admin can always re-enable or recategorise; the six system defaults are the
      // ones the application (and the expense-entry UI's "no categories configured" empty state)
      // depends on always having at least a usable set of.
      if (input.isEnabled === false && existing.isSystem) {
        const [usage] = await tx
          .select({ expenseLineId: expenseLines.expenseLineId })
          .from(expenseLines)
          .where(and(eq(expenseLines.tenantId, tenantId), eq(expenseLines.expenseCategoryId, expenseCategoryId)))
          .limit(1);
        if (usage) {
          throw new BusinessRuleException(
            "EXPENSE_CATEGORY.IN_USE",
            "Category in use",
            `Expense category "${existing.name}" is a system default and is already referenced by at least one expense line; it cannot be disabled.`,
          );
        }
      }

      if (input.isDefault === true) {
        await tx
          .update(expenseCategories)
          .set({ isDefault: false, updatedBy: actorId })
          .where(and(eq(expenseCategories.tenantId, tenantId), ne(expenseCategories.expenseCategoryId, expenseCategoryId)));
      }

      await tx
        .update(expenseCategories)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.glAccountId !== undefined && { glAccountId: input.glAccountId }),
          ...(input.isEnabled !== undefined && { isEnabled: input.isEnabled }),
          ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
          ...(input.sortOrder !== undefined && { sortOrder: input.sortOrder }),
          ...(input.remarks !== undefined && { remarks: input.remarks }),
          updatedBy: actorId,
        })
        .where(eq(expenseCategories.expenseCategoryId, expenseCategoryId));

      const [row] = await tx.select().from(expenseCategories).where(eq(expenseCategories.expenseCategoryId, expenseCategoryId));
      if (!row) throw new Error("expense_category update did not land"); // unreachable; defensive
      return row;
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async loadHeader(dbOrTx: DbOrTx, tenantId: number, expenseCategoryId: number): Promise<ExpenseCategoryRow> {
    const [row] = await dbOrTx
      .select()
      .from(expenseCategories)
      .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.expenseCategoryId, expenseCategoryId)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "EXPENSE_CATEGORY.NOT_FOUND",
        title: "Expense category not found",
        detail: `No expense category with id ${expenseCategoryId} exists.`,
      });
    }
    return row;
  }

  /** §5.2's own fix: glAccountId must reference a real, postable, active gl_account -- the exact
   *  same invariant adjustment_reason.gl_account_id already enforces (inventory.ts), and the same
   *  error code 18-api-plan.md §5.2 names for this row (`422 LOOKUP.GL_ACCOUNT_REQUIRED`). */
  private async assertGlAccountPostable(tx: Tx, tenantId: number, glAccountId: number): Promise<void> {
    const [row] = await tx
      .select({ isPostable: glAccounts.isPostable, isActive: glAccounts.isActive })
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.glAccountId, glAccountId)));
    if (!row) {
      throw new BusinessRuleException("LOOKUP.GL_ACCOUNT_REQUIRED", "Unknown GL account", `glAccountId ${glAccountId} does not exist.`, [
        { path: "glAccountId", code: "LOOKUP.GL_ACCOUNT_REQUIRED", message: "Unknown GL account" },
      ]);
    }
    if (!row.isPostable || !row.isActive) {
      throw new BusinessRuleException(
        "LOOKUP.GL_ACCOUNT_REQUIRED",
        "GL account not postable",
        `glAccountId ${glAccountId} is not a postable, active leaf account.`,
        [{ path: "glAccountId", code: "LOOKUP.GL_ACCOUNT_REQUIRED", message: "Not postable/active" }],
      );
    }
  }
}
