import { Controller, Get } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { LookupsService } from "../application/lookups.service.js";

@Controller()
export class LookupsController {
  constructor(private readonly lookups: LookupsService) {}

  @RequirePermission("sale.cash", "list")
  @Get("sale-categories")
  async saleCategories(@CurrentActor() actor: Actor) {
    return this.lookups.listSaleCategories(actor);
  }

  @RequirePermission("sale.cash", "list")
  @Get("payment-methods")
  async paymentMethods(@CurrentActor() actor: Actor) {
    return this.lookups.listPaymentMethods(actor);
  }
}
