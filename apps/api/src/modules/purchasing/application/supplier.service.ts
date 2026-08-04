// Blueprint: 19-mysql-schema-blueprint.md Module D (parties.ts) -- "a party IS a ledger
// account": every supplier carries a mandatory, UNIQUE gl_account_id pointing at its own
// control-account leaf under the AP_CONTROL sub-account (the seeded 2001 "Dev Supplier"
// pattern, packages/db/scripts/seed.ts GL_LEAVES). Supplier creation therefore creates the GL
// leaf and the supplier row in ONE transaction (TX-1: the application service owns it).
import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, like, lte, ne } from "drizzle-orm";
import { getDb, glAccountSubs, glAccounts, journalEntries, journalLines, suppliers } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../../../common/auth/actor.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateSupplierDto, DeactivateSupplierDto, UpdateSupplierDto } from "../api/dto/supplier.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

@Injectable()
export class SupplierService {
  // TODO(real tenancy): TenantContextService is the shared dev-mode scope resolution (see its
  // header) -- replace with actor.tenantId/branchId once the real session carries them.
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(
    params: {
      q?: string | undefined;
      isActive?: boolean | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(suppliers.tenantId, tenantId)];
    if (params.q !== undefined) conditions.push(like(suppliers.name, `%${params.q}%`));
    if (params.isActive !== undefined) conditions.push(eq(suppliers.isActive, params.isActive));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(suppliers)
      .where(and(...conditions))
      .orderBy(suppliers.name)
      .limit(limit)
      .offset(offset);
    return { suppliers: rows, offset, limit };
  }

