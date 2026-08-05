// Blueprint: docs/system-analysis/17-technical-blueprint.md §10.3 "Runtime resolution and
// caching", §10.4 "Admin UI contract" (only enabled values appear in pickers), P1.5 (options
// filtered by the caller's permission, then re-checked on submit).
import { Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { branches, getDb } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { BusinessRuleException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import type { CreateOptionItemInput, UpdateOptionItemInput } from "../api/dto/option-item.dto.js";
import type { UpdateBranchInput } from "../api/dto/branch.dto.js";
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

  // ---- branch admin (Wave 8, U-062/D18/R7 -- see branch.dto.ts's header comment) ------------
  //
  // No BranchesRepository: two small, single-table methods don't earn a repository layer of
  // their own (same call OptionsRepository's own file did NOT make for e.g. a one-off lookup --
  // this mirrors how other thin services in this module access `getDb()` directly rather than
  // wrapping every table in a repository class).

  /** `GET /branches` -- every branch belonging to the actor's tenant (D16 isolation: scoped by
   *  tenantId, never a bare unscoped `SELECT * FROM branch`), including inactive ones -- the
   *  admin view, same "show everything, let the UI filter" convention `listOptionListItems`
   *  above already establishes for its own admin surface. */
  async listBranches(actor: Actor) {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const db = getDb();
    const rows = await db.select().from(branches).where(eq(branches.tenantId, tenantId));
    return rows.map(shapeBranch);
  }

  /** `PATCH /branches/:branchId`. 404 if the branch doesn't exist or belongs to a different
   *  tenant (D16 isolation -- the WHERE clause scopes by both branchId AND tenantId together, so
   *  a cross-tenant id never even reveals existence). */
  async updateBranch(branchId: number, input: UpdateBranchInput, actor: Actor) {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const actorId = Number(actor.userId);
    const db = getDb();

    const [existing] = await db.select().from(branches).where(and(eq(branches.branchId, branchId), eq(branches.tenantId, tenantId)));
    if (!existing) {
      throw new NotFoundException(`No branch ${branchId} for this tenant.`);
    }

    // Conditional spread per field, same convention OptionsRepository.updateItem already
    // establishes for an identical "PATCH, every field optional" shape: Drizzle's `.set()` does
    // NOT skip `undefined`-valued keys on its own (an unconditional `{name: input.name}` would
    // write a literal SQL NULL, or crash the mysql2 parameter binder, for every field the caller
    // omitted) -- each field is only included when the caller actually sent it.
    await db
      .update(branches)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 }),
        ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 }),
        ...(input.city !== undefined && { city: input.city }),
        ...(input.drugSaleLicenceNo !== undefined && { drugSaleLicenceNo: input.drugSaleLicenceNo }),
        // A `date()`-mode column WRITE (`.set()`/`.values()`) wants an actual `Date`, matching
        // every other date-column write in this codebase (e.g. sale-invoices.service.ts's own
        // `new Date(`${dto.documentDate}T00:00:00`)`) -- NOT a bare string, and NOT
        // report-helpers.ts's `businessDateParam`, which is a narrower, different fix for a
        // `gte`/`lte`/`eq` QUERY FILTER's own serialization bug (that function's own doc comment)
        // and does not apply to this write path.
        ...(input.drugLicenceExpiryDate !== undefined && {
          drugLicenceExpiryDate: input.drugLicenceExpiryDate === null ? null : new Date(`${input.drugLicenceExpiryDate}T00:00:00`),
        }),
        updatedBy: actorId,
      })
      .where(eq(branches.branchId, branchId));

    const [updated] = await db.select().from(branches).where(eq(branches.branchId, branchId));
    if (!updated) throw new Error(`branch ${branchId} vanished immediately after its own update`); // unreachable; defensive
    return shapeBranch(updated);
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

// ---- module-local helpers -------------------------------------------------------------------

/** A `date()`-mode column comes back from Drizzle as a real JS `Date` (mysql2's own
 *  `dateStrings` config only governs the raw driver layer -- Drizzle re-hydrates it per the
 *  column's declared mode), which `JSON.stringify` renders as a full
 *  `"2026-08-15T00:00:00.000Z"` timestamp -- confirmed live via this wave's own integration test
 *  before this fix was written (test 3 in controlled-drug-compliance.test.ts originally failed on
 *  exactly this). Safe to slice via `.toISOString()` here specifically because the source is a
 *  DATE column with no time-of-day component to begin with (unlike `common/dates/business-date.ts`'s
 *  `localToday()`, which is about "now", a real instant, and needs the explicit-timezone
 *  `Intl.DateTimeFormat` treatment instead) -- mirrors reporting/application/report-helpers.ts's
 *  own identical `toDateOnly` one-for-one, duplicated rather than reaching into a different
 *  module for one line, same call this wave already made for notification.service.ts's
 *  `dateOnlyParam`. */
function toDateOnlyOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString().slice(0, 10);
}

function shapeBranch<T extends { drugLicenceExpiryDate: Date | null }>(row: T): Omit<T, "drugLicenceExpiryDate"> & { drugLicenceExpiryDate: string | null } {
  return { ...row, drugLicenceExpiryDate: toDateOnlyOrNull(row.drugLicenceExpiryDate) };
}
