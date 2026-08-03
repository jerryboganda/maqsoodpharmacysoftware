// Stock adjustment lifecycle (18-api-plan.md §2.6): create a DRAFT (no stock effect), then post
// it in ONE transaction that moves stock (StockService), optionally re-averages cost
// (CostingService, C-5: adjustment-increase only, and only when the header opts in), and writes
// the balanced GL journal the legacy system never did (07 §13.3 -- all 1,542 legacy adjustments
// were invisible to the GL).
import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { costAmount, Money, Quantity } from "@pharmacy/money";
import {
  adjustmentReasons,
  getDb,
  glAccounts,
  items,
  stockAdjustmentLines,
  stockAdjustments,
  stockLots,
} from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService } from "../../../common/docflow/index.js";
import type { JournalLegInput } from "../../../common/docflow/index.js";
import { BusinessRuleException } from "../../../common/errors/index.js";
import { CostingService } from "../infrastructure/costing.service.js";
import { StockService } from "../infrastructure/stock.service.js";
import type { TenantBranchScope } from "../infrastructure/tenant-context.service.js";

/** GL leaf `1200 Inventory` (packages/db/scripts/seed.ts) -- the stock side of every adjustment
 *  journal. The reason side comes from `adjustment_reason.gl_account_id` (NOT NULL by design). */
const INVENTORY_GL_CODE = "1200";

export interface CreateAdjustmentLineInput {
  readonly itemId: number;
  readonly stockLotId: number;
  readonly qty: Quantity; // parsed by the DTO (zQuantity); > 0, sign lives on the header
  readonly unitCost?: string | undefined; // AVG_COST 5dp-max decimal string; increase lines only
  readonly notes?: string | undefined;
}

export interface CreateAdjustmentInput {
  readonly direction: "increase" | "decrease";
  readonly adjustmentReasonId: number;
  readonly documentDate: string; // YYYY-MM-DD
  readonly updateAvgCost?: boolean | undefined;
  readonly notes?: string | undefined;
  readonly lines: readonly CreateAdjustmentLineInput[];
}

@Injectable()
export class StockAdjustmentService {
  constructor(
    private readonly stockService: StockService,
    private readonly costingService: CostingService,
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
  ) {}

