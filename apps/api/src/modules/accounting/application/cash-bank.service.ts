// Blueprint: 18-api-plan.md §8.2 "/cash-bank-accounts, /cash-bank/book, /cash-bank/transfers"
// (R2.3). Structural mirror of purchasing/application/supplier.service.ts's create (GL leaf
// validation inside the same transaction) and purchase-return.service.ts's TX-6 lock order.
import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { cashBankAccounts, getDb, glAccountSubs, glAccounts, journalEntries, journalLines } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import { ScopeService } from "../../../common/authz/scope.service.js";
import type { Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type {
  CashBankBookQuery,
  CreateCashBankAccountInput,
  CreateCashBankTransferInput,
} from "../api/dto/cash-bank.dto.js";
import { LedgerQueryService } from "./ledger-query.service.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

type CashBankAccountKind = "cash_drawer" | "petty_cash" | "bank" | "mobile_wallet" | "card_settlement";

@Injectable()
export class CashBankService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
    private readonly tenantContext: TenantContextService,
    private readonly ledgerQuery: LedgerQueryService,
    private readonly scope: ScopeService,
  ) {}

  async list(
    params: { accountKind?: CashBankAccountKind | undefined; isActive?: boolean | undefined; offset?: number | undefined; limit?: number | undefined },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(cashBankAccounts.tenantId, tenantId)];
    if (params.accountKind !== undefined) conditions.push(eq(cashBankAccounts.accountKind, params.accountKind));
    if (params.isActive !== undefined) conditions.push(eq(cashBankAccounts.isActive, params.isActive));

    // F-4 (18-api-plan.md): role_scope is a mandatory AND applied AFTER the client's own filters
    // -- an actor scoped to specific accounts (e.g. "SLS own till") never sees rows outside it,
    // no matter what accountKind/isActive they pass.
    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const allowedIds = await this.scope.getAllowedIds(actor, "cash_bank_account");
    if (allowedIds !== null) {
      if (allowedIds.size === 0) return { cashBankAccounts: [], offset, limit };
      conditions.push(inArray(cashBankAccounts.cashBankAccountId, [...allowedIds]));
    }
    const rows = await db
      .select()
      .from(cashBankAccounts)
      .where(and(...conditions))
      .orderBy(asc(cashBankAccounts.cashBankAccountId))
      .limit(limit)
      .offset(offset);
    return { cashBankAccounts: rows, offset, limit };
  }

  async getById(cashBankAccountId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [row] = await db
      .select()
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
    // "Invisible row on read" (18-api-plan.md §0.13.3): a scope-denied account 404s exactly like
    // one that doesn't exist, never a 403 that would confirm its existence to an out-of-scope actor.
    if (!row || !(await this.scope.isReadAllowed(actor, "cash_bank_account", cashBankAccountId))) throw accountNotFound(cashBankAccountId);
    return row;
  }

  /**
   * POST /cash-bank-accounts. `glAccountId` must be a postable, active leaf under a
   * gl_account_sub with subledgerKind='cash_bank' (validated here) that isn't already bound to
   * another cash_bank_account (uk_cash_bank_gl_account -- caught as a clean 422, not a raw DB
   * error). `openingBalanceAmount` is never accepted from the client (no such field on
   * CreateCashBankAccountDto) -- always forced to "0.00" server-side (D10/R3.1).
   */
  async create(input: CreateCashBankAccountInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const glAccount = await this.assertCashBankEligibleGlAccount(tx, tenantId, input.glAccountId);

      try {
        await tx.insert(cashBankAccounts).values({
          tenantId,
          glAccountId: glAccount.glAccountId,
          accountKind: input.accountKind,
          bankName: input.bankName ?? null,
          branchName: input.branchName ?? null,
          accountNo: input.accountNo ?? null,
          iban: input.iban ?? null,
          branchId,
          // D10/R3.1: ALWAYS forced to zero server-side. "0.00", not the "0.0000" the task
          // instruction quoted verbatim -- this column is DOCUMENT_AMOUNT-scale (15,2), the same
          // precision-archetype reconciliation payments.ts's own header comment already documents
          // for this exact column family (17§6.2 vs 19§3.1).
          openingBalanceAmount: Money.zero().toDb(),
          allowNegative: input.allowNegative ?? false,
          isDefaultForSales: input.isDefaultForSales ?? false,
          createdBy: actorId,
          createdSource: "api",
        });
      } catch (error) {
        if (!isDuplicateKeyError(error, "uk_cash_bank_gl_account")) throw error;
        throw new BusinessRuleException(
          "CASH_BANK.GL_ACCOUNT_ALREADY_BOUND",
          "GL account already in use",
          `GL account ${input.glAccountId} is already bound to another cash/bank account.`,
          [{ path: "glAccountId", code: "CASH_BANK.GL_ACCOUNT_ALREADY_BOUND", message: "Already bound to a cash/bank account" }],
        );
      }

      const [row] = await tx
        .select()
        .from(cashBankAccounts)
        .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.glAccountId, glAccount.glAccountId)));
      if (!row) throw new Error("cash_bank_account insert did not land"); // unreachable; defensive
      return row;
    });
  }

  /**
   * GET /cash-bank/book -- thin wrapper: resolves the account's own glAccountId/normalBalance
   * then delegates entirely to LedgerQueryService (also used by
   * GET /gl/accounts/{id}/ledger, gl-account.service.ts) -- no running-balance logic duplicated.
   */
  async book(params: CashBankBookQuery, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [account] = await db
      .select({ cashBankAccountId: cashBankAccounts.cashBankAccountId, glAccountId: cashBankAccounts.glAccountId })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, params.cashBankAccountId)));
    if (!account || !(await this.scope.isReadAllowed(actor, "cash_bank_account", params.cashBankAccountId))) throw accountNotFound(params.cashBankAccountId);

    const [gl] = await db.select({ normalBalance: glAccounts.normalBalance }).from(glAccounts).where(eq(glAccounts.glAccountId, account.glAccountId));
    if (!gl) throw new Error("cash_bank_account.gl_account_id points at a missing gl_account"); // unreachable; FK-enforced

    const ledger = await this.ledgerQuery.getAccountLedger(tenantId, account.glAccountId, gl.normalBalance, params);
    return { cashBankAccountId: account.cashBankAccountId, glAccountId: account.glAccountId, ...ledger };
  }

  /**
   * POST /cash-bank/transfers -- Dr to-account's glAccountId, Cr from-account's glAccountId, both
   * explicit user-supplied accounts (no invented rule). Posts documentTypeCode "CBT" (series from
   * the foundation report's DOC_TYPES). No dedicated header table was asked for here (unlike the
   * manual-voucher flow's `manual_voucher`), so journal_entry.source_document_id is left NULL for
   * a transfer -- ledger.ts's own column comment already anticipates NULL for a document with no
   * header row ("NULL only for manual JVs"; extended here to any document type with none), and
   * MySQL's UNIQUE index (uk_journal_source) permits multiple NULLs so this cannot collide across
   * transfers. Documented consequence: a transfer entry cannot be reversed through
   * POST /gl/journal-entries/{id}/reverse (journal-entry.service.ts#reverse 422s
   * LEDGER.REVERSAL_UNSUPPORTED on a null source_document_id) -- no reverse-a-transfer endpoint
   * was in this task's instructed scope either, so this is a documented gap, not a silent one.
   */
  async transfer(input: CreateCashBankTransferInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    if (input.fromCashBankAccountId === input.toCashBankAccountId) {
      throw new BusinessRuleException(
        "CASH_BANK.SAME_ACCOUNT",
        "Same account",
        "fromCashBankAccountId and toCashBankAccountId must be different accounts.",
        [{ path: "toCashBankAccountId", code: "CASH_BANK.SAME_ACCOUNT", message: "Must differ from fromCashBankAccountId" }],
      );
    }

    return db.transaction(async (tx) => {
      const from = await this.assertActiveAccount(tx, tenantId, input.fromCashBankAccountId, "fromCashBankAccountId");
      const to = await this.assertActiveAccount(tx, tenantId, input.toCashBankAccountId, "toCashBankAccountId");
      // Write-scope check (403 AUTHZ.SCOPE_DENIED, not the read path's 404 mask): a transfer
      // moves real money, so BOTH legs must be within the actor's cash_bank_account scope, not
      // just one -- an actor scoped to their own till cannot move money INTO it from an account
      // they don't otherwise have access to either.
      await this.scope.assertAllowed(actor, "cash_bank_account", input.fromCashBankAccountId, "fromCashBankAccountId");
      await this.scope.assertAllowed(actor, "cash_bank_account", input.toCashBankAccountId, "toCashBankAccountId");
      const amount = parseAmount(input.amount, "amount");

      await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, input.transferDate);

      // ---- TX-6 lock: the document counter (must be first) ---------------------------------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "CBT");

      // exactOptionalPropertyTypes: only include `memo` at all when it was actually supplied.
      const memo = input.memo !== undefined ? { memo: input.memo } : {};
      const legs: JournalLegInput[] = [
        { glAccountId: to.glAccountId, debit: amount.toDb(), legRole: "primary_debit", ...memo },
        { glAccountId: from.glAccountId, credit: amount.toDb(), legRole: "primary_credit", ...memo },
      ];

      const journalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: allocated.docNumber,
        entryDate: input.transferDate,
        documentTypeCode: "CBT",
        // No sourceDocumentId -- see this method's own doc comment.
        description: `Cash/bank transfer ${allocated.docNumber} -- account ${from.cashBankAccountId} -> account ${to.cashBankAccountId}`,
        legs,
        postedBy: actorId,
      });

      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.journalEntryId, journalEntryId));
      if (!entry) throw new Error("journal_entry insert did not land"); // unreachable; defensive
      const lines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, journalEntryId))
        .orderBy(asc(journalLines.lineNo));

      return { entry, lines, from, to, amount: amount.toDb() };
    });
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async assertCashBankEligibleGlAccount(tx: Tx, tenantId: number, glAccountId: number) {
    const [glAccount] = await tx
      .select({ glAccountId: glAccounts.glAccountId, isPostable: glAccounts.isPostable, isActive: glAccounts.isActive, glAccountSubId: glAccounts.glAccountSubId })
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.glAccountId, glAccountId)));
    if (!glAccount) {
      throw new BusinessRuleException(
        "CASH_BANK.GL_ACCOUNT_NOT_FOUND",
        "Unknown GL account",
        `GL account ${glAccountId} does not exist.`,
        [{ path: "glAccountId", code: "CASH_BANK.GL_ACCOUNT_NOT_FOUND", message: "Unknown GL account" }],
      );
    }
    if (!glAccount.isPostable || !glAccount.isActive) {
      throw new BusinessRuleException(
        "CASH_BANK.GL_ACCOUNT_NOT_POSTABLE",
        "GL account not postable",
        `GL account ${glAccountId} is not a postable, active leaf account.`,
        [{ path: "glAccountId", code: "CASH_BANK.GL_ACCOUNT_NOT_POSTABLE", message: "Not postable/active" }],
      );
    }
    const [sub] = await tx.select({ subledgerKind: glAccountSubs.subledgerKind }).from(glAccountSubs).where(eq(glAccountSubs.glAccountSubId, glAccount.glAccountSubId));
    if (!sub || sub.subledgerKind !== "cash_bank") {
      throw new BusinessRuleException(
        "CASH_BANK.NOT_CASH_BANK_SUBLEDGER",
        "Not a cash/bank leaf",
        `GL account ${glAccountId} is not under a gl_account_sub with subledgerKind="cash_bank".`,
        [{ path: "glAccountId", code: "CASH_BANK.NOT_CASH_BANK_SUBLEDGER", message: "Not a cash/bank leaf" }],
      );
    }
    return glAccount;
  }

  private async assertActiveAccount(tx: Tx, tenantId: number, cashBankAccountId: number, path: string) {
    const [row] = await tx
      .select({
        cashBankAccountId: cashBankAccounts.cashBankAccountId,
        glAccountId: cashBankAccounts.glAccountId,
        isActive: cashBankAccounts.isActive,
      })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
    if (!row) {
      throw new BusinessRuleException(
        "CASH_BANK.ACCOUNT_NOT_FOUND",
        "Unknown cash/bank account",
        `Cash/bank account ${cashBankAccountId} does not exist.`,
        [{ path, code: "CASH_BANK.ACCOUNT_NOT_FOUND", message: "Unknown cash/bank account" }],
      );
    }
    if (!row.isActive) {
      throw new BusinessRuleException(
        "CASH_BANK.ACCOUNT_INACTIVE",
        "Inactive cash/bank account",
        `Cash/bank account ${cashBankAccountId} is inactive.`,
        [{ path, code: "CASH_BANK.ACCOUNT_INACTIVE", message: "Inactive cash/bank account" }],
      );
    }
    return row;
  }
}

