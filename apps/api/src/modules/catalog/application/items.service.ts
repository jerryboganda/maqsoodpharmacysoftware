// Read-only item-master queries (catalog.ts's `items` table). See this module's header comment
// for scope: no create/edit surface here, purely so other modules' create-forms can search and
// resolve an itemId.
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, like, or } from "drizzle-orm";
import { getDb, items } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { AppException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

@Injectable()
export class ItemsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(params: { q?: string | undefined; isActive?: boolean | undefined; offset?: number; limit?: number }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(items.tenantId, tenantId), isNull(items.deletedAt)];
    if (params.q !== undefined) {
      conditions.push(or(like(items.name, `%${params.q}%`), like(items.customCode, `%${params.q}%`))!);
    }
    if (params.isActive !== undefined) conditions.push(eq(items.isActive, params.isActive));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select({
        itemId: items.itemId,
        customCode: items.customCode,
        name: items.name,
        nameLocal: items.nameLocal,
        packUnits: items.packUnits,
        allowDecimalQty: items.allowDecimalQty,
        salePrice: items.salePrice,
        purchasePrice: items.purchasePrice,
        avgUnitCost: items.avgUnitCost,
        hasExpiry: items.hasExpiry,
        expiryCaptureMode: items.expiryCaptureMode,
        isControlledDrug: items.isControlledDrug,
        isActive: items.isActive,
      })
      .from(items)
      .where(and(...conditions))
      .orderBy(asc(items.name))
      .limit(limit)
      .offset(offset);
    return { items: rows, offset, limit };
  }

  async getById(itemId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [row] = await db
      .select()
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId), isNull(items.deletedAt)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "CATALOG.ITEM_NOT_FOUND",
        title: "Item not found",
        detail: `No item with id ${itemId} exists.`,
      });
    }
    return row;
  }
}
