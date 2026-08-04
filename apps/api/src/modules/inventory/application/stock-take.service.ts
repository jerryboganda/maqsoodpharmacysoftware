// Stock-take (physical inventory count) orchestration. Per this task's explicit instruction, this
// module is a THIN layer over `StockAdjustmentService` -- it snapshots expected quantities, records
// counted quantities, computes variance, and turns non-zero variance into real
// `stock_adjustment` documents by calling `StockAdjustmentService.create()` + `.post()` directly.
// It never touches `stock_balance`, `item.avg_unit_cost`, `journal_entry`, or any other posting-
// engine table itself -- that would be a second, parallel posting engine, which is exactly what
// this task said not to build.
//
// Endpoint list followed here is the task instruction's explicit 7-endpoint list, which differs
// from 18-api-plan.md §2.6 in two deliberate ways (documented once, here, rather than repeated at
// every call site):
//   1. §2.6 has NO distinct "materialise the count sheet" endpoint -- `POST /stock-takes` itself
//      is documented as returning `expectedLineCount`, implying lines are generated at create
//      time. The task instruction is explicit that step 2 (`POST .../count-sheet`) is a SEPARATE
//      step from step 1 (`POST /stock-takes`), so `create()` below only writes the header (status
//      `draft`, no lines) and `generateCountSheet()` is the step that snapshots `stock_balance`
//      into frozen `stock_take_line` rows (status -> `counting`). This is also strictly more
//      useful: it lets an admin adjust the scope filter (re-create) before committing to a frozen
//      snapshot, and it means the expensive branch-wide snapshot query never runs as a side effect
//      of a plain header create.
//   2. §2.6's `GET /stock-takes/{id}/count-sheet` is a *printable PDF* of the sheet -- a different
//      concern from step 2 above (which is a *write*, materialising rows). This module does not
//      implement the PDF endpoint (rendering is out of scope for this task); `generateCountSheet`
//      reuses that endpoint's PATH but is a `POST` because it is a write, not idempotent-safe to
//      repeat (see its own doc comment), and returns JSON (the take with its lines), not a PDF.
//
// Status lifecycle (packages/db/schema/inventory.ts's `stockTakes.status`, see that table's doc
// comment for the full reasoning): draft -> counting -> reviewed -> closed (terminal), with
// `cancelled` reserved for a future /cancel endpoint this task's 7-endpoint list does not include.
import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { costAmount, Money, Quantity } from "@pharmacy/money";
import { getDb, items, stockBalances, stockLots, stockTakeLines, stockTakes } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import type { DbOrTx, Tx } from "../../../common/db/index.js";
import { localToday } from "../../../common/dates/index.js";
import { DocNumberService, FiscalPeriodService } from "../../../common/docflow/index.js";
import { BusinessRuleException } from "../../../common/errors/index.js";
import type { TenantBranchScope } from "../infrastructure/tenant-context.service.js";
import { StockAdjustmentService } from "./stock-adjustment.service.js";

export type StockTakeStatus = "draft" | "counting" | "reviewed" | "closed" | "cancelled";

export interface CreateStockTakeInput {
  readonly documentDate: string; // YYYY-MM-DD
  readonly scopeItemId?: number | undefined;
  readonly scopeCategoryId?: number | undefined;
  readonly notes?: string | undefined;
}

export interface RecordCountInput {
  readonly itemId: number;
  readonly stockLotId: number;
  readonly qtyCounted: Quantity;
  readonly capturedBatchNo?: string | undefined;
  readonly capturedExpiryDate?: string | undefined; // YYYY-MM-DD
  readonly notes?: string | undefined;
}

export interface GenerateAdjustmentsInput {
  readonly adjustmentReasonId: number;
  readonly postingDate?: string | undefined; // YYYY-MM-DD; also the resulting adjustments' documentDate
  readonly notes?: string | undefined;
}