function accountNotFound(cashBankAccountId: number): AppException {
  return new AppException({
    status: 404,
    code: "CASH_BANK.ACCOUNT_NOT_FOUND",
    title: "Cash/bank account not found",
    detail: `No cash/bank account with id ${cashBankAccountId} exists.`,
  });
}

function parseAmount(raw: string, path: string): Money {
  const result = Money.fromInput(raw);
  if (!result.ok) {
    throw new BusinessRuleException("CASH_BANK.INVALID_AMOUNT", "Invalid amount", `${path} is not a valid amount.`, [
      { path, code: "CASH_BANK.INVALID_AMOUNT", message: "Invalid amount" },
    ]);
  }
  return result.value;
}

/**
 * True when `error` is a MySQL duplicate-key error (ER_DUP_ENTRY / errno 1062) against the named
 * unique key. Mirrors purchase-invoice.service.ts's own identically-named helper (not imported
 * from there -- that one is module-private, not exported).
 */
function isDuplicateKeyError(error: unknown, keyName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const mysqlError = error as { code?: unknown; errno?: unknown; sqlMessage?: unknown };
  const isDupEntry = mysqlError.code === "ER_DUP_ENTRY" || mysqlError.errno === 1062;
  if (!isDupEntry) return false;
  return typeof mysqlError.sqlMessage === "string" && mysqlError.sqlMessage.includes(keyName);
}
