// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md Module D -- "a party IS a ledger
// account": every customer carries a mandatory, UNIQUE control-account leaf under AR_CONTROL
// (parties.ts header). Creating a customer therefore creates the GL leaf + the customer row in
// ONE transaction (TX-1: the application service owns the transaction).
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, like, or } from "drizzle-orm";
import { customers, getDb, glAccounts, glAccountSubs } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import type { Tx } from "../../../common/db/index.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateCustomerDto, ListCustomersQueryDto } from "../api/dto/customer.dto.js";

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
}
