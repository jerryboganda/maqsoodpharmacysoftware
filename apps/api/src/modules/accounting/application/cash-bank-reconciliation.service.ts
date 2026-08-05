// Blueprint: 18-api-plan.md §8.2 `/cash-bank/reconciliations` (R2.3 -- this file's sibling
// cash-bank.service.ts already cites "R2.4 daily reconciliation" as the reason cash_bank_account
// is 1:1 with gl_account). Structural sibling of cash-bank.service.ts -- same
// TenantContextService/LedgerQueryService-adjacent conventions, same GL-leaf validation pattern.
//
// Deliberately NOT built: the `adjustments[]` sub-step of `POST .../complete` that would post a
// GL journal entry for an unexplained bank difference. That is a NEW posting rule (what account
// is debited/credited for a bank-statement discrepancy?) this codebase has never modelled and has
// no existing account binding to resolve it from -- same "don't invent a contra account" judgement
// sale-invoices.service.ts's own discount-rejection 422 already makes for an analogous gap. A
// reconciliation only ever completes when the matched lines' net effect exactly equals the
// statement's closing balance; any non-zero difference is an honest 422
// `RECON.UNEXPLAINED_DIFFERENCE`, whether or not the caller supplied `adjustments`.
import { Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, lte, ne, notInArray } from "drizzle-orm";
import { cashBankAccounts, cashBankReconciliationMatches, cashBankReconciliations, getDb, glAccounts, journalEntries, journalLines } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import { ScopeService } from "../../../common/authz/scope.service.js";
import { businessDateParam } from "../../../common/dates/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CompleteReconciliationInput, StartReconciliationInput } from "../api/dto/cash-bank.dto.js";

