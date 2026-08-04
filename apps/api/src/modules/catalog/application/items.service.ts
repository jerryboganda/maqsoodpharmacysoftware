// Item-master queries plus the narrow edit surface (catalog.ts's `items` table). See this
// module's header comment for scope: no item-CREATE and no reference-table (category/generic/
// manufacturer/dosage-form) surface here -- only list/view (unchanged) plus PATCH-style edits and
// deactivate on an item's own already-existing, already-populated fields.
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, like, ne, or } from "drizzle-orm";
import { getDb, items } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { AppException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { PatchItemDto } from "../api/dto/item.dto.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** `PatchItemDto`'s optional fields are typed `T | undefined` (Zod's normal optional-field
 *  inference); this project's `exactOptionalPropertyTypes: true` then rejects spreading that
 *  straight into drizzle's `.set()`, whose own optional properties (`name?: string | SQL<...>`)
 *  don't admit an explicit `undefined`. The parsed DTO never actually carries an explicit-
 *  undefined key (an omitted field is just absent), so this only needs to narrow the TYPE to
 *  match, by dropping any key whose value actually is `undefined` at runtime too. */
function withoutUndefined<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

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

  /** PATCH /items/:id -- edits an item's own already-populated fields. Never touches `isActive`
   *  (see item.dto.ts's PatchItemSchema header comment) or `avgUnitCost`/reference-table FKs. */
  async update(itemId: number, input: PatchItemDto, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const [existing] = await db
      .select({ itemId: items.itemId })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId), isNull(items.deletedAt)));
    if (!existing) {
      throw new AppException({
        status: 404,
        code: "CATALOG.ITEM_NOT_FOUND",
        title: "Item not found",
        detail: `No item with id ${itemId} exists.`,
      });
    }

    // uk_item_tenant_custom_code / uk_item_tenant_name (catalog.ts) -- check before the write so
    // a duplicate surfaces as a clean 409 rather than a raw MySQL constraint-violation 500.
    if (input.customCode !== undefined) {
      const [dupe] = await db
        .select({ itemId: items.itemId })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.customCode, input.customCode), ne(items.itemId, itemId)));
      if (dupe) {
        throw new AppException({
          status: 409,
          code: "CATALOG.DUPLICATE_ITEM_CODE",
          title: "Item code already used",
          detail: `An item with code "${input.customCode}" already exists.`,
        });
      }
    }
    if (input.name !== undefined) {
      const [dupe] = await db
        .select({ itemId: items.itemId })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), eq(items.name, input.name), ne(items.itemId, itemId)));
      if (dupe) {
        throw new AppException({
          status: 409,
          code: "CATALOG.DUPLICATE_ITEM_NAME",
          title: "Item name already used",
          detail: `An item named "${input.name}" already exists.`,
        });
      }
    }

    await db
      .update(items)
      .set({ ...withoutUndefined(input), updatedBy: actorId })
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId)));
    return this.getById(itemId, actor);
  }

  /** POST /items/:id/deactivate -- flips `isActive` to false. R1 (00b D7): the master visibility
   *  switch, never a delete (softDeleteColumns' `deletedAt` is a separate, unused-by-this-task
   *  concern). No reactivate endpoint yet -- out of scope for this task; add one the same shape
   *  when needed. */
  async deactivate(itemId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const [existing] = await db
      .select({ itemId: items.itemId })
      .from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId), isNull(items.deletedAt)));
    if (!existing) {
      throw new AppException({
        status: 404,
        code: "CATALOG.ITEM_NOT_FOUND",
        title: "Item not found",
        detail: `No item with id ${itemId} exists.`,
      });
    }

    await db
      .update(items)
      .set({ isActive: false, updatedBy: actorId })
      .where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId)));
    return this.getById(itemId, actor);
  }
}
