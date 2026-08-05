// Thin controllers (§2.2): validate, resolve actor scope, call one application service.
// Routes per 18-api-plan.md §2.4: /stock, /stock/movements, /stock-lots, plus the post-audit
// additions §2.5 documents: /stock-lots/{id}, /stock-lots/{id}/hold, /stock-lots/{id}/release.
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { StockLotService } from "../application/stock-lot.service.js";
import { StockQueryService } from "../application/stock-query.service.js";
import { TenantContextService } from "../infrastructure/tenant-context.service.js";
import {
  HoldStockLotDto,
  LotListQueryDto,
  MovementListQueryDto,
  ReleaseStockLotDto,
  StockListQueryDto,
  StockLotIdParamDto,
} from "./dto/stock.dto.js";

@Controller()
export class StockController {
  constructor(
    private readonly stockQueries: StockQueryService,
    private readonly stockLots: StockLotService,
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

  /** GET /stock-lots/:id -- full single-lot detail (fields + on-hand + recent movements). */
  @RequirePermission("inventory.stock_lot", "view")
  @Get("stock-lots/:id")
  async getLotById(@Param() params: StockLotIdParamDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockQueries.getLotById(scope, params.id);
  }

  /** GET /stock-lots/:id/recall-trace -- Wave 9, R4.5: given a batch, every sale that dispensed
   *  it. Distinct permission from plain `:view` (a recall trace surfaces customer/contact
   *  information across potentially many invoices -- a deliberately separate grant, same
   *  reasoning `view_ledger` is kept separate from plain `view` elsewhere in this codebase). */
  @RequirePermission("inventory.stock_lot", "recall_trace")
  @Get("stock-lots/:id/recall-trace")
  async getRecallTrace(@Param() params: StockLotIdParamDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockQueries.getRecallTrace(scope, params.id);
  }

  /** POST /stock-lots/:id/hold -- available -> quarantined; excluded from FEFO immediately. */
  @RequirePermission("inventory.stock_lot", "hold")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post("stock-lots/:id/hold")
  async holdLot(@Param() params: StockLotIdParamDto, @Body() body: HoldStockLotDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockLots.hold(scope, actor, params.id, body);
  }

  /** POST /stock-lots/:id/release -- quarantined -> available; 422 if the lot isn't held. */
  @RequirePermission("inventory.stock_lot", "release")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post("stock-lots/:id/release")
  async releaseLot(@Param() params: StockLotIdParamDto, @Body() body: ReleaseStockLotDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockLots.release(scope, actor, params.id, body);
  }
}
