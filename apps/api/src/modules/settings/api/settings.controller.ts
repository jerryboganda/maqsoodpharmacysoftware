// Blueprint: docs/system-analysis/17-technical-blueprint.md Part 10 -- the P1 "options are
// data" API surface. Thin controller: validates params, resolves the actor, calls exactly one
// application service (§2.2).
import { Body, Controller, Get, Param, Patch } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { SettingsService } from "../application/settings.service.js";
import { BranchIdParamDto, UpdateBranchDto } from "./dto/branch.dto.js";
import { OptionSetKeyParamDto, type OptionValueResponseDto } from "./dto/option-value.dto.js";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * GET /settings/options/:key -- lists the enabled, role-appropriate values for one P1
   * option set (e.g. "sale.tender_method"), sorted for display (§10.4 "grouped, searchable").
   */
  @RequirePermission("settings.option", "list")
  @Get("options/:key")
  async listOptions(@Param() params: OptionSetKeyParamDto, @CurrentActor() actor: Actor): Promise<OptionValueResponseDto[]> {
    const values = await this.settings.listOptions(params.key, actor);
    return [...values]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((value) => ({
        optionValueId: value.optionValueId,
        setKey: value.setKey,
        code: value.code,
        displayName: value.displayName,
        helpText: value.helpText,
        groupLabel: value.groupLabel,
        sortOrder: value.sortOrder,
        isDefault: value.isDefault,
        meta: value.meta,
      }));
  }

  // ---- branch admin (Wave 8, U-062/D18/R7 -- see branch.dto.ts's header comment for why this
  // exists: D17 already calls branch/tenant identity fields "admin-editable settings", but no
  // endpoint anywhere in this codebase actually let anyone edit a `branch` row) --------------

  /** `GET /settings/branches` -- every branch belonging to the actor's own tenant. */
  @RequirePermission("settings.branch", "list")
  @Get("branches")
  async listBranches(@CurrentActor() actor: Actor) {
    return this.settings.listBranches(actor);
  }

  /** `PATCH /settings/branches/:branchId` -- name/address/city plus the two DRAP licence-tracking
   *  fields (drugSaleLicenceNo/drugLicenceExpiryDate). See branch.dto.ts for the full field list
   *  and what is deliberately excluded. */
  @RequirePermission("settings.branch", "edit")
  @Patch("branches/:branchId")
  async updateBranch(@Param() params: BranchIdParamDto, @Body() body: UpdateBranchDto, @CurrentActor() actor: Actor) {
    return this.settings.updateBranch(params.branchId, body, actor);
  }
}
