// Thin controller (§2.2), mirroring suppliers.controller.ts's shape. `GET /:id` is not in the
// task's literal endpoint list but is added for the same reason every other master-data
// controller in this codebase has one (PATCH needs a way to fetch current state; trivial,
// low-risk addition, flagged here rather than silently included).
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { PaymentMethodService } from "../application/payment-method.service.js";
import { CreatePaymentMethodDto, ListPaymentMethodsQueryDto, PaymentMethodIdParamDto, UpdatePaymentMethodDto } from "./dto/payment-method.dto.js";

@Controller("payment-methods")
export class PaymentMethodsController {
  constructor(private readonly paymentMethodService: PaymentMethodService) {}

  @RequirePermission("payment_method", "list")
  @Get()
  async list(@Query() query: ListPaymentMethodsQueryDto, @CurrentActor() actor: Actor) {
    return this.paymentMethodService.list(query, actor);
  }

  @RequirePermission("payment_method", "view")
  @Get(":id")
  async getById(@Param() params: PaymentMethodIdParamDto, @CurrentActor() actor: Actor) {
    return this.paymentMethodService.getById(params.id, actor);
  }

  @RequirePermission("payment_method", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreatePaymentMethodDto, @CurrentActor() actor: Actor) {
    return this.paymentMethodService.create(body, actor);
  }

  @RequirePermission("payment_method", "edit")
  @Patch(":id")
  async update(@Param() params: PaymentMethodIdParamDto, @Body() body: UpdatePaymentMethodDto, @CurrentActor() actor: Actor) {
    return this.paymentMethodService.update(params.id, body, actor);
  }
}
