// Wave 10c (`/admin/visibility/*`, R1 -- 00b-owner-decisions-and-requirements.md D7):
// scope-aware item visibility curation. `packages/db/schema/catalog.ts`'s `itemVisibility` table
// already modelled exactly what R1.6 asks for (per-scope override, absence-means-visible,
// bulk-grouping) since the Foundations package -- nothing here reads/wrote it until now.
//
// Deliberately NOT built in this wave: `GET/POST/PATCH /admin/visibility/presets` +
// `.../presets/:id/preview` (R1.5's SAVED, rule-evaluated visibility -- six rule kinds
// (never_stocked/no_sales_since/zero_stock_no_po/manufacturer_discontinued/category/custom), each
// needing its own query against sales/stock/purchase history). That is a real, separate rule-
// engine feature, not a natural extension of the CRUD+bulk-action surface this file builds --
// same "deserves its own dedicated wave" reasoning already applied to role_scope/role_limit and
// cashier shifts (tasks #39/#40). Tracked as Wave 10 backlog, not silently dropped.
import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { getDb, items, itemVisibility, visibilityBulkOperations } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { VisibilityScope } from "../api/dto/visibility.dto.js";

const MAX_BULK_ITEMS = 10000; // 18-api-plan.md: ">30,052 is impossible but the guard is explicit"
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

