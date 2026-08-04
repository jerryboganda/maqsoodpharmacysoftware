// Thin controller (§2.2), mirroring purchase-returns.controller.ts exactly. POST creates AND
// posts in one transaction (a sale return is the reverse-direction sibling of a cash sale --
// same seriousness, same shape) -- protected by @RequireIdempotencyKey (§7.5; this exact route
// is named in require-idempotency-key.decorator.ts's own doc comment).
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { SaleReturnsService } from "../application/sale-returns.service.js";
import { CreateSaleReturnDto, ListSaleReturnsQueryDto, SaleReturnIdParamDto } from "./dto/sale-return.dto.js";

@Controller("sale-returns")
export class SaleReturnsController {
  constructor(private readonly saleReturns: SaleReturnsService) {}

  @RequirePermission("sale.return", "list")
  @Get()
  async list(@Query() query: ListSaleReturnsQueryDto, @CurrentActor() actor: Actor) {
    return this.saleReturns.list(query, actor);
  }

  @RequirePermission("sale.return", "view")
  @Get(":id")
  async getById(@Param() params: SaleReturnIdParamDto, @CurrentActor() actor: Actor) {
    return this.saleReturns.getById(params.id, actor);
  }

  /** Create + post: inbound stock movement, reverses the Sales/Inventory-COGS/settlement legs --
   *  one transaction. */
  @RequirePermission("sale.return", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async createAndPost(@Body() body: CreateSaleReturnDto, @CurrentActor() actor: Actor) {
    return this.saleReturns.createAndPost(body, actor);
  }
}