  /**
   * POST /stock-adjustments -- create the DRAFT header + lines in one transaction. No stock or
   * GL effect happens here (that is `post`).
   *
   * NOTE(N-1 relaxed for drafts): the doc number is allocated NOW, at create time, because
   * `stock_adjustment.doc_number` is NOT NULL and a draft must be addressable/printable by its
   * number. §7.6 N-1 ("allocate as late as possible") is deliberately relaxed: N-3 already
   * guarantees cancelled documents keep their numbers, so a draft that never posts simply leaves
   * a used number -- an audit fact, not a gap to plug. Revisit with the full draft lifecycle
   * (edit/cancel endpoints).
   */
  async create(scope: TenantBranchScope, actor: Actor, input: CreateAdjustmentInput) {
    const db = getDb();
    const actorId = Number(actor.userId);

    const created = await db.transaction(async (tx) => {
      const reason = await this.loadReason(tx, scope.tenantId, input.adjustmentReasonId, input.direction);

      // Drafts still carry NOT NULL posting_date/fiscal_period_id (pack DOC): stamp the document
      // date's open period now; `post` re-resolves both for the actual posting date.
      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, scope.tenantId, input.documentDate);

      // TX-6: doc_counter is the first lock of the flow.
      const allocated = await this.docNumbers.allocate(tx, scope.tenantId, "ADJ");

      // Per-line validation + cost defaulting (increase lines default to the item's current
      // moving average, C-5).
      let totalQty = Quantity.zero();
      let totalCost = Money.zero();
      const lineRows: (typeof stockAdjustmentLines.$inferInsert)[] = [];
      for (const [index, line] of input.lines.entries()) {
        const item = await this.loadItemForLine(tx, scope.tenantId, line.itemId, line.stockLotId, index);
        if (line.qty.isZero()) {
          throw new BusinessRuleException(
            "ADJUSTMENT.LINE_QTY_INVALID",
            "Invalid line quantity",
            `Line ${index + 1}: quantity must be greater than zero (ck_adj_line_qty).`,
          );
        }
        const unitCost = input.direction === "increase" ? (line.unitCost ?? item.avgUnitCost) : item.avgUnitCost;
        const lineCost = costAmount(line.qty.toDb(), unitCost);
        totalQty = totalQty.add(line.qty);
        totalCost = totalCost.add(Money.fromDb(lineCost));
        lineRows.push({
          stockAdjustmentId: 0, // patched after the header lands
          tenantId: scope.tenantId,
          branchId: scope.branchId,
          lineNo: index + 1,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          qty: line.qty.toDb(),
          unitCost,
          costAmount: lineCost,
          notes: line.notes ?? null,
          createdBy: actorId,
          createdSource: "api",
        });
      }

      await tx.insert(stockAdjustments).values({
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        docNumber: allocated.docNumber,
        docSeriesId: allocated.docSeriesId,
        documentTypeId: allocated.documentTypeId,
        documentDate: new Date(`${input.documentDate}T00:00:00`),
        postingDate: new Date(`${input.documentDate}T00:00:00`),
        fiscalPeriodId,
        status: "draft",
        adjustmentReasonId: reason.adjustmentReasonId,
        direction: input.direction,
        totalQty: totalQty.toDb(),
        totalCostAmount: totalCost.toDb(),
        updateAvgCost: input.updateAvgCost ?? false,
        requiresApproval: reason.requiresApproval,
        notes: input.notes ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [header] = await tx
        .select({ stockAdjustmentId: stockAdjustments.stockAdjustmentId })
        .from(stockAdjustments)
        .where(
          and(eq(stockAdjustments.docSeriesId, allocated.docSeriesId), eq(stockAdjustments.docNumber, allocated.docNumber)),
        );
      if (!header) throw new Error("stock_adjustment insert did not land"); // unreachable; defensive

      await tx
        .insert(stockAdjustmentLines)
        .values(lineRows.map((row) => ({ ...row, stockAdjustmentId: header.stockAdjustmentId })));

      return header.stockAdjustmentId;
    });

    return this.getById(scope, created);
  }

  /**
   * POST /stock-adjustments/:id/post -- ONE transaction: lock the draft header, resolve the open
   * period for the posting date, apply every line's stock movement (and, for increase lines when
   * the header opts in, re-average the item's cost BEFORE the movement -- CostingService reads
   * the pre-receipt balance, see its C-2 comment), then write the balanced journal:
   * increase -> Dr 1200 Inventory / Cr reason GL; decrease -> Dr reason GL / Cr 1200 Inventory.
   */
  async post(scope: TenantBranchScope, actor: Actor, stockAdjustmentId: number, postingDate?: string) {
    const db = getDb();
    const actorId = Number(actor.userId);
    const effectivePostingDate = postingDate ?? localToday();

    await db.transaction(async (tx) => {
      const [header] = await tx
        .select()
        .from(stockAdjustments)
        .where(
          and(eq(stockAdjustments.tenantId, scope.tenantId), eq(stockAdjustments.stockAdjustmentId, stockAdjustmentId)),
        )
        .for("update");
      if (!header) {
        throw new BusinessRuleException(
          "ADJUSTMENT.NOT_FOUND",
          "Adjustment missing",
          `Stock adjustment ${stockAdjustmentId} does not exist.`,
        );
      }
      if (header.status !== "draft") {
        throw new BusinessRuleException(
          "DOC.NOT_DRAFT",
          "Not a draft",
          `Adjustment ${header.docNumber} is ${header.status}; only drafts can be posted.`,
        );
      }
      // The fix for the legacy defect this table's header comment documents: legacy
      // sp_PostStockAdjustment writes Posted='Y' immediately with no approval whatsoever (08
      // §28.5, Verified; ck_adjustment_approval in packages/db/schema/inventory.ts). A reason
      // with requiresApproval=true (e.g. Theft/shrinkage) must be approved -- see `approve()` --
      // before it can post, full stop.
      if (header.requiresApproval && header.approvedBy === null) {
        throw new BusinessRuleException(
          "ADJUSTMENT.APPROVAL_REQUIRED",
          "Approval required",
          `Adjustment ${header.docNumber} requires approval before it can be posted.`,
        );
      }

      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, scope.tenantId, effectivePostingDate);
      const reason = await this.loadReason(tx, scope.tenantId, header.adjustmentReasonId, header.direction);

      const lines = await tx
        .select()
        .from(stockAdjustmentLines)
        .where(eq(stockAdjustmentLines.stockAdjustmentId, stockAdjustmentId))
        .orderBy(asc(stockAdjustmentLines.lineNo));
      if (lines.length === 0) {
        throw new BusinessRuleException(
          "ADJUSTMENT.NO_LINES",
          "Empty adjustment",
          `Adjustment ${header.docNumber} has no lines to post.`,
        );
      }

      let totalQty = Quantity.zero();
      let totalCost = Money.zero();
      for (const line of lines) {
        const qty = Quantity.fromDb(line.qty);

        // Frozen per-unit cost for the movement/journal: increase lines keep the cost captured
        // at draft time; decrease lines re-read the item's CURRENT moving average -- the
        // COGS-style cost at the moment of posting (C-5/C-6), not a stale draft snapshot.
        let unitCost = line.unitCost;
        if (header.direction === "decrease") {
          const item = await this.loadItemForLine(tx, scope.tenantId, line.itemId, line.stockLotId, line.lineNo - 1);
          unitCost = item.avgUnitCost;
        } else if (header.updateAvgCost) {
          // C-5: adjustment-increase may move the average, and costing must run BEFORE this
          // line's own movement so stock_before reads pre-receipt (CostingService C-2 comment).
          await this.costingService.applyInbound(tx, {
            tenantId: scope.tenantId,
            itemId: line.itemId,
            qtyIn: qty.toDb(),
            unitCostIn: line.unitCost,
            costBasis: "manual",
            documentTypeId: header.documentTypeId,
            sourceDocumentId: header.stockAdjustmentId,
            postingDate: effectivePostingDate,
            actorId,
          });
        }

        const signedQty = header.direction === "increase" ? qty.toDb() : `-${qty.toDb()}`;
        await this.stockService.applyMovement(tx, {
          tenantId: scope.tenantId,
          branchId: header.branchId,
          itemId: line.itemId,
          stockLotId: line.stockLotId,
          qtyDelta: signedQty,
          unitCost,
          documentTypeId: header.documentTypeId,
          sourceDocumentId: header.stockAdjustmentId,
          sourceLineId: line.lineId,
          fiscalPeriodId,
          postingDate: effectivePostingDate,
          reasonId: header.adjustmentReasonId,
          actorId,
        });

        const lineCost = costAmount(qty.toDb(), unitCost);
        totalQty = totalQty.add(qty);
        totalCost = totalCost.add(Money.fromDb(lineCost));
        if (unitCost !== line.unitCost || lineCost !== line.costAmount) {
          await tx
            .update(stockAdjustmentLines)
            .set({ unitCost, costAmount: lineCost, updatedBy: actorId })
            .where(eq(stockAdjustmentLines.lineId, line.lineId));
        }
      }

      // The stock side of the journal: seeded leaf 1200 Inventory; the other side is the
      // reason's mandatory GL account (e.g. 5300 Stock Adjustment Expense).
      const inventoryGlId = await this.resolveInventoryGl(tx, scope.tenantId);
      const total = totalCost.toDb();
      const legs: JournalLegInput[] =
        header.direction === "increase"
          ? [
              { glAccountId: inventoryGlId, debit: total, legRole: "primary_debit", memo: reason.name },
              { glAccountId: reason.glAccountId, credit: total, legRole: "primary_credit", memo: reason.name },
            ]
          : [
              { glAccountId: reason.glAccountId, debit: total, legRole: "primary_debit", memo: reason.name },
              { glAccountId: inventoryGlId, credit: total, legRole: "primary_credit", memo: reason.name },
            ];
      await this.journal.post(tx, {
        tenantId: scope.tenantId,
        branchId: header.branchId,
        entryNo: header.docNumber,
        entryDate: effectivePostingDate,
        documentTypeCode: "ADJ",
        sourceDocumentId: header.stockAdjustmentId,
        description: `Stock adjustment ${header.docNumber} (${header.direction}, ${reason.name})`,
        legs,
        postedBy: actorId,
      });

      // NOTE: the schema has no journal_entry_id column on stock_adjustment -- linkage is via
      // journal_entry (document_type_code, source_document_id), same as stock_movement.
      await tx
        .update(stockAdjustments)
        .set({
          status: "posted",
          postingDate: new Date(`${effectivePostingDate}T00:00:00`),
          fiscalPeriodId,
          postedAt: new Date(),
          postedBy: actorId,
          totalQty: totalQty.toDb(),
          totalCostAmount: totalCost.toDb(),
          updatedBy: actorId,
        })
        .where(eq(stockAdjustments.stockAdjustmentId, stockAdjustmentId));
    });

    return this.getById(scope, stockAdjustmentId);
  }

