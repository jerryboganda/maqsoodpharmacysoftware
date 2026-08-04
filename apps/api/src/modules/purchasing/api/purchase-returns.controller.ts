// Thin controller (§2.2), mirroring purchase-invoices.controller.ts exactly. POST creates AND
// posts in one transaction (a purchase return is the reverse-direction sibling of a purchase
// invoice -- same seriousness, same shape) -- protected by @RequireIdempotencyKey (§7.5).
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { PurchaseReturnService } from "../application/purchase-return.service.js";
import {
  CreatePurchaseReturnDto,
  ListPurchaseReturnsQueryDto,
  PurchaseReturnIdParamDto,
} from "./dto/purchase-return.dto.js";

@Controller("purchase-returns")
export class PurchaseReturnsController {
  constructor(private readonly purchaseReturnService: PurchaseReturnService) {}

  @RequirePermission("purchase.return", "list")
  @Get()
  async list(@Query() query: ListPurchaseReturnsQueryDto, @CurrentActor() actor: Actor) {
    return this.purchaseReturnService.list(query, actor);
  }

  @RequirePermission("purchase.return", "view")
  @Get(":id")
  async getById(@Param() params: PurchaseReturnIdParamDto, @CurrentActor() actor: Actor) {
    return this.purchaseReturnService.getById(params.id, actor);
  }

  /** Create + post: outbound stock movement, reverses the AP/Inventory legs -- one transaction. */
  @RequirePermission("purchase.return", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async createAndPost(@Body() body: CreatePurchaseReturnDto, @CurrentActor() actor: Actor) {
    return this.purchaseReturnService.createAndPost(body, actor);
  }
}
