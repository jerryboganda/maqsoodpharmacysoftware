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
// Phase 1 has exactly one tenant in practice (the seeded "dev" tenant, packages/db/scripts/
// seed.ts) and no tenant-resolution middleware yet -- every query below is scoped to the actor's
// own tenant (Actor has no tenantId field yet either; see TODO on listValues). Multi-tenant
// request-scoping is a real gap, tracked here rather than silently assumed away.
import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { getDb, optionItems, optionLists } from "@pharmacy/db";

import type { OptionValue } from "../domain/option-value.js";

@Injectable()
export class OptionsRepository {
  // TODO(real multi-tenancy): scope this query by the caller's tenant once Actor carries a
  // tenantId (see this file's header comment) -- today `listCode` alone resolves the row because
  // only the seeded "dev" tenant exists.
  async listValues(setKey: string): Promise<readonly OptionValue[]> {
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
      .where(eq(optionLists.listCode, setKey));

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

  async isKnownSet(setKey: string): Promise<boolean> {
    const db = getDb();
    const [row] = await db.select({ optionListId: optionLists.optionListId }).from(optionLists).where(eq(optionLists.listCode, setKey));
    return row !== undefined;
  }
}