  /**
   * POST /stock-adjustments/:id/approve -- required before `post()` whenever the draft's
   * adjustment reason set `requiresApproval` (see the check in `post()` above). Loads the draft
   * header FOR UPDATE (same locking pattern as `post`), then stamps `approvedBy`/`approvedAt`.
   *
   * 18-api-plan.md §2.6's row for this route is explicit: "MGR (never the creator)" -- approver
   * must not be the actor who created the draft (422 APPROVAL.SELF_APPROVAL_FORBIDDEN). `reason`
   * is accepted for the request's audit trail (§2.6 lists it as the only body field) but there is
   * no column on `stock_adjustment` to persist free-text approval reasons, so it is not stored.
   */
  async approve(scope: TenantBranchScope, actor: Actor, stockAdjustmentId: number, reason?: string) {
    const db = getDb();
    const actorId = Number(actor.userId);
    void reason; // see doc comment: accepted for the API contract, not persisted (no column yet)

    await db.transaction(async (tx) => {
      const [header] = await tx
        .select()
        .from(stockAdjustments)
        .where(
          and(eq(stockAdjustments.tenantId, scope.tenantId), eq(stockAdjustments.stockAdjustmentId, stockAdjustmentId)),
        )
        .for("update");
      if (!header) {
        throw new BusinessRuleException(
          "ADJUSTMENT.NOT_FOUND",
          "Adjustment missing",
          `Stock adjustment ${stockAdjustmentId} does not exist.`,
        );
      }
      if (header.status !== "draft") {
        throw new BusinessRuleException(
          "DOC.NOT_DRAFT",
          "Not a draft",
          `Adjustment ${header.docNumber} is ${header.status}; only drafts can be approved.`,
        );
      }
      if (!header.requiresApproval) {
        // Approving something that was never gated is a no-op error, not a silent allow --
        // otherwise `approvedBy` could be set on documents where it carries no real meaning.
        throw new BusinessRuleException(
          "ADJUSTMENT.APPROVAL_NOT_REQUIRED",
          "Approval not required",
          `Adjustment ${header.docNumber}'s reason does not require approval.`,
        );
      }
      // 18-api-plan.md §2.6 POST /stock-adjustments/{id}/approve: "MGR (never the creator)" --
      // approver != creator is enforced here, not left to role assignment alone.
      if (header.createdBy !== null && header.createdBy === actorId) {
        throw new BusinessRuleException(
          "APPROVAL.SELF_APPROVAL_FORBIDDEN",
          "Cannot self-approve",
          `Adjustment ${header.docNumber} was created by this user; a different user must approve it.`,
        );
      }

      await tx
        .update(stockAdjustments)
        .set({
          approvedBy: actorId,
          approvedAt: new Date(),
          updatedBy: actorId,
        })
        .where(eq(stockAdjustments.stockAdjustmentId, stockAdjustmentId));
    });

    return this.getById(scope, stockAdjustmentId);
  }

