// Blueprint: docs/system-analysis/17-technical-blueprint.md §10.2 (schema), §10.5 (the P1
// areas from 00b, mapped to option-set keys).
//
// Reconciles this repository's shape (`listValues(setKey)`) against @pharmacy/db's
// `option_list`/`option_item` column names (packages/db/schema/options.ts): `displayName` <-
// `name`, `helpText` <- `description` (option_item has no dedicated help_text column distinct
// from description; §10.5's option_value.help_text and this table's description serve the same
// purpose). `groupLabel`/`minPermission`/`searchTerms`/`meta` map onto the matching §10.5 columns
// added to option_item alongside this wiring.
//
// Real tenant scoping (17 §9.1): `tenantId` is resolved by the caller (settings.service.ts, via
// `TenantContextService.resolveScope(actor)`) from the real authenticated actor and threaded
// through every query below -- `option_list`/`option_item` are both `tenant_id NOT NULL`
// (options.ts), so an un-scoped query would leak every tenant's option catalogue to every caller.
//
// Admin CRUD extension (option-list/option-item management): `listAllSets`/`listAllItems` are the
// admin-view reads (every row, including disabled -- unlike `listValues` above, which is the
// enabled-only, app-facing read); `createItem`/`updateItem`/`setDefault` are the writes. Mirrors
// `UserAdminRepository`'s shape (identity/infrastructure/user-admin.repository.ts): a genuine
// repository (as opposed to a service that touches Drizzle tables directly, e.g.
// payment-method.service.ts) owns its own `db.transaction()` for any multi-statement write, so
// callers never see a partially-applied mutation. Business-rule checks (`isAdminExtensible`,
// `allowsDisable`, `isSystem`, "must be enabled to become the default") live in
// `SettingsService`, one layer up -- this repository only enforces what the database itself would
// reject anyway (duplicate `code` within a list) plus the one atomicity guarantee only the
// repository can give (`setDefault`'s unset-then-set swap).
import { Injectable } from "@nestjs/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb, optionItems, optionLists } from "@pharmacy/db";

import { AppException } from "../../../common/errors/index.js";
import type { OptionValue } from "../domain/option-value.js";

export type OptionItemRow = typeof optionItems.$inferSelect;

/** `GET /option-lists` row shape -- list metadata plus a computed item count (§ task spec). */
export interface OptionListSummary {
  readonly optionListId: number;
  readonly listCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly isAdminExtensible: boolean;
  readonly allowsDisable: boolean;
  readonly itemCount: number;
}

/** The subset of `option_list` columns the service needs to enforce P1.4 (`isAdminExtensible`)
 *  and the disable-guard (`allowsDisable`) before writing to `option_item`. */
export interface OptionListRecord {
  readonly optionListId: number;
  readonly listCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly isAdminExtensible: boolean;
  readonly allowsDisable: boolean;
}

export interface CreateOptionItemInput {
  readonly optionListId: number;
  readonly tenantId: number;
  readonly code: string;
  readonly name: string;
  readonly nameUr: string | null;
  readonly description: string | null;
  readonly groupLabel: string | null;
  readonly sortOrder: number;
  readonly isEnabled: boolean;
  readonly createdBy: number;
}

export interface UpdateOptionItemPatch {
  readonly name?: string | undefined;
  readonly nameUr?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly groupLabel?: string | null | undefined;
  readonly sortOrder?: number | undefined;
  readonly isEnabled?: boolean | undefined;
  readonly updatedBy: number;
}

@Injectable()
export class OptionsRepository {
  async listValues(setKey: string, tenantId: number): Promise<readonly OptionValue[]> {
    const db = getDb();
    const rows = await db
      .select({
        optionItemId: optionItems.optionItemId,
        code: optionItems.code,
        name: optionItems.name,
        description: optionItems.description,
        groupLabel: optionItems.groupLabel,
        sortOrder: optionItems.sortOrder,
        isEnabled: optionItems.isEnabled,
        isDefault: optionItems.isDefault,
        isSystem: optionItems.isSystem,
        minPermission: optionItems.minPermission,
        searchTerms: optionItems.searchTerms,
        metaJson: optionItems.metaJson,
      })
      .from(optionItems)
      .innerJoin(optionLists, eq(optionItems.optionListId, optionLists.optionListId))
      .where(and(eq(optionLists.listCode, setKey), eq(optionItems.tenantId, tenantId)));

    return rows.map((row) => ({
      optionValueId: String(row.optionItemId),
      setKey,
      code: row.code,
      displayName: row.name,
      helpText: row.description,
      groupLabel: row.groupLabel,
      sortOrder: row.sortOrder,
      isEnabled: row.isEnabled,
      isDefault: row.isDefault,
      isSystem: row.isSystem,
      minPermission: row.minPermission,
      searchTerms: row.searchTerms,
      meta: row.metaJson,
    }));
  }

