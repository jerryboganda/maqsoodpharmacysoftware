// Thin controller (§2.2), mirroring supplier's own list/getById/create shape
// (purchasing/api/suppliers.controller.ts). "list"/"view"/"create" mirror the seeded cash_bank
// permission grid exactly (seed.ts: "create" = "Open a cash/bank account or record a transfer").
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { CashBankService } from "../application/cash-bank.service.js";
import { CashBankAccountIdParamDto, CreateCashBankAccountDto, ListCashBankAccountsQueryDto } from "./dto/cash-bank.dto.js";

@Controller("cash-bank-accounts")
export class CashBankAccountsController {
  constructor(private readonly cashBankService: CashBankService) {}

  @RequirePermission("cash_bank", "list")
  @Get()
  async list(@Query() query: ListCashBankAccountsQueryDto, @CurrentActor() actor: Actor) {
    return this.cashBankService.list(query, actor);
  }

  @RequirePermission("cash_bank", "view")
  @Get(":id")
  async getById(@Param() params: CashBankAccountIdParamDto, @CurrentActor() actor: Actor) {
    return this.cashBankService.getById(params.id, actor);
  }

  @RequirePermission("cash_bank", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateCashBankAccountDto, @CurrentActor() actor: Actor) {
    return this.cashBankService.create(body, actor);
  }
}
