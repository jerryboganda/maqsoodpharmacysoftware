// Blueprint: 18-api-plan.md §5.4 -- GET /gl/journal-entries (list/browse), GET
// /gl/journal-entries/{id}, POST /gl/journal-entries (manual JV/CP/CR/BP/BR voucher), POST
// /gl/journal-entries/{id}/reverse. Structural mirror of
// purchasing/application/purchase-return.service.ts's createAndPost: TX-6 lock order
// (DocNumberService.allocate() first), AppException/BusinessRuleException error pattern,
// TenantContextService.resolveScope(actor).
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import {
  cashBankAccounts,
  getDb,
  glAccounts,
  journalEntries,
  journalLines,
  manualVouchers,
  optionItems,
  optionLists,
} from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import { ScopeService } from "../../../common/authz/scope.service.js";
import type { Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateJournalEntryInput, ReverseJournalEntryInput } from "../api/dto/journal-entry.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Must match packages/db/scripts/seed.ts's VOUCHER_CATEGORY_LIST_CODE exactly -- renamed to a
// dotted "module.concept" form during Wave 5 integration so the same list is also reachable
// through the generic settings/options admin endpoint (see seed.ts's comment on the rename).
const VOUCHER_CATEGORY_LIST_CODE = "accounting.voucher_category";

interface VoucherCategoryMeta {
  readonly headerSide: "debit" | "credit" | null;
  readonly detailSide: "debit" | "credit" | null;
  readonly requiredCashBankAccountKind: readonly string[] | null;
}

interface ResolvedVoucherCategory {
  readonly optionItemId: number;
  readonly code: string;
  readonly name: string;
  readonly meta: VoucherCategoryMeta;
}

