// Purchase order endpoints (§T82/§T83). A purchase order is a commitment/intent document -- it
// never touches stock or posts to the GL (see purchase-order.service.ts's header comment), but
// every mutating action still carries @RequireIdempotencyKey (§7.5), same as every other
// financial-document endpoint in this module.
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { PurchaseOrderService } from "../application/purchase-order.service.js";
import {
  ApprovePurchaseOrderDto,
  CancelPurchaseOrderDto,
  ClosePurchaseOrderDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  PurchaseOrderIdParamDto,
} from "./dto/purchase-order.dto.js";

@Controller("purchase-orders")
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrderService) {}

  @RequirePermission("purchase.order", "list")
  @Get()
  async list(@Query() query: ListPurchaseOrdersQueryDto, @CurrentActor() actor: Actor) {
    return this.purchaseOrders.list(query, actor);
  }

  @RequirePermission("purchase.order", "view")
  @Get(":id")
  async getById(@Param() params: PurchaseOrderIdParamDto, @CurrentActor() actor: Actor) {
    return this.purchaseOrders.getById(params.id, actor);
  }

  /** Create a DRAFT purchase order (header + lines). No stock/GL effect -- POs never post. */
  @RequirePermission("purchase.order", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreatePurchaseOrderDto, @CurrentActor() actor: Actor) {
    return this.purchaseOrders.create(body, actor);
  }

  /** draft -> confirmed. "MGR (never the creator)" -- enforced in the service, same rule
   *  stock-adjustment's approve() uses. */
  @RequirePermission("purchase.order", "approve")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/approve")
  async approve(@Param() params: PurchaseOrderIdParamDto, @Body() body: ApprovePurchaseOrderDto, @CurrentActor() actor: Actor) {
    return this.purchaseOrders.approve(params.id, actor, body.reason);
  }

  /** confirmed -> orderStatus 'closed' (terminal). */
  @RequirePermission("purchase.order", "close")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/close")
  async close(@Param() params: PurchaseOrderIdParamDto, @Body() body: ClosePurchaseOrderDto, @CurrentActor() actor: Actor) {
    return this.purchaseOrders.close(params.id, actor, body.reason);
  }

  /** draft|confirmed -> status 'cancelled' (terminal). */
  @RequirePermission("purchase.order", "cancel")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/cancel")
  async cancel(@Param() params: PurchaseOrderIdParamDto, @Body() body: CancelPurchaseOrderDto, @CurrentActor() actor: Actor) {
    return this.purchaseOrders.cancel(params.id, actor, body.cancelReasonId, body.reason);
  }
}
