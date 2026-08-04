// Blueprint: docs/system-analysis/17-technical-blueprint.md §10.3 "Runtime resolution and
// caching", §10.4 "Admin UI contract" (only enabled values appear in pickers), P1.5 (options
// filtered by the caller's permission, then re-checked on submit).
import { Injectable, NotFoundException } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateOptionItemInput, UpdateOptionItemInput } from "../api/dto/option-item.dto.js";
import type { OptionValue } from "../domain/option-value.js";
import type { OptionItemRow, OptionListSummary } from "../infrastructure/options.repository.js";
import { OptionsRepository } from "../infrastructure/options.repository.js";

@Injectable()
export class SettingsService {
  constructor(
    private readonly options: OptionsRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * §10.3: "In-process LRU cache with the settings_version stamp" is the target design once
   * `@pharmacy/db` exists; Phase 1 reads are unconditional (no cache) since the seed data is
   * already in memory -- reads being cheap enough to be unconditional is the whole point
   * (§10.3), so an explicit cache would be premature here, not a shortcut.
   */
  async listOptions(setKey: string, actor: Actor): Promise<readonly OptionValue[]> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    if (!(await this.options.isKnownSet(setKey, tenantId))) {
      // §10.3: "fail-closed on unknown option keys in development (throw)".
      throw new NotFoundException(`Unknown option set "${setKey}".`);
    }
    const values = await this.options.listValues(setKey, tenantId);
    // P1.5/P1.6: only enabled values are offered in pickers; permission filtering narrows
    // further once `minPermission` is checked against a real permission service (TODO -- see
    // common/authz/permissions.service.ts's own "known gap" note on role_scope/role_limit).
    return values.filter((v) => v.isEnabled);
  }

  // ---- admin CRUD (option-list/option-item management) --------------------------------------
  //
  // Thin pass-through onto OptionsRepository, plus the business-rule (422) checks the repository
  // deliberately does NOT own (options.repository.ts's own header comment): `isAdminExtensible`
  // gates create, `isSystem`/`allowsDisable` gate disabling, and "must be enabled" gates
  // set-default. Every method resolves tenant scope itself (same pattern as `listOptions` above)
  // rather than trusting a tenantId from the caller.

