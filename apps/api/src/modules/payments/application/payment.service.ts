// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.1 "Module `payments`" (R2.1);
// 19-mysql-schema-blueprint.md §T95 `payment` / §T96 `payment_allocation`. Structural mirror of
// purchase-invoice.service.ts / purchase-return.service.ts's create-and-post-in-one-transaction
// shape (TX-6 lock order: DocNumberService.allocate() first) -- a payment is the SAME
// seriousness of financial event as those documents.
//
// GL (mirrors purchase-invoice.service.ts's use of supplier.glAccountId / sale-invoices.service.
// ts's use of customer.glAccountId -- no invented GL policy, per the task's own framing):
//   direction=out (paying a supplier):     Dr supplier.glAccountId   Cr cashBankAccount.glAccountId
//   direction=in  (receiving a customer):  Dr cashBankAccount.glAccountId   Cr customer.glAccountId
//
// SCOPE DECISION (documented, not a silent gap): payments.ts's own header comment says "the
// debit and credit rules for every new R2 posting require accountant sign-off before
// implementation (R2.8)" -- that sign-off, and the task instruction that specified this module,
// only cover the two flows above. `direction=in with partyKind=supplier` (a supplier refunding
// us cash) and `direction=out with partyKind=customer` (refunding a customer in cash outside a
// sale-return's own posting) are real-world flows but have no established GL rule anywhere in
// this codebase, and `employee`/`other` party kinds have no `gl_account_id` column to post
// against at all. `createAndPost` 422s any (direction, partyKind) pair other than the two above
// (`PAYMENT.UNSUPPORTED_DIRECTION_PARTY`) rather than inventing a posting rule.
//
// ALLOCATION TARGETS -- purchase_invoice / purchase_return / sale_invoice / sale_return, resolved
// via `payment_allocation.target_document_type_id` (real FK -> document_type; DOC_TYPES codes
// PURCHASE / PURCHASE_RETURN / SALE / SALE_RETURN). Allocation is a pure bookkeeping/matching
// record -- it never posts its own GL entry; only the payment's own two legs above touch the
// ledger. "Outstanding balance" per target, worked out from what actually exists on each schema
// (no schema file was touched to build this):
//   - purchase_invoice / sale_invoice: `paid_amount` (§T77/§T67, both already GENERATED-backed by
//     `balance_amount = invoice_total - paid_amount`) IS the running total this module maintains
//     -- incremented/decremented directly as allocations are added/reversed, exactly matching
//     purchase_invoice.paid_amount's own inline comment ("Σ allocations from payment (R2.1)").
//     sale_invoice.paid_amount's comment says "Σ sale_invoice_payment" (the cash-tendered-at-sale
//     table, D5) instead -- since D5 already sets it equal to invoice_total for every cash sale
//     (leaving balance_amount at 0, correctly never a candidate), and since sale_invoice_payment
//     is a completely separate insert path this module never touches, treating paid_amount as the
//     SAME aggregate "amount settled so far" on both invoice tables (mirroring purchase_invoice
//     exactly) is what keeps `balance_amount`'s aged-receivables purpose meaningful for the one
//     case that matters here: a genuine credit sale invoice later settled by a real payment.
//   - purchase_return / sale_return: NEITHER has a `paid_amount` column (confirmed by reading
//     packages/db/schema/{purchasing,sales}.ts in full -- not re-derived from a guess), so their
//     outstanding is computed LIVE as `returnTotal - Σ(active payment_allocation)` every time,
//     the same "self-contained, just query directly" philosophy the task specified for the
//     cash-balance check below. `sale_return` additionally already posts its OWN cash-refund leg
//     synchronously at creation time (sale-returns.service.ts's only reachable path today --
//     "Credit refunds not available yet" throws on the alternative) -- a sale_return with a
//     non-null `cash_bank_account_id` is therefore always fully settled already and reports
//     outstanding = 0 rather than double-counting a refund payment_allocation can't see.
//
// CASH/BANK BALANCE CHECK -- self-contained per the task instruction: sums `journal_line.debit_
// amount`/`credit_amount` for the account's own `gl_account_id` directly (posted entries only),
// never depends on the accounting module's ledger endpoint.
//
// CANCEL / REVERSING JOURNAL -- `journal_entry`'s own `uk_journal_source` unique key is
// (document_type_code, source_document_id, reversal_seq); the shared `JournalService.post()`
// (apps/api/src/common/ledger) never sets `reversal_seq` (always inserts the column default, 0),
// so calling it a second time for the SAME payment (same documentTypeCode "PMT" + sourceDocumentId
// = paymentId) would collide with the entry `createAndPost` already posted. Rather than extend a
// shared common/ file for a single-module need (out of this task's stated scope -- and every
// other Wave-5 follow-up module, accounting/expenses, would independently hit the identical wall
// for its own /reverse endpoint), `postReversingJournal` below is a small, self-contained,
// in-module mirror of JournalService.post()'s balance-check/insert logic that additionally
// computes and stamps the next `reversalSeq` for the pair. Reversing an ALLOCATION (as opposed to
// cancelling the whole payment) never touches the ledger at all -- allocation carries no GL entry
// of its own to reverse (see the "ALLOCATION TARGETS" note above).
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import {
  cashBankAccounts,
  customers,
  documentTypes,
  getDb,
  journalEntries,
  journalLines,
  paymentAllocations,
  paymentMethods,
  payments,
  purchaseInvoices,
  purchaseReturns,
  saleInvoices,
  saleReturns,
  suppliers,
} from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { DbOrTx, Tx } from "../../../common/db/index.js";
import { DocNumberService, FiscalPeriodService, JournalService, type JournalLegInput } from "../../../common/docflow/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type {
  AddPaymentAllocationsInput,
  CancelPaymentInput,
  CreatePaymentInput,
  PaymentAllocationInput,
} from "../api/dto/payment.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const SUPPORTED_TARGET_CODES = ["PURCHASE", "PURCHASE_RETURN", "SALE", "SALE_RETURN"] as const;
type SupportedTargetCode = (typeof SUPPORTED_TARGET_CODES)[number];

interface ResolvedParty {
  readonly id: number;
  readonly glAccountId: number;
  readonly name: string;
}

