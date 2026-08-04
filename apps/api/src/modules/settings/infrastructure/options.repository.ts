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
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { getDb, optionItems, optionLists } from "@pharmacy/db";

import type { OptionValue } from "../domain/option-value.js";

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
}
