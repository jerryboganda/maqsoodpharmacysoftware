// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md Module D -- "a party IS a ledger
// account": every customer carries a mandatory, UNIQUE control-account leaf under AR_CONTROL
// (parties.ts header). Creating a customer therefore creates the GL leaf + the customer row in
// ONE transaction (TX-1: the application service owns the transaction).
import { Injectable } from "@nestjs/common";
import { and, asc, eq, gte, isNull, like, lte, ne, or } from "drizzle-orm";
import { customers, getDb, glAccounts, glAccountSubs, journalEntries, journalLines } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type {
  CreateCustomerDto,
  DeactivateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from "../api/dto/customer.dto.js";

export type CustomerRow = typeof customers.$inferSelect;

@Injectable()
export class CustomersService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(query: ListCustomersQueryDto, actor: Actor): Promise<{ customers: CustomerRow[]; limit: number; offset: number }> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const conditions = [eq(customers.tenantId, tenantId), isNull(customers.deletedAt)];
    if (query.isActive !== undefined) conditions.push(eq(customers.isActive, query.isActive));
    if (query.q !== undefined) {
      const needle = `%${query.q}%`;
      const qCond = or(like(customers.code, needle), like(customers.name, needle));
      if (qCond) conditions.push(qCond);
    }
    const rows = await db
      .select()
      .from(customers)
      .where(and(...conditions))
      .orderBy(asc(customers.name))
      .limit(query.limit)
      .offset(query.offset);
    return { customers: rows, limit: query.limit, offset: query.offset };
  }

  async getById(customerId: number, actor: Actor): Promise<CustomerRow> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const [row] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, customerId), isNull(customers.deletedAt)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "SALES.CUSTOMER_NOT_FOUND",
        title: "Customer not found",
        detail: `No customer with id ${customerId} exists.`,
      });
    }
    return row;
  }

  /**
   * One transaction: create the customer's own GL control leaf (mirroring the seed's `1501
   * Walk-in Customer` -- AR_CONTROL sub, asset/debit, postable) and the customer row bound to it
   * (uk_customer_account: one control account per customer).
   */
  async create(dto: CreateCustomerDto, actor: Actor): Promise<CustomerRow> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const actorId = Number(actor.userId);

    return db.transaction(async (tx: Tx) => {
      const [existing] = await tx
        .select({ customerId: customers.customerId })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.code, dto.code)));
      if (existing) {
        throw new BusinessRuleException(
          "SALES.CUSTOMER_CODE_TAKEN",
          "Customer code already used",
          `A customer with code "${dto.code}" already exists.`,
        );
      }

      // The AR control sub every per-customer leaf hangs under (seed GL_SUBS "AR_CONTROL").
      const [arSub] = await tx
        .select({ glAccountSubId: glAccountSubs.glAccountSubId })
        .from(glAccountSubs)
        .where(and(eq(glAccountSubs.tenantId, tenantId), eq(glAccountSubs.code, "AR_CONTROL")));
      if (!arSub) {
        throw new BusinessRuleException(
          "SALES.AR_CONTROL_MISSING",
          "Chart of accounts incomplete",
          "The Accounts Receivable control group (AR_CONTROL) is not configured; run the GL seed first.",
        );
      }

      // Same hierarchy as the seeded 1501 leaf: AR_CONTROL sub, asset nature, debit balance.
      // GL code/name are derived from the customer's own code/name (both tenant-unique).
      const glCode = `15C-${dto.code}`.slice(0, 24);
      await tx.insert(glAccounts).values({
        tenantId,
        glAccountSubId: arSub.glAccountSubId,
        code: glCode,
        name: dto.name,
        accountNature: "asset",
        normalBalance: "debit",
        isContra: false,
        isPostable: true,
        isSystem: false,
        createdBy: actorId,
        createdSource: "api",
      });
      const [glLeaf] = await tx
        .select({ glAccountId: glAccounts.glAccountId })
        .from(glAccounts)
        .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, glCode)));
      if (!glLeaf) throw new Error("gl_account insert did not land"); // unreachable; defensive

      await tx.insert(customers).values({
        tenantId,
        code: dto.code,
        name: dto.name,
        nameUr: dto.nameUr ?? null,
        glAccountId: glLeaf.glAccountId,
        phone: dto.phone ?? null,
        mobile: dto.mobile ?? null,
        email: dto.email ?? null,
        addressLine1: dto.addressLine1 ?? null,
        addressLine2: dto.addressLine2 ?? null,
        city: dto.city ?? null,
        ntnNo: dto.ntnNo ?? null,
        cnicNo: dto.cnicNo ?? null,
        creditLimitAmount: dto.creditLimitAmount ?? null,
        creditDays: dto.creditDays ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [created] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.code, dto.code)));
      if (!created) throw new Error("customer insert did not land"); // unreachable; defensive
      return created;
    });
  }

  /**
   * PATCH /customers/:id -- edits the customer's own editable fields. `glAccountId` is never
   * accepted here (UpdateCustomerDto has no such field -- see its doc comment): the GL
   * control-account link is fixed for the account's life once `create` sets it. `isActive` is
   * likewise out of scope of this endpoint; see `deactivate` below. Mirrors
   * SupplierService.update field-for-field, minus the `.toUpperCase()` code normalisation --
   * unlike suppliers, `create` never uppercases a customer's code, so `update` doesn't either.
   */
  async update(customerId: number, input: UpdateCustomerDto, actor: Actor): Promise<CustomerRow> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const actorId = Number(actor.userId);

    return db.transaction(async (tx: Tx) => {
      const [existing] = await tx
        .select({ customerId: customers.customerId, code: customers.code })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, customerId), isNull(customers.deletedAt)));
      if (!existing) {
        throw new AppException({
          status: 404,
          code: "SALES.CUSTOMER_NOT_FOUND",
          title: "Customer not found",
          detail: `No customer with id ${customerId} exists.`,
        });
      }

      if (input.code !== undefined && input.code !== existing.code) {
        const [dup] = await tx
          .select({ customerId: customers.customerId })
          .from(customers)
          .where(and(eq(customers.tenantId, tenantId), eq(customers.code, input.code)));
        if (dup) {
          throw new BusinessRuleException(
            "SALES.CUSTOMER_CODE_TAKEN",
            "Customer code already used",
            `A customer with code "${input.code}" already exists.`,
          );
        }
      }

      await tx
        .update(customers)
        .set({
          ...(input.code !== undefined && { code: input.code }),
          ...(input.name !== undefined && { name: input.name }),
          ...(input.nameUr !== undefined && { nameUr: input.nameUr }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.mobile !== undefined && { mobile: input.mobile }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 }),
          ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 }),
          ...(input.city !== undefined && { city: input.city }),
          ...(input.ntnNo !== undefined && { ntnNo: input.ntnNo }),
          ...(input.cnicNo !== undefined && { cnicNo: input.cnicNo }),
          ...(input.creditLimitAmount !== undefined && { creditLimitAmount: input.creditLimitAmount }),
          ...(input.creditDays !== undefined && { creditDays: input.creditDays }),
          updatedBy: actorId,
        })
        .where(eq(customers.customerId, customerId));

      const [updated] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.customerId, customerId), isNull(customers.deletedAt)));
      if (!updated) throw new Error("customer update did not land"); // unreachable; defensive
      return updated;
    });
  }

  /**
   * POST /customers/:id/deactivate -- retires the customer without deleting it (no hard-delete
   * of a party, same reasoning as SupplierService.deactivate: sale invoices reference
   * `customer_id` indefinitely). One-way from the API surface today (no matching reactivate
   * endpoint was asked for); a customer that is already inactive is a 422, not a silent no-op.
   *
   * SIMPLIFICATION (documented): mirrors SupplierService.deactivate -- the API plan's open-
   * documents gate (18-api-plan.md §4.1's analogous supplier row) is out of scope here; `reason`
   * is accepted for the audit trail but not persisted (no column).
   */
  async deactivate(customerId: number, input: DeactivateCustomerDto, actor: Actor): Promise<CustomerRow> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const actorId = Number(actor.userId);
    void input.reason; // accepted for the API contract, not persisted (no column yet)

    return db.transaction(async (tx: Tx) => {
      const [existing] = await tx
        .select({ customerId: customers.customerId, isActive: customers.isActive })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, customerId), isNull(customers.deletedAt)))
        .for("update");
      if (!existing) {
        throw new AppException({
          status: 404,
          code: "SALES.CUSTOMER_NOT_FOUND",
          title: "Customer not found",
          detail: `No customer with id ${customerId} exists.`,
        });
      }
      if (!existing.isActive) {
        throw new BusinessRuleException(
          "SALES.CUSTOMER_ALREADY_INACTIVE",
          "Already inactive",
          `Customer ${customerId} is already inactive.`,
        );
      }

      await tx.update(customers).set({ isActive: false, updatedBy: actorId }).where(eq(customers.customerId, customerId));

      const [updated] = await tx.select().from(customers).where(eq(customers.customerId, customerId));
      if (!updated) throw new Error("customer deactivate did not land"); // unreachable; defensive
      return updated;
    });
  }

  /**
   * GET /customers/:id/ledger -- the customer's AR sub-ledger: every `journal_line` posted
   * against this customer's own control account (`customer.gl_account_id`), joined to its parent
   * `journal_entry` for date/document context, oldest first.
   *
   * Running balance (SIMPLIFICATION, documented): a customer's AR account is an ASSET, so its
   * normal balance rises on debit and falls on credit -- the mirror image of
   * SupplierService.getLedger's liability formula (which rises on credit): each line's balance
   * is the previous balance plus that line's debit minus its credit. Because D10/R3 fixes every
   * party's balance at exactly zero at cutover (19-mysql-schema-blueprint.md's header note;
   * there is no migrated opening balance to carry in), the true balance immediately before this
   * account's very first posting is always 0.00 -- so reading this ONE account's full posting
   * history in ledger order (indexed by `ix_jl_account_date`, cheap because it is scoped to a
   * single GL leaf, unlike a whole-chart trial balance) and folding a running total across it
   * produces a fully correct running balance at every line, with no need for the blocked
   * trial-balance/financial-statement engine (U-017, 14-unknowns-and-questions.md) -- that engine
   * would only be needed to combine balances *across* many accounts (e.g. a balance sheet), not
   * to total one account's own lines. `dateFrom`/`dateTo` and `offset`/`limit` narrow which of
   * those already-correct lines are returned; `openingBalance`/`closingBalance` bound the
   * returned page, not the account's whole history.
   */
  async getLedger(
    customerId: number,
    params: {
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    },
    actor: Actor,
  ) {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();

    const [customer] = await db
      .select({ customerId: customers.customerId, glAccountId: customers.glAccountId })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.customerId, customerId), isNull(customers.deletedAt)));
    if (!customer) {
      throw new AppException({
        status: 404,
        code: "SALES.CUSTOMER_NOT_FOUND",
        title: "Customer not found",
        detail: `No customer with id ${customerId} exists.`,
      });
    }

    const conditions = [
      eq(journalLines.glAccountId, customer.glAccountId),
      eq(journalLines.tenantId, tenantId), // denormalised defence-in-depth column, same filter as journalEntries.tenantId below
      eq(journalEntries.tenantId, tenantId),
      ne(journalEntries.status, "draft"), // a draft carries no real financial event yet (§T91)
    ];
    if (params.dateFrom !== undefined) conditions.push(gte(journalEntries.entryDate, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lte(journalEntries.entryDate, new Date(`${params.dateTo}T00:00:00`)));

    // Full filtered history, oldest first -- see the method doc comment for why this is safe
    // (single-account, index-backed) and NOT the same thing as a whole-ledger trial balance.
    const rows = await db
      .select({
        journalLineId: journalLines.journalLineId,
        lineNo: journalLines.lineNo,
        debitAmount: journalLines.debitAmount,
        creditAmount: journalLines.creditAmount,
        legRole: journalLines.legRole,
        memo: journalLines.memo,
        journalEntryId: journalEntries.journalEntryId,
        entryNo: journalEntries.entryNo,
        entryDate: journalEntries.entryDate,
        documentTypeCode: journalEntries.documentTypeCode,
        sourceDocumentId: journalEntries.sourceDocumentId,
        description: journalEntries.description,
        status: journalEntries.status,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.journalEntryId))
      .where(and(...conditions))
      .orderBy(asc(journalEntries.entryDate), asc(journalEntries.journalEntryId), asc(journalLines.lineNo));

    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;

    let running = Money.zero(); // true opening balance at account inception is 0.00 (D10/R3)
    const withBalance = rows.map((row) => {
      running = running.add(Money.fromDb(row.debitAmount)).sub(Money.fromDb(row.creditAmount));
      return { ...row, balance: running.toDb() };
    });

    const openingBalance = offset > 0 ? (withBalance[offset - 1]?.balance ?? Money.zero().toDb()) : Money.zero().toDb();
    const page = withBalance.slice(offset, offset + limit);
    const closingBalance = page.length > 0 ? page[page.length - 1]!.balance : openingBalance;

    return {
      customerId,
      glAccountId: customer.glAccountId,
      openingBalance,
      lines: page,
      closingBalance,
      offset,
      limit,
      total: withBalance.length,
    };
  }
}
