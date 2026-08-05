// Blueprint: 18-api-plan.md §5.3 "/cashier-shifts/*" (R2.4) -- open/count/close/approve/z-report,
// activating the legacy CashierShift/CashierShiftCashCount tables that sat dormant with 0 rows
// (`06` §3.6) -- a fresh implementation per R-049 (porting the vendor code is forbidden).
//
// RS-3 (19-mysql-schema-blueprint.md §15 / 20-testing-acceptance-plan.md's own "hard
// precondition" wording): "no R2 code is written until the accountant has signed the debit/credit
// rules for every new posting" -- covers supplier payment, expense, cash/bank transfer, AND
// cashier variance (V-2). Wave 5 resolved this for payment/expense/transfer by deriving their GL
// legs from ALREADY-EXISTING account bindings; the cashier-variance leg has no such binding to
// derive from -- the blueprint's own `variance_account_id` defaults from
// `gl_account_binding['cashier_variance']`, and `gl_account_binding` itself was never built in
// this rebuild (see packages/db/schema/payments.ts's own cashierShifts class comment for the full
// writeup). This service therefore implements the FULL shift lifecycle -- open, blind count,
// close (with an honestly-computed variance and a mandatory typed reason whenever it's non-zero,
// per FT-117/AC-5), and supervisor approval -- but close() NEVER posts a GL journal entry.
// `journalEntryId` stays null forever this wave; the `journalEntry` field is simply absent from
// close()'s response (18-api-plan.md's own `200 { cashierShift, journalEntry? }` already marks it
// optional).
//
// Shift attribution to sales/returns/expenses (for count()'s own blind "expected cash" figure and
// the z-report's breakdown) is derived from the shift's own cashBankAccountId + its
// [openedAt, closedAt-or-now) time window -- against journal_line for the blind-count expected
// figure (mirrors payment.service.ts's own self-contained getCashBankBalance query, just bounded
// by the shift's window instead of "all time"), and against sale_invoice_payment/sale_return/
// expense directly for the z-report's structured salesByMethod[]/returns/expensesPaid breakdown.
// No new `cashier_shift_id` FK was retrofitted onto those tables -- see payments.ts's own class
// comment for why.
import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { cashBankAccounts, cashierShiftCounts, cashierShifts, expenses, getDb, journalEntries, journalLines, saleInvoicePayments, saleInvoices, saleReturns } from "@pharmacy/db";
import { Money, Quantity } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { DbOrTx, Tx } from "../../../common/db/index.js";
import { DocNumberService } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { ApproveCashierShiftInput, CloseCashierShiftInput, CountCashierShiftInput, OpenCashierShiftInput } from "../api/dto/cashier-shift.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** D4 (PKR-only, no currency/currency_denomination table exists in this rebuild) -- the real PKR
 *  banknote/coin denominations currently in circulation (State Bank of Pakistan). Canonical
 *  Money.toDb() form (scale 2) so a submitted count line can be compared by exact string match
 *  after normalisation, regardless of how the client formatted it ("5000", "5000.0", "5000.00"
 *  all normalise to "5000.00"). */
const PKR_DENOMINATIONS = new Set(["5000.00", "1000.00", "500.00", "100.00", "50.00", "20.00", "10.00", "5.00", "2.00", "1.00"]);

/** Roles whose z-report/getById access is NOT limited to their own shift -- everyone else (in
 *  practice, a bare sales_officer) can only see a shift they themselves opened
 *  (18-api-plan.md's own "SLS ◐ own" notation on the z-report row, applied consistently to
 *  getById too). */
const ROLES_WITH_BROAD_SHIFT_ACCESS = new Set(["owner", "shift_incharge", "pharmacy_manager", "accountant", "auditor"]);

type CashierShiftRow = typeof cashierShifts.$inferSelect;

