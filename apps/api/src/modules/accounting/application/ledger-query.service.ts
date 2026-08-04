// Shared running-balance computation for any single GL leaf's own posting history. Used by
// GET /gl/accounts/{id}/ledger (gl-account.service.ts) AND GET /cash-bank/book
// (cash-bank.service.ts, a thin filter to one cash/bank account's own bound gl_account) -- the
// task instruction is explicit that these must not duplicate the running-balance logic, so both
// endpoints call this one class instead of each having their own copy.
//
// Pattern mirrors apps/api/src/modules/purchasing/application/supplier.service.ts#getLedger
// almost exactly (single-account, index-backed `ix_jl_account_date`/`ix_jl_supplier`-shaped
// query, fold a running total in application code, date range + offset/limit narrow the
// returned page) -- generalised here to respect the account's OWN `normalBalance` (debit-normal
// accounts increase on debit; credit-normal accounts increase on credit) instead of hard-coding
// AP's credit-normal direction.
import { Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte, ne } from "drizzle-orm";
import { getDb, journalEntries, journalLines } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface LedgerQueryParams {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

export interface LedgerLineRow {
  readonly journalLineId: number;
  readonly lineNo: number;
  readonly journalEntryId: number;
  readonly entryNo: string;
  readonly entryDate: Date;
  readonly postedAt: Date | null;
  readonly documentTypeCode: string;
  readonly sourceDocumentId: number | null;
  readonly description: string;
  readonly memo: string | null;
  readonly legRole: string;
  readonly supplierId: number | null;
  readonly customerId: number | null;
  readonly debit: string;
  readonly credit: string;
  readonly runningBalance: string;
}

export interface LedgerResult {
  readonly openingBalance: string;
  readonly lines: readonly LedgerLineRow[];
  readonly closingBalance: string;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

@Injectable()
export class LedgerQueryService {
  /**
   * SIMPLIFICATION (documented, mirrors supplier.service.ts#getLedger's own identical choice):
   * `from`/`to` are WHERE filters on the query itself, and the running balance starts at 0.00 at
   * the first row of the *filtered* window, not a true as-of-`from`-date historical balance
   * summed from every prior posting. Justified the same way supplier.service.ts documents: D10/R3
   * fixes every account's true balance at exactly zero at the system's own inception (no migrated
   * opening balance is ever carried in), so folding a running total across an account's full
   * history in date order is correct as long as `from` is left unset or set at/before the
   * account's first-ever posting. A caller who narrows `from` to some later date sees
   * `openingBalance: "0.00"` rather than the account's true balance immediately before that date
   * -- flagged here exactly as it already is in supplier.service.ts, not silently re-derived.
   */
  async getAccountLedger(
    tenantId: number,
    glAccountId: number,
    normalBalance: "debit" | "credit",
    params: LedgerQueryParams,
  ): Promise<LedgerResult> {
    const db = getDb();
    const conditions = [
      eq(journalLines.glAccountId, glAccountId),
      eq(journalLines.tenantId, tenantId), // denormalised defence-in-depth column, same filter as journalEntries.tenantId
      eq(journalEntries.tenantId, tenantId),
      ne(journalEntries.status, "draft"), // a draft carries no real financial event yet (§T91)
    ];
    if (params.from !== undefined) conditions.push(gte(journalEntries.entryDate, new Date(`${params.from}T00:00:00`)));
    if (params.to !== undefined) conditions.push(lte(journalEntries.entryDate, new Date(`${params.to}T00:00:00`)));

    const rows = await db
      .select({
        journalLineId: journalLines.journalLineId,
        lineNo: journalLines.lineNo,
        debitAmount: journalLines.debitAmount,
        creditAmount: journalLines.creditAmount,
        legRole: journalLines.legRole,
        memo: journalLines.memo,
        supplierId: journalLines.supplierId,
        customerId: journalLines.customerId,
        journalEntryId: journalEntries.journalEntryId,
        entryNo: journalEntries.entryNo,
        entryDate: journalEntries.entryDate,
        postedAt: journalEntries.postedAt,
        documentTypeCode: journalEntries.documentTypeCode,
        sourceDocumentId: journalEntries.sourceDocumentId,
        description: journalEntries.description,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
      .where(and(...conditions))
      .orderBy(asc(journalEntries.entryDate), asc(journalEntries.journalEntryId), asc(journalLines.lineNo));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;

    let running = Money.zero(); // true opening balance at the filtered window's start is 0.00 -- see doc comment
    const withBalance: LedgerLineRow[] = rows.map((row) => {
      const debit = Money.fromDb(row.debitAmount);
      const credit = Money.fromDb(row.creditAmount);
      running = normalBalance === "debit" ? running.add(debit).sub(credit) : running.add(credit).sub(debit);
      return {
        journalLineId: row.journalLineId,
        lineNo: row.lineNo,
        journalEntryId: row.journalEntryId,
        entryNo: row.entryNo,
        entryDate: row.entryDate,
        postedAt: row.postedAt,
        documentTypeCode: row.documentTypeCode,
        sourceDocumentId: row.sourceDocumentId,
        description: row.description,
        memo: row.memo,
        legRole: row.legRole,
        supplierId: row.supplierId,
        customerId: row.customerId,
        debit: row.debitAmount,
        credit: row.creditAmount,
        runningBalance: running.toDb(),
      };
    });

    const openingBalance = offset > 0 ? (withBalance[offset - 1]?.runningBalance ?? Money.zero().toDb()) : Money.zero().toDb();
    const page = withBalance.slice(offset, offset + limit);
    const closingBalance = page.length > 0 ? page[page.length - 1]!.runningBalance : openingBalance;

    return { openingBalance, lines: page, closingBalance, offset, limit, total: withBalance.length };
  }
}