export interface AllocationCandidate {
  readonly targetDocumentTypeId: number;
  readonly targetDocumentKind: SupportedTargetCode;
  readonly targetDocumentId: number;
  readonly docNumber: string;
  readonly documentDate: Date;
  readonly totalAmount: string;
  readonly outstandingAmount: string;
}

interface ResolvedTarget {
  readonly code: SupportedTargetCode;
  readonly partyKind: "supplier" | "customer";
  readonly partyId: number;
  readonly status: string;
  readonly outstanding: Money;
  /** Zero for purchase_return/sale_return -- see this file's header comment. */
  readonly currentPaidAmount: Money;
  /** True only for purchase_invoice/sale_invoice -- whether applyAllocation should bump the
   *  target's own `paidAmount` column. */
  readonly tracksPaidAmount: boolean;
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly docNumbers: DocNumberService,
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly journal: JournalService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async list(
    params: {
      direction?: "out" | "in" | undefined;
      partyKind?: "supplier" | "customer" | "employee" | "other" | undefined;
      supplierId?: number | undefined;
      customerId?: number | undefined;
      status?: "draft" | "confirmed" | "posted" | "cancelled" | "reversed" | undefined;
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(payments.tenantId, tenantId)];
    if (params.direction !== undefined) conditions.push(eq(payments.direction, params.direction));
    if (params.partyKind !== undefined) conditions.push(eq(payments.partyKind, params.partyKind));
    if (params.supplierId !== undefined) conditions.push(eq(payments.supplierId, params.supplierId));
    if (params.customerId !== undefined) conditions.push(eq(payments.customerId, params.customerId));
    if (params.status !== undefined) conditions.push(eq(payments.status, params.status));
    if (params.dateFrom !== undefined) conditions.push(gte(payments.postingDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(payments.postingDate, new Date(`${params.dateTo}T00:00:00`)));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(payments)
      .where(and(...conditions))
      .orderBy(desc(payments.postingDate), desc(payments.paymentId))
      .limit(limit)
      .offset(offset);
    return { payments: rows, offset, limit };
  }

  async getById(paymentId: number, actor: Actor, dbOrTx?: DbOrTx) {
    const db = dbOrTx ?? getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [header] = await db.select().from(payments).where(and(eq(payments.tenantId, tenantId), eq(payments.paymentId, paymentId)));
    if (!header) {
      throw new AppException({
        status: 404,
        code: "PAYMENT.NOT_FOUND",
        title: "Payment not found",
        detail: `No payment with id ${paymentId} exists.`,
      });
    }
    const allocations = await db
      .select()
      .from(paymentAllocations)
      .where(and(eq(paymentAllocations.tenantId, tenantId), eq(paymentAllocations.paymentId, paymentId)))
      .orderBy(asc(paymentAllocations.paymentAllocationId));
    return { payment: header, allocations };
  }

  /**
   * GET /payments/allocation-candidates -- open purchase_invoices/purchase_returns for a
   * supplier, or sale_invoices/sale_returns for a customer, each with their outstanding balance.
   * Read-only (no `.for("update")` locking -- see this file's header comment on why
   * purchase_return/sale_return outstanding is computed live either way).
   */
  async getAllocationCandidates(params: { supplierId?: number | undefined; customerId?: number | undefined }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);

    if (params.supplierId !== undefined) {
      const [supplier] = await db
        .select({ supplierId: suppliers.supplierId })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, params.supplierId)));
      if (!supplier) {
        throw new AppException({
          status: 404,
          code: "PAYMENT.SUPPLIER_NOT_FOUND",
          title: "Supplier not found",
          detail: `No supplier with id ${params.supplierId} exists.`,
        });
      }

      const invoiceDocTypeId = await this.resolveDocumentTypeIdByCode(db, tenantId, "PURCHASE");
      const invoiceRows = await db
        .select()
        .from(purchaseInvoices)
        .where(
          and(
            eq(purchaseInvoices.tenantId, tenantId),
            eq(purchaseInvoices.supplierId, params.supplierId),
            eq(purchaseInvoices.status, "posted"),
            sql`${purchaseInvoices.balanceAmount} > 0`,
          ),
        )
        .orderBy(asc(purchaseInvoices.postingDate));

      const candidates: AllocationCandidate[] = invoiceRows.map((row) => ({
        targetDocumentTypeId: invoiceDocTypeId,
        targetDocumentKind: "PURCHASE",
        targetDocumentId: row.purchaseInvoiceId,
        docNumber: row.docNumber,
        documentDate: row.documentDate,
        totalAmount: row.invoiceTotal,
        outstandingAmount: row.balanceAmount,
      }));

      const returnDocTypeId = await this.resolveDocumentTypeIdByCode(db, tenantId, "PURCHASE_RETURN");
      const returnRows = await db
        .select()
        .from(purchaseReturns)
        .where(and(eq(purchaseReturns.tenantId, tenantId), eq(purchaseReturns.supplierId, params.supplierId), eq(purchaseReturns.status, "posted")))
        .orderBy(asc(purchaseReturns.postingDate));
      for (const row of returnRows) {
        const allocated = await this.sumActiveAllocations(db, tenantId, returnDocTypeId, row.purchaseReturnId);
        const outstanding = Money.fromDb(row.returnTotal).sub(allocated);
        if (outstanding.compare(Money.zero()) > 0) {
          candidates.push({
            targetDocumentTypeId: returnDocTypeId,
            targetDocumentKind: "PURCHASE_RETURN",
            targetDocumentId: row.purchaseReturnId,
            docNumber: row.docNumber,
            documentDate: row.documentDate,
            totalAmount: row.returnTotal,
            outstandingAmount: outstanding.toDb(),
          });
        }
      }
      return { candidates };
    }

    if (params.customerId !== undefined) {
      const [customer] = await db
        .select({ customerId: customers.customerId })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, params.customerId)));
      if (!customer) {
        throw new AppException({
          status: 404,
          code: "PAYMENT.CUSTOMER_NOT_FOUND",
          title: "Customer not found",
          detail: `No customer with id ${params.customerId} exists.`,
        });
      }

      const invoiceDocTypeId = await this.resolveDocumentTypeIdByCode(db, tenantId, "SALE");
      const invoiceRows = await db
        .select()
        .from(saleInvoices)
        .where(
          and(
            eq(saleInvoices.tenantId, tenantId),
            eq(saleInvoices.customerId, params.customerId),
            eq(saleInvoices.status, "posted"),
            sql`${saleInvoices.balanceAmount} > 0`,
          ),
        )
        .orderBy(asc(saleInvoices.postingDate));

      const candidates: AllocationCandidate[] = invoiceRows.map((row) => ({
        targetDocumentTypeId: invoiceDocTypeId,
        targetDocumentKind: "SALE",
        targetDocumentId: row.saleInvoiceId,
        docNumber: row.docNumber,
        documentDate: row.documentDate,
        totalAmount: row.invoiceTotal,
        outstandingAmount: row.balanceAmount,
      }));

      const returnDocTypeId = await this.resolveDocumentTypeIdByCode(db, tenantId, "SALE_RETURN");
      // cashBankAccountId is null only for a not-yet-implemented credit refund (see this file's
      // header comment) -- a non-null one means the return already self-settled at posting.
      const returnRows = await db
        .select()
        .from(saleReturns)
        .where(
          and(
            eq(saleReturns.tenantId, tenantId),
            eq(saleReturns.customerId, params.customerId),
            eq(saleReturns.status, "posted"),
            isNull(saleReturns.cashBankAccountId),
          ),
        )
        .orderBy(asc(saleReturns.postingDate));
      for (const row of returnRows) {
        const allocated = await this.sumActiveAllocations(db, tenantId, returnDocTypeId, row.saleReturnId);
        const outstanding = Money.fromDb(row.returnTotal).sub(allocated);
        if (outstanding.compare(Money.zero()) > 0) {
          candidates.push({
            targetDocumentTypeId: returnDocTypeId,
            targetDocumentKind: "SALE_RETURN",
            targetDocumentId: row.saleReturnId,
            docNumber: row.docNumber,
            documentDate: row.documentDate,
            totalAmount: row.returnTotal,
            outstandingAmount: outstanding.toDb(),
          });
        }
      }
      return { candidates };
    }

    // Unreachable -- AllocationCandidatesQuerySchema's refine requires exactly one of the two.
    throw new BusinessRuleException("PAYMENT.MISSING_PARTY_FILTER", "Missing party filter", "Either supplierId or customerId is required.");
  }

  /** Create AND post a payment in one transaction (mirrors PurchaseInvoiceService/
   *  PurchaseReturnService's createAndPost -- see this file's header comment for the GL rule and
   *  the deliberate (direction, partyKind) scope restriction). */
  async createAndPost(input: CreatePaymentInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const postingDate = input.documentDate;

    this.assertSupportedDirectionParty(input.direction, input.partyKind);

    const amount = parseAmount(input.amount, "amount");
    if (amount.compare(Money.zero()) <= 0) {
      throw new BusinessRuleException("PAYMENT.INVALID_AMOUNT", "Invalid amount", "amount must be greater than zero.", [
        { path: "amount", code: "PAYMENT.INVALID_AMOUNT", message: "Amount must be > 0" },
      ]);
    }

    return db.transaction(async (tx) => {
      // ---- Validation (before any lock is taken) -------------------------------------------
      const party =
        input.direction === "out" ? await this.resolveSupplierParty(tx, tenantId, input.supplierId!) : await this.resolveCustomerParty(tx, tenantId, input.customerId!);

      const paymentMethod = await this.resolvePaymentMethod(tx, tenantId, input.paymentMethodId, input.direction);
      if (paymentMethod.requiresChequeDetails && (input.chequeNo === undefined || input.chequeDate === undefined)) {
        throw new BusinessRuleException(
          "PAYMENT.CHEQUE_DETAILS_REQUIRED",
          "Cheque details required",
          `Payment method "${paymentMethod.name}" requires chequeNo and chequeDate.`,
          [{ path: "chequeNo", code: "PAYMENT.CHEQUE_DETAILS_REQUIRED", message: "Required for this payment method" }],
        );
      }

      const cashBankAccount = await this.resolveCashBankAccount(tx, tenantId, input.cashBankAccountId);

      if (input.allocations !== undefined && input.allocations.length > 0) {
        let allocSum = Money.zero();
        for (const [i, line] of input.allocations.entries()) allocSum = allocSum.add(parseAmount(line.allocatedAmount, `allocations.${i}.allocatedAmount`));
        if (allocSum.compare(amount) > 0) {
          throw new BusinessRuleException(
            "PAYMENT.ALLOCATIONS_EXCEED_AMOUNT",
            "Allocations exceed payment amount",
            `Allocations total ${allocSum.toDb()} exceeds payment amount ${amount.toDb()}.`,
            [{ path: "allocations", code: "PAYMENT.ALLOCATIONS_EXCEED_AMOUNT", message: "Exceeds payment amount" }],
          );
        }
      }

      const fiscalPeriodId = await this.fiscalPeriods.resolveOpenPeriod(tx, tenantId, postingDate);

      if (input.direction === "out" && !cashBankAccount.allowNegative) {
        const balance = await this.getCashBankBalance(tx, tenantId, cashBankAccount.glAccountId);
        if (balance.sub(amount).compare(Money.zero()) < 0) {
          throw new BusinessRuleException(
            "PAYMENT.INSUFFICIENT_FUNDS",
            "Insufficient funds",
            `Cash/bank account #${cashBankAccount.cashBankAccountId} has ${balance.toDb()} available; cannot pay out ${amount.toDb()}.`,
            [{ path: "amount", code: "PAYMENT.INSUFFICIENT_FUNDS", message: "Insufficient funds" }],
          );
        }
      }

      // ---- TX-6 lock 1: the document counter (must be first) --------------------------------
      const allocated = await this.docNumbers.allocate(tx, tenantId, "PMT");

      await tx.insert(payments).values({
        tenantId,
        branchId,
        docNumber: allocated.docNumber,
        docSeriesId: allocated.docSeriesId,
        documentTypeId: allocated.documentTypeId,
        documentDate: new Date(`${input.documentDate}T00:00:00`),
        postingDate: new Date(`${postingDate}T00:00:00`),
        fiscalPeriodId,
        status: "draft",
        direction: input.direction,
        partyKind: input.partyKind,
        supplierId: input.direction === "out" ? party.id : null,
        customerId: input.direction === "in" ? party.id : null,
        otherPartyName: input.otherPartyName ?? null,
        paymentMethodId: input.paymentMethodId,
        cashBankAccountId: input.cashBankAccountId,
        amount: amount.toDb(),
        allocationMode: input.allocationMode,
        referenceNo: input.referenceNo ?? null,
        chequeNo: input.chequeNo ?? null,
        chequeDate: input.chequeDate ? new Date(`${input.chequeDate}T00:00:00`) : null,
        chequeStatus: input.chequeNo !== undefined ? "issued" : null,
        notes: input.notes ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [headerRow] = await tx.select({ paymentId: payments.paymentId }).from(payments).where(and(eq(payments.tenantId, tenantId), eq(payments.docNumber, allocated.docNumber)));
      if (!headerRow) throw new Error("payment insert did not land"); // unreachable; defensive
      const paymentId = headerRow.paymentId;

      // ---- Allocations supplied at creation time --------------------------------------------
      let allocatedTotal = Money.zero();
      if (input.allocations !== undefined) {
        for (const [i, line] of input.allocations.entries()) {
          const applied = await this.applyAllocation(tx, {
            tenantId,
            paymentId,
            paymentPartyKind: input.direction === "out" ? "supplier" : "customer",
            paymentPartyId: party.id,
            line,
            lineIndex: i,
            actorId,
          });
          allocatedTotal = allocatedTotal.add(applied);
        }
      }

      // ---- GL ---------------------------------------------------------------------------------
      const legs: JournalLegInput[] =
        input.direction === "out"
          ? [
              { glAccountId: party.glAccountId, debit: amount.toDb(), legRole: "primary_debit", supplierId: party.id },
              { glAccountId: cashBankAccount.glAccountId, credit: amount.toDb(), legRole: "payment" },
            ]
          : [
              { glAccountId: cashBankAccount.glAccountId, debit: amount.toDb(), legRole: "payment" },
              { glAccountId: party.glAccountId, credit: amount.toDb(), legRole: "primary_credit", customerId: party.id },
            ];

      const journalEntryId = await this.journal.post(tx, {
        tenantId,
        branchId,
        entryNo: allocated.docNumber,
        entryDate: postingDate,
        documentTypeCode: "PMT",
        sourceDocumentId: paymentId,
        description: input.direction === "out" ? `Payment ${allocated.docNumber} -- ${party.name}` : `Receipt ${allocated.docNumber} -- ${party.name}`,
        legs,
        postedBy: actorId,
      });

      // ---- Close out the header ---------------------------------------------------------------
      const now = new Date();
      await tx
        .update(payments)
        .set({
          allocatedAmount: allocatedTotal.toDb(),
          journalEntryId,
          status: "posted",
          postedAt: now,
          postedBy: actorId,
          updatedBy: actorId,
        })
        .where(eq(payments.paymentId, paymentId));

      return this.getById(paymentId, actor, tx);
    });
  }

  /** POST /payments/:id/allocations -- add allocations against an existing posted payment's
   *  unallocatedAmount (the GENERATED column, §T95). */
  async addAllocations(paymentId: number, input: AddPaymentAllocationsInput, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.tenantId, tenantId), eq(payments.paymentId, paymentId)))
        .for("update");
      if (!payment) {
        throw new AppException({ status: 404, code: "PAYMENT.NOT_FOUND", title: "Payment not found", detail: `No payment with id ${paymentId} exists.` });
      }
      if (payment.status !== "posted") {
        throw new BusinessRuleException(
          "PAYMENT.NOT_POSTED",
          "Payment not posted",
          `Payment ${payment.docNumber} is "${payment.status}"; only a posted payment can receive new allocations.`,
        );
      }
      if (payment.partyKind !== "supplier" && payment.partyKind !== "customer") {
        throw new BusinessRuleException(
          "PAYMENT.PARTY_KIND_NOT_ALLOCATABLE",
          "Not allocatable",
          `Payment ${payment.docNumber}'s partyKind "${payment.partyKind}" has no allocatable target document types this wave.`,
        );
      }
      const paymentPartyId = payment.partyKind === "supplier" ? payment.supplierId : payment.customerId;
      if (paymentPartyId === null) throw new Error("payment party id is null for a supplier/customer-kind payment"); // unreachable; ck_payment_party

      let newAllocSum = Money.zero();
      for (const [i, line] of input.allocations.entries()) newAllocSum = newAllocSum.add(parseAmount(line.allocatedAmount, `allocations.${i}.allocatedAmount`));
      const unallocated = Money.fromDb(payment.unallocatedAmount);
      if (newAllocSum.compare(unallocated) > 0) {
        throw new BusinessRuleException(
          "PAYMENT.ALLOCATIONS_EXCEED_UNALLOCATED",
          "Allocations exceed unallocated amount",
          `Payment ${payment.docNumber} has ${unallocated.toDb()} unallocated; cannot allocate ${newAllocSum.toDb()} more.`,
          [{ path: "allocations", code: "PAYMENT.ALLOCATIONS_EXCEED_UNALLOCATED", message: "Exceeds unallocated amount" }],
        );
      }

      let appliedTotal = Money.zero();
      for (const [i, line] of input.allocations.entries()) {
        const applied = await this.applyAllocation(tx, {
          tenantId,
          paymentId,
          paymentPartyKind: payment.partyKind,
          paymentPartyId,
          line,
          lineIndex: i,
          actorId,
        });
        appliedTotal = appliedTotal.add(applied);
      }

      await tx
        .update(payments)
        .set({ allocatedAmount: Money.fromDb(payment.allocatedAmount).add(appliedTotal).toDb(), updatedBy: actorId })
        .where(eq(payments.paymentId, paymentId));

      return this.getById(paymentId, actor, tx);
    });
  }

  /** POST /payments/:id/allocations/:allocationId/reverse -- soft-reverses one allocation row
   *  (reversedAt) and restores the target document's outstanding balance. No GL impact -- see
   *  this file's header comment. */
  async reverseAllocation(paymentId: number, allocationId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [allocation] = await tx
        .select()
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.tenantId, tenantId), eq(paymentAllocations.paymentId, paymentId), eq(paymentAllocations.paymentAllocationId, allocationId)))
        .for("update");
      if (!allocation) {
        throw new AppException({
          status: 404,
          code: "PAYMENT.ALLOCATION_NOT_FOUND",
          title: "Allocation not found",
          detail: `No allocation ${allocationId} on payment ${paymentId} exists.`,
        });
      }
      if (allocation.reversedAt !== null) {
        throw new BusinessRuleException("PAYMENT.ALLOCATION_ALREADY_REVERSED", "Already reversed", `Allocation ${allocationId} was already reversed.`);
      }

      const [payment] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.tenantId, tenantId), eq(payments.paymentId, paymentId)))
        .for("update");
      if (!payment) throw new Error("payment vanished mid-transaction"); // unreachable; allocation FK guarantees it exists

      const amount = Money.fromDb(allocation.allocatedAmount);
      const code = await this.resolveDocumentTypeCode(tx, tenantId, allocation.targetDocumentTypeId);
      if (code === "PURCHASE") {
        const [row] = await tx
          .select({ paidAmount: purchaseInvoices.paidAmount })
          .from(purchaseInvoices)
          .where(eq(purchaseInvoices.purchaseInvoiceId, allocation.targetDocumentId))
          .for("update");
        if (row) {
          await tx
            .update(purchaseInvoices)
            .set({ paidAmount: Money.fromDb(row.paidAmount).sub(amount).toDb(), updatedBy: actorId })
            .where(eq(purchaseInvoices.purchaseInvoiceId, allocation.targetDocumentId));
        }
      } else if (code === "SALE") {
        const [row] = await tx.select({ paidAmount: saleInvoices.paidAmount }).from(saleInvoices).where(eq(saleInvoices.saleInvoiceId, allocation.targetDocumentId)).for("update");
        if (row) {
          await tx
            .update(saleInvoices)
            .set({ paidAmount: Money.fromDb(row.paidAmount).sub(amount).toDb(), updatedBy: actorId })
            .where(eq(saleInvoices.saleInvoiceId, allocation.targetDocumentId));
        }
      }
      // PURCHASE_RETURN / SALE_RETURN: no stored paidAmount column -- their outstanding is
      // derived live from Σ active payment_allocation (see resolveTarget/getAllocationCandidates),
      // so marking this row reversed below is the only bookkeeping needed to restore it.

      await tx.update(paymentAllocations).set({ reversedAt: new Date() }).where(eq(paymentAllocations.paymentAllocationId, allocationId));

      await tx
        .update(payments)
        .set({ allocatedAmount: Money.fromDb(payment.allocatedAmount).sub(amount).toDb(), updatedBy: actorId })
        .where(eq(payments.paymentId, paymentId));

      return this.getById(paymentId, actor, tx);
    });
  }

  /** POST /payments/:id/cancel -- only reachable with zero active allocations; posts a reversing
   *  journal entry (swap the two legs) and marks the payment cancelled. */
  async cancel(paymentId: number, input: CancelPaymentInput, actor: Actor) {
    const db = getDb();
    const { tenantId, branchId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.tenantId, tenantId), eq(payments.paymentId, paymentId)))
        .for("update");
      if (!payment) {
        throw new AppException({ status: 404, code: "PAYMENT.NOT_FOUND", title: "Payment not found", detail: `No payment with id ${paymentId} exists.` });
      }
      if (payment.status === "cancelled") {
        throw new BusinessRuleException("PAYMENT.ALREADY_CANCELLED", "Already cancelled", `Payment ${payment.docNumber} was already cancelled.`);
      }
      if (payment.status !== "posted") {
        throw new BusinessRuleException("PAYMENT.NOT_POSTED", "Payment not posted", `Payment ${payment.docNumber} is "${payment.status}"; only a posted payment can be cancelled.`);
      }

      const [activeCount] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.tenantId, tenantId), eq(paymentAllocations.paymentId, paymentId), isNull(paymentAllocations.reversedAt)));
      if ((activeCount?.n ?? 0) > 0) {
        throw new BusinessRuleException(
          "PAYMENT.HAS_ACTIVE_ALLOCATIONS",
          "Cannot cancel -- allocations exist",
          `Payment ${payment.docNumber} has ${activeCount?.n ?? 0} active allocation(s); reverse them first before cancelling.`,
        );
      }

      const amount = Money.fromDb(payment.amount);
      const party =
        payment.direction === "out" ? await this.resolveSupplierParty(tx, tenantId, payment.supplierId!) : await this.resolveCustomerParty(tx, tenantId, payment.customerId!);
      const cashBankAccount = await this.resolveCashBankAccount(tx, tenantId, payment.cashBankAccountId);

      // Swap the two legs from createAndPost's own posting -- the correct reversal (AP is
      // credit-normal, so undoing a "Dr supplier" needs a "Cr supplier"; same reasoning
      // purchase-return.service.ts documents for its own reversal of the invoice's supplier leg).
      const legs: JournalLegInput[] =
        payment.direction === "out"
          ? [
              { glAccountId: cashBankAccount.glAccountId, debit: amount.toDb(), legRole: "payment" },
              { glAccountId: party.glAccountId, credit: amount.toDb(), legRole: "primary_credit", supplierId: party.id },
            ]
          : [
              { glAccountId: party.glAccountId, debit: amount.toDb(), legRole: "primary_debit", customerId: party.id },
              { glAccountId: cashBankAccount.glAccountId, credit: amount.toDb(), legRole: "payment" },
            ];

      // Reversal is dated on the day it actually happens... except no server-local "today in
      // Asia/Karachi" helper exists in this module's scope, and re-deriving one risks disagreeing
      // with whatever the eventual real one does. SIMPLIFICATION (documented): reuse the original
      // payment's own postingDate, sidestepping both problems at the cost of not distinguishing
      // "posted on" from "cancelled on" in the entry date.
      const entryDate = toDateString(payment.postingDate);

      const reversalJournalEntryId = await this.postReversingJournal(tx, {
        tenantId,
        branchId,
        entryNo: `${payment.docNumber}-CANCEL`,
        entryDate,
        documentTypeCode: "PMT",
        sourceDocumentId: paymentId,
        description: `Cancellation of payment ${payment.docNumber} -- ${party.name}`,
        legs,
        postedBy: actorId,
        reversalOfJournalId: payment.journalEntryId,
        reversalReason: input.reason ?? "Payment cancelled",
      });
      void reversalJournalEntryId; // not stored on `payment` itself -- discoverable via journal_entry.reversal_of_journal_id

      if (payment.journalEntryId !== null) {
        await tx.update(journalEntries).set({ status: "reversed", updatedBy: actorId }).where(eq(journalEntries.journalEntryId, payment.journalEntryId));
      }

      await tx
        .update(payments)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy: actorId,
          cancelReasonId: input.cancelReasonId ?? null,
          updatedBy: actorId,
        })
        .where(eq(payments.paymentId, paymentId));

      return this.getById(paymentId, actor, tx);
    });
  }

  // ---- helpers --------------------------------------------------------------------------------

  private assertSupportedDirectionParty(direction: "out" | "in", partyKind: "supplier" | "customer" | "employee" | "other"): void {
    const ok = (direction === "out" && partyKind === "supplier") || (direction === "in" && partyKind === "customer");
    if (!ok) {
      throw new BusinessRuleException(
        "PAYMENT.UNSUPPORTED_DIRECTION_PARTY",
        "Not yet supported",
        `direction "${direction}" with partyKind "${partyKind}" is not yet supported -- this wave only posts "out" payments to a supplier and "in" receipts from a customer (see PaymentService's header comment for the deferred combinations and why).`,
      );
    }
  }

  private async resolveSupplierParty(tx: Tx, tenantId: number, supplierId: number): Promise<ResolvedParty> {
    const [row] = await tx
      .select({ supplierId: suppliers.supplierId, glAccountId: suppliers.glAccountId, name: suppliers.name, isActive: suppliers.isActive })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, supplierId)));
    if (!row) {
      throw new AppException({ status: 404, code: "PAYMENT.SUPPLIER_NOT_FOUND", title: "Supplier not found", detail: `No supplier with id ${supplierId} exists.` });
    }
    if (!row.isActive) {
      throw new BusinessRuleException("PAYMENT.SUPPLIER_INACTIVE", "Supplier is inactive", `Supplier "${row.name}" is inactive.`);
    }
    return { id: row.supplierId, glAccountId: row.glAccountId, name: row.name };
  }

  private async resolveCustomerParty(tx: Tx, tenantId: number, customerId: number): Promise<ResolvedParty> {
    const [row] = await tx
      .select({ customerId: customers.customerId, glAccountId: customers.glAccountId, name: customers.name, isActive: customers.isActive })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, customerId)));
    if (!row) {
      throw new AppException({ status: 404, code: "PAYMENT.CUSTOMER_NOT_FOUND", title: "Customer not found", detail: `No customer with id ${customerId} exists.` });
    }
    if (!row.isActive) {
      throw new BusinessRuleException("PAYMENT.CUSTOMER_INACTIVE", "Customer is inactive", `Customer "${row.name}" is inactive.`);
    }
    return { id: row.customerId, glAccountId: row.glAccountId, name: row.name };
  }

  private async resolvePaymentMethod(tx: Tx, tenantId: number, paymentMethodId: number, direction: "out" | "in") {
    const [row] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.paymentMethodId, paymentMethodId)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "PAYMENT.METHOD_NOT_FOUND",
        title: "Payment method not found",
        detail: `No payment method with id ${paymentMethodId} exists.`,
      });
    }
    if (!row.isEnabled) {
      throw new BusinessRuleException("PAYMENT.METHOD_DISABLED", "Payment method disabled", `Payment method "${row.name}" is disabled.`);
    }
    if (row.directionAllowed !== "both" && row.directionAllowed !== direction) {
      throw new BusinessRuleException(
        "PAYMENT.METHOD_DIRECTION_MISMATCH",
        "Payment method direction mismatch",
        `Payment method "${row.name}" does not allow direction "${direction}".`,
      );
    }
    return row;
  }

  private async resolveCashBankAccount(tx: Tx, tenantId: number, cashBankAccountId: number) {
    const [row] = await tx.select().from(cashBankAccounts).where(and(eq(cashBankAccounts.tenantId, tenantId), eq(cashBankAccounts.cashBankAccountId, cashBankAccountId)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "PAYMENT.CASH_BANK_ACCOUNT_NOT_FOUND",
        title: "Cash/bank account not found",
        detail: `No cash/bank account with id ${cashBankAccountId} exists.`,
      });
    }
    if (!row.isActive) {
      throw new BusinessRuleException("PAYMENT.CASH_BANK_ACCOUNT_INACTIVE", "Cash/bank account inactive", `Cash/bank account #${cashBankAccountId} is inactive.`);
    }
    return row;
  }

  /** Self-contained running balance for one GL account (posted entries only) -- debit-normal
   *  (asset) sign convention, matching every seeded cash/bank leaf. Deliberately queries
   *  journal_line directly rather than depending on the accounting module's ledger endpoint, per
   *  the task instruction. */
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

  private async resolveDocumentTypeCode(tx: Tx, tenantId: number, documentTypeId: number): Promise<string> {
    const [row] = await tx.select({ code: documentTypes.code }).from(documentTypes).where(and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.documentTypeId, documentTypeId)));
    if (!row) {
      throw new BusinessRuleException("PAYMENT.UNKNOWN_TARGET_DOCUMENT_TYPE", "Unknown document type", `targetDocumentTypeId ${documentTypeId} does not exist.`);
    }
    return row.code;
  }

  private async resolveDocumentTypeIdByCode(dbOrTx: DbOrTx, tenantId: number, code: string): Promise<number> {
    const [row] = await dbOrTx.select({ documentTypeId: documentTypes.documentTypeId }).from(documentTypes).where(and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.code, code)));
    if (!row) {
      throw new BusinessRuleException("PAYMENT.DOCUMENT_TYPE_MISSING", "Document type missing", `Document type "${code}" is not configured; run the seed / set up document types.`);
    }
    return row.documentTypeId;
  }

  private async sumActiveAllocations(dbOrTx: DbOrTx, tenantId: number, targetDocumentTypeId: number, targetDocumentId: number): Promise<Money> {
    const [row] = await dbOrTx
      .select({ total: sql<string>`coalesce(sum(${paymentAllocations.allocatedAmount}), 0)` })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.tenantId, tenantId),
          eq(paymentAllocations.targetDocumentTypeId, targetDocumentTypeId),
          eq(paymentAllocations.targetDocumentId, targetDocumentId),
          isNull(paymentAllocations.reversedAt),
        ),
      );
    return Money.fromDb(row?.total ?? "0.00");
  }

  /** Locks (`FOR UPDATE`) and resolves the target document an allocation line points at -- see
   *  this file's header comment ("ALLOCATION TARGETS") for the outstanding-balance formula per
   *  document kind. Mutation-only (locking): never call this from a read-only listing. */
  private async resolveTarget(tx: Tx, tenantId: number, targetDocumentTypeId: number, targetDocumentId: number): Promise<ResolvedTarget> {
    const code = await this.resolveDocumentTypeCode(tx, tenantId, targetDocumentTypeId);
    switch (code) {
      case "PURCHASE": {
        const [row] = await tx.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.tenantId, tenantId), eq(purchaseInvoices.purchaseInvoiceId, targetDocumentId))).for("update");
        if (!row) throw new BusinessRuleException("PAYMENT.TARGET_NOT_FOUND", "Target document not found", `Purchase invoice ${targetDocumentId} does not exist.`);
        const paid = Money.fromDb(row.paidAmount);
        return {
          code: "PURCHASE",
          partyKind: "supplier",
          partyId: row.supplierId,
          status: row.status,
          outstanding: Money.fromDb(row.invoiceTotal).sub(paid),
          currentPaidAmount: paid,
          tracksPaidAmount: true,
        };
      }
      case "PURCHASE_RETURN": {
        const [row] = await tx.select().from(purchaseReturns).where(and(eq(purchaseReturns.tenantId, tenantId), eq(purchaseReturns.purchaseReturnId, targetDocumentId))).for("update");
        if (!row) throw new BusinessRuleException("PAYMENT.TARGET_NOT_FOUND", "Target document not found", `Purchase return ${targetDocumentId} does not exist.`);
        const allocated = await this.sumActiveAllocations(tx, tenantId, targetDocumentTypeId, targetDocumentId);
        return {
          code: "PURCHASE_RETURN",
          partyKind: "supplier",
          partyId: row.supplierId,
          status: row.status,
          outstanding: Money.fromDb(row.returnTotal).sub(allocated),
          currentPaidAmount: Money.zero(),
          tracksPaidAmount: false,
        };
      }
      case "SALE": {
        const [row] = await tx.select().from(saleInvoices).where(and(eq(saleInvoices.tenantId, tenantId), eq(saleInvoices.saleInvoiceId, targetDocumentId))).for("update");
        if (!row) throw new BusinessRuleException("PAYMENT.TARGET_NOT_FOUND", "Target document not found", `Sale invoice ${targetDocumentId} does not exist.`);
        const paid = Money.fromDb(row.paidAmount);
        return {
          code: "SALE",
          partyKind: "customer",
          partyId: row.customerId,
          status: row.status,
          outstanding: Money.fromDb(row.invoiceTotal).sub(paid),
          currentPaidAmount: paid,
          tracksPaidAmount: true,
        };
      }
      case "SALE_RETURN": {
        const [row] = await tx.select().from(saleReturns).where(and(eq(saleReturns.tenantId, tenantId), eq(saleReturns.saleReturnId, targetDocumentId))).for("update");
        if (!row) throw new BusinessRuleException("PAYMENT.TARGET_NOT_FOUND", "Target document not found", `Sale return ${targetDocumentId} does not exist.`);
        const outstanding =
          row.cashBankAccountId !== null
            ? Money.zero() // already self-settled via its own cash-refund leg -- see header comment
            : Money.fromDb(row.returnTotal).sub(await this.sumActiveAllocations(tx, tenantId, targetDocumentTypeId, targetDocumentId));
        return { code: "SALE_RETURN", partyKind: "customer", partyId: row.customerId, status: row.status, outstanding, currentPaidAmount: Money.zero(), tracksPaidAmount: false };
      }
      default:
        throw new BusinessRuleException(
          "PAYMENT.UNSUPPORTED_TARGET_DOCUMENT_TYPE",
          "Unsupported target document type",
          `Document type "${code}" (id ${targetDocumentTypeId}) cannot be settled by a payment allocation -- only purchase/sale invoices and returns are supported.`,
        );
    }
  }

  /** Shared by createAndPost's inline `allocations` and addAllocations -- validates one
   *  allocation line, inserts the `payment_allocation` row, and bumps the target's own
   *  `paidAmount` where that column tracks it. Returns the parsed, validated amount. */
  private async applyAllocation(
    tx: Tx,
    params: {
      tenantId: number;
      paymentId: number;
      paymentPartyKind: "supplier" | "customer";
      paymentPartyId: number;
      line: PaymentAllocationInput;
      lineIndex: number;
      actorId: number;
    },
  ): Promise<Money> {
    const amount = parseAmount(params.line.allocatedAmount, `allocations.${params.lineIndex}.allocatedAmount`);
    if (amount.compare(Money.zero()) <= 0) {
      throw new BusinessRuleException(
        "PAYMENT.INVALID_ALLOCATION_AMOUNT",
        "Invalid allocation amount",
        `allocations.${params.lineIndex}.allocatedAmount must be greater than zero.`,
        [{ path: `allocations.${params.lineIndex}.allocatedAmount`, code: "PAYMENT.INVALID_ALLOCATION_AMOUNT", message: "Must be > 0" }],
      );
    }

    const target = await this.resolveTarget(tx, params.tenantId, params.line.targetDocumentTypeId, params.line.targetDocumentId);

    if (target.status !== "posted") {
      throw new BusinessRuleException(
        "PAYMENT.TARGET_NOT_POSTED",
        "Target document not posted",
        `${target.code} ${params.line.targetDocumentId} is "${target.status}"; only a posted document can be allocated against.`,
        [{ path: `allocations.${params.lineIndex}.targetDocumentId`, code: "PAYMENT.TARGET_NOT_POSTED", message: "Not posted" }],
      );
    }
    if (target.partyKind !== params.paymentPartyKind || target.partyId !== params.paymentPartyId) {
      throw new BusinessRuleException(
        "PAYMENT.TARGET_PARTY_MISMATCH",
        "Document belongs to a different party",
        `${target.code} ${params.line.targetDocumentId} does not belong to this payment's ${params.paymentPartyKind}.`,
        [{ path: `allocations.${params.lineIndex}.targetDocumentId`, code: "PAYMENT.TARGET_PARTY_MISMATCH", message: "Party mismatch" }],
      );
    }
    if (amount.compare(target.outstanding) > 0) {
      throw new BusinessRuleException(
        "PAYMENT.ALLOCATION_EXCEEDS_OUTSTANDING",
        "Allocation exceeds outstanding balance",
        `${target.code} ${params.line.targetDocumentId} has ${target.outstanding.toDb()} outstanding; cannot allocate ${amount.toDb()}.`,
        [{ path: `allocations.${params.lineIndex}.allocatedAmount`, code: "PAYMENT.ALLOCATION_EXCEEDS_OUTSTANDING", message: "Exceeds outstanding balance" }],
      );
    }

    const now = new Date();
    await tx.insert(paymentAllocations).values({
      tenantId: params.tenantId,
      paymentId: params.paymentId,
      targetDocumentTypeId: params.line.targetDocumentTypeId,
      targetDocumentId: params.line.targetDocumentId,
      allocatedAmount: amount.toDb(),
      allocatedAt: now,
      allocatedBy: params.actorId,
      isAuto: false,
      createdBy: params.actorId,
      createdSource: "api",
    });

    if (target.tracksPaidAmount) {
      const newPaid = target.currentPaidAmount.add(amount);
      if (target.code === "PURCHASE") {
        await tx.update(purchaseInvoices).set({ paidAmount: newPaid.toDb(), updatedBy: params.actorId }).where(eq(purchaseInvoices.purchaseInvoiceId, params.line.targetDocumentId));
      } else if (target.code === "SALE") {
        await tx.update(saleInvoices).set({ paidAmount: newPaid.toDb(), updatedBy: params.actorId }).where(eq(saleInvoices.saleInvoiceId, params.line.targetDocumentId));
      }
    }

    return amount;
  }

  /** See this file's header comment ("CANCEL / REVERSING JOURNAL") for why this in-module mirror
   *  of JournalService.post() exists instead of extending the shared one. */
  private async postReversingJournal(
    tx: Tx,
    params: {
      tenantId: number;
      branchId: number;
      entryNo: string;
      entryDate: string;
      documentTypeCode: string;
      sourceDocumentId: number;
      description: string;
      legs: readonly JournalLegInput[];
      postedBy: number;
      reversalOfJournalId: number | null;
      reversalReason: string;
    },
  ): Promise<number> {
    let totalDebit = Money.zero();
    let totalCredit = Money.zero();
    for (const leg of params.legs) {
      if (leg.debit !== undefined) totalDebit = totalDebit.add(Money.fromDb(leg.debit));
      if (leg.credit !== undefined) totalCredit = totalCredit.add(Money.fromDb(leg.credit));
    }
    if (totalDebit.toDb() !== totalCredit.toDb()) {
      throw new BusinessRuleException("LEDGER.UNBALANCED", "Journal does not balance", `Debits (${totalDebit.toDb()}) and credits (${totalCredit.toDb()}) must be equal.`);
    }

    const [prior] = await tx
      .select({ maxSeq: sql<number>`coalesce(max(${journalEntries.reversalSeq}), 0)` })
      .from(journalEntries)
      .where(and(eq(journalEntries.tenantId, params.tenantId), eq(journalEntries.documentTypeCode, params.documentTypeCode), eq(journalEntries.sourceDocumentId, params.sourceDocumentId)));
    const reversalSeq = (prior?.maxSeq ?? 0) + 1;

    const now = new Date();
    await tx.insert(journalEntries).values({
      tenantId: params.tenantId,
      branchId: params.branchId,
      entryNo: params.entryNo,
      entryDate: new Date(`${params.entryDate}T00:00:00`),
      documentTypeCode: params.documentTypeCode,
      sourceDocumentId: params.sourceDocumentId,
      reversalSeq,
      description: params.description,
      totalDebit: totalDebit.toDb(),
      totalCredit: totalCredit.toDb(),
      lineCount: params.legs.length,
      status: "posted",
      postedAt: now,
      postedBy: params.postedBy,
      reversalOfJournalId: params.reversalOfJournalId,
      reversalReason: params.reversalReason,
      createdBy: params.postedBy,
    });
    const [entry] = await tx
      .select({ journalEntryId: journalEntries.journalEntryId })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.tenantId, params.tenantId),
          eq(journalEntries.documentTypeCode, params.documentTypeCode),
          eq(journalEntries.sourceDocumentId, params.sourceDocumentId),
          eq(journalEntries.reversalSeq, reversalSeq),
        ),
      );
    if (!entry) throw new Error("journal_entry (reversal) insert did not land"); // unreachable; defensive

    await tx.insert(journalLines).values(
      params.legs.map((leg, i) => ({
        journalEntryId: entry.journalEntryId,
        tenantId: params.tenantId,
        lineNo: i + 1,
        glAccountId: leg.glAccountId,
        debitAmount: leg.debit ?? "0.00",
        creditAmount: leg.credit ?? "0.00",
        legRole: leg.legRole,
        supplierId: leg.supplierId ?? null,
        customerId: leg.customerId ?? null,
        analysisAccountId: leg.analysisAccountId ?? null,
        memo: leg.memo ?? null,
        createdBy: params.postedBy,
      })),
    );

    return entry.journalEntryId;
  }
}

function parseAmount(raw: string, path: string): Money {
  const parsed = Money.fromInput(raw);
  if (!parsed.ok) {
    throw new BusinessRuleException("PAYMENT.INVALID_AMOUNT", "Invalid amount", `${path} is not a valid amount.`, [
      { path, code: "PAYMENT.INVALID_AMOUNT", message: "Invalid amount" },
    ]);
  }
  return parsed.value;
}

/** YYYY-MM-DD from a drizzle date-mode Date -- see cancel()'s own comment on why this reuses the
 *  original posting date instead of a fresh "today" (no Asia/Karachi "today" helper exists in
 *  this module's scope). */
function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
