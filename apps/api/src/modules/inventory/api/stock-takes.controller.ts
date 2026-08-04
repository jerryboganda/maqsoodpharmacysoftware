// Stock-take endpoints. Permission actions (task instruction): list/view/create/count/
// generate_adjustments/close under resource `inventory.stock_take`. Two endpoints share `create`
// (POST /stock-takes and POST /stock-takes/:id/count-sheet) and two share `view` (GET
// /stock-takes/:id/variance and GET /stock-takes/:id) -- see stock-take.service.ts's header
// comment for why count-sheet generation is `create`-gated: it is still "standing the take up",
// before any actual counting happens. Idempotency-Key required on every write that isn't a plain
// read, matching 18-api-plan.md §2.6's "Required" column for this module's rows.
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { StockTakeService } from "../application/stock-take.service.js";
import { TenantContextService } from "../infrastructure/tenant-context.service.js";
import {
  CloseStockTakeDto,
  CreateStockTakeDto,
  GenerateAdjustmentsDto,
  RecordCountsDto,
  StockTakeIdParamDto,
  StockTakeListQueryDto,
  VarianceQueryDto,
} from "./dto/stock-take.dto.js";

@Controller("stock-takes")
export class StockTakesController {
  constructor(
    private readonly stockTakes: StockTakeService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** POST /stock-takes -- create a draft count session (header only, no lines yet). */
  @RequirePermission("inventory.stock_take", "create")
  @RequireIdempotencyKey()
  @Post()
  async create(@Body() body: CreateStockTakeDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.create(scope, actor, body);
  }

  /** POST /stock-takes/:id/count-sheet -- snapshot stock_balance into frozen count-sheet lines. */
  @RequirePermission("inventory.stock_take", "create")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/count-sheet")
  async generateCountSheet(@Param() params: StockTakeIdParamDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.generateCountSheet(scope, actor, params.id);
  }

  /** PUT /stock-takes/:id/lines -- bulk-record counted quantities. */
  @RequirePermission("inventory.stock_take", "count")
  @RequireIdempotencyKey()
  @Put(":id/lines")
  async recordCounts(@Param() params: StockTakeIdParamDto, @Body() body: RecordCountsDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.recordCounts(scope, actor, params.id, body.lines);
  }

  /** GET /stock-takes/:id/variance -- per-line variance + totals, before committing to adjustments. */
  @RequirePermission("inventory.stock_take", "view")
  @Get(":id/variance")
  async variance(@Param() params: StockTakeIdParamDto, @Query() query: VarianceQueryDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.variance(scope, params.id, { minVarianceQty: query.minVarianceQty });
  }

  /** POST /stock-takes/:id/generate-adjustments -- turn non-zero variance into real, posted
   *  stock_adjustment document(s) via StockAdjustmentService. */
  @RequirePermission("inventory.stock_take", "generate_adjustments")
  @RequireIdempotencyKey()
  @HttpCode(201)
  @Post(":id/generate-adjustments")
  async generateAdjustments(
    @Param() params: StockTakeIdParamDto,
    @Body() body: GenerateAdjustmentsDto,
    @CurrentActor() actor: Actor,
  ) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.generateAdjustments(scope, actor, params.id, body);
  }

  /** POST /stock-takes/:id/close -- terminal transition. */
  @RequirePermission("inventory.stock_take", "close")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/close")
  async close(@Param() params: StockTakeIdParamDto, @Body() body: CloseStockTakeDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.close(scope, actor, params.id, body.reason);
  }

  /** GET /stock-takes */
  @RequirePermission("inventory.stock_take", "list")
  @Get()
  async list(@Query() query: StockTakeListQueryDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.list(scope, query);
  }

  /** GET /stock-takes/:id -- header with lines. */
  @RequirePermission("inventory.stock_take", "view")
  @Get(":id")
  async getById(@Param() params: StockTakeIdParamDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.stockTakes.getById(scope, params.id);
  }
}
