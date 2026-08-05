// Thin controller (§2.2). Route/action names mirror the seeded cashier_shift permission grid
// exactly (seed.ts: list/view/create/edit/post/approve).
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { CashierShiftService } from "../application/cashier-shift.service.js";
import {
  ApproveCashierShiftDto,
  CashierShiftIdParamDto,
  CloseCashierShiftDto,
  CountCashierShiftDto,
  ListCashierShiftsQueryDto,
  OpenCashierShiftDto,
} from "./dto/cashier-shift.dto.js";

@Controller("cashier-shifts")
export class CashierShiftsController {
  constructor(private readonly cashierShiftService: CashierShiftService) {}

  @RequirePermission("cashier_shift", "list")
  @Get()
  async list(@Query() query: ListCashierShiftsQueryDto, @CurrentActor() actor: Actor) {
    return this.cashierShiftService.list(query, actor);
  }

  @RequirePermission("cashier_shift", "view")
  @Get(":id")
  async getById(@Param() params: CashierShiftIdParamDto, @CurrentActor() actor: Actor) {
    return this.cashierShiftService.getById(params.id, actor);
  }

  @RequirePermission("cashier_shift", "view")
  @Get(":id/z-report")
  async zReport(@Param() params: CashierShiftIdParamDto, @CurrentActor() actor: Actor) {
    return this.cashierShiftService.zReport(params.id, actor);
  }

  @RequirePermission("cashier_shift", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async open(@Body() body: OpenCashierShiftDto, @CurrentActor() actor: Actor) {
    return this.cashierShiftService.open(body, actor);
  }

  @RequirePermission("cashier_shift", "edit")
  @RequireIdempotencyKey()
  @Post(":id/count")
  @HttpCode(200)
  async count(@Param() params: CashierShiftIdParamDto, @Body() body: CountCashierShiftDto, @CurrentActor() actor: Actor) {
    return this.cashierShiftService.count(params.id, body, actor);
  }

  @RequirePermission("cashier_shift", "post")
  @RequireIdempotencyKey()
  @Post(":id/close")
  @HttpCode(200)
  async close(@Param() params: CashierShiftIdParamDto, @Body() body: CloseCashierShiftDto, @CurrentActor() actor: Actor) {
    return this.cashierShiftService.close(params.id, body, actor);
  }

  @RequirePermission("cashier_shift", "approve")
  @RequireIdempotencyKey()
  @Post(":id/approve")
  @HttpCode(200)
  async approve(@Param() params: CashierShiftIdParamDto, @Body() body: ApproveCashierShiftDto, @CurrentActor() actor: Actor) {
    return this.cashierShiftService.approve(params.id, body, actor);
  }
}