@Injectable()
export class JournalEntryService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
    private readonly tenantContext: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  async list(
    params: {
      documentTypeCode?: string | undefined;
      status?: "draft" | "posted" | "reversed" | undefined;
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(journalEntries.tenantId, tenantId)];
    if (params.documentTypeCode !== undefined) conditions.push(eq(journalEntries.documentTypeCode, params.documentTypeCode));
    if (params.status !== undefined) conditions.push(eq(journalEntries.status, params.status));
    if (params.dateFrom !== undefined) conditions.push(gte(journalEntries.entryDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(journalEntries.entryDate, new Date(`${params.dateTo}T00:00:00`)));

    // voucher_category scope only constrains MANUAL vouchers -- the only document kind that
    // carries a voucherCategoryId at all (via the manual_voucher join table). Every other
    // document type this listing spans (sale/purchase/payment/expense/transfer postings) has no
    // category concept to be scoped by, so a scoped actor still sees those; only an out-of-scope
    // manual voucher is hidden -- F-4's "mandatory AND" (18-api-plan.md), narrowed to the one
    // document kind it actually governs rather than hiding unrelated postings by mistake.
    const allowedCategoryIds = await this.scope.getAllowedIds(actor, "voucher_category");
    if (allowedCategoryIds !== null) {
      conditions.push(
        allowedCategoryIds.size === 0
          ? isNull(manualVouchers.voucherCategoryId)
          : or(isNull(manualVouchers.voucherCategoryId), inArray(manualVouchers.voucherCategoryId, [...allowedCategoryIds]))!,
      );
    }

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select({ entry: journalEntries })
      .from(journalEntries)
      .leftJoin(manualVouchers, eq(manualVouchers.journalEntryId, journalEntries.journalEntryId))
      .where(and(...conditions))
      .orderBy(desc(journalEntries.entryDate), desc(journalEntries.journalEntryId))
      .limit(limit)
      .offset(offset);
    return { journalEntries: rows.map((r) => r.entry), offset, limit };
  }

  async getById(journalEntryId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.journalEntryId, journalEntryId)));
    if (!entry) throw entryNotFound(journalEntryId);

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, journalEntryId))
      .orderBy(asc(journalLines.lineNo));

    const [voucher] = await db
      .select({
        manualVoucherId: manualVouchers.manualVoucherId,
        voucherCategoryId: manualVouchers.voucherCategoryId,
        narration: manualVouchers.narration,
        categoryCode: optionItems.code,
        categoryName: optionItems.name,
      })
      .from(manualVouchers)
      .innerJoin(optionItems, eq(manualVouchers.voucherCategoryId, optionItems.optionItemId))
      .where(eq(manualVouchers.journalEntryId, journalEntryId));

    // "Invisible row on read": a manual voucher whose category is outside the actor's
    // voucher_category scope 404s exactly like an entry that doesn't exist. Non-manual-voucher
    // entries (voucher === null) have no category to be scoped by -- always visible, same as list().
    if (voucher && !(await this.scope.isReadAllowed(actor, "voucher_category", voucher.voucherCategoryId))) throw entryNotFound(journalEntryId);

    return { entry, lines, manualVoucher: voucher ?? null };
  }

  /**
   * POST /gl/journal-entries -- a manual voucher (JV/CP/CR/BP/BR, chosen by `voucherCategoryId`).
   * Always allocates from the "JV" doc series regardless of category -- the category is a
   * business classification (the seeded `voucher_category` option list), not a distinct document
   * type/series (per this task's own instruction, mirrored from the Wave 5 foundation report's
   * DOC_TYPES comment: "JV covers ALL manual voucher categories").
   */
  async createManualVoucher(input: CreateJournalEntryInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      // ---- Validation (before any lock is taken) -----------------------------------------
      const category = await this.resolveVoucherCategory(tx, tenantId, input.voucherCategoryId);
      await this.scope.assertAllowed(actor, "voucher_category", input.voucherCategoryId, "voucherCategoryId");

      const legs: JournalLegInput[] = [];
      for (const [index, line] of input.lines.entries()) {
        await this.assertPostableAccount(tx, tenantId, line.glAccountId, index);
        await this.assertCashBankKindAllowed(tx, tenantId, line.glAccountId, category.meta, index);

        const debit = line.debit !== undefined ? parseAmount(line.debit, `lines.${index}.debit`) : undefined;
        const credit = line.credit !== undefined ? parseAmount(line.credit, `lines.${index}.credit`) : undefined;
        const nonZeroSide = debit ?? credit;
        if (!nonZeroSide || nonZeroSide.isZero()) {
          const path = debit !== undefined ? `lines.${index}.debit` : `lines.${index}.credit`;
          throw new BusinessRuleException(
            "LEDGER.EMPTY_LINE",
            "Empty voucher line",
            `Line ${index + 1}: the debit/credit amount must be greater than zero.`,
            [{ path, code: "LEDGER.EMPTY_LINE", message: "Must be greater than zero" }],
          );
        }

        legs.push({
          glAccountId: line.glAccountId,
          // exactOptionalPropertyTypes: only the populated side's key is included at all --
          // `{ debit: undefined }` is a type error against JournalLegInput's `debit?: string`.
          ...(debit !== undefined ? { debit: debit.toDb() } : { credit: (credit as Money).toDb() }),
          // Manual vouchers are free-form -- any number of lines, no single "primary" debit/
          // credit leg the way a 2-leg sale/purchase posting has. Every leg is tagged "other",
          // the same fallback legRole purchase-invoice.service.ts/purchase-return.service.ts use
          // for legs that aren't one of the named roles (sales_tax/cogs/rounding/...).
          legRole: "other",
          ...(line.supplierId !== undefined ? { supplierId: line.supplierId } : {}),
          ...(line.customerId !== undefined ? { customerId: line.customerId } : {}),
          ...(line.memo !== undefined ? { memo: line.memo } : {}),
        });
      }

      // Period-lock validation only -- journal_entry (ledger.ts) has no fiscalPeriodId column to
      // persist the result on (this task's own explicit note; the same documented gap
      // expenses.ts's `expense` table already flags for its own DOC-pack deviation). `documentDate`
      // is validated (zDateString, journal-entry.dto.ts) but likewise not persisted separately --
      // journal_entry has a single date column, entryDate, stamped from postingDate below.
      await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, input.postingDate);

      // ---- TX-6 lock 1: the document counter (must be first) -------------------------------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "JV");

      // Header row inserted first (journalEntryId still null) so its own PK can be used as
      // journal_entry.source_document_id below -- see packages/db/schema/accounting.ts's
      // manualVouchers doc comment for why this ordering is required.
      const [voucherResult] = await tx.insert(manualVouchers).values({
        tenantId,
        voucherCategoryId: category.optionItemId,
        narration: input.narration,
        createdBy: actorId,
        createdSource: "api",
      });
      const manualVoucherId = Number(voucherResult.insertId);

      const journalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: allocated.docNumber,
        entryDate: input.postingDate,
        documentTypeCode: "JV",
        sourceDocumentId: manualVoucherId,
        description: `${category.name} voucher ${allocated.docNumber} -- ${input.narration}`,
        legs,
        postedBy: actorId,
      });

      await tx
        .update(manualVouchers)
        .set({ journalEntryId, updatedBy: actorId })
        .where(eq(manualVouchers.manualVoucherId, manualVoucherId));

      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.journalEntryId, journalEntryId));
      if (!entry) throw new Error("journal_entry insert did not land"); // unreachable; defensive
      const lines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, journalEntryId))
        .orderBy(asc(journalLines.lineNo));

      return {
        entry,
        lines,
        manualVoucher: {
          manualVoucherId,
          voucherCategoryId: category.optionItemId,
          categoryCode: category.code,
          categoryName: category.name,
          narration: input.narration,
        },
      };
    });
  }

  /**
   * POST /gl/journal-entries/{id}/reverse -- a new journal_entry with every leg's debit/credit
   * swapped, linked via `reversalOfJournalId`, sharing the original's (documentTypeCode,
   * sourceDocumentId) pair but with an incremented `reversalSeq` (uk_journal_source). The
   * original's own status becomes "reversed"; an already-reversed entry cannot be reversed again.
   */
  async reverse(journalEntryId: number, input: ReverseJournalEntryInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [original] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.tenantId, tenantId), eq(journalEntries.journalEntryId, journalEntryId)))
        .for("update");
      if (!original) throw entryNotFound(journalEntryId);
      if (original.status === "reversed") {
        throw new BusinessRuleException(
          "LEDGER.ALREADY_REVERSED",
          "Already reversed",
          `Journal entry ${original.entryNo} has already been reversed and cannot be reversed again.`,
        );
      }
      if (original.status !== "posted") {
        throw new BusinessRuleException(
          "LEDGER.NOT_POSTED",
          "Not posted",
          `Journal entry ${original.entryNo} is ${original.status}; only a posted entry can be reversed.`,
        );
      }
      if (original.sourceDocumentId === null) {
        // Documented gap: every entry this task's own flows produce (manual vouchers, and every
        // existing purchasing/sales/inventory posting service) always supplies a real
        // sourceDocumentId. A null one is a legacy/edge shape ledger.ts's own header comment
        // allows ("NULL only for manual JVs") but that this endpoint does not yet support
        // reversing -- flagged with a clean 422 rather than crashing on it.
        throw new BusinessRuleException(
          "LEDGER.REVERSAL_UNSUPPORTED",
          "Cannot reverse",
          `Journal entry ${original.entryNo} has no source document reference; this endpoint cannot reverse it yet.`,
        );
      }
      // Write-scope check: reversing a manual voucher is gated by the SAME voucher_category scope
      // as creating one -- "JV" is createManualVoucher's own fixed doc series code (its header
      // comment: "Always allocates from the JV doc series regardless of category"), so it alone
      // identifies which reversible entries are manual vouchers with a category to be scoped by.
      if (original.documentTypeCode === "JV") {
        const [voucher] = await tx.select({ voucherCategoryId: manualVouchers.voucherCategoryId }).from(manualVouchers).where(eq(manualVouchers.journalEntryId, journalEntryId));
        if (voucher) await this.scope.assertAllowed(actor, "voucher_category", voucher.voucherCategoryId, "journalEntryId");
      }

      await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, input.postingDate);

      const originalLines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, journalEntryId))
        .orderBy(asc(journalLines.lineNo));

      // exactOptionalPropertyTypes: build each leg with only the keys that actually have a
      // value -- `{ debit: undefined }` is a type error against JournalLegInput's `debit?: string`.
      const legs: JournalLegInput[] = originalLines.map((line) => {
        // Swap: this line's original credit becomes the reversal's debit, and vice versa.
        const swappedDebitIsNonZero = !Money.fromDb(line.creditAmount).isZero();
        return {
          glAccountId: line.glAccountId,
          ...(swappedDebitIsNonZero ? { debit: line.creditAmount } : { credit: line.debitAmount }),
          legRole: line.legRole,
          ...(line.supplierId !== null ? { supplierId: line.supplierId } : {}),
          ...(line.customerId !== null ? { customerId: line.customerId } : {}),
          ...(line.analysisAccountId !== null ? { analysisAccountId: line.analysisAccountId } : {}),
          ...(line.memo !== null ? { memo: line.memo } : {}),
        };
      });

      // ---- TX-6 lock: the document counter (must be first) -- same series as the original
      // entry's own documentTypeCode (this codebase's convention: documentTypeCode passed to
      // JournalService.post() IS the doc_series code, e.g. "PV"/"JV"/"CBT" -- see
      // purchase-invoice.service.ts's own usage and the Wave 5 foundation report's DOC_TYPES note).
      const allocated = await this.docNumbers.allocate(tx, tenantId, original.documentTypeCode);

      // Next reversalSeq for (documentTypeCode, sourceDocumentId) -- uk_journal_source. The
      // original always holds seq 0; this counts how many journal_entry rows already share that
      // pair (>=1, the original itself) and uses that count as the new row's seq, so the first
      // reversal gets seq 1, a hypothetical second reversal (of a re-posted correction) gets 2.
      const siblings = await tx
        .select({ reversalSeq: journalEntries.reversalSeq })
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.tenantId, tenantId),
            eq(journalEntries.documentTypeCode, original.documentTypeCode),
            eq(journalEntries.sourceDocumentId, original.sourceDocumentId),
          ),
        );
      const nextReversalSeq = siblings.length;

      const reversalJournalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId: original.branchId ?? branchId,
        entryNo: allocated.docNumber,
        entryDate: input.postingDate,
        documentTypeCode: original.documentTypeCode,
        sourceDocumentId: original.sourceDocumentId,
        description: `Reversal of ${original.entryNo} -- ${input.reason}`,
        legs,
        postedBy: actorId,
        reversalSeq: nextReversalSeq,
        reversalOfJournalId: original.journalEntryId,
        reversalReason: input.reason,
      });

      await tx.update(journalEntries).set({ status: "reversed" }).where(eq(journalEntries.journalEntryId, journalEntryId));

      const [reversalEntry] = await tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.journalEntryId, reversalJournalEntryId));
      const reversalLines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, reversalJournalEntryId))
        .orderBy(asc(journalLines.lineNo));
      const [updatedOriginal] = await tx.select().from(journalEntries).where(eq(journalEntries.journalEntryId, journalEntryId));
      if (!reversalEntry || !updatedOriginal) throw new Error("reversal insert did not land"); // unreachable; defensive

      return { original: updatedOriginal, reversal: reversalEntry, reversalLines };
    });
  }

  // ---- helpers ----------------------------------------------------------------------------

  private async resolveVoucherCategory(tx: Tx, tenantId: number, voucherCategoryId: number): Promise<ResolvedVoucherCategory> {
    const [row] = await tx
      .select({
        optionItemId: optionItems.optionItemId,
        code: optionItems.code,
        name: optionItems.name,
        isEnabled: optionItems.isEnabled,
        metaJson: optionItems.metaJson,
      })
      .from(optionItems)
      .innerJoin(optionLists, eq(optionItems.optionListId, optionLists.optionListId))
      .where(
        and(
          eq(optionItems.tenantId, tenantId),
          eq(optionItems.optionItemId, voucherCategoryId),
          eq(optionLists.listCode, VOUCHER_CATEGORY_LIST_CODE),
        ),
      );
    if (!row || !row.isEnabled) {
      throw new BusinessRuleException(
        "LEDGER.VOUCHER_CATEGORY_INVALID",
        "Unknown voucher category",
        `Voucher category ${voucherCategoryId} does not exist, is disabled, or is not a voucher_category option.`,
        [{ path: "voucherCategoryId", code: "LEDGER.VOUCHER_CATEGORY_INVALID", message: "Unknown or disabled voucher category" }],
      );
    }
    return { optionItemId: row.optionItemId, code: row.code, name: row.name, meta: parseVoucherCategoryMeta(row.metaJson) };
  }

  private async assertPostableAccount(tx: Tx, tenantId: number, glAccountId: number, index: number): Promise<void> {
    const [account] = await tx
      .select({ glAccountId: glAccounts.glAccountId, isPostable: glAccounts.isPostable, isActive: glAccounts.isActive })
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.glAccountId, glAccountId)));
    if (!account) {
      throw new BusinessRuleException(
        "LEDGER.ACCOUNT_NOT_FOUND",
        "Unknown GL account",
        `Line ${index + 1}: GL account ${glAccountId} does not exist.`,
        [{ path: `lines.${index}.glAccountId`, code: "LEDGER.ACCOUNT_NOT_FOUND", message: "Unknown GL account" }],
      );
    }
    if (!account.isPostable || !account.isActive) {
      throw new BusinessRuleException(
        "LEDGER.ACCOUNT_NOT_POSTABLE",
        "Account not postable",
        `Line ${index + 1}: GL account ${glAccountId} is not a postable, active leaf account.`,
        [{ path: `lines.${index}.glAccountId`, code: "LEDGER.ACCOUNT_NOT_POSTABLE", message: "Not postable/active" }],
      );
    }
  }

  /** Only enforced for whichever line(s) actually reference a cash_bank_account-linked
   *  gl_account (task instruction) -- a line whose account isn't bound to any cash_bank_account
   *  is skipped entirely, and an unrestricted category (JV: requiredCashBankAccountKind null)
   *  never checks anything. */
  private async assertCashBankKindAllowed(
    tx: Tx,
    tenantId: number,
    glAccountId: number,
    meta: VoucherCategoryMeta,
    index: number,
  ): Promise<void> {
    if (meta.requiredCashBankAccountKind === null) return;
    const [cba] = await tx
      .select({ accountKind: cashBankAccounts.accountKind })
      .from(cashBankAccounts)
      .where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.glAccountId, glAccountId)));
    if (!cba) return; // this line's account isn't a cash/bank account at all -- nothing to enforce
    if (!meta.requiredCashBankAccountKind.includes(cba.accountKind)) {
      throw new BusinessRuleException(
        "LEDGER.CASH_BANK_KIND_MISMATCH",
        "Wrong cash/bank account kind",
        `Line ${index + 1}: this voucher category requires a ${meta.requiredCashBankAccountKind.join("/")} account; GL account ${glAccountId} is bound to a "${cba.accountKind}" account.`,
        [{ path: `lines.${index}.glAccountId`, code: "LEDGER.CASH_BANK_KIND_MISMATCH", message: "Wrong cash/bank account kind" }],
      );
    }
  }
}

