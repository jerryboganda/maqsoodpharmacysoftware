// Stock adjustment endpoints (18-api-plan.md §2.6). Financial mutations carry
// @RequireIdempotencyKey (§7.5) -- create and post are both replay-protected.
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { StockAdjustmentService } from "../application/stock-adjustment.service.js";
import { TenantContextService } from "../infrastructure/tenant-context.service.js";
import {
  AdjustmentIdParamDto,
  AdjustmentListQueryDto,
  ApproveAdjustmentDto,
  CreateAdjustmentDto,
  PostAdjustmentDto,
} from "./dto/stock-adjustment.dto.js";

@Controller("stock-adjustments")
export class StockAdjustmentsController {
  constructor(
    private readonly adjustments: StockAdjustmentService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** POST /stock-adjustments -- create a DRAFT (no stock/GL effect). */
  @RequirePermission("inventory.adjustment", "create")
  @RequireIdempotencyKey()
  @Post()
  async create(@Body() body: CreateAdjustmentDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.adjustments.create(scope, actor, body);
  }

  /** POST /stock-adjustments/:id/post -- post the draft: stock movements + costing + journal. */
  @RequirePermission("inventory.adjustment", "post")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/post")
  async post(@Param() params: AdjustmentIdParamDto, @Body() body: PostAdjustmentDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.adjustments.post(scope, actor, params.id, body.postingDate);
  }

  /** POST /stock-adjustments/:id/approve -- required before /post when the reason gates on
   *  requiresApproval (18-api-plan.md §2.6). "MGR (never the creator)" -- enforced in the service. */
  @RequirePermission("inventory.adjustment", "approve")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/approve")
  async approve(@Param() params: AdjustmentIdParamDto, @Body() body: ApproveAdjustmentDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.adjustments.approve(scope, actor, params.id, body.reason);
  }

  /** GET /stock-adjustments */
  @RequirePermission("inventory.adjustment", "list")
  @Get()
  async list(@Query() query: AdjustmentListQueryDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.adjustments.list(scope, query);
  }

  /** GET /stock-adjustments/:id -- header with lines. */
  @RequirePermission("inventory.adjustment", "view")
  @Get(":id")
  async getById(@Param() params: AdjustmentIdParamDto, @CurrentActor() actor: Actor) {
    const scope = await this.tenantContext.resolveScope(actor);
    return this.adjustments.getById(scope, params.id);
  }
}
