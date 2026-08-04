// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T82/§T83 purchase_order /
// purchase_order_line; purchasing.ts's header comment on purchase_order: "No journal_entry_id:
// purchase orders never post to the ledger; the financial document is the purchase_invoice they
// are received into."
//
// SCOPE (explicitly out of scope for this increment, tracked as follow-up, not silently
// dropped): purchase-invoice.service.ts does NOT consume a purchase order -- there is no
// receivedQty tracking wired from goods receipt back onto purchase_order_line.qty_received, and
// no PI->PO linkage. This service is intent/commitment-only: create, list, view, approve, close,
// cancel. It never touches stock_movement, item.avg_unit_cost, or journal_entry.
//
// STATE MACHINE -- two independent axes, both real columns on purchase_order:
//   `status` (docColumns() pack DOC -- draft/confirmed/posted/cancelled/reversed): the generic
//     document-workflow axis every DOC-pack table carries. A PO is created 'draft', `approve`
//     moves it to 'confirmed' (the closest existing enum value to the task's "approved" -- the
//     schema defines no literal "approved" state and none is invented here, per the DOC pack's
//     own don't-add-a-column-lightly convention), and `cancel` moves it to 'cancelled' (reusing
//     the DOC pack's cancelledAt/cancelledBy/cancelReasonId columns exactly as they're designed
//     for). A PO never reaches 'posted' -- purchase orders never post to the GL (see file header).
//   `orderStatus` (purchase_order's own order_status enum -- open/partial/received/closed/
//     cancelled): the PO-specific receiving-progress axis. Defaults to 'open' at create (no
//     receiving is wired in this increment, so it never naturally advances to
//     'partial'/'received' here -- that is the deferred PI<->PO linkage). `close` moves it to
//     'closed' (manually declaring the order done, independent of whether every line's
//     qty_outstanding is actually zero, since nothing in this increment can move qty_received).
//     `cancel` also sets this to 'cancelled', kept in sync with `status`.
//
// Lifecycle: draft --approve--> confirmed --close--> (orderStatus=closed, terminal)
//                      |                       |
//                      +---------cancel--------+--> (status=cancelled, orderStatus=cancelled, terminal)
// `cancel` is allowed from 'draft' or 'confirmed' (not yet terminal); `close` requires 'confirmed'
// (must be approved first -- an order that was never sent to the supplier has nothing to close,
// it should be cancelled instead).
import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb, items, purchaseOrderLines, purchaseOrders, suppliers } from "@pharmacy/db";
import { costAmount, Money, Quantity } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { DbOrTx, Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreatePurchaseOrderInput, PurchaseOrderLineInput } from "../api/dto/purchase-order.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