  /** GET /stock-adjustments */
  async list(
    scope: TenantBranchScope,
    filters: {
      status?: "draft" | "confirmed" | "posted" | "cancelled" | "reversed" | undefined;
      direction?: "increase" | "decrease" | undefined;
      limit: number;
      offset: number;
    },
  ) {
    const db = getDb();
    const conditions = [eq(stockAdjustments.tenantId, scope.tenantId), eq(stockAdjustments.branchId, scope.branchId)];
    if (filters.status !== undefined) conditions.push(eq(stockAdjustments.status, filters.status));
    if (filters.direction !== undefined) conditions.push(eq(stockAdjustments.direction, filters.direction));
    const rows = await db
      .select()
      .from(stockAdjustments)
      .where(and(...conditions))
      .orderBy(asc(stockAdjustments.stockAdjustmentId))
      .limit(filters.limit + 1)
      .offset(filters.offset);
    const hasMore = rows.length > filters.limit;
    return {
      data: rows.slice(0, filters.limit),
      meta: { limit: filters.limit, offset: filters.offset, hasMore },
    };
  }

  /** GET /stock-adjustments/:id -- header with lines. */
  async getById(scope: TenantBranchScope, stockAdjustmentId: number) {
    const db = getDb();
    const [header] = await db
      .select()
      .from(stockAdjustments)
      .where(
        and(eq(stockAdjustments.tenantId, scope.tenantId), eq(stockAdjustments.stockAdjustmentId, stockAdjustmentId)),
      );
    if (!header) {
      throw new BusinessRuleException(
        "ADJUSTMENT.NOT_FOUND",
        "Adjustment missing",
        `Stock adjustment ${stockAdjustmentId} does not exist.`,
      );
    }
    const lines = await db
      .select()
      .from(stockAdjustmentLines)
      .where(eq(stockAdjustmentLines.stockAdjustmentId, stockAdjustmentId))
      .orderBy(asc(stockAdjustmentLines.lineNo));
    return { ...header, lines };
  }

