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

  // `GET /payment-methods` used to live here (gated on "sale.cash":"list", a partial field
  // subset for the sale-invoice payment-method picker). Removed -- it collided at the router
  // level (Fastify FST_ERR_DUPLICATED_ROUTE, verified by booting the app) with the payments
  // module's own canonical `GET /payment-methods` (apps/api/src/modules/payments/api/payment-
  // methods.controller.ts, full CRUD owner of the `payment_method` resource per 18-api-plan.md
  // §5.1). Two controllers cannot both register the same method+path in the same Fastify
  // instance regardless of what permission each one checks, so only one of them could survive.
  //
  // KNOWN GAP (flagged, not silently dropped): the new canonical route requires
  // `payment_method:list` (owner/pharmacy_manager/accountant/auditor per seed.ts), which is
  // NARROWER than this route's old `sale.cash:list` (also includes shift_incharge/sales_officer)
  // -- those two roles lose `GET /payment-methods` access at the POS sale-invoice flow until
  // seed.ts grants them `payment_method:list` too (or a narrower list-only variant). That seed.ts
  // edit was explicitly out of scope for the task that removed this route (payments module build,
  // "do not touch packages/db/scripts/seed.ts") -- needs a follow-up. `LookupsService.
  // listPaymentMethods` (application/lookups.service.ts) is left in place, unused, for whichever
  // fix lands (either restoring a role-appropriate route here, or a seed.ts permission grant that
  // lets the canonical route serve every caller).
}
