import { Controller, Get, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { AdjustmentReasonsService } from "../application/adjustment-reasons.service.js";
import { ListAdjustmentReasonsQueryDto } from "./dto/adjustment-reason.dto.js";

@Controller("adjustment-reasons")
export class AdjustmentReasonsController {
  constructor(private readonly reasons: AdjustmentReasonsService) {}

  @RequirePermission("inventory.adjustment", "list")
  @Get()
  async list(@Query() query: ListAdjustmentReasonsQueryDto, @CurrentActor() actor: Actor) {
    return this.reasons.list(query, actor);
  }
}
