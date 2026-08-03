// Thin controllers (§2.2): validate, resolve actor scope, call one application service.
// Routes per 18-api-plan.md §2.4: /stock, /stock/movements, /stock-lots.
import { Controller, Get, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { StockQueryService } from "../application/stock-query.service.js";
import { TenantContextService } from "../infrastructure/tenant-context.service.js";
import { LotListQueryDto, MovementListQueryDto, StockListQueryDto } from "./dto/stock.dto.js";

@Controller()
export class StockController {
  constructor(
    private readonly stockQueries: StockQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** GET /stock -- per-item on-hand balances. */
  @RequirePermission("inventory.stock", "list")
  @Get("stock")
  async listStock(@Query() query: StockListQueryDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockQueries.listStock(scope, query);
  }

  /** GET /stock/movements -- the append-only inventory ledger, newest first. */
  @RequirePermission("inventory.stock", "list")
  @Get("stock/movements")
  async listMovements(@Query() query: MovementListQueryDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockQueries.listMovements(scope, query);
  }

  /** GET /stock-lots -- lot browser with current on-hand. */
  @RequirePermission("inventory.stock", "list")
  @Get("stock-lots")
  async listLots(@Query() query: LotListQueryDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockQueries.listLots(scope, query);
  }
}
