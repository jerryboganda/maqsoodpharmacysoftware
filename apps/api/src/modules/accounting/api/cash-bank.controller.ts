// Thin controller (§2.2). GET /cash-bank/book is a thin read wrapper over the same
// running-balance logic GET /gl/accounts/{id}/ledger uses (LedgerQueryService); POST
// /cash-bank/transfers creates + posts a transfer in one transaction, protected by
// @RequireIdempotencyKey (§7.5). "view"/"create" mirror the seeded cash_bank permission grid
// exactly (seed.ts: "view" = "View a cash/bank account's book"; "create" = "Open a cash/bank
// account or record a transfer").
import { Body, Controller, Get, HttpCode, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { CashBankService } from "../application/cash-bank.service.js";
import { CashBankBookQueryDto, CreateCashBankTransferDto } from "./dto/cash-bank.dto.js";

@Controller("cash-bank")
export class CashBankController {
  constructor(private readonly cashBankService: CashBankService) {}

  @RequirePermission("cash_bank", "view")
  @Get("book")
  async book(@Query() query: CashBankBookQueryDto, @CurrentActor() actor: Actor) {
    return this.cashBankService.book(query, actor);
  }

  @RequirePermission("cash_bank", "create")
  @RequireIdempotencyKey()
  @Post("transfers")
  @HttpCode(201)
  async transfer(@Body() body: CreateCashBankTransferDto, @CurrentActor() actor: Actor) {
    return this.cashBankService.transfer(body, actor);
  }
}