  async isKnownSet(setKey: string, tenantId: number): Promise<boolean> {
    const db = getDb();
    const [row] = await db
      .select({ optionListId: optionLists.optionListId })
      .from(optionLists)
      .where(and(eq(optionLists.listCode, setKey), eq(optionLists.tenantId, tenantId)));
    return row !== undefined;
  }

  // ---- admin CRUD (option-list/option-item management) --------------------------------------

  /** `GET /option-lists/:listCode/items`'s lookup step, and every write's own list-metadata
   *  check (`isAdminExtensible`/`allowsDisable`) -- one place that reads the parent list row. */
  async findListByCode(listCode: string, tenantId: number): Promise<OptionListRecord | undefined> {
    const db = getDb();
    const [row] = await db
      .select({
        optionListId: optionLists.optionListId,
        listCode: optionLists.listCode,
        name: optionLists.name,
        description: optionLists.description,
        isAdminExtensible: optionLists.isAdminExtensible,
        allowsDisable: optionLists.allowsDisable,
      })
      .from(optionLists)
      .where(and(eq(optionLists.listCode, listCode), eq(optionLists.tenantId, tenantId)));
    return row;
  }

  /** `GET /option-lists` -- every list this tenant has, plus a computed item count. The count
   *  join is a LEFT JOIN filtered to non-deleted items so an empty list still reports (correctly)
   *  as 0 rather than being dropped by an inner join. */
  async listAllSets(tenantId: number): Promise<OptionListSummary[]> {
    const db = getDb();
    const rows = await db
      .select({
        optionListId: optionLists.optionListId,
        listCode: optionLists.listCode,
        name: optionLists.name,
        description: optionLists.description,
        isAdminExtensible: optionLists.isAdminExtensible,
        allowsDisable: optionLists.allowsDisable,
        itemCount: sql<number>`count(${optionItems.optionItemId})`,
      })
      .from(optionLists)
      .leftJoin(optionItems, and(eq(optionItems.optionListId, optionLists.optionListId), isNull(optionItems.deletedAt)))
      .where(eq(optionLists.tenantId, tenantId))
      .groupBy(
        optionLists.optionListId,
        optionLists.listCode,
        optionLists.name,
        optionLists.description,
        optionLists.isAdminExtensible,
        optionLists.allowsDisable,
      )
      .orderBy(asc(optionLists.name));
    return rows.map((row) => ({ ...row, itemCount: Number(row.itemCount) }));
  }

  /** `GET /option-lists/:listCode/items` -- deliberately EVERY item in the list, including
   *  disabled ones (unlike `listValues` above, which is the enabled-only app-facing read) so a
   *  disabled row can be found and re-enabled from the admin screen. */
  async listAllItems(optionListId: number, tenantId: number): Promise<OptionItemRow[]> {
    const db = getDb();
    return db
      .select()
      .from(optionItems)
      .where(and(eq(optionItems.optionListId, optionListId), eq(optionItems.tenantId, tenantId), isNull(optionItems.deletedAt)))
      .orderBy(asc(optionItems.sortOrder), asc(optionItems.name));
  }

  /** Scoped to a specific parent list (not just tenant) so a `PATCH`/`set-default` against
   *  `:listCode/items/:optionItemId` can never touch an item that belongs to a different list --
   *  even one in the same tenant. */
  async findItemById(optionListId: number, optionItemId: number, tenantId: number): Promise<OptionItemRow | undefined> {
    const db = getDb();
    const [row] = await db
      .select()
      .from(optionItems)
      .where(
        and(
          eq(optionItems.optionItemId, optionItemId),
          eq(optionItems.optionListId, optionListId),
          eq(optionItems.tenantId, tenantId),
          isNull(optionItems.deletedAt),
        ),
      );
    return row;
  }

