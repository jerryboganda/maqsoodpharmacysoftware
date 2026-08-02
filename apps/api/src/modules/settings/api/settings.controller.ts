// Blueprint: docs/system-analysis/17-technical-blueprint.md Part 10 -- the P1 "options are
// data" API surface. Thin controller: validates params, resolves the actor, calls exactly one
// application service (§2.2).
import { Controller, Get, Param } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { SettingsService } from "../application/settings.service.js";
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
}
