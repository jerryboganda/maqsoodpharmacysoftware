// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.8 -- `ledger.post(journal)`
// validates Σ Dr = Σ Cr BEFORE inserting and rejects the whole journal otherwise; GL rows are
// written synchronously inside the caller's business transaction; entries are append-only and
// double-posting is structurally impossible (uk_journal_source on ledger.ts journalEntries).
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { journalEntries, journalLines } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Tx } from "../db/index.js";
import { BusinessRuleException } from "../errors/index.js";

export interface JournalLegInput {
  readonly glAccountId: number;
  /** Exactly one of debit/credit non-zero (ck_journal_line_one_side). Money `toDb()` strings. */
  readonly debit?: string;
  readonly credit?: string;
  readonly legRole:
    | "primary_debit"
    | "primary_credit"
    | "sales_tax"
    | "income_tax"
    | "fbr_fee"
    | "payment"
    | "cogs"
    | "rounding"
    | "charge"
    | "other";
  readonly supplierId?: number;
  readonly customerId?: number;
  readonly analysisAccountId?: number;
  readonly memo?: string;
}

export interface PostJournalInput {
  readonly tenantId: number;
  readonly branchId: number;
  readonly entryNo: string; // the source document's own doc number -- one journal per document
  readonly entryDate: string; // YYYY-MM-DD
  readonly documentTypeCode: string; // 'SV' | 'SR' | 'PV' | 'PR' | 'ADJ' | ...
  // Optional (added by the `accounting` module for POST /cash-bank/transfers -- "CBT" has no
  // dedicated header table, so there is no row id to reference; ledger.ts's own header comment
  // already anticipated NULL here for exactly this shape: "the invoice/payment/expense/
  // adjustment that caused it; NULL only for manual JVs" -- extended to cover any document type
  // with no header row, not just JV. MySQL UNIQUE indexes (uk_journal_source) permit multiple
  // NULLs, so this cannot collide across transfers.) Every existing caller always supplies a
  // real id, so this stays a required `number` for them in practice; only the type widened.
  readonly sourceDocumentId?: number;
  readonly description: string;
  readonly legs: readonly JournalLegInput[];
  readonly postedBy: number;
  // Reversal fields (added by the `accounting` module, apps/api/src/modules/accounting/
  // application/journal-entry.service.ts, for POST /gl/journal-entries/{id}/reverse -- ledger.ts's
  // journal_entry table has always had reversalSeq/reversalOfJournalId/reversalReason columns,
  // but nothing wrote them until this endpoint existed). All optional and default to the exact
  // same values the unparameterised insert already produced (reversalSeq 0 via the column's own
  // DB default, reversalOfJournalId/reversalReason null), so every existing caller
  // (purchase-invoice.service.ts, purchase-return.service.ts, sale-invoices.service.ts,
  // sale-returns.service.ts, stock-adjustment.service.ts) is unaffected.
  readonly reversalSeq?: number;
  readonly reversalOfJournalId?: number;
  readonly reversalReason?: string;
}

@Injectable()
export class JournalService {
  /**
   * Insert a balanced, immediately-posted journal inside the caller's transaction. Throws
   * `422 LEDGER.UNBALANCED` when Σ debit ≠ Σ credit -- the caller's whole transaction rolls
   * back, so no partial financial state is reachable (TX-2).
   */
  async post(tx: Tx, input: PostJournalInput): Promise<number> {
    if (input.legs.length < 2) {
      throw new BusinessRuleException(
        "LEDGER.TOO_FEW_LEGS",
        "Journal too small",
        "A journal entry needs at least a debit and a credit leg.",
      );
    }

    let totalDebit = Money.zero();
    let totalCredit = Money.zero();
    for (const leg of input.legs) {
      if ((leg.debit === undefined) === (leg.credit === undefined)) {
        throw new BusinessRuleException(
          "LEDGER.ONE_SIDE_REQUIRED",
          "Invalid journal leg",
          "Each journal leg must carry exactly one of debit or credit.",
        );
      }
      if (leg.debit !== undefined) totalDebit = totalDebit.add(Money.fromDb(leg.debit));
      if (leg.credit !== undefined) totalCredit = totalCredit.add(Money.fromDb(leg.credit));
    }
    if (totalDebit.toDb() !== totalCredit.toDb()) {
      throw new BusinessRuleException(
        "LEDGER.UNBALANCED",
        "Journal does not balance",
        `Debits (${totalDebit.toDb()}) and credits (${totalCredit.toDb()}) must be equal.`,
      );
    }

    const now = new Date();
    await tx.insert(journalEntries).values({
      tenantId: input.tenantId,
      branchId: input.branchId,
      entryNo: input.entryNo,
      entryDate: new Date(`${input.entryDate}T00:00:00`),
      documentTypeCode: input.documentTypeCode,
      sourceDocumentId: input.sourceDocumentId ?? null,
      description: input.description,
      totalDebit: totalDebit.toDb(),
      totalCredit: totalCredit.toDb(),
      lineCount: input.legs.length,
      status: "posted",
      postedAt: now,
      postedBy: input.postedBy,
      reversalSeq: input.reversalSeq ?? 0,
      reversalOfJournalId: input.reversalOfJournalId ?? null,
      reversalReason: input.reversalReason ?? null,
      createdBy: input.postedBy,
    });
    const [entry] = await tx
      .select({ journalEntryId: journalEntries.journalEntryId })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, input.tenantId), eq(journalEntries.entryNo, input.entryNo)));
    if (!entry) throw new Error("journal_entry insert did not land"); // unreachable; defensive

    await tx.insert(journalLines).values(
      input.legs.map((leg, i) => ({
        journalEntryId: entry.journalEntryId,
        tenantId: input.tenantId,
        lineNo: i + 1,
        glAccountId: leg.glAccountId,
        debitAmount: leg.debit ?? "0.00",
        creditAmount: leg.credit ?? "0.00",
        legRole: leg.legRole,
        supplierId: leg.supplierId ?? null,
        customerId: leg.customerId ?? null,
        analysisAccountId: leg.analysisAccountId ?? null,
        memo: leg.memo ?? null,
        createdBy: input.postedBy,
      })),
    );

    return entry.journalEntryId;
  }
}
