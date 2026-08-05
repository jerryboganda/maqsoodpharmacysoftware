// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.2 "Module `payments` -- expenses"
// (R2.2). Structural mirror of purchasing/application/purchase-return.service.ts and
// payments/application/payment.service.ts: TX-6 lock order (DocNumberService.allocate() first),
// AppException/BusinessRuleException RFC-9457 error pattern, TenantContextService.resolveScope
// (actor). Unlike those two (create-and-post-in-one-transaction), expenses use a draft-then-post
// workflow (this task's own instruction) -- create() only writes status "draft"; post() is a
// separate call/transaction that does the actual GL posting. A real "EXP-" doc number is still
// allocated at draft-create time: `expense.doc_number` is NOT NULL, mirroring
// stock-take.service.ts's own "N-1-relaxed-for-drafts" precedent (a draft document must still be
// addressable by its number) -- confirmed against that file's create() before writing this one.
//
// GL (task instruction, resolves off already-existing per-category/per-account GL bindings --
// expense_category.glAccountId is a real, mandatory, admin-configured FK to a postable
// gl_account, exactly like cashBankAccounts.glAccountId; see packages/db/schema/expenses.ts's
// header comment):
//   post():    for each line, Dr expenseCategory.glAccountId  line.amount   (legRole "charge")
//              one aggregate                Cr cashBankAccount.glAccountId  totalAmount  (legRole "primary_credit")
//   reverse(): every leg swapped -- Dr/Cr flip. Position-describing roles flip with the side
//              (primary_credit -> primary_debit, mirroring payment.service.ts's cancel() swap of
//              its own party leg); role-describing tags that name WHAT a leg is (not WHICH SIDE)
//              stay put, so "charge" is reused on both sides (mirroring how payment.service.ts's
//              cash/bank leg keeps its "payment" role tag on cancel regardless of side).
// `legRole` choice for the per-line debits: journal_line's leg_role enum (ledger.ts) has no
// "multiple debits in one document" role -- "primary_debit" reads as THE single primary debit of
// a 2-leg document (how purchase-return.service.ts/payment.service.ts both use it), which doesn't
// fit an expense's N-debit/1-credit shape. "charge" is the closest fit semantically (an expense
// IS a charge against a GL account) and is otherwise unused in this codebase, so it is reused here
// for every per-category debit leg; the aggregate cash/bank leg gets "primary_credit" per the
// task's own explicit instruction.
//
// Period-lock VALIDATION only, never persisted -- `expense` deliberately has no fiscalPeriodId
// column (packages/db/schema/expenses.ts's own documented DOC-pack deviation, flagged there for
// this exact follow-up agent). `FiscalPeriodService.resolveOpenPeriod` is still called at create/
// update/post/reverse so a document cannot be drafted or posted against a closed period, it just
// has nowhere on the row to persist the resolved id.
//
// CANCEL vs REVERSE -- draft cancel has zero GL impact (nothing was ever posted), so cancel() is
// a pure status flip. reverse() only runs from "posted" and posts a real reversing journal entry
// via the now-current shared JournalService.post() (its reversalSeq/reversalOfJournalId/
// reversalReason parameters, added by the `accounting` module for POST /gl/journal-entries/{id}/
// reverse -- see journal.service.ts's own header comment) rather than payment.service.ts's older
// in-module postReversingJournal mirror, which predates that extension and is now redundant to
// re-derive. Schema decision (explicit task instruction to choose and document): the ORIGINAL
// `expense` row is flipped to status "reversed" and keeps its original `journalEntryId` pointing
// at the ORIGINAL posting; the reversing journal_entry is discoverable via its own
// `reversalOfJournalId` back-reference (exactly how payment.service.ts's cancel() leaves
// `payment.journalEntryId` alone). `expense.reversalOfExpenseId` (the schema's self-ref column)
// is NOT used by this flow -- no second `expense` row is created, so there is nothing for it to
// point at; it stays available for a future "post a correcting expense" flow this task didn't ask
// for.
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { cashBankAccounts, expenseCategories, expenseLines, expenses, getDb, journalEntries, journalLines } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import { ScopeService } from "../../../common/authz/scope.service.js";
import type { DbOrTx, Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateExpenseInput, ExpenseLineInput, ReverseExpenseInput, UpdateExpenseInput } from "../api/dto/expense.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface ComputedExpenseLine {
  readonly lineNo: number;
  readonly expenseCategoryId: number;
  readonly amount: Money;
  readonly memo?: string | undefined;
}