interface ComputedLine {
  readonly lineNo: number;
  readonly itemId: number;
  readonly qtyOrdered: Quantity;
  readonly unitPrice: string;
  readonly lineAmount: Money;
}

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    // TODO(real tenancy): same dev-mode shared resolution every sibling service in this module
    // uses (see purchase-invoice.service.ts's identical constructor comment).
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(
    params: {
      supplierId?: number | undefined;
      status?: "draft" | "confirmed" | "posted" | "cancelled" | "reversed" | undefined;
      orderStatus?: "open" | "partial" | "received" | "closed" | "cancelled" | undefined;
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(purchaseOrders.tenantId, tenantId)];
    if (params.supplierId !== undefined) conditions.push(eq(purchaseOrders.supplierId, params.supplierId));
    if (params.status !== undefined) conditions.push(eq(purchaseOrders.status, params.status));
    if (params.orderStatus !== undefined) conditions.push(eq(purchaseOrders.orderStatus, params.orderStatus));
    if (params.dateFrom !== undefined) conditions.push(gte(purchaseOrders.postingDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(purchaseOrders.postingDate, new Date(`${params.dateTo}T00:00:00`)));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(purchaseOrders)
      .where(and(...conditions))
      .orderBy(desc(purchaseOrders.postingDate), desc(purchaseOrders.purchaseOrderId))
      .limit(limit)
      .offset(offset);
    return { purchaseOrders: rows, offset, limit };
  }

  async getById(purchaseOrderId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const header = await this.loadHeader(db, tenantId, purchaseOrderId);
    const lines = await db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
      .orderBy(purchaseOrderLines.lineNo);
    return { purchaseOrder: header, lines };
  }

  /** POST /purchase-orders -- create the DRAFT header + lines in one transaction. A purchase
   *  order never touches stock or the GL (see file header); only the doc-number counter is
   *  locked (TX-6 lock 1, same as every other DOC-pack create). */
  async create(input: CreatePurchaseOrderInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const postingDate = input.documentDate;

    const created = await db.transaction(async (tx) => {
      const [supplier] = await tx
        .select()
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, input.supplierId)));
      if (!supplier) {
        throw new AppException({
          status: 404,
          code: "PURCHASE_ORDER.SUPPLIER_NOT_FOUND",
          title: "Supplier not found",
          detail: `No supplier with id ${input.supplierId} exists.`,
        });
      }
      if (!supplier.isActive) {
        throw new BusinessRuleException(
          "PURCHASE_ORDER.SUPPLIER_INACTIVE",
          "Supplier is inactive",
          `Supplier "${supplier.name}" is inactive; reactivate it before raising an order against it.`,
        );
      }

      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, postingDate);

      // Parse + validate every line BEFORE the doc-counter lock (N-1: allocate as late as
      // possible), same ordering purchase-invoice.service.ts's createAndPost uses.
      const computed: ComputedLine[] = [];
      for (const [index, line] of input.lines.entries()) {
        computed.push(await this.computeLine(tx, tenantId, index, line));
      }
      let totalAmount = Money.zero();
      for (const line of computed) totalAmount = totalAmount.add(line.lineAmount);

      // ---- TX-6 lock 1 (and only lock): the document counter --------------------------------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "PO");

      await tx.insert(purchaseOrders).values({
        tenantId,
        branchId,
        docNumber: allocated.docNumber,
        docSeriesId: allocated.docSeriesId,
        documentTypeId: allocated.documentTypeId,
        documentDate: new Date(`${input.documentDate}T00:00:00`),
        postingDate: new Date(`${postingDate}T00:00:00`),
        fiscalPeriodId,
        status: "draft",
        supplierId: input.supplierId,
        expectedDate: input.expectedDate ? new Date(`${input.expectedDate}T00:00:00`) : null,
        orderStatus: "open",
        totalAmount: totalAmount.toDb(),
        notes: input.notes ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [headerRow] = await tx
        .select({ purchaseOrderId: purchaseOrders.purchaseOrderId })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.docNumber, allocated.docNumber)));
      if (!headerRow) throw new Error("purchase_order insert did not land"); // unreachable; defensive
      const purchaseOrderId = headerRow.purchaseOrderId;

      const lineRows: (typeof purchaseOrderLines.$inferInsert)[] = computed.map((line) => ({
        tenantId,
        purchaseOrderId,
        lineNo: line.lineNo,
        itemId: line.itemId,
        qtyOrdered: line.qtyOrdered.toDb(),
        unitPrice: line.unitPrice,
        createdBy: actorId,
        createdSource: "api",
      }));
      await tx.insert(purchaseOrderLines).values(lineRows);

      return purchaseOrderId;
    });

    return this.getById(created, actor);
  }

  /** POST /purchase-orders/:id/approve -- draft -> confirmed (see file header for why
   *  'confirmed' is the schema's real stand-in for "approved"). Self-approval-forbidden, same
   *  rule and same code stock-adjustment.service.ts's approve() enforces: the creator cannot
   *  approve their own order. */
  async approve(purchaseOrderId: number, actor: Actor, _reason?: string) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    await db.transaction(async (tx) => {
      const header = await this.loadHeaderForUpdate(tx, tenantId, purchaseOrderId);
      if (header.status !== "draft") {
        throw new BusinessRuleException(
          "DOC.NOT_DRAFT",
          "Not a draft",
          `Purchase order ${header.docNumber} is ${header.status}; only drafts can be approved.`,
        );
      }
      if (header.createdBy !== null && header.createdBy === actorId) {
        throw new BusinessRuleException(
          "APPROVAL.SELF_APPROVAL_FORBIDDEN",
          "Cannot self-approve",
          `Purchase order ${header.docNumber} was created by this user; a different user must approve it.`,
        );
      }

      await tx
        .update(purchaseOrders)
        .set({ status: "confirmed", updatedBy: actorId })
        .where(eq(purchaseOrders.purchaseOrderId, purchaseOrderId));
    });

    return this.getById(purchaseOrderId, actor);
  }

  /** POST /purchase-orders/:id/close -- confirmed -> orderStatus 'closed' (terminal). Requires
   *  the order to have been approved first; an order still in 'draft' was never committed to, so
   *  it should be cancelled instead of closed. */
  async close(purchaseOrderId: number, actor: Actor, _reason?: string) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    await db.transaction(async (tx) => {
      const header = await this.loadHeaderForUpdate(tx, tenantId, purchaseOrderId);
      if (header.status === "cancelled") {
        throw new BusinessRuleException(
          "PURCHASE_ORDER.CANCELLED",
          "Order cancelled",
          `Purchase order ${header.docNumber} is cancelled and cannot be closed.`,
        );
      }
      if (header.status !== "confirmed") {
        throw new BusinessRuleException(
          "PURCHASE_ORDER.NOT_APPROVED",
          "Not approved",
          `Purchase order ${header.docNumber} is ${header.status}; it must be approved before it can be closed.`,
        );
      }
      if (header.orderStatus === "closed" || header.orderStatus === "cancelled") {
        throw new BusinessRuleException(
          "PURCHASE_ORDER.ALREADY_TERMINAL",
          "Already closed",
          `Purchase order ${header.docNumber} is already ${header.orderStatus}.`,
        );
      }

      await tx
        .update(purchaseOrders)
        .set({ orderStatus: "closed", updatedBy: actorId })
        .where(eq(purchaseOrders.purchaseOrderId, purchaseOrderId));
    });

    return this.getById(purchaseOrderId, actor);
  }

  /** POST /purchase-orders/:id/cancel -- draft or confirmed -> status 'cancelled' (terminal),
   *  orderStatus kept in sync. Stamps cancelledAt/cancelledBy/cancelReasonId, the DOC pack's own
   *  cancellation columns (_shared.ts: "cancelled/reversed via status, never deleted", N-3). */
  async cancel(purchaseOrderId: number, actor: Actor, cancelReasonId: number | undefined, _reason?: string) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    await db.transaction(async (tx) => {
      const header = await this.loadHeaderForUpdate(tx, tenantId, purchaseOrderId);
      if (header.orderStatus === "closed") {
        throw new BusinessRuleException(
          "PURCHASE_ORDER.ALREADY_TERMINAL",
          "Already closed",
          `Purchase order ${header.docNumber} is already closed and cannot be cancelled.`,
        );
      }
      if (header.status === "cancelled") {
        throw new BusinessRuleException(
          "PURCHASE_ORDER.ALREADY_TERMINAL",
          "Already cancelled",
          `Purchase order ${header.docNumber} is already cancelled.`,
        );
      }

      await tx
        .update(purchaseOrders)
        .set({
          status: "cancelled",
          orderStatus: "cancelled",
          cancelledAt: new Date(),
          cancelledBy: actorId,
          cancelReasonId: cancelReasonId ?? null,
          updatedBy: actorId,
        })
        .where(eq(purchaseOrders.purchaseOrderId, purchaseOrderId));
    });

    return this.getById(purchaseOrderId, actor);
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async loadHeader(db: DbOrTx, tenantId: number, purchaseOrderId: number) {
    const [header] = await db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.purchaseOrderId, purchaseOrderId)));
    if (!header) {
      throw new AppException({
        status: 404,
        code: "PURCHASE_ORDER.NOT_FOUND",
        title: "Purchase order not found",
        detail: `No purchase order with id ${purchaseOrderId} exists.`,
      });
    }
    return header;
  }

  private async loadHeaderForUpdate(tx: Tx, tenantId: number, purchaseOrderId: number) {
    const [header] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.purchaseOrderId, purchaseOrderId)))
      .for("update");
    if (!header) {
      throw new AppException({
        status: 404,
        code: "PURCHASE_ORDER.NOT_FOUND",
        title: "Purchase order not found",
        detail: `No purchase order with id ${purchaseOrderId} exists.`,
      });
    }
    return header;
  }

  /** Parse one input line and compute its rollup amount -- pure computation, no locks. Unlike
   *  purchase-invoice.service.ts's computeLine, there is no pack/loose/bonus breakdown and no
   *  costing basis: a PO commits to a plain ordered quantity at an agreed unit price. */
  private async computeLine(tx: Tx, tenantId: number, index: number, line: PurchaseOrderLineInput): Promise<ComputedLine> {
    const lineNo = index + 1;
    const [item] = await tx
      .select({ itemId: items.itemId })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, line.itemId)));
    if (!item) {
      throw new BusinessRuleException(
        "CATALOG.ITEM_MISSING",
        "Unknown item",
        `Line ${lineNo}: item ${line.itemId} does not exist.`,
        [{ path: `lines.${index}.itemId`, code: "PURCHASE_ORDER.UNKNOWN_ITEM", message: "Unknown item" }],
      );
    }

    if (line.qtyOrdered.isZero()) {
      throw new BusinessRuleException(
        "PURCHASE_ORDER.EMPTY_LINE",
        "Empty line",
        `Line ${lineNo}: the ordered quantity must be greater than zero.`,
        [{ path: `lines.${index}.qtyOrdered`, code: "PURCHASE_ORDER.EMPTY_LINE", message: "Quantity must be > 0" }],
      );
    }

    const lineAmount = Money.fromDb(costAmount(line.qtyOrdered.toDb(), line.unitPrice));

    return {
      lineNo,
      itemId: item.itemId,
      qtyOrdered: line.qtyOrdered,
      unitPrice: line.unitPrice,
      lineAmount,
    };
  }
}