  /** `GET /option-lists`. */
  async listOptionLists(actor: Actor): Promise<readonly OptionListSummary[]> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    return this.options.listAllSets(tenantId);
  }

  /** `GET /option-lists/:listCode/items` -- deliberately NOT filtered to enabled-only (unlike
   *  `listOptions` above): this is the admin view, which needs disabled rows visible so they can
   *  be found and re-enabled. */
  async listOptionListItems(listCode: string, actor: Actor): Promise<readonly OptionItemRow[]> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const list = await this.requireList(listCode, tenantId);
    return this.options.listAllItems(list.optionListId, tenantId);
  }

  /** `POST /option-lists/:listCode/items`. 422 if the parent list is not admin-extensible
   *  (P1.4: some lists are fixed/system-defined and never accept admin-added items). */
  async createOptionItem(listCode: string, input: CreateOptionItemInput, actor: Actor): Promise<OptionItemRow> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const list = await this.requireList(listCode, tenantId);

    if (!list.isAdminExtensible) {
      throw new BusinessRuleException(
        "OPTION_LIST.NOT_ADMIN_EXTENSIBLE",
        "List is not admin-extensible",
        `Option list "${listCode}" is fixed/system-defined and does not accept admin-added items.`,
      );
    }

    return this.options.createItem({
      optionListId: list.optionListId,
      tenantId,
      code: input.code,
      name: input.name,
      nameUr: input.nameUr ?? null,
      description: input.description ?? null,
      groupLabel: input.groupLabel ?? null,
      sortOrder: input.sortOrder,
      isEnabled: input.isEnabled,
      createdBy: actorId,
    });
  }

  /**
   * `PATCH /option-lists/:listCode/items/:optionItemId`. Two independent 422 checks fire only
   * when the caller is trying to set `isEnabled: false` (a no-op or `isEnabled: true` patch never
   * triggers either):
   *   1. `isSystem` rows can never be disabled through this endpoint. options.ts's own comment on
   *      the column -- "seeded rows the application depends on" -- is a dependency on the row
   *      being present AND enabled, not on its cosmetic fields (name/description/etc.) staying
   *      fixed; those remain editable even on a system row. Since there is no DELETE endpoint in
   *      this module (isEnabled is the real "remove" mechanism, per the task's own framing),
   *      blocking `isEnabled: false` on isSystem rows IS blocking their one deletion-equivalent
   *      action, not a separate, stricter "no edits at all" rule.
   *   2. Independently, `allowsDisable` on the PARENT LIST also gates `isEnabled: false` -- a list
   *      that disallows disabling forbids it for every item, system or not.
   */
  async updateOptionItem(listCode: string, optionItemId: number, input: UpdateOptionItemInput, actor: Actor): Promise<OptionItemRow> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const list = await this.requireList(listCode, tenantId);
    const existing = await this.requireItem(list.optionListId, optionItemId, tenantId, listCode);

    if (input.isEnabled === false) {
      if (existing.isSystem) {
        throw new BusinessRuleException(
          "OPTION_ITEM.SYSTEM_ITEM_CANNOT_BE_DISABLED",
          "System option cannot be disabled",
          `Option "${existing.code}" in list "${listCode}" is a system-seeded default the application depends on and cannot be disabled.`,
        );
      }
      if (!list.allowsDisable) {
        throw new BusinessRuleException(
          "OPTION_LIST.DISABLE_NOT_ALLOWED",
          "List does not allow disabling items",
          `Option list "${listCode}" does not allow its items to be disabled.`,
        );
      }
    }

    return this.options.updateItem(optionItemId, {
      name: input.name,
      nameUr: input.nameUr,
      description: input.description,
      groupLabel: input.groupLabel,
      sortOrder: input.sortOrder,
      isEnabled: input.isEnabled,
      updatedBy: actorId,
    });
  }

  /** `POST /option-lists/:listCode/items/:optionItemId/set-default`. Requires the target be
   *  enabled -- P1.2's "sensible default" is meaningless if the default is a row no picker ever
   *  offers; an admin must enable it first, then default it, rather than this endpoint silently
   *  re-enabling it as a side effect. The actual swap (unset old default, set new, atomically) is
   *  `OptionsRepository.setDefault` -- see that method's own comment for why it must be one
   *  transaction. */
  async setDefaultOptionItem(listCode: string, optionItemId: number, actor: Actor): Promise<OptionItemRow> {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const list = await this.requireList(listCode, tenantId);
    const existing = await this.requireItem(list.optionListId, optionItemId, tenantId, listCode);

    if (!existing.isEnabled) {
      throw new BusinessRuleException(
        "OPTION_ITEM.CANNOT_DEFAULT_DISABLED",
        "Cannot default a disabled option",
        `Option "${existing.code}" in list "${listCode}" is disabled; enable it before making it the default.`,
      );
    }

    return this.options.setDefault(list.optionListId, optionItemId, actorId);
  }

  // ---- helpers ------------------------------------------------------------------------------

  private async requireList(listCode: string, tenantId: number) {
    const list = await this.options.findListByCode(listCode, tenantId);
    if (!list) {
      // Same fail-closed-on-unknown-key convention as listOptions() above (§10.3).
      throw new NotFoundException(`Unknown option list "${listCode}".`);
    }
    return list;
  }

  private async requireItem(optionListId: number, optionItemId: number, tenantId: number, listCode: string): Promise<OptionItemRow> {
    const item = await this.options.findItemById(optionListId, optionItemId, tenantId);
    if (!item) {
      throw new NotFoundException(`No option item ${optionItemId} in list "${listCode}".`);
    }
    return item;
  }
}