function entryNotFound(journalEntryId: number): AppException {
  return new AppException({
    status: 404,
    code: "LEDGER.JOURNAL_ENTRY_NOT_FOUND",
    title: "Journal entry not found",
    detail: `No journal entry with id ${journalEntryId} exists.`,
  });
}

function parseAmount(raw: string, path: string): Money {
  const result = Money.fromInput(raw);
  if (!result.ok) {
    throw new BusinessRuleException("LEDGER.INVALID_AMOUNT", "Invalid amount", `${path} is not a valid amount.`, [
      { path, code: "LEDGER.INVALID_AMOUNT", message: "Invalid amount" },
    ]);
  }
  return result.value;
}

/** `option_item.meta_json` is an untyped `Record<string, unknown>` at the schema level
 *  (options.ts) -- this narrows the seeded `voucher_category` shape defensively (falls back to
 *  "unrestricted" for anything malformed rather than throwing, since these rows are seeded system
 *  data, not user input). */
function parseVoucherCategoryMeta(raw: unknown): VoucherCategoryMeta {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const headerSide = obj["headerSide"] === "debit" || obj["headerSide"] === "credit" ? obj["headerSide"] : null;
  const detailSide = obj["detailSide"] === "debit" || obj["detailSide"] === "credit" ? obj["detailSide"] : null;
  const kinds = obj["requiredCashBankAccountKind"];
  const requiredCashBankAccountKind = Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === "string") : null;
  return { headerSide, detailSide, requiredCashBankAccountKind };
}
