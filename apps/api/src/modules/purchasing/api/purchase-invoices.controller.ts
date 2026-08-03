// Thin controller (§2.2). POST creates AND posts in one transaction (P-1: the purchase
// invoice IS the goods receipt) -- protected by @RequireIdempotencyKey (§7.5).
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { PurchaseInvoiceService } from "../application/purchase-invoice.service.js";
import {
  CreatePurchaseInvoiceDto,
  ListPurchaseInvoicesQueryDto,
  PurchaseInvoiceIdParamDto,
} from "./dto/purchase-invoice.dto.js";

@Controller("purchase-invoices")
export class PurchaseInvoicesController {
  constructor(private readonly purchaseInvoiceService: PurchaseInvoiceService) {}

  @RequirePermission("purchase", "list")
  @Get()
  async list(@Query() query: ListPurchaseInvoicesQueryDto, @CurrentActor() actor: Actor) {
    return this.purchaseInvoiceService.list(query, actor);
  }

  @RequirePermission("purchase", "view")
  @Get(":id")
  async getById(@Param() params: PurchaseInvoiceIdParamDto, @CurrentActor() actor: Actor) {
    return this.purchaseInvoiceService.getById(params.id, actor);
  }

  /** Create + post: receives stock, moves the average, writes the GL -- one transaction. */
  @RequirePermission("purchase", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async createAndPost(@Body() body: CreatePurchaseInvoiceDto, @CurrentActor() actor: Actor) {
    return this.purchaseInvoiceService.createAndPost(body, actor);
  }
}
