import { Controller, Get } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { PurchaseCategoriesService } from "../application/purchase-categories.service.js";

@Controller("purchase-categories")
export class PurchaseCategoriesController {
  constructor(private readonly categories: PurchaseCategoriesService) {}

  @RequirePermission("purchase", "list")
  @Get()
  async list(@CurrentActor() actor: Actor) {
    return this.categories.list(actor);
  }
}