  async getById(supplierId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [row] = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, supplierId)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "PURCHASE.SUPPLIER_NOT_FOUND",
        title: "Supplier not found",
        detail: `No supplier with id ${supplierId} exists.`,
      });
    }
    return row;
  }

  /**
   * Create the supplier's own GL control leaf (next numeric code under AP_CONTROL, mirroring
   * the seeded 2000/2001 hierarchy) and then the supplier row -- one transaction, so a failed
   * supplier insert never leaves an orphan account.
   */
  async create(input: CreateSupplierDto, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const code = (input.code ?? deriveCode(input.name)).toUpperCase();

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ supplierId: suppliers.supplierId })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.code, code)));
      if (existing) {
        throw new AppException({
          status: 409,
          code: "PURCHASE.DUPLICATE_SUPPLIER_CODE",
          title: "Supplier code already used",
          detail: `A supplier with code "${code}" already exists.`,
        });
      }

      // The AP_CONTROL sub-account the seed hangs 2000/2001 under (seed.ts GL_SUBS/GL_LEAVES).
      const [apSub] = await tx
        .select({ glAccountSubId: glAccountSubs.glAccountSubId })
        .from(glAccountSubs)
        .where(and(eq(glAccountSubs.tenantId, tenantId), eq(glAccountSubs.code, "AP_CONTROL")));
      if (!apSub) {
        throw new BusinessRuleException(
          "LEDGER.AP_CONTROL_MISSING",
          "Chart of accounts incomplete",
          "The AP_CONTROL sub-account is not configured; run the seed / set up the chart of accounts first.",
        );
      }

      // Next numeric code in the 2xxx payables range: max existing numeric code under
      // AP_CONTROL + 1 (seed: 2000 control, 2001 Dev Supplier -> next is 2002). Account codes
      // are identifiers, not money -- plain integer arithmetic is fine here (Rule M applies to
      // amounts/quantities, not codes).
      const subLeaves = await tx
        .select({ code: glAccounts.code })
        .from(glAccounts)
        .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.glAccountSubId, apSub.glAccountSubId)));
      const maxCode = subLeaves.reduce((max, row) => {
        const n = /^\d+$/.test(row.code) ? Number(row.code) : 0;
        return n > max ? n : max;
      }, 2000);
      const glCode = String(maxCode + 1);

      await tx.insert(glAccounts).values({
        tenantId,
        glAccountSubId: apSub.glAccountSubId,
        code: glCode,
        name: input.name,
        accountNature: "liability",
        normalBalance: "credit",
        isContra: false,
        isPostable: true,
        isSystem: false,
        createdBy: actorId,
        createdSource: "api",
      });
      const [glRow] = await tx
        .select({ glAccountId: glAccounts.glAccountId })
        .from(glAccounts)
        .where(and(eq(glAccounts.tenantId, tenantId), eq(glAccounts.code, glCode)));
      if (!glRow) throw new Error("gl_account insert did not land"); // unreachable; defensive

      await tx.insert(suppliers).values({
        tenantId,
        code,
        name: input.name,
        nameUr: input.nameUr ?? null,
        glAccountId: glRow.glAccountId,
        ntnNo: input.ntnNo ?? null,
        strnNo: input.strnNo ?? null,
        cnicNo: input.cnicNo ?? null,
        phone: input.phone ?? null,
        mobile: input.mobile ?? null,
        email: input.email ?? null,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        creditDays: input.creditDays ?? null,
        leadTimeDays: input.leadTimeDays ?? null,
        specialInstructions: input.specialInstructions ?? null,
        createdBy: actorId,
        createdSource: "api",
      });
      const [supplierRow] = await tx
        .select()
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.code, code)))
        .orderBy(desc(suppliers.supplierId));
      if (!supplierRow) throw new Error("supplier insert did not land"); // unreachable; defensive
      return supplierRow;
    });
  }

  /**
   * PATCH /suppliers/:id -- edits the supplier's own editable fields. `glAccountId` is never
   * accepted here (UpdateSupplierDto has no such field -- see its doc comment): the GL
   * control-account link is fixed for the account's life once `create` sets it. `isActive` is
   * likewise out of scope of this endpoint; see `deactivate` below.
   */
  async update(supplierId: number, input: UpdateSupplierDto, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ supplierId: suppliers.supplierId, code: suppliers.code })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, supplierId)));
      if (!existing) {
        throw new AppException({
          status: 404,
          code: "PURCHASE.SUPPLIER_NOT_FOUND",
          title: "Supplier not found",
          detail: `No supplier with id ${supplierId} exists.`,
        });
      }

      const nextCode = input.code !== undefined ? input.code.toUpperCase() : undefined;
      if (nextCode !== undefined && nextCode !== existing.code) {
        const [dup] = await tx
          .select({ supplierId: suppliers.supplierId })
          .from(suppliers)
          .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.code, nextCode)));
        if (dup) {
          throw new AppException({
            status: 409,
            code: "PURCHASE.DUPLICATE_SUPPLIER_CODE",
            title: "Supplier code already used",
            detail: `A supplier with code "${nextCode}" already exists.`,
          });
        }
      }

      await tx
        .update(suppliers)
        .set({
          ...(input.name !== undefined && { name: input.name }),
          ...(nextCode !== undefined && { code: nextCode }),
          ...(input.nameUr !== undefined && { nameUr: input.nameUr }),
          ...(input.ntnNo !== undefined && { ntnNo: input.ntnNo }),
          ...(input.strnNo !== undefined && { strnNo: input.strnNo }),
          ...(input.cnicNo !== undefined && { cnicNo: input.cnicNo }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.mobile !== undefined && { mobile: input.mobile }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 }),
          ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 }),
          ...(input.city !== undefined && { city: input.city }),
          ...(input.creditDays !== undefined && { creditDays: input.creditDays }),
          ...(input.leadTimeDays !== undefined && { leadTimeDays: input.leadTimeDays }),
          ...(input.specialInstructions !== undefined && { specialInstructions: input.specialInstructions }),
          updatedBy: actorId,
        })
        .where(eq(suppliers.supplierId, supplierId));

      const [updated] = await tx.select().from(suppliers).where(eq(suppliers.supplierId, supplierId));
      if (!updated) throw new Error("supplier update did not land"); // unreachable; defensive
      return updated;
    });
  }

  /**
   * POST /suppliers/:id/deactivate -- retires the supplier without deleting it (no hard-delete
   * of a party, same reasoning as UserAdminService: purchase invoices reference `supplier_id`
   * indefinitely). One-way from the API surface today (no matching reactivate endpoint was asked
   * for); a supplier that is already inactive is a 422, not a silent no-op, matching the
   * state-machine style StockAdjustmentService uses for `approve`/`post` (e.g. `DOC.NOT_DRAFT`).
   *
   * SIMPLIFICATION (documented): the API plan (18-api-plan.md §4.1) additionally gates this on
   * "no open documents, or `force` + reason" -- that check would need to reach into every
   * document type that can reference a supplier (purchase orders, purchase invoices, ...) and is
   * out of scope here; `reason` is accepted for the audit trail but not persisted (no column).
   */
  async deactivate(supplierId: number, input: DeactivateSupplierDto, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    void input.reason; // accepted for the API contract, not persisted (no column yet)

    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ supplierId: suppliers.supplierId, isActive: suppliers.isActive })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, supplierId)))
        .for("update");
      if (!existing) {
        throw new AppException({
          status: 404,
          code: "PURCHASE.SUPPLIER_NOT_FOUND",
          title: "Supplier not found",
          detail: `No supplier with id ${supplierId} exists.`,
        });
      }
      if (!existing.isActive) {
        throw new BusinessRuleException(
          "PURCHASE.SUPPLIER_ALREADY_INACTIVE",
          "Already inactive",
          `Supplier ${supplierId} is already inactive.`,
        );
      }

      await tx.update(suppliers).set({ isActive: false, updatedBy: actorId }).where(eq(suppliers.supplierId, supplierId));

      const [updated] = await tx.select().from(suppliers).where(eq(suppliers.supplierId, supplierId));
      if (!updated) throw new Error("supplier deactivate did not land"); // unreachable; defensive
      return updated;
    });
  }

  /**
   * GET /suppliers/:id/ledger -- the supplier's AP sub-ledger: every `journal_line` posted
   * against this supplier's own control account (`supplier.gl_account_id`), joined to its parent
   * `journal_entry` for date/document context, oldest first.
   *
   * Running balance (SIMPLIFICATION, documented): a supplier's AP account is a liability, so its
   * normal balance rises on credit and falls on debit; each line's balance is the previous
   * balance plus that line's credit minus its debit. Because D10/R3 fixes every party's balance
   * at exactly zero at cutover (19-mysql-schema-blueprint.md's header note; there is no migrated
   * opening balance to carry in), the true balance immediately before this account's very first
   * posting is always 0.00 -- so reading this ONE account's full posting history in ledger order
   * (indexed by `ix_jl_account_date`, cheap because it is scoped to a single GL leaf, unlike a
   * whole-chart trial balance) and folding a running total across it produces a fully correct
   * running balance at every line, with no need for the blocked trial-balance/financial-statement
   * engine (U-017, 14-unknowns-and-questions.md) -- that engine would only be needed to combine
   * balances *across* many accounts (e.g. a balance sheet), not to total one account's own lines.
   * `dateFrom`/`dateTo` and `offset`/`limit` narrow which of those already-correct lines are
   * returned; `openingBalance`/`closingBalance` bound the returned page, not the account's whole
   * history.
   */
  async getLedger(
    supplierId: number,
    params: {
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
      offset?: number | undefined;
      limit?: number | undefined;
    },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);

    const [supplier] = await db
      .select({ supplierId: suppliers.supplierId, glAccountId: suppliers.glAccountId })
      .from(suppliers)
      .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.supplierId, supplierId)));
    if (!supplier) {
      throw new AppException({
        status: 404,
        code: "PURCHASE.SUPPLIER_NOT_FOUND",
        title: "Supplier not found",
        detail: `No supplier with id ${supplierId} exists.`,
      });
    }

    const conditions = [
      eq(journalLines.glAccountId, supplier.glAccountId),
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

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;

    let running = Money.zero(); // true opening balance at account inception is 0.00 (D10/R3)
    const withBalance = rows.map((row) => {
      running = running.add(Money.fromDb(row.creditAmount)).sub(Money.fromDb(row.debitAmount));
      return { ...row, balance: running.toDb() };
    });

    const openingBalance = offset > 0 ? (withBalance[offset - 1]?.balance ?? Money.zero().toDb()) : Money.zero().toDb();
    const page = withBalance.slice(offset, offset + limit);
    const closingBalance = page.length > 0 ? page[page.length - 1]!.balance : openingBalance;

    return {
      supplierId,
      glAccountId: supplier.glAccountId,
      openingBalance,
      lines: page,
      closingBalance,
      offset,
      limit,
      total: withBalance.length,
    };
  }
}

/** "Dev Supplier & Co." -> "DEV_SUPPLIER_CO" (max 32 chars, matching the seed's code style). */
function deriveCode(name: string): string {
  return (
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "SUPPLIER"
  );
}
