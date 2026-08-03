// Blueprint: 19-mysql-schema-blueprint.md Module D (parties.ts) -- "a party IS a ledger
// account": every supplier carries a mandatory, UNIQUE gl_account_id pointing at its own
// control-account leaf under the AP_CONTROL sub-account (the seeded 2001 "Dev Supplier"
// pattern, packages/db/scripts/seed.ts GL_LEAVES). Supplier creation therefore creates the GL
// leaf and the supplier row in ONE transaction (TX-1: the application service owns it).
import { Injectable } from "@nestjs/common";
import { and, desc, eq, like } from "drizzle-orm";
import { getDb, glAccountSubs, glAccounts, suppliers } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { AppException, BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateSupplierDto } from "../api/dto/supplier.dto.js";

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