@Injectable()
export class CashierShiftService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(params: { status?: "open" | "closed" | "approved" | undefined; offset?: number | undefined; limit?: number | undefined }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(cashierShifts.tenantId, tenantId)];
    if (params.status !== undefined) conditions.push(eq(cashierShifts.status, params.status));
    if (!this.hasBroadAccess(actor)) conditions.push(eq(cashierShifts.userId, Number(actor.userId)));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(cashierShifts)
      .where(and(...conditions))
      .orderBy(desc(cashierShifts.openedAt))
      .limit(limit)
      .offset(offset);
    return { cashierShifts: rows, offset, limit };
  }

  async getById(cashierShiftId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const shift = await this.loadShift(db, tenantId, cashierShiftId);
    this.assertCanView(actor, shift);
    return shift;
  }

  /** POST /cashier-shifts -- opens a till session. 409 SHIFT.ALREADY_OPEN if this actor already
   *  has an open shift on this SAME till (18-api-plan.md's own literal "no other open shift for
   *  this user+till" wording -- a different user may open a different shift on a different till
   *  concurrently; two users sharing one till at once is a real-world edge case this wording
   *  doesn't clearly forbid and this service doesn't invent a stricter rule for). */
  async open(input: OpenCashierShiftInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const account = await this.assertTillEligible(tx, tenantId, input.cashBankAccountId);

      const [existing] = await tx
        .select({ cashierShiftId: cashierShifts.cashierShiftId })
        .from(cashierShifts)
        .where(and(eq(cashierShifts.tenantId, tenantId), eq(cashierShifts.userId, actorId), eq(cashierShifts.cashBankAccountId, account.cashBankAccountId), eq(cashierShifts.status, "open")));
      if (existing) {
        throw new AppException({
          status: 409,
          code: "SHIFT.ALREADY_OPEN",
          title: "Shift already open",
          detail: `You already have an open shift (#${existing.cashierShiftId}) on this till -- close it before opening a new one.`,
        });
      }

      const allocated = await this.docNumbers.allocate(tx, tenantId, "CSHIFT");
      await tx.insert(cashierShifts).values({
        tenantId,
        branchId,
        docNumber: allocated.docNumber,
        docSeriesId: allocated.docSeriesId,
        documentTypeId: allocated.documentTypeId,
        userId: actorId,
        cashBankAccountId: account.cashBankAccountId,
        // Explicit app-set Date, NOT the schema's own `DEFAULT CURRENT_TIMESTAMP(3)` -- found live
        // during this wave's own verification: MySQL's CURRENT_TIMESTAMP(3) is evaluated by the
        // DATABASE SERVER's own session/system time zone, while every OTHER timestamp this
        // service compares it against (journal_entry.posted_at, sale_invoice.posted_at, etc.) is
        // stamped by APPLICATION code via `new Date()`, going through the mysql2 driver's own
        // (differently-behaving) Date serialization. On this dev machine those two paths are ~5
        // hours apart -- a DEFAULT-stamped `openedAt` compared against an app-stamped `postedAt`
        // in the SAME query silently produced a window boundary in the wrong instant entirely
        // (computeExpectedCash's own window query). Setting `openedAt` explicitly here puts it
        // through the IDENTICAL app-side serialization every other timestamp this service reads
        // already uses, making the two directly, correctly comparable. This is a real,
        // previously-undiscovered systemic inconsistency (DEFAULT CURRENT_TIMESTAMP(3) vs
        // app-set `new Date()`) that likely affects other DEFAULT-stamped columns elsewhere in
        // this codebase too (every auditColumns() `createdAt`) -- flagged separately, out of this
        // wave's own scope to fix system-wide.
        openedAt: new Date(),
        openingFloatAmount: input.openingFloatAmount,
        status: "open",
        createdBy: actorId,
        createdSource: "api",
      });
      const [row] = await tx.select().from(cashierShifts).where(and(eq(cashierShifts.tenantId, tenantId), eq(cashierShifts.docNumber, allocated.docNumber)));
      if (!row) throw new Error("cashier_shift insert did not land"); // unreachable; defensive
      return row;
    });
  }

  /** POST /cashier-shifts/:id/count -- the blind denomination count: `expectedCash` is computed
   *  and returned HERE, alongside `countedTotal`/`variance`, the first and only moment it's ever
   *  exposed to the caller (18-api-plan.md: "the expected figure is hidden until the count is
   *  submitted"). Replaces the shift's whole count set (delete-then-insert). */
  async count(cashierShiftId: number, input: CountCashierShiftInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [shift] = await tx
        .select()
        .from(cashierShifts)
        .where(and(eq(cashierShifts.tenantId, tenantId), eq(cashierShifts.cashierShiftId, cashierShiftId)))
        .for("update");
      if (!shift) throw shiftNotFound(cashierShiftId);
      if (shift.status !== "open") {
        throw new BusinessRuleException("SHIFT.NOT_OPEN", "Shift not open", `Shift ${shift.docNumber} is "${shift.status}"; only an open shift can be counted.`);
      }

      let countedTotal = Money.zero();
      const rows = input.counts.map((line, i) => {
        const amount = parseAmount(line.denominationAmount, `counts.${i}.denominationAmount`);
        const normalized = amount.toDb();
        if (!PKR_DENOMINATIONS.has(normalized)) {
          throw new BusinessRuleException(
            "SHIFT.INVALID_DENOMINATION",
            "Invalid denomination",
            `counts.${i}.denominationAmount (${normalized}) is not a real PKR denomination.`,
            [{ path: `counts.${i}.denominationAmount`, code: "SHIFT.INVALID_DENOMINATION", message: "Not a valid PKR denomination" }],
          );
        }
        countedTotal = countedTotal.add(amount.mulQty(Quantity.of(line.denominationCount), { scale: 2 }));
        return { cashierShiftId, denominationAmount: normalized, denominationCount: line.denominationCount, countedAt: new Date(), countedBy: actorId };
      });

      await tx.delete(cashierShiftCounts).where(eq(cashierShiftCounts.cashierShiftId, cashierShiftId));
      if (rows.length > 0) await tx.insert(cashierShiftCounts).values(rows);

      const expectedCash = await this.computeExpectedCash(tx, shift, new Date());

      await tx
        .update(cashierShifts)
        .set({ countedCashAmount: countedTotal.toDb(), expectedCashAmount: expectedCash.toDb(), updatedBy: actorId })
        .where(eq(cashierShifts.cashierShiftId, cashierShiftId));

      return { countedTotal: countedTotal.toDb(), expectedCash: expectedCash.toDb(), variance: countedTotal.sub(expectedCash).toDb() };
    });
  }

  /** POST /cashier-shifts/:id/close -- requires a count already submitted; `varianceReason` is
   *  mandatory whenever the PERSISTED variance (from count(), not a client-supplied number) is
   *  non-zero (FT-117/AC-5: "an over/short cannot be dismissed, only explained"). Never posts a GL
   *  journal entry -- see this file's own header comment. */
  async close(cashierShiftId: number, input: CloseCashierShiftInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [shift] = await tx
        .select()
        .from(cashierShifts)
        .where(and(eq(cashierShifts.tenantId, tenantId), eq(cashierShifts.cashierShiftId, cashierShiftId)))
        .for("update");
      if (!shift) throw shiftNotFound(cashierShiftId);
      if (shift.status !== "open") {
        throw new BusinessRuleException("SHIFT.NOT_OPEN", "Shift not open", `Shift ${shift.docNumber} is "${shift.status}"; only an open shift can be closed.`);
      }
      if (shift.countedCashAmount === null) {
        throw new BusinessRuleException(
          "SHIFT.COUNT_REQUIRED",
          "Count required",
          `Shift ${shift.docNumber} has not been counted yet -- submit POST /cashier-shifts/${cashierShiftId}/count before closing.`,
        );
      }

      const variance = Money.fromDb(shift.varianceAmount ?? "0.00");
      if (!variance.isZero() && (input.varianceReason === undefined || input.varianceReason.trim().length === 0)) {
        throw new BusinessRuleException(
          "SHIFT.VARIANCE_REASON_REQUIRED",
          "Variance reason required",
          `Shift ${shift.docNumber} has a variance of ${variance.toDb()}; varianceReason is required to close it.`,
          [{ path: "varianceReason", code: "SHIFT.VARIANCE_REASON_REQUIRED", message: "Required when the counted variance is non-zero" }],
        );
      }

      const now = new Date();
      await tx
        .update(cashierShifts)
        .set({ status: "closed", closedAt: now, varianceReason: input.varianceReason ?? null, updatedBy: actorId })
        .where(eq(cashierShifts.cashierShiftId, cashierShiftId));
      const [row] = await tx.select().from(cashierShifts).where(eq(cashierShifts.cashierShiftId, cashierShiftId));
      if (!row) throw new Error("cashier_shift vanished mid-transaction"); // unreachable; defensive
      // `journalEntry` deliberately absent -- see this file's own header comment (RS-3).
      return { cashierShift: row };
    });
  }

  /** POST /cashier-shifts/:id/approve -- supervisor sign-off; the cashier who opened the shift can
   *  never approve their own closure. */
  async approve(cashierShiftId: number, _input: ApproveCashierShiftInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [shift] = await tx
        .select()
        .from(cashierShifts)
        .where(and(eq(cashierShifts.tenantId, tenantId), eq(cashierShifts.cashierShiftId, cashierShiftId)))
        .for("update");
      if (!shift) throw shiftNotFound(cashierShiftId);
      if (shift.status !== "closed") {
        throw new BusinessRuleException("SHIFT.NOT_CLOSED", "Shift not closed", `Shift ${shift.docNumber} is "${shift.status}"; only a closed shift can be approved.`);
      }
      if (shift.userId === actorId) {
        throw new BusinessRuleException(
          "APPROVAL.SELF_APPROVAL_FORBIDDEN",
          "Cannot self-approve",
          "The cashier who opened this shift cannot approve its own closure -- a different supervisor must.",
        );
      }

      const now = new Date();
      await tx.update(cashierShifts).set({ status: "approved", approvedBy: actorId, approvedAt: now, updatedBy: actorId }).where(eq(cashierShifts.cashierShiftId, cashierShiftId));
      const [row] = await tx.select().from(cashierShifts).where(eq(cashierShifts.cashierShiftId, cashierShiftId));
      if (!row) throw new Error("cashier_shift vanished mid-transaction"); // unreachable; defensive
      return row;
    });
  }

  /** GET /cashier-shifts/:id/z-report -- end-of-shift summary. `expectedCash`/`countedCash`/
   *  `variance` reflect the shift's own persisted figures (null until count() has run);
   *  salesByMethod[]/returns/expensesPaid/invoiceCount are derived fresh from the shift's own
   *  cashBankAccountId + time window every call (never stored) -- see this file's own header
   *  comment. */
  async zReport(cashierShiftId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const shift = await this.loadShift(db, tenantId, cashierShiftId);
    this.assertCanView(actor, shift);

    const windowEnd = shift.closedAt ?? new Date();
    const windowCondition = and(gte(saleInvoices.postedAt, shift.openedAt), lte(saleInvoices.postedAt, windowEnd));

    const salesByMethod = await db
      .select({ paymentMethodId: saleInvoicePayments.paymentMethodId, total: sql<string>`coalesce(sum(${saleInvoicePayments.amount}), 0)` })
      .from(saleInvoicePayments)
      .innerJoin(saleInvoices, eq(saleInvoicePayments.saleInvoiceId, saleInvoices.saleInvoiceId))
      .where(and(eq(saleInvoicePayments.cashBankAccountId, shift.cashBankAccountId), eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.status, "posted"), windowCondition))
      .groupBy(saleInvoicePayments.paymentMethodId);

    const [invoiceCountRow] = await db
      .select({ n: sql<number>`count(distinct ${saleInvoicePayments.saleInvoiceId})` })
      .from(saleInvoicePayments)
      .innerJoin(saleInvoices, eq(saleInvoicePayments.saleInvoiceId, saleInvoices.saleInvoiceId))
      .where(and(eq(saleInvoicePayments.cashBankAccountId, shift.cashBankAccountId), eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.status, "posted"), windowCondition));

    const [returnsRow] = await db
      .select({ total: sql<string>`coalesce(sum(${saleReturns.returnTotal}), 0)` })
      .from(saleReturns)
      .where(
        and(
          eq(saleReturns.cashBankAccountId, shift.cashBankAccountId),
          eq(saleReturns.tenantId, tenantId),
          eq(saleReturns.status, "posted"),
          gte(saleReturns.postedAt, shift.openedAt),
          lte(saleReturns.postedAt, windowEnd),
        ),
      );

    const [expensesRow] = await db
      .select({ total: sql<string>`coalesce(sum(${expenses.totalAmount}), 0)` })
      .from(expenses)
      .where(
        and(
          eq(expenses.cashBankAccountId, shift.cashBankAccountId),
          eq(expenses.tenantId, tenantId),
          eq(expenses.status, "posted"),
          gte(expenses.postedAt, shift.openedAt),
          lte(expenses.postedAt, windowEnd),
        ),
      );

    const expectedCash = shift.expectedCashAmount !== null ? Money.fromDb(shift.expectedCashAmount) : await this.computeExpectedCash(db, shift, windowEnd);

    return {
      shift,
      salesByMethod: salesByMethod.map((r) => ({ paymentMethodId: r.paymentMethodId, total: r.total })),
      returns: returnsRow?.total ?? "0.00",
      expensesPaid: expensesRow?.total ?? "0.00",
      openingFloat: shift.openingFloatAmount,
      expectedCash: expectedCash.toDb(),
      countedCash: shift.countedCashAmount,
      variance: shift.varianceAmount,
      invoiceCount: Number(invoiceCountRow?.n ?? 0),
    };
  }

  // ---- helpers --------------------------------------------------------------------------------

  private hasBroadAccess(actor: Actor): boolean {
    return actor.roles.some((r) => ROLES_WITH_BROAD_SHIFT_ACCESS.has(r));
  }

  private assertCanView(actor: Actor, shift: CashierShiftRow): void {
    if (this.hasBroadAccess(actor)) return;
    if (shift.userId === Number(actor.userId)) return;
    throw new AppException({
      status: 403,
      code: "AUTHZ.OWN_SHIFT_ONLY",
      title: "Not your shift",
      detail: "This role can only view a cashier shift it opened itself.",
    });
  }

  private async loadShift(dbOrTx: DbOrTx, tenantId: number, cashierShiftId: number): Promise<CashierShiftRow> {
    const [row] = await dbOrTx.select().from(cashierShifts).where(and(eq(cashierShifts.tenantId, tenantId), eq(cashierShifts.cashierShiftId, cashierShiftId)));
    if (!row) throw shiftNotFound(cashierShiftId);
    return row;
  }

  private async assertTillEligible(tx: Tx, tenantId: number, cashBankAccountId: number) {
    const [row] = await tx.select().from(cashBankAccounts).where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
    if (!row) {
      throw new AppException({ status: 404, code: "SHIFT.CASH_BANK_ACCOUNT_NOT_FOUND", title: "Cash/bank account not found", detail: `No cash/bank account with id ${cashBankAccountId} exists.` });
    }
    if (!row.isActive) {
      throw new BusinessRuleException("SHIFT.CASH_BANK_ACCOUNT_INACTIVE", "Cash/bank account inactive", `Cash/bank account #${cashBankAccountId} is inactive.`);
    }
    if (row.accountKind !== "cash_drawer" && row.accountKind !== "petty_cash") {
      throw new BusinessRuleException(
        "SHIFT.NOT_A_TILL",
        "Not a till",
        `Cash/bank account #${cashBankAccountId} is a "${row.accountKind}" account; a cashier shift can only be opened on a cash_drawer/petty_cash account.`,
        [{ path: "cashBankAccountId", code: "SHIFT.NOT_A_TILL", message: "Must be a cash_drawer/petty_cash account" }],
      );
    }
    return row;
  }

  /** Self-contained running balance for the shift's own till, bounded by [openedAt, windowEnd] --
   *  mirrors payment.service.ts's own getCashBankBalance query (debit-normal asset sign
   *  convention), just windowed to this shift instead of "all posted entries ever". */
  private async computeExpectedCash(dbOrTx: DbOrTx, shift: CashierShiftRow, windowEnd: Date): Promise<Money> {
    const [account] = await dbOrTx.select({ glAccountId: cashBankAccounts.glAccountId }).from(cashBankAccounts).where(eq(cashBankAccounts.cashBankAccountId, shift.cashBankAccountId));
    if (!account) throw new Error(`cashier_shift ${shift.cashierShiftId} points at a missing cash_bank_account`); // unreachable; FK-enforced

    const [row] = await dbOrTx
      .select({ debit: sql<string>`coalesce(sum(${journalLines.debitAmount}), 0)`, credit: sql<string>`coalesce(sum(${journalLines.creditAmount}), 0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
      .where(
        and(
          eq(journalLines.glAccountId, account.glAccountId),
          eq(journalLines.tenantId, shift.tenantId),
          eq(journalEntries.tenantId, shift.tenantId),
          eq(journalEntries.status, "posted"),
          gte(journalEntries.postedAt, shift.openedAt),
          lte(journalEntries.postedAt, windowEnd),
        ),
      );
    const net = Money.fromDb(row?.debit ?? "0.00").sub(Money.fromDb(row?.credit ?? "0.00"));
    return Money.fromDb(shift.openingFloatAmount).add(net);
  }
}

function shiftNotFound(cashierShiftId: number): AppException {
  return new AppException({ status: 404, code: "SHIFT.NOT_FOUND", title: "Cashier shift not found", detail: `No cashier shift with id ${cashierShiftId} exists.` });
}

function parseAmount(raw: string, path: string): Money {
  const result = Money.fromInput(raw);
  if (!result.ok) {
    throw new BusinessRuleException("SHIFT.INVALID_AMOUNT", "Invalid amount", `${path} is not a valid amount.`, [{ path, code: "SHIFT.INVALID_AMOUNT", message: "Invalid amount" }]);
  }
  return result.value;
}