@Injectable()
export class CashBankReconciliationService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** `POST /cash-bank/reconciliations` -- 422 if the account isn't a `bank` kind (per
   *  18-api-plan.md's own "account is a bank kind" validation note; a cash drawer/petty cash
   *  account has no external statement to reconcile against). */
  async start(input: StartReconciliationInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const account = await this.assertBankAccount(tenantId, input.cashBankAccountId);
    // Write-scope check: starting a reconciliation against an account outside the actor's
    // cash_bank_account scope 403s -- same choke point cash-bank.service.ts's own transfer()
    // and payment/expense's resolveCashBankAccount use.
    await this.scope.assertAllowed(actor, "cash_bank_account", input.cashBankAccountId, "cashBankAccountId");

    const [result] = await db.insert(cashBankReconciliations).values({
      tenantId,
      cashBankAccountId: account.cashBankAccountId,
      statementDate: new Date(`${input.statementDate}T00:00:00`),
      statementClosingBalance: input.statementClosingBalance,
      status: "open",
      createdBy: actorId,
      createdSource: "api",
    });
    const reconciliationId = Number(result.insertId);
    const [reconciliation] = await db.select().from(cashBankReconciliations).where(eq(cashBankReconciliations.reconciliationId, reconciliationId));
    if (!reconciliation) throw new Error("cash_bank_reconciliation insert did not land"); // unreachable; defensive

    const unreconciledLines = await this.candidateLines(tenantId, account.glAccountId, input.statementDate);
    return { reconciliation: shapeReconciliation(reconciliation), unreconciledLines };
  }

  /** `POST /cash-bank/reconciliations/:id/complete` -- see this file's own header comment for why
   *  a non-zero difference always 422s rather than accepting `adjustments`. */
  async complete(reconciliationId: number, input: CompleteReconciliationInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const [header] = await db.select().from(cashBankReconciliations).where(and(eq(cashBankReconciliations.reconciliationId, reconciliationId), eq(cashBankReconciliations.tenantId, tenantId)));
    if (!header) throw new NotFoundException(`No cash/bank reconciliation ${reconciliationId} for this tenant.`);
    // Write-scope check: a reconciliation someone else started, against an account outside THIS
    // actor's current cash_bank_account scope, cannot be completed by them either -- re-checked
    // here (not just at start()) since the completing actor need not be the one who started it.
    await this.scope.assertAllowed(actor, "cash_bank_account", header.cashBankAccountId, "cashBankAccountId");
    if (header.status === "completed") {
      throw new BusinessRuleException("RECON.ALREADY_COMPLETED", "Already completed", `Reconciliation ${reconciliationId} was already completed.`);
    }

    const [account] = await db.select({ glAccountId: cashBankAccounts.glAccountId }).from(cashBankAccounts).where(eq(cashBankAccounts.cashBankAccountId, header.cashBankAccountId));
    if (!account) throw new Error(`cash_bank_reconciliation ${reconciliationId} points at a missing cash_bank_account`); // unreachable; FK-enforced
    const [gl] = await db.select({ normalBalance: glAccounts.normalBalance }).from(glAccounts).where(eq(glAccounts.glAccountId, account.glAccountId));
    if (!gl) throw new Error("cash_bank_account.gl_account_id points at a missing gl_account"); // unreachable; FK-enforced

    return db.transaction(async (tx) => {
      const lines = await tx
        .select({
          journalLineId: journalLines.journalLineId,
          debitAmount: journalLines.debitAmount,
          creditAmount: journalLines.creditAmount,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
        .where(
          and(
            inArray(journalLines.journalLineId, [...input.matchedLineIds]),
            eq(journalLines.glAccountId, account.glAccountId),
            eq(journalLines.tenantId, tenantId),
            ne(journalEntries.status, "draft"),
          ),
        );
      if (lines.length !== input.matchedLineIds.length) {
        throw new BusinessRuleException(
          "RECON.INVALID_LINE_SELECTION",
          "Invalid line selection",
          `One or more matchedLineIds do not belong to this account, are not posted, or do not exist. Expected ${input.matchedLineIds.length}, resolved ${lines.length}.`,
        );
      }

      const alreadyMatched = await tx
        .select({ journalLineId: cashBankReconciliationMatches.journalLineId })
        .from(cashBankReconciliationMatches)
        .innerJoin(cashBankReconciliations, eq(cashBankReconciliationMatches.reconciliationId, cashBankReconciliations.reconciliationId))
        .where(and(eq(cashBankReconciliations.status, "completed"), inArray(cashBankReconciliationMatches.journalLineId, [...input.matchedLineIds])));
      if (alreadyMatched.length > 0) {
        throw new BusinessRuleException(
          "RECON.LINE_ALREADY_RECONCILED",
          "Line already reconciled",
          `Journal line(s) ${alreadyMatched.map((r) => r.journalLineId).join(", ")} were already matched by a completed reconciliation.`,
        );
      }

      let matchedTotal = Money.zero();
      for (const line of lines) {
        const debit = Money.fromDb(line.debitAmount);
        const credit = Money.fromDb(line.creditAmount);
        matchedTotal = gl.normalBalance === "debit" ? matchedTotal.add(debit).sub(credit) : matchedTotal.add(credit).sub(debit);
      }
      const difference = Money.fromDb(header.statementClosingBalance).sub(matchedTotal);

      if (!difference.isZero()) {
        throw new BusinessRuleException(
          "RECON.UNEXPLAINED_DIFFERENCE",
          "Unexplained difference",
          `The matched lines' net effect (${matchedTotal.toDb()}) does not equal the statement closing balance (${header.statementClosingBalance}) -- a difference of ${difference.toDb()}. ` +
            "This wave does not post an adjustment for an unexplained bank difference (no existing GL rule covers it) -- re-select matchedLineIds until the difference is exactly zero.",
        );
      }

      if (input.matchedLineIds.length > 0) {
        await tx.insert(cashBankReconciliationMatches).values(input.matchedLineIds.map((journalLineId) => ({ reconciliationId, journalLineId })));
      }

      const now = new Date();
      await tx
        .update(cashBankReconciliations)
        .set({
          status: "completed",
          differenceAmount: difference.toDb(),
          ...(input.reason !== undefined && { reason: input.reason }),
          completedAt: now,
          completedBy: actorId,
        })
        .where(eq(cashBankReconciliations.reconciliationId, reconciliationId));

      const [updated] = await tx.select().from(cashBankReconciliations).where(eq(cashBankReconciliations.reconciliationId, reconciliationId));
      if (!updated) throw new Error(`cash_bank_reconciliation ${reconciliationId} vanished immediately after its own update`); // unreachable; defensive
      return { reconciliation: shapeReconciliation(updated), journalEntry: null };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async assertBankAccount(tenantId: number, cashBankAccountId: number) {
    const db = getDb();
    const [row] = await db
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId, glAccountId: cashBankAccounts.glAccountId, accountKind: cashBankAccounts.accountKind })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
    if (!row) {
      throw new AppException({ status: 404, code: "CASH_BANK.ACCOUNT_NOT_FOUND", title: "Cash/bank account not found", detail: `No cash/bank account with id ${cashBankAccountId} exists.` });
    }
    if (row.accountKind !== "bank") {
      throw new BusinessRuleException(
        "RECON.NOT_A_BANK_ACCOUNT",
        "Not a bank account",
        `Cash/bank account ${cashBankAccountId} is a "${row.accountKind}" account -- only "bank" accounts can be reconciled against a statement.`,
      );
    }
    return row;
  }

  /** Every posted journal line on this GL leaf, dated on/before the statement date, that hasn't
   *  already been matched by a COMPLETED reconciliation (a still-open, never-completed
   *  reconciliation's own candidate offer does not block a different reconciliation from also
   *  proposing the same line -- see payments.ts's own `cash_bank_reconciliation_match` doc
   *  comment). */
  private async candidateLines(tenantId: number, glAccountId: number, statementDate: string) {
    const db = getDb();
    const completedMatches = await db
      .select({ journalLineId: cashBankReconciliationMatches.journalLineId })
      .from(cashBankReconciliationMatches)
      .innerJoin(cashBankReconciliations, eq(cashBankReconciliationMatches.reconciliationId, cashBankReconciliations.reconciliationId))
      .where(eq(cashBankReconciliations.status, "completed"));
    const excludedIds = completedMatches.map((m) => m.journalLineId);

    const conditions = [
      eq(journalLines.glAccountId, glAccountId),
      eq(journalLines.tenantId, tenantId),
      eq(journalEntries.tenantId, tenantId),
      ne(journalEntries.status, "draft"),
      lte(journalEntries.entryDate, businessDateParam(statementDate)),
    ];
    if (excludedIds.length > 0) conditions.push(notInArray(journalLines.journalLineId, excludedIds));

    const rows = await db
      .select({
        journalLineId: journalLines.journalLineId,
        journalEntryId: journalEntries.journalEntryId,
        entryNo: journalEntries.entryNo,
        entryDate: journalEntries.entryDate,
        description: journalEntries.description,
        debit: journalLines.debitAmount,
        credit: journalLines.creditAmount,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
      .where(and(...conditions))
      .orderBy(asc(journalEntries.entryDate), asc(journalLines.lineNo));
    return rows;
  }
}

function shapeReconciliation<T extends { statementDate: Date; completedAt: Date | null }>(row: T): Omit<T, "statementDate" | "completedAt"> & { statementDate: string; completedAt: string | null } {
  // Same Date-mode-column-read-back-as-full-ISO-timestamp pattern documented in
  // settings.service.ts's `toDateOnlyOrNull` -- `statementDate` is a plain business date, not a
  // timestamp, and must round-trip as YYYY-MM-DD.
  return {
    ...row,
    statementDate: row.statementDate.toISOString().slice(0, 10),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  };
}