  /** `POST /option-lists/:listCode/items`. The `isAdminExtensible` 422 check happens one layer up
   *  (SettingsService, against the list row `findListByCode` already returned) -- this method
   *  only owns the one invariant the database would reject anyway: `code` unique within the list
   *  (`uk_option_item_list_code`, options.ts). Pre-checked inside the same transaction as the
   *  insert (mirrors payment-method.service.ts's `create()`) so a nicer 409 is returned instead of
   *  a raw `ER_DUP_ENTRY` surfacing as a 500. New items are always `isDefault: false` (P1.2: the
   *  only path to becoming the default is the atomic `setDefault` below, never a create-time flag
   *  -- that keeps the "unset old, set new" swap the single place `isDefault` ever changes) and
   *  always `isSystem: false` (that flag is seed-only, never API-settable). */
  async createItem(input: CreateOptionItemInput): Promise<OptionItemRow> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ optionItemId: optionItems.optionItemId })
        .from(optionItems)
        .where(and(eq(optionItems.optionListId, input.optionListId), eq(optionItems.code, input.code)));
      if (existing) {
        throw new AppException({
          status: 409,
          code: "OPTION_ITEM.DUPLICATE_CODE",
          title: "Option code already used",
          detail: `An option with code "${input.code}" already exists in this list.`,
        });
      }

      await tx.insert(optionItems).values({
        optionListId: input.optionListId,
        tenantId: input.tenantId,
        code: input.code,
        name: input.name,
        nameUr: input.nameUr,
        description: input.description,
        groupLabel: input.groupLabel,
        sortOrder: input.sortOrder,
        isEnabled: input.isEnabled,
        isDefault: false,
        isSystem: false,
        createdBy: input.createdBy,
        createdSource: "api",
      });

      const [row] = await tx
        .select()
        .from(optionItems)
        .where(and(eq(optionItems.optionListId, input.optionListId), eq(optionItems.code, input.code)));
      if (!row) throw new Error("option_item insert did not land"); // unreachable; defensive
      return row;
    });
  }

  /** `PATCH /option-lists/:listCode/items/:optionItemId`. Every 422 business-rule check
   *  (`isSystem`, `allowsDisable`) already happened one layer up in SettingsService before this is
   *  called -- this method is a plain partial update + re-select, wrapped in a transaction only
   *  for the same "read-your-own-write" consistency every sibling LK-pack `update()` uses
   *  (payment-method.service.ts, expense-category.service.ts), not because it needs multi-row
   *  atomicity. `code`/`isDefault`/`isSystem` are not accepted here -- see UpdateOptionItemDto's
   *  header comment for why each is excluded. */
  async updateItem(optionItemId: number, patch: UpdateOptionItemPatch): Promise<OptionItemRow> {
    const db = getDb();
    return db.transaction(async (tx) => {
      await tx
        .update(optionItems)
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.nameUr !== undefined && { nameUr: patch.nameUr }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.groupLabel !== undefined && { groupLabel: patch.groupLabel }),
          ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
          ...(patch.isEnabled !== undefined && { isEnabled: patch.isEnabled }),
          updatedBy: patch.updatedBy,
        })
        .where(eq(optionItems.optionItemId, optionItemId));

      const [row] = await tx.select().from(optionItems).where(eq(optionItems.optionItemId, optionItemId));
      if (!row) throw new Error("option_item update did not land"); // unreachable; defensive
      return row;
    });
  }

  /**
   * `POST /option-lists/:listCode/items/:optionItemId/set-default`. The atomic swap the task
   * spec calls for: unset whichever item currently holds `isDefault` in this list, then set the
   * target -- both inside ONE `db.transaction()`, not two separate statements a concurrent caller
   * could interleave with. That ordering matters even though `uk_option_item_default` (options.ts,
   * a functional unique index on a generated column that is non-null only when `is_default = 1`)
   * is the real, DB-level backstop for "at most one default per list": doing the unset and the set
   * as two separate top-level statements would let a second concurrent `setDefault` call for a
   * DIFFERENT target land its own "unset" between this call's unset and set, silently undoing
   * whichever one committed last. One transaction serializes the two rows' worth of writes so
   * that can't happen. Existence/tenant/list-membership of `optionItemId` is already verified by
   * the caller (SettingsService, via `findItemById`) before this runs.
   */
  async setDefault(optionListId: number, optionItemId: number, actorId: number): Promise<OptionItemRow> {
    const db = getDb();
    return db.transaction(async (tx) => {
      await tx
        .update(optionItems)
        .set({ isDefault: false, updatedBy: actorId })
        .where(and(eq(optionItems.optionListId, optionListId), eq(optionItems.isDefault, true)));

      await tx
        .update(optionItems)
        .set({ isDefault: true, updatedBy: actorId })
        .where(eq(optionItems.optionItemId, optionItemId));

      const [row] = await tx.select().from(optionItems).where(eq(optionItems.optionItemId, optionItemId));
      if (!row) throw new Error("option_item set-default did not land"); // unreachable; defensive
      return row;
    });
  }
}