@Injectable()
export class VisibilityService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** `GET /admin/visibility/items` -- lists override rows (not the whole catalogue), joined with
   *  the item's name for display. */
  async workbench(
    params: { scope?: VisibilityScope | undefined; source?: string | undefined; q?: string | undefined; offset?: number | undefined; limit?: number | undefined },
    actor: Actor,
  ) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const conditions = [eq(itemVisibility.tenantId, tenantId)];
    if (params.scope !== undefined) conditions.push(eq(itemVisibility.scope, params.scope));
    if (params.source !== undefined) conditions.push(eq(itemVisibility.source, params.source as (typeof itemVisibility.source.enumValues)[number]));
    if (params.q !== undefined) {
      conditions.push(or(like(items.name, `%${params.q}%`), like(items.customCode, `%${params.q}%`))!);
    }

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;

    const rows = await db
      .select({
        itemId: itemVisibility.itemId,
        name: items.name,
        scope: itemVisibility.scope,
        isVisible: itemVisibility.isVisible,
        source: itemVisibility.source,
        changedAt: itemVisibility.changedAt,
        changedBy: itemVisibility.changedBy,
        bulkOperationId: itemVisibility.bulkOperationId,
      })
      .from(itemVisibility)
      .innerJoin(items, eq(itemVisibility.itemId, items.itemId))
      .where(and(...conditions))
      .limit(limit)
      .offset(offset);

    const allMatching = await db
      .select({ isVisible: itemVisibility.isVisible })
      .from(itemVisibility)
      .innerJoin(items, eq(itemVisibility.itemId, items.itemId))
      .where(and(...conditions));
    const hiddenCount = allMatching.filter((r) => !r.isVisible).length;
    const visibleCount = allMatching.length - hiddenCount;

    return { data: rows, meta: { hiddenCount, visibleCount, offset, limit } };
  }

  /** `GET /admin/visibility/effective/:itemId?scope=...` -- "why is this item hidden?" */
  async effective(itemId: number, scope: VisibilityScope, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [item] = await db.select({ itemId: items.itemId, name: items.name, isActive: items.isActive }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId), isNull(items.deletedAt)));
    if (!item) throw new NotFoundException(`No item ${itemId} for this tenant.`);

    if (!item.isActive) {
      return { isVisible: false, decidedBy: "is_active" as const, explanation: `Item "${item.name}" is deactivated (the master switch) -- hidden everywhere regardless of any per-scope override.` };
    }

    const [override] = await db.select().from(itemVisibility).where(and(eq(itemVisibility.tenantId, tenantId), eq(itemVisibility.itemId, itemId), eq(itemVisibility.scope, scope)));
    if (!override) {
      return { isVisible: true, decidedBy: "default" as const, explanation: `No override exists for scope "${scope}" -- visible by default (R1.2).` };
    }
    const decidedBy = override.source === "preset" ? ("preset:unknown" as const) : ("override" as const);
    return {
      isVisible: override.isVisible,
      decidedBy,
      explanation: `A ${override.source} override set this item's "${scope}" visibility to ${override.isVisible ? "visible" : "hidden"} on ${override.changedAt.toString()}.`,
    };
  }

  /** `PUT /items/:itemId/visibility` -- per-scope, single item. */
  async setItemVisibility(itemId: number, input: { scopes: ReadonlyArray<{ scope: VisibilityScope; isVisible: boolean }>; reason?: string | undefined }, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const [item] = await db.select({ itemId: items.itemId }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.itemId, itemId), isNull(items.deletedAt)));
    if (!item) throw new NotFoundException(`No item ${itemId} for this tenant.`);

    await db.transaction(async (tx) => {
      const now = new Date();
      for (const { scope, isVisible } of input.scopes) {
        if (isVisible) {
          // R1.2: absence means visible -- delete the redundant override rather than storing it.
          await tx.delete(itemVisibility).where(and(eq(itemVisibility.itemId, itemId), eq(itemVisibility.scope, scope)));
        } else {
          const [existing] = await tx.select({ itemId: itemVisibility.itemId }).from(itemVisibility).where(and(eq(itemVisibility.itemId, itemId), eq(itemVisibility.scope, scope)));
          if (existing) {
            await tx
              .update(itemVisibility)
              .set({ isVisible: false, source: "manual", changedAt: now, changedBy: actorId, bulkOperationId: null })
              .where(and(eq(itemVisibility.itemId, itemId), eq(itemVisibility.scope, scope)));
          } else {
            await tx.insert(itemVisibility).values({ itemId, tenantId, scope, isVisible: false, source: "manual", changedAt: now, changedBy: actorId });
          }
        }
      }
    });

    return this.currentVisibility(itemId, tenantId);
  }

  private async currentVisibility(itemId: number, tenantId: number) {
    const db = getDb();
    const rows = await db.select().from(itemVisibility).where(and(eq(itemVisibility.itemId, itemId), eq(itemVisibility.tenantId, tenantId)));
    const byScope = new Map(rows.map((r) => [r.scope, r]));
    const scopes = (["pos", "purchase", "reports", "stock_list"] as const).map((scope) => {
      const row = byScope.get(scope);
      return row ? { scope, isVisible: row.isVisible, source: row.source } : { scope, isVisible: true, source: "default" as const };
    });
    return { itemId, scopes };
  }

  /** `POST /admin/visibility/bulk`. `dryRun: true` writes nothing, returns the live count only. */
  async bulkApply(
    input: { itemIds?: readonly number[] | undefined; q?: string | undefined; scopes: readonly VisibilityScope[]; isVisible: boolean; reason: string; dryRun?: boolean | undefined },
    actor: Actor,
  ): Promise<{ affectedCount: number; bulkOperationId?: number }> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const targetItemIds = await this.resolveTargetItemIds(tenantId, input);
    if (targetItemIds.length > MAX_BULK_ITEMS) {
      throw new BusinessRuleException("VISIBILITY.SELECTION_TOO_LARGE", "Selection too large", `This bulk action would affect ${targetItemIds.length} items, over the ${MAX_BULK_ITEMS} limit.`);
    }

    if (input.dryRun === true) {
      return { affectedCount: targetItemIds.length };
    }

    const bulkOperationId = await db.transaction(async (tx) => {
      // mysql2's own INSERT result carries the new row's real auto-increment id directly
      // (`result.insertId`) -- same pattern purchase-invoice.service.ts's `findOrCreateLot`
      // already establishes, avoiding a same-transaction read-your-own-write re-query entirely.
      const [result] = await tx.insert(visibilityBulkOperations).values({ tenantId, isVisible: input.isVisible, reason: input.reason, appliedBy: actorId });
      const opId = Number(result.insertId);

      const now = new Date();
      for (const itemId of targetItemIds) {
        for (const scope of input.scopes) {
          const [existing] = await tx.select({ itemId: itemVisibility.itemId }).from(itemVisibility).where(and(eq(itemVisibility.itemId, itemId), eq(itemVisibility.scope, scope)));
          if (existing) {
            await tx
              .update(itemVisibility)
              .set({ isVisible: input.isVisible, source: "bulk", changedAt: now, changedBy: actorId, bulkOperationId: opId })
              .where(and(eq(itemVisibility.itemId, itemId), eq(itemVisibility.scope, scope)));
          } else {
            await tx.insert(itemVisibility).values({ itemId, tenantId, scope, isVisible: input.isVisible, source: "bulk", changedAt: now, changedBy: actorId, bulkOperationId: opId });
          }
        }
      }
      return opId;
    });

    return { affectedCount: targetItemIds.length, bulkOperationId };
  }

  private async resolveTargetItemIds(tenantId: number, input: { itemIds?: readonly number[] | undefined; q?: string | undefined }): Promise<number[]> {
    const db = getDb();
    if (input.itemIds !== undefined && input.itemIds.length > 0) {
      const rows = await db.select({ itemId: items.itemId }).from(items).where(and(eq(items.tenantId, tenantId), isNull(items.deletedAt), inArray(items.itemId, [...input.itemIds])));
      return rows.map((r) => r.itemId);
    }
    if (input.q !== undefined) {
      const rows = await db
        .select({ itemId: items.itemId })
        .from(items)
        .where(and(eq(items.tenantId, tenantId), isNull(items.deletedAt), or(like(items.name, `%${input.q}%`), like(items.customCode, `%${input.q}%`))!));
      return rows.map((r) => r.itemId);
    }
    return [];
  }

  /** `POST /admin/visibility/bulk/:bulkOperationId/undo`. Deletes every `item_visibility` row this
   *  operation tagged, reverting each (item, scope) to default-visible (or whatever OTHER,
   *  non-bulk override may still legitimately apply -- there is none in this codebase's current
   *  scope, since presets don't exist yet). Documented limitation: if this bulk action overwrote a
   *  PRE-EXISTING manual override on some item, undo reverts to default-visible, not that prior
   *  manual state -- a real, acknowledged simplification (see this file's own header comment on
   *  what's deliberately out of scope), not a silent gap. */
  async undoBulk(bulkOperationId: number, actor: Actor): Promise<{ bulkOperationId: number; reversedCount: number }> {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);

    const [header] = await db.select().from(visibilityBulkOperations).where(and(eq(visibilityBulkOperations.bulkOperationId, bulkOperationId), eq(visibilityBulkOperations.tenantId, tenantId)));
    if (!header) throw new NotFoundException(`No bulk visibility operation ${bulkOperationId} for this tenant.`);
    if (header.undoneAt !== null) {
      throw new BusinessRuleException("VISIBILITY.ALREADY_UNDONE", "Already undone", `Bulk operation ${bulkOperationId} was already undone at ${header.undoneAt.toString()}.`);
    }

    const reversedCount = await db.transaction(async (tx) => {
      const affected = await tx.select({ itemId: itemVisibility.itemId }).from(itemVisibility).where(eq(itemVisibility.bulkOperationId, bulkOperationId));
      await tx.delete(itemVisibility).where(eq(itemVisibility.bulkOperationId, bulkOperationId));
      await tx.update(visibilityBulkOperations).set({ undoneAt: new Date(), undoneBy: actorId }).where(eq(visibilityBulkOperations.bulkOperationId, bulkOperationId));
      return affected.length;
    });

    return { bulkOperationId, reversedCount };
  }
}