  private async loadReason(tx: Tx, tenantId: number, adjustmentReasonId: number, direction: "increase" | "decrease") {
    const [reason] = await tx
      .select()
      .from(adjustmentReasons)
      .where(and(eq(adjustmentReasons.tenantId, tenantId), eq(adjustmentReasons.adjustmentReasonId, adjustmentReasonId)));
    if (!reason || !reason.isEnabled || reason.deletedAt !== null) {
      throw new BusinessRuleException(
        "ADJUSTMENT.REASON_UNKNOWN",
        "Unknown adjustment reason",
        `Adjustment reason ${adjustmentReasonId} does not exist or is disabled.`,
      );
    }
    if (reason.direction !== "both" && reason.direction !== direction) {
      throw new BusinessRuleException(
        "ADJUSTMENT.REASON_DIRECTION_MISMATCH",
        "Reason direction mismatch",
        `Reason '${reason.name}' only applies to ${reason.direction} adjustments, not ${direction}.`,
      );
    }
    return reason;
  }

  private async loadItemForLine(tx: Tx, tenantId: number, itemId: number, stockLotId: number, lineIndex: number) {
    // Locked (SELECT ... FOR UPDATE): decrease-direction lines in `post` read `avgUnitCost` as
    // the COGS-style cost "current at the moment of posting" (see the comment at that call site).
    // An unlocked read here could observe a stale average if it races a concurrent transaction
    // that is mid-write to this same item's avgUnitCost (e.g. CostingService.applyInbound).
    const [item] = await tx
      .select({ itemId: items.itemId, avgUnitCost: items.avgUnitCost })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId)))
      .for("update");
    if (!item) {
      throw new BusinessRuleException(
        "CATALOG.ITEM_MISSING",
        "Unknown item",
        `Line ${lineIndex + 1}: item ${itemId} does not exist.`,
      );
    }
    const [lot] = await tx
      .select({ stockLotId: stockLots.stockLotId, itemId: stockLots.itemId })
      .from(stockLots)
      .where(and(eq(stockLots.tenantId, tenantId), eq(stockLots.stockLotId, stockLotId)));
    if (!lot || lot.itemId !== itemId) {
      throw new BusinessRuleException(
        "ADJUSTMENT.LOT_ITEM_MISMATCH",
        "Lot does not match item",
        `Line ${lineIndex + 1}: stock lot ${stockLotId} does not belong to item ${itemId}.`,
      );
    }
    return item;
  }

  private async resolveInventoryGl(tx: Tx, tenantId: number): Promise<number> {
    const [gl] = await tx
      .select({ glAccountId: glAccounts.glAccountId })
      .from(glAccounts)
      .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, INVENTORY_GL_CODE)));
    if (!gl) {
      throw new BusinessRuleException(
        "LEDGER.ACCOUNT_MISSING",
        "Inventory account missing",
        `GL leaf '${INVENTORY_GL_CODE} Inventory' is not configured for this tenant.`,
      );
    }
    return gl.glAccountId;
  }
}

/** Today as a `YYYY-MM-DD` business date in server-local time (Asia/Karachi in deployment, §3.6). */
function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