@Injectable()
export class ExpenseService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
    private readonly tenantContext: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  async list(
    params: {
      status?: "draft" | "posted" | "cancelled" | "reversed" | undefined;
      cashBankAccountId?: number | undefined;
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(expenses.tenantId, tenantId)];
    if (params.status !== undefined) conditions.push(eq(expenses.status, params.status));
    if (params.cashBankAccountId !== undefined) conditions.push(eq(expenses.cashBankAccountId, params.cashBankAccountId));
    if (params.dateFrom !== undefined) conditions.push(gte(expenses.expenseDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(expenses.expenseDate, new Date(`${params.dateTo}T00:00:00`)));

    // F-4 (18-api-plan.md): role_scope is a mandatory AND applied AFTER the client's own filters.
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const allowedAccountIds = await this.scope.getAllowedIds(actor, "cash_bank_account");
    if (allowedAccountIds !== null) {
      if (allowedAccountIds.size === 0) return { expenses: [], offset, limit };
      conditions.push(inArray(expenses.cashBankAccountId, [...allowedAccountIds]));
    }
    const rows = await db
      .select()
      .from(expenses)
      .where(and(...conditions))
      .orderBy(desc(expenses.expenseDate), desc(expenses.expenseId))
      .limit(limit)
      .offset(offset);
    return { expenses: rows, offset, limit };
  }

  async getById(expenseId: number, actor: Actor, dbOrTx?: DbOrTx) {
    const db = dbOrTx ?? getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const header = await this.loadHeader(db, tenantId, expenseId);
    const lines = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, expenseId)).orderBy(asc(expenseLines.lineNo));
    return { expense: header, lines };
  }

  /** POST /expenses -- creates the DRAFT header + lines in one transaction. No journal posting
   *  here (see this file's header comment); only the doc-number counter is locked (TX-6 lock 1). */
  async create(input: CreateExpenseInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const created = await db.transaction(async (tx) => {
      // ---- Validation (before any lock is taken) -------------------------------------------
      await this.resolveCashBankAccount(tx, tenantId, input.cashBankAccountId, actor);

      const computed = await this.computeLines(tx, tenantId, input.lines);
      let totalAmount = Money.zero();
      for (const line of computed) totalAmount = totalAmount.add(line.amount);

      // Period-lock VALIDATION only -- see this file's header comment.
      await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, input.expenseDate);

      // ---- TX-6 lock 1 (and only lock): the document counter --------------------------------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "EXP");

      await tx.insert(expenses).values({
        tenantId,
        branchId,
        docNumber: allocated.docNumber,
        expenseDate: new Date(`${input.expenseDate}T00:00:00`),
        cashBankAccountId: input.cashBankAccountId,
        totalAmount: totalAmount.toDb(),
        description: input.description ?? null,
        status: "draft",
        createdBy: actorId,
        createdSource: "api",
      });
      const [headerRow] = await tx
        .select({ expenseId: expenses.expenseId })
        .from(expenses)
        .where(and(eq(expenses.tenantId, tenantId), eq(expenses.docNumber, allocated.docNumber)));
      if (!headerRow) throw new Error("expense insert did not land"); // unreachable; defensive
      const expenseId = headerRow.expenseId;

      await tx.insert(expenseLines).values(
        computed.map((line) => ({
          tenantId,
          expenseId,
          lineNo: line.lineNo,
          expenseCategoryId: line.expenseCategoryId,
          amount: line.amount.toDb(),
          memo: line.memo ?? null,
          createdBy: actorId,
          createdSource: "api" as const,
        })),
      );

      return expenseId;
    });

    return this.getById(created, actor);
  }

  /** PATCH /expenses/:id -- draft only. `lines`, when supplied, replaces the whole set (delete +
   *  re-insert) and recomputes `totalAmount`; omitted, the existing lines/total are untouched. */
  async update(expenseId: number, input: UpdateExpenseInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const updated = await db.transaction(async (tx) => {
      const header = await this.loadHeaderForUpdate(tx, tenantId, expenseId);
      if (header.status !== "draft") {
        throw new BusinessRuleException(
          "EXPENSE.NOT_DRAFT",
          "Not a draft",
          `Expense ${header.docNumber} is "${header.status}"; only a draft expense can be edited.`,
        );
      }

      if (input.cashBankAccountId !== undefined) {
        await this.resolveCashBankAccount(tx, tenantId, input.cashBankAccountId, actor);
      }
      if (input.expenseDate !== undefined) {
        // Period-lock VALIDATION only -- see this file's header comment.
        await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, input.expenseDate);
      }

      let totalAmount: Money | undefined;
      if (input.lines !== undefined) {
        const computed = await this.computeLines(tx, tenantId, input.lines);
        totalAmount = Money.zero();
        for (const line of computed) totalAmount = totalAmount.add(line.amount);

        await tx.delete(expenseLines).where(eq(expenseLines.expenseId, expenseId));
        await tx.insert(expenseLines).values(
          computed.map((line) => ({
            tenantId,
            expenseId,
            lineNo: line.lineNo,
            expenseCategoryId: line.expenseCategoryId,
            amount: line.amount.toDb(),
            memo: line.memo ?? null,
            createdBy: actorId,
            createdSource: "api" as const,
          })),
        );
      }

      await tx
        .update(expenses)
        .set({
          ...(input.expenseDate !== undefined && { expenseDate: new Date(`${input.expenseDate}T00:00:00`) }),
          ...(input.cashBankAccountId !== undefined && { cashBankAccountId: input.cashBankAccountId }),
          ...(input.description !== undefined && { description: input.description }),
          ...(totalAmount !== undefined && { totalAmount: totalAmount.toDb() }),
          updatedBy: actorId,
        })
        .where(eq(expenses.expenseId, expenseId));

      return expenseId;
    });

    return this.getById(updated, actor);
  }

  /** POST /expenses/:id/post -- draft only. Dr each line's category account, one aggregate Cr the
   *  cash/bank account. Balance-checked (self-contained journal_line query, mirroring
   *  payment.service.ts's own getCashBankBalance) unless the account allows going negative. */
  async post(expenseId: number, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const posted = await db.transaction(async (tx) => {
      const header = await this.loadHeaderForUpdate(tx, tenantId, expenseId);
      if (header.status !== "draft") {
        throw new BusinessRuleException(
          "EXPENSE.NOT_DRAFT",
          "Not a draft",
          `Expense ${header.docNumber} is "${header.status}"; only a draft expense can be posted.`,
        );
      }

      const lines = await tx.select().from(expenseLines).where(eq(expenseLines.expenseId, expenseId)).orderBy(asc(expenseLines.lineNo));
      if (lines.length === 0) {
        // Unreachable in practice -- create()/update() both enforce lines.length >= 1 -- kept as
        // a defensive 422 rather than trusting that invariant blindly at post time.
        throw new BusinessRuleException("EXPENSE.EMPTY", "No lines", `Expense ${header.docNumber} has no lines to post.`);
      }

      const expenseDateStr = toDateString(header.expenseDate);
      // Period-lock VALIDATION only -- see this file's header comment.
      await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, expenseDateStr);

      const cashBankAccount = await this.resolveCashBankAccount(tx, tenantId, header.cashBankAccountId, actor);
      const totalAmount = Money.fromDb(header.totalAmount);

      if (!cashBankAccount.allowNegative) {
        const balance = await this.getCashBankBalance(tx, tenantId, cashBankAccount.glAccountId);
        if (balance.sub(totalAmount).compare(Money.zero()) < 0) {
          throw new BusinessRuleException(
            "EXPENSE.INSUFFICIENT_FUNDS",
            "Insufficient funds",
            `Cash/bank account #${cashBankAccount.cashBankAccountId} has ${balance.toDb()} available; cannot post an expense of ${totalAmount.toDb()}.`,
            [{ path: "cashBankAccountId", code: "EXPENSE.INSUFFICIENT_FUNDS", message: "Insufficient funds" }],
          );
        }
      }

      const legs: JournalLegInput[] = [];
      for (const [index, line] of lines.entries()) {
        const category = await this.assertCategoryPostable(tx, tenantId, line.expenseCategoryId, index);
        legs.push({ glAccountId: category.glAccountId, debit: line.amount, legRole: "charge" });
      }
      legs.push({ glAccountId: cashBankAccount.glAccountId, credit: totalAmount.toDb(), legRole: "primary_credit" });

      const journalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: header.docNumber,
        entryDate: expenseDateStr,
        documentTypeCode: "EXP",
        sourceDocumentId: expenseId,
        description: `Expense ${header.docNumber}${header.description ? ` -- ${header.description}` : ""}`,
        legs,
        postedBy: actorId,
      });

      const now = new Date();
      await tx
        .update(expenses)
        .set({ journalEntryId, status: "posted", postedAt: now, postedBy: actorId, updatedBy: actorId })
        .where(eq(expenses.expenseId, expenseId));

      return expenseId;
    });

    const result = await this.getById(posted, actor);
    return { ...result, journalEntryId: result.expense.journalEntryId };
  }

  /** POST /expenses/:id/cancel -- draft only (no GL impact to undo -- nothing was ever posted).
   *  A posted expense must go through reverse() instead. */
  async cancel(expenseId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    await db.transaction(async (tx) => {
      const header = await this.loadHeaderForUpdate(tx, tenantId, expenseId);
      if (header.status !== "draft") {
        throw new BusinessRuleException(
          "EXPENSE.NOT_DRAFT",
          "Not a draft",
          `Expense ${header.docNumber} is "${header.status}"; only a draft expense can be cancelled -- a posted expense has a real GL impact and must be reversed instead.`,
        );
      }
      await tx.update(expenses).set({ status: "cancelled", updatedBy: actorId }).where(eq(expenses.expenseId, expenseId));
    });

    return this.getById(expenseId, actor);
  }

  /** POST /expenses/:id/reverse -- posted only. Posts a reversing journal entry (every leg
   *  swapped) via the shared JournalService.post() and flips this row to status "reversed" --
   *  see this file's header comment for the schema-shape decision and the legRole swap rules. */
  async reverse(expenseId: number, input: ReverseExpenseInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const reversed = await db.transaction(async (tx) => {
      const header = await this.loadHeaderForUpdate(tx, tenantId, expenseId);
      if (header.status !== "posted") {
        throw new BusinessRuleException(
          "EXPENSE.NOT_POSTED",
          "Not posted",
          `Expense ${header.docNumber} is "${header.status}"; only a posted expense can be reversed.`,
        );
      }
      if (header.journalEntryId === null) {
        throw new Error("posted expense has no journalEntryId"); // unreachable; ledger.ts's ck_journal_posted invariant
      }

      const lines = await tx.select().from(expenseLines).where(eq(expenseLines.expenseId, expenseId)).orderBy(asc(expenseLines.lineNo));
      const cashBankAccount = await this.resolveCashBankAccount(tx, tenantId, header.cashBankAccountId, actor);
      const totalAmount = Money.fromDb(header.totalAmount);

      // Swap: the original's per-category debit ("charge") legs become credits (role tag stays
      // "charge" -- it names WHAT the leg is, not which side); the original's aggregate cash/
      // bank "primary_credit" leg becomes one aggregate debit, relabelled "primary_debit" (that
      // role tag names the document POSITION, so it flips with the side -- mirrors
      // payment.service.ts's cancel() swap of its own party leg).
      const legs: JournalLegInput[] = [];
      for (const line of lines) {
        const [category] = await tx
          .select({ glAccountId: expenseCategories.glAccountId })
          .from(expenseCategories)
          .where(eq(expenseCategories.expenseCategoryId, line.expenseCategoryId));
        if (!category) throw new Error(`expense category ${line.expenseCategoryId} vanished mid-transaction`); // unreachable; fk_expense_line_category
        legs.push({ glAccountId: category.glAccountId, credit: line.amount, legRole: "charge" });
      }
      legs.push({ glAccountId: cashBankAccount.glAccountId, debit: totalAmount.toDb(), legRole: "primary_debit" });

      const expenseDateStr = toDateString(header.expenseDate);
      // Period-lock VALIDATION only -- see this file's header comment. Reversal is dated on the
      // original expense's own expenseDate, sidestepping the lack of a local "today" helper in
      // this module's scope -- same simplification payment.service.ts's cancel() documents.
      await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, expenseDateStr);

      // ---- TX-6 lock: the document counter (must be first) -- the reversal gets its own real
      // "EXP-" doc number from the same series, mirroring accounting/journal-entry.service.ts's
      // own reverse() precedent (the current, up-to-date reference implementation in this same
      // Wave 5 set) rather than a string-suffixed reuse of the original's number.
      const allocated = await this.docNumbers.allocate(tx, tenantId, "EXP");

      const siblings = await tx
        .select({ reversalSeq: journalEntries.reversalSeq })
        .from(journalEntries)
        .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.documentTypeCode, "EXP"), eq(journalEntries.sourceDocumentId, expenseId)));
      const nextReversalSeq = siblings.length; // original always holds seq 0 -- see journal-entry.service.ts's identical comment

      await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: allocated.docNumber,
        entryDate: expenseDateStr,
        documentTypeCode: "EXP",
        sourceDocumentId: expenseId,
        description: `Reversal of expense ${header.docNumber} -- ${input.reason}`,
        legs,
        postedBy: actorId,
        reversalSeq: nextReversalSeq,
        reversalOfJournalId: header.journalEntryId,
        reversalReason: input.reason,
      });

      await tx.update(journalEntries).set({ status: "reversed" }).where(eq(journalEntries.journalEntryId, header.journalEntryId));

      // Flip the original row only -- no second `expense` row is created (see this file's header
      // comment); `journalEntryId` is left pointing at the ORIGINAL posting, exactly like
      // payment.service.ts's cancel() leaves `payment.journalEntryId` alone.
      await tx.update(expenses).set({ status: "reversed", updatedBy: actorId }).where(eq(expenses.expenseId, expenseId));

      return expenseId;
    });

    return this.getById(reversed, actor);
  }

  // ---- helpers --------------------------------------------------------------------------------

  private async loadHeader(dbOrTx: DbOrTx, tenantId: number, expenseId: number) {
    const [header] = await dbOrTx.select().from(expenses).where(and(eq(expenses.tenantId, tenantId), eq(expenses.expenseId, expenseId)));
    if (!header) {
      throw new AppException({ status: 404, code: "EXPENSE.NOT_FOUND", title: "Expense not found", detail: `No expense with id ${expenseId} exists.` });
    }
    return header;
  }

  private async loadHeaderForUpdate(tx: Tx, tenantId: number, expenseId: number) {
    const [header] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.tenantId, tenantId), eq(expenses.expenseId, expenseId)))
      .for("update");
    if (!header) {
      throw new AppException({ status: 404, code: "EXPENSE.NOT_FOUND", title: "Expense not found", detail: `No expense with id ${expenseId} exists.` });
    }
    return header;
  }

  private async resolveCashBankAccount(tx: Tx, tenantId: number, cashBankAccountId: number, actor: Actor) {
    const [row] = await tx.select().from(cashBankAccounts).where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "EXPENSE.CASH_BANK_ACCOUNT_NOT_FOUND",
        title: "Cash/bank account not found",
        detail: `No cash/bank account with id ${cashBankAccountId} exists.`,
      });
    }
    if (!row.isActive) {
      throw new BusinessRuleException("EXPENSE.CASH_BANK_ACCOUNT_INACTIVE", "Cash/bank account inactive", `Cash/bank account #${cashBankAccountId} is inactive.`);
    }
    // Single choke point for every write that touches a cash/bank account in this service
    // (create, update, post, reverse) -- a write outside the actor's cash_bank_account scope
    // 403s here.
    await this.scope.assertAllowed(actor, "cash_bank_account", cashBankAccountId, "cashBankAccountId");
    return row;
  }

  /** Validates + parses every input line: category exists and is enabled (does NOT re-check the
   *  category's glAccountId is still postable/active -- that invariant is enforced once, at
   *  ExpenseCategoryService create/update time, and trusted here exactly like
   *  payment.service.ts trusts supplier.glAccountId/customer.glAccountId without re-verifying at
   *  payment-post time), amount strictly > 0. No locks taken (pure validation + one read per
   *  line), matching purchase-return.service.ts's computeLine's own "no lock" contract. */
  private async computeLines(tx: Tx, tenantId: number, lines: readonly ExpenseLineInput[]): Promise<ComputedExpenseLine[]> {
    const computed: ComputedExpenseLine[] = [];
    for (const [index, line] of lines.entries()) {
      const lineNo = index + 1;
      const amount = parseAmount(line.amount, `lines.${index}.amount`);
      if (amount.compare(Money.zero()) <= 0) {
        throw new BusinessRuleException("EXPENSE.EMPTY_LINE", "Empty line", `Line ${lineNo}: amount must be greater than zero.`, [
          { path: `lines.${index}.amount`, code: "EXPENSE.EMPTY_LINE", message: "Amount must be > 0" },
        ]);
      }
      await this.assertCategoryEnabled(tx, tenantId, line.expenseCategoryId, index);
      computed.push({ lineNo, expenseCategoryId: line.expenseCategoryId, amount, memo: line.memo });
    }
    return computed;
  }

  private async assertCategoryEnabled(tx: Tx, tenantId: number, expenseCategoryId: number, index: number): Promise<void> {
    const [row] = await tx
      .select({ expenseCategoryId: expenseCategories.expenseCategoryId, isEnabled: expenseCategories.isEnabled })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.expenseCategoryId, expenseCategoryId)));
    if (!row) {
      throw new BusinessRuleException(
        "EXPENSE.CATEGORY_MISSING",
        "Unknown expense category",
        `Line ${index + 1}: expense category ${expenseCategoryId} does not exist.`,
        [{ path: `lines.${index}.expenseCategoryId`, code: "EXPENSE.CATEGORY_MISSING", message: "Unknown expense category" }],
      );
    }
    if (!row.isEnabled) {
      throw new BusinessRuleException(
        "EXPENSE.CATEGORY_DISABLED",
        "Expense category disabled",
        `Line ${index + 1}: expense category ${expenseCategoryId} is disabled.`,
        [{ path: `lines.${index}.expenseCategoryId`, code: "EXPENSE.CATEGORY_DISABLED", message: "Disabled" }],
      );
    }
  }

  /** post()'s own per-line category resolver -- re-checks isEnabled (time may have passed since
   *  create/update; an admin could have disabled the category in the interim) and returns the
   *  glAccountId to post against. */
  private async assertCategoryPostable(tx: Tx, tenantId: number, expenseCategoryId: number, index: number) {
    const [row] = await tx
      .select({ glAccountId: expenseCategories.glAccountId, isEnabled: expenseCategories.isEnabled, name: expenseCategories.name })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.expenseCategoryId, expenseCategoryId)));
    if (!row) {
      throw new BusinessRuleException(
        "EXPENSE.CATEGORY_MISSING",
        "Unknown expense category",
        `Line ${index + 1}: expense category ${expenseCategoryId} does not exist.`,
      );
    }
    if (!row.isEnabled) {
      throw new BusinessRuleException(
        "EXPENSE.CATEGORY_DISABLED",
        "Expense category disabled",
        `Line ${index + 1}: expense category "${row.name}" has been disabled since this draft was created; re-categorise the line before posting.`,
      );
    }
    return row;
  }

  /** Self-contained running balance for one GL account (posted entries only) -- debit-normal
   *  (asset) sign convention, matching every seeded cash/bank leaf. Deliberately queries
   *  journal_line directly rather than depending on the accounting module's ledger endpoint,
   *  mirroring payment.service.ts's own getCashBankBalance (same task instruction, same module
   *  generation). */
  private async getCashBankBalance(tx: Tx, tenantId: number, glAccountId: number): Promise<Money> {
    const [row] = await tx
      .select({
        debit: sql<string>`coalesce(sum(${journalLines.debitAmount}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.creditAmount}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
      .where(
        and(
          eq(journalLines.glAccountId, glAccountId),
          eq(journalLines.tenantId, tenantId),
          eq(journalEntries.tenantId, tenantId),
          eq(journalEntries.status, "posted"),
        ),
      );
    return Money.fromDb(row?.debit ?? "0.00").sub(Money.fromDb(row?.credit ?? "0.00"));
  }
}

function parseAmount(raw: string, path: string): Money {
  const parsed = Money.fromInput(raw);
  if (!parsed.ok) {
    throw new BusinessRuleException("EXPENSE.INVALID_AMOUNT", "Invalid amount", `${path} is not a valid amount.`, [
      { path, code: "EXPENSE.INVALID_AMOUNT", message: "Invalid amount" },
    ]);
  }
  return parsed.value;
}

/** YYYY-MM-DD from a drizzle date-mode Date -- mirrors payment.service.ts's identical helper
 *  (same reasoning: no Asia/Karachi "today" helper exists in this module's scope, and posting/
 *  reversal both need the header's own stored date back out as a wire-shaped string). */
function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