@Injectable()
export class StockTakeService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly adjustments: StockAdjustmentService,
  ) {}

  /**
   * POST /stock-takes -- create the DRAFT header only (no lines yet -- see this file's header
   * comment on why count-sheet generation is a separate step). Allocates a real doc number now
   * (same N-1-relaxed-for-drafts reasoning as `StockAdjustmentService.create()`'s own comment):
   * `stock_take.doc_number` is NOT NULL and a draft must be addressable by its number.
   */
  async create(scope: TenantBranchScope, actor: Actor, input: CreateStockTakeInput) {
    const db = getDb();
    const actorId = Number(actor.userId);

    const created = await db.transaction(async (tx) => {
      if (input.scopeItemId !== undefined) {
        const [item] = await tx
          .select({ itemId: items.itemId })
          .from(items)
          .where(and(eq(items.tenantId, scope.tenantId), eq(items.itemId, input.scopeItemId)));
        if (!item) {
          throw new BusinessRuleException(
            "CATALOG.ITEM_MISSING",
            "Unknown item",
            `Scope item ${input.scopeItemId} does not exist.`,
          );
        }
      }
      // scopeCategoryId is stored as-is, unvalidated -- item_category doesn't exist yet in this
      // package (see inventory.ts's stockTakes doc comment); there is nothing to check it against.

      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, scope.tenantId, input.documentDate);
      // TX-6: doc_counter is the first lock of the flow (same convention as stock-adjustment).
      const allocated = await this.docNumbers.allocate(tx, scope.tenantId, "STK");

      await tx.insert(stockTakes).values({
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        docNumber: allocated.docNumber,
        docSeriesId: allocated.docSeriesId,
        documentTypeId: allocated.documentTypeId,
        documentDate: new Date(`${input.documentDate}T00:00:00`),
        postingDate: new Date(`${input.documentDate}T00:00:00`),
        fiscalPeriodId,
        status: "draft",
        scopeItemId: input.scopeItemId ?? null,
        scopeCategoryId: input.scopeCategoryId ?? null,
        notes: input.notes ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [header] = await tx
        .select({ stockTakeId: stockTakes.stockTakeId })
        .from(stockTakes)
        .where(and(eq(stockTakes.docSeriesId, allocated.docSeriesId), eq(stockTakes.docNumber, allocated.docNumber)));
      if (!header) throw new Error("stock_take insert did not land"); // unreachable; defensive
      return header.stockTakeId;
    });

    return this.getById(scope, created);
  }

  /**
   * POST /stock-takes/:id/count-sheet -- materialise `stock_take_line` rows by snapshotting
   * CURRENT `stock_balance` for every (item, lot) in the take's scope, at the branch. `qtySystem`
   * is frozen here, permanently -- nothing re-derives it later (inventory.ts's stockTakeLines doc
   * comment). A write, not idempotent-safe to repeat: only reachable from `draft`, and moves the
   * take to `counting`. Calling it again on an already-`counting`-or-later take is rejected
   * (`STOCKTAKE.COUNT_SHEET_ALREADY_GENERATED`) rather than silently re-snapshotting -- a second
   * snapshot mid-count would invalidate every count already entered against the first one's
   * `qtySystem` values.
   *
   * `scopeCategoryId` is NOT applied as a filter here (see the header's own doc comment) --
   * `item_category` doesn't exist in this package yet. Only `scopeItemId` narrows the snapshot;
   * NULL on both means every (item, lot) with a `stock_balance` row at this branch, including
   * zero-on-hand lots (retained by design, §T58) -- a blind count against a lot the system
   * believes is empty is exactly how an unrecorded receipt gets caught.
   */
  async generateCountSheet(scope: TenantBranchScope, actor: Actor, stockTakeId: number) {
    const db = getDb();
    const actorId = Number(actor.userId);

    await db.transaction(async (tx) => {
      const header = await this.loadForUpdate(tx, scope, stockTakeId);
      if (header.status !== "draft") {
        throw new BusinessRuleException(
          "STOCKTAKE.COUNT_SHEET_ALREADY_GENERATED",
          "Count sheet already generated",
          `Stock take ${header.docNumber} is ${header.status}; the count sheet can only be generated once, from draft.`,
        );
      }

      const conditions = [eq(stockBalances.tenantId, scope.tenantId), eq(stockBalances.branchId, scope.branchId)];
      if (header.scopeItemId !== null) conditions.push(eq(stockBalances.itemId, header.scopeItemId));

      const rows = await tx
        .select({
          itemId: stockBalances.itemId,
          stockLotId: stockBalances.stockLotId,
          qtyOnHand: stockBalances.qtyOnHand,
          avgUnitCost: items.avgUnitCost,
        })
        .from(stockBalances)
        .innerJoin(items, eq(items.itemId, stockBalances.itemId))
        .innerJoin(stockLots, eq(stockLots.stockLotId, stockBalances.stockLotId))
        .where(and(...conditions))
        .orderBy(asc(stockBalances.itemId), asc(stockBalances.stockLotId));

      if (rows.length === 0) {
        throw new BusinessRuleException(
          "STOCKTAKE.EMPTY_SCOPE",
          "Nothing to count",
          "No stock balances match this take's scope; there is nothing to generate a count sheet for.",
        );
      }

      await tx.insert(stockTakeLines).values(
        rows.map((row, index) => ({
          stockTakeId,
          tenantId: scope.tenantId,
          branchId: scope.branchId,
          lineNo: index + 1,
          itemId: row.itemId,
          stockLotId: row.stockLotId,
          qtySystem: row.qtyOnHand,
          unitCostSnapshot: row.avgUnitCost,
          createdBy: actorId,
          createdSource: "api" as const,
        })),
      );

      await tx
        .update(stockTakes)
        .set({ status: "counting", countSheetGeneratedAt: new Date(), updatedBy: actorId })
        .where(eq(stockTakes.stockTakeId, stockTakeId));
    });

    return this.getById(scope, stockTakeId);
  }

  /**
   * PUT /stock-takes/:id/lines -- bulk-record counted quantities. Only while `status = 'counting'`
   * (the count sheet must exist first). Each input line is matched to an already-generated
   * `stock_take_line` by (itemId, stockLotId) -- a pair not on the sheet is rejected
   * (`STOCKTAKE.LINE_NOT_IN_SCOPE`), never silently inserted as a new line (that would defeat the
   * frozen-scope contract `generateCountSheet` establishes). Callable repeatedly (re-counting a
   * line before the take moves past `counting` simply overwrites its previous count) -- that is
   * the "batched" submission model 18-api-plan.md §2.6 describes.
   */
  async recordCounts(scope: TenantBranchScope, actor: Actor, stockTakeId: number, lines: readonly RecordCountInput[]) {
    const db = getDb();
    const actorId = Number(actor.userId);

    await db.transaction(async (tx) => {
      const header = await this.loadForUpdate(tx, scope, stockTakeId);
      if (header.status !== "counting") {
        throw new BusinessRuleException(
          "STOCKTAKE.WRONG_STATUS",
          "Not counting",
          `Stock take ${header.docNumber} is ${header.status}; counts can only be recorded while status is 'counting'.`,
        );
      }

      for (const [index, line] of lines.entries()) {
        const [existing] = await tx
          .select({ lineId: stockTakeLines.lineId })
          .from(stockTakeLines)
          .where(
            and(
              eq(stockTakeLines.stockTakeId, stockTakeId),
              eq(stockTakeLines.itemId, line.itemId),
              eq(stockTakeLines.stockLotId, line.stockLotId),
            ),
          );
        if (!existing) {
          throw new BusinessRuleException(
            "STOCKTAKE.LINE_NOT_IN_SCOPE",
            "Line not on the count sheet",
            `Line ${index + 1}: item ${line.itemId} / lot ${line.stockLotId} is not on this take's count sheet.`,
          );
        }
        await tx
          .update(stockTakeLines)
          .set({
            qtyCounted: line.qtyCounted.toDb(),
            capturedBatchNo: line.capturedBatchNo ?? null,
            capturedExpiryDate: line.capturedExpiryDate ? new Date(`${line.capturedExpiryDate}T00:00:00`) : null,
            notes: line.notes ?? null,
            countedBy: actorId,
            countedAt: new Date(),
            updatedBy: actorId,
          })
          .where(eq(stockTakeLines.lineId, existing.lineId));
      }
    });

    const { totals } = await this.computeVariance(getDb(), stockTakeId);
    return { acceptedCount: lines.length, varianceSummary: totals };
  }

  /** GET /stock-takes/:id/variance -- every line's variance, plus totals. `minVarianceQty`
   *  filters the returned `lines` to |variance| >= that (totals are always computed over every
   *  line, unfiltered). */
  async variance(scope: TenantBranchScope, stockTakeId: number, filters: { minVarianceQty?: Quantity | undefined }) {
    const db = getDb();
    await this.loadHeader(db, scope, stockTakeId);
    const { lines, totals } = await this.computeVariance(db, stockTakeId);

    if (filters.minVarianceQty === undefined) return { lines, totals };
    const threshold = filters.minVarianceQty;
    const filtered = lines.filter((line) => {
      if (line.qtyVariance === null) return false;
      const variance = Quantity.fromDb(line.qtyVariance);
      const magnitude = variance.isNegative() ? Quantity.zero().sub(variance) : variance;
      return magnitude.compare(threshold) >= 0;
    });
    return { lines: filtered, totals };
  }

  /**
   * POST /stock-takes/:id/generate-adjustments -- the one step that produces real, posted
   * `stock_adjustment` documents. Every line must be counted first (an uncounted line has no
   * defined variance, not a zero one -- `STOCKTAKE.LINES_NOT_COUNTED`). Lines split by the sign
   * of `qtyVariance`: variance > 0 -> one `increase` adjustment; variance < 0 -> one `decrease`
   * adjustment (a `stock_adjustment` has a single direction for all its lines, §T61) -- zero-
   * variance lines produce nothing. Both resulting documents are created AND posted by calling
   * `StockAdjustmentService.create()` + `.post()` directly (never reimplemented here), composed
   * inside ONE outer transaction via their optional `externalTx` parameter so this really is
   * "both documents in one transaction, or neither" (18-api-plan.md §2.6), not two independent
   * best-effort calls.
   *
   * `updateAvgCost` is deliberately left at its default (`false`, same as an ordinary manual
   * increase-adjustment) -- a stock take is not the tool for a considered costing-policy decision,
   * and this endpoint's DTO does not expose the toggle; an admin can always re-average manually
   * afterward via a normal adjustment.
   *
   * Idempotency: only reachable from `counting` (checked via the header's own status, not a
   * separate flag) -- calling this twice on the same take is rejected
   * (`STOCKTAKE.ALREADY_GENERATED`, matching 18-api-plan.md §2.6's documented code) rather than
   * generating a second pair of documents for the same variance.
   */
  async generateAdjustments(scope: TenantBranchScope, actor: Actor, stockTakeId: number, input: GenerateAdjustmentsInput) {
    const db = getDb();
    const actorId = Number(actor.userId);
    const postingDate = input.postingDate ?? localToday();

    await db.transaction(async (tx) => {
      const header = await this.loadForUpdate(tx, scope, stockTakeId);
      if (header.status !== "counting") {
        throw new BusinessRuleException(
          "STOCKTAKE.ALREADY_GENERATED",
          header.status === "draft" || header.status === "cancelled" ? "Not ready" : "Adjustments already generated",
          `Stock take ${header.docNumber} is ${header.status}; adjustments can only be generated once, from 'counting'.`,
        );
      }

      const lines = await tx
        .select()
        .from(stockTakeLines)
        .where(eq(stockTakeLines.stockTakeId, stockTakeId))
        .orderBy(asc(stockTakeLines.lineNo));
      if (lines.length === 0) {
        throw new BusinessRuleException("STOCKTAKE.EMPTY", "No lines", `Stock take ${header.docNumber} has no count-sheet lines.`);
      }
      const uncounted = lines.filter((l) => l.qtyCounted === null);
      if (uncounted.length > 0) {
        throw new BusinessRuleException(
          "STOCKTAKE.LINES_NOT_COUNTED",
          "Lines still uncounted",
          `Stock take ${header.docNumber} has ${uncounted.length} line(s) with no counted quantity yet; every line must be counted before adjustments can be generated.`,
        );
      }

      type TakeLine = (typeof lines)[number];
      const increaseLines: { line: TakeLine; qty: Quantity }[] = [];
      const decreaseLines: { line: TakeLine; qty: Quantity }[] = [];
      for (const line of lines) {
        const system = Quantity.fromDb(line.qtySystem);
        const counted = Quantity.fromDb(line.qtyCounted!); // non-null: filtered above
        const varianceQty = counted.sub(system);
        if (varianceQty.isZero()) continue;
        if (varianceQty.isNegative()) {
          decreaseLines.push({ line, qty: system.sub(counted) });
        } else {
          increaseLines.push({ line, qty: varianceQty });
        }
      }

      let increaseAdjustmentId: number | null = null;
      let decreaseAdjustmentId: number | null = null;

      if (increaseLines.length > 0) {
        const draft = await this.adjustments.create(
          scope,
          actor,
          {
            direction: "increase",
            adjustmentReasonId: input.adjustmentReasonId,
            documentDate: postingDate,
            notes: input.notes ?? `Generated from stock take ${header.docNumber}`,
            stockTakeId,
            lines: increaseLines.map(({ line, qty }) => ({
              itemId: line.itemId,
              stockLotId: line.stockLotId,
              qty,
              notes: `Stock take ${header.docNumber} line ${line.lineNo}`,
            })),
          },
          tx,
        );
        const posted = await this.adjustments.post(scope, actor, draft.stockAdjustmentId, postingDate, tx);
        increaseAdjustmentId = posted.stockAdjustmentId;
        for (const [index, { line }] of increaseLines.entries()) {
          const adjLine = posted.lines[index];
          if (!adjLine) throw new Error("increase adjustment line count mismatch"); // unreachable; 1:1 by construction
          await tx
            .update(stockTakeLines)
            .set({ adjustmentLineId: adjLine.lineId, updatedBy: actorId })
            .where(eq(stockTakeLines.lineId, line.lineId));
        }
      }

      if (decreaseLines.length > 0) {
        const draft = await this.adjustments.create(
          scope,
          actor,
          {
            direction: "decrease",
            adjustmentReasonId: input.adjustmentReasonId,
            documentDate: postingDate,
            notes: input.notes ?? `Generated from stock take ${header.docNumber}`,
            stockTakeId,
            lines: decreaseLines.map(({ line, qty }) => ({
              itemId: line.itemId,
              stockLotId: line.stockLotId,
              qty,
              notes: `Stock take ${header.docNumber} line ${line.lineNo}`,
            })),
          },
          tx,
        );
        const posted = await this.adjustments.post(scope, actor, draft.stockAdjustmentId, postingDate, tx);
        decreaseAdjustmentId = posted.stockAdjustmentId;
        for (const [index, { line }] of decreaseLines.entries()) {
          const adjLine = posted.lines[index];
          if (!adjLine) throw new Error("decrease adjustment line count mismatch"); // unreachable; 1:1 by construction
          await tx
            .update(stockTakeLines)
            .set({ adjustmentLineId: adjLine.lineId, updatedBy: actorId })
            .where(eq(stockTakeLines.lineId, line.lineId));
        }
      }

      await tx
        .update(stockTakes)
        .set({
          status: "reviewed",
          reviewedBy: actorId,
          reviewedAt: new Date(),
          increaseAdjustmentId,
          decreaseAdjustmentId,
          updatedBy: actorId,
        })
        .where(eq(stockTakes.stockTakeId, stockTakeId));
    });

    const stockTake = await this.getById(scope, stockTakeId);
    return {
      stockTake,
      increaseAdjustment: stockTake.increaseAdjustmentId ? await this.adjustments.getById(scope, stockTake.increaseAdjustmentId) : null,
      decreaseAdjustment: stockTake.decreaseAdjustmentId ? await this.adjustments.getById(scope, stockTake.decreaseAdjustmentId) : null,
    };
  }

  /**
   * POST /stock-takes/:id/close -- terminal transition. Two reachable paths, per the task
   * instruction ("only reachable after adjustments have been generated, or explicitly skipped if
   * variance is zero everywhere"):
   *   - from `reviewed` (generate-adjustments already ran, for this variance or for none) ->
   *     close directly.
   *   - from `counting` -> allowed ONLY as an explicit skip: every line must already be counted
   *     AND every counted variance must be exactly zero (an uncounted line blocks closing outright
   *     -- a take is not "done" with lines still unaccounted for). Any non-zero variance in this
   *     state means generate-adjustments was never called for it, so this rejects
   *     (`STOCKTAKE.GENERATE_ADJUSTMENTS_REQUIRED`) rather than silently discarding the variance.
   *     The skip path stamps `reviewedBy`/`reviewedAt` itself (there is no other moment this take
   *     was ever reviewed), so a closed take's review fields are always populated either way.
   * `reason` is accepted for the request's audit trail (mirrors `StockAdjustmentService.approve()`
   * 's own `reason` parameter) but there is no column to persist free-text close reasons, so it is
   * not stored.
   */
  async close(scope: TenantBranchScope, actor: Actor, stockTakeId: number, reason?: string) {
    const db = getDb();
    const actorId = Number(actor.userId);
    void reason; // see doc comment: accepted for the API contract, not persisted (no column yet)

    await db.transaction(async (tx) => {
      const header = await this.loadForUpdate(tx, scope, stockTakeId);
      if (header.status === "closed") {
        throw new BusinessRuleException("STOCKTAKE.ALREADY_CLOSED", "Already closed", `Stock take ${header.docNumber} is already closed.`);
      }
      if (header.status === "cancelled") {
        throw new BusinessRuleException(
          "STOCKTAKE.CANCELLED",
          "Cancelled",
          `Stock take ${header.docNumber} is cancelled and cannot be closed.`,
        );
      }
      if (header.status === "draft") {
        throw new BusinessRuleException(
          "STOCKTAKE.NOT_READY",
          "Count sheet not generated",
          `Stock take ${header.docNumber} has no count sheet yet; generate it and record counts before closing.`,
        );
      }

      let reviewedBy = header.reviewedBy;
      let reviewedAt = header.reviewedAt;

      if (header.status === "counting") {
        const lines = await tx
          .select({ qtyCounted: stockTakeLines.qtyCounted, qtyVariance: stockTakeLines.qtyVariance })
          .from(stockTakeLines)
          .where(eq(stockTakeLines.stockTakeId, stockTakeId));
        if (lines.length === 0) {
          throw new BusinessRuleException("STOCKTAKE.NOT_READY", "No lines", `Stock take ${header.docNumber} has no count-sheet lines.`);
        }
        const uncounted = lines.filter((l) => l.qtyCounted === null);
        if (uncounted.length > 0) {
          throw new BusinessRuleException(
            "STOCKTAKE.LINES_NOT_COUNTED",
            "Lines still uncounted",
            `Stock take ${header.docNumber} has ${uncounted.length} line(s) with no counted quantity yet.`,
          );
        }
        const hasVariance = lines.some((l) => l.qtyVariance !== null && !Quantity.fromDb(l.qtyVariance).isZero());
        if (hasVariance) {
          throw new BusinessRuleException(
            "STOCKTAKE.GENERATE_ADJUSTMENTS_REQUIRED",
            "Adjustments not generated",
            `Stock take ${header.docNumber} has non-zero variance; call generate-adjustments before closing.`,
          );
        }
        // Zero variance everywhere: the explicit skip path. Stamp the implicit review now, since
        // this is the only moment the take was ever reviewed.
        reviewedBy = actorId;
        reviewedAt = new Date();
      }
      // status === "reviewed": close directly, reviewedBy/reviewedAt already set by generate-adjustments.

      await tx
        .update(stockTakes)
        .set({
          status: "closed",
          reviewedBy,
          reviewedAt,
          closedBy: actorId,
          closedAt: new Date(),
          // Pack DOC's postedAt/postedBy, repurposed to mean "closed" -- see stockTakes' doc comment.
          postedAt: new Date(),
          postedBy: actorId,
          updatedBy: actorId,
        })
        .where(eq(stockTakes.stockTakeId, stockTakeId));
    });

    return this.getById(scope, stockTakeId);
  }

  /** GET /stock-takes */
  async list(scope: TenantBranchScope, filters: { status?: StockTakeStatus | undefined; limit: number; offset: number }) {
    const db = getDb();
    const conditions = [eq(stockTakes.tenantId, scope.tenantId), eq(stockTakes.branchId, scope.branchId)];
    if (filters.status !== undefined) conditions.push(eq(stockTakes.status, filters.status));
    const rows = await db
      .select()
      .from(stockTakes)
      .where(and(...conditions))
      .orderBy(asc(stockTakes.stockTakeId))
      .limit(filters.limit + 1)
      .offset(filters.offset);
    const hasMore = rows.length > filters.limit;
    return { data: rows.slice(0, filters.limit), meta: { limit: filters.limit, offset: filters.offset, hasMore } };
  }

  /** GET /stock-takes/:id -- header with lines. */
  async getById(scope: TenantBranchScope, stockTakeId: number, dbOrTx: DbOrTx = getDb()) {
    const header = await this.loadHeader(dbOrTx, scope, stockTakeId);
    const lines = await dbOrTx
      .select()
      .from(stockTakeLines)
      .where(eq(stockTakeLines.stockTakeId, stockTakeId))
      .orderBy(asc(stockTakeLines.lineNo));
    return { ...header, lines };
  }

  private async loadHeader(dbOrTx: DbOrTx, scope: TenantBranchScope, stockTakeId: number) {
    const [header] = await dbOrTx
      .select()
      .from(stockTakes)
      .where(and(eq(stockTakes.tenantId, scope.tenantId), eq(stockTakes.stockTakeId, stockTakeId)));
    if (!header) {
      throw new BusinessRuleException("STOCKTAKE.NOT_FOUND", "Stock take missing", `Stock take ${stockTakeId} does not exist.`);
    }
    return header;
  }

  /** Same as `loadHeader`, `FOR UPDATE` -- for the mutating flows (generateCountSheet,
   *  recordCounts, generateAdjustments, close), same locking discipline as
   *  `StockAdjustmentService`'s own header loads. */
  private async loadForUpdate(tx: Tx, scope: TenantBranchScope, stockTakeId: number) {
    const [header] = await tx
      .select()
      .from(stockTakes)
      .where(and(eq(stockTakes.tenantId, scope.tenantId), eq(stockTakes.stockTakeId, stockTakeId)))
      .for("update");
    if (!header) {
      throw new BusinessRuleException("STOCKTAKE.NOT_FOUND", "Stock take missing", `Stock take ${stockTakeId} does not exist.`);
    }
    return header;
  }

  /** Shared by `variance()` and `recordCounts()`'s response summary: per-line variance + cost
   *  impact (signed -- positive means found more than expected, negative means found less), plus
   *  take-wide totals. */
  private async computeVariance(dbOrTx: DbOrTx, stockTakeId: number) {
    const rows = await dbOrTx
      .select({
        lineId: stockTakeLines.lineId,
        itemId: stockTakeLines.itemId,
        stockLotId: stockTakeLines.stockLotId,
        qtySystem: stockTakeLines.qtySystem,
        qtyCounted: stockTakeLines.qtyCounted,
        qtyVariance: stockTakeLines.qtyVariance,
        unitCostSnapshot: stockTakeLines.unitCostSnapshot,
      })
      .from(stockTakeLines)
      .where(eq(stockTakeLines.stockTakeId, stockTakeId))
      .orderBy(asc(stockTakeLines.lineNo));

    let countedLines = 0;
    let varianceLines = 0;
    let netCostImpact = Money.zero();
    const lines = rows.map((row) => {
      if (row.qtyCounted !== null) countedLines++;
      let costImpact: string | null = null;
      if (row.qtyVariance !== null) {
        costImpact = costAmount(row.qtyVariance, row.unitCostSnapshot);
        if (!Quantity.fromDb(row.qtyVariance).isZero()) {
          varianceLines++;
          netCostImpact = netCostImpact.add(Money.fromDb(costImpact));
        }
      }
      return { ...row, costImpact };
    });

    return {
      lines,
      totals: {
        totalLines: rows.length,
        countedLines,
        pendingLines: rows.length - countedLines,
        varianceLines,
        netCostImpact: netCostImpact.toDb(),
      },
    };
  }
}
