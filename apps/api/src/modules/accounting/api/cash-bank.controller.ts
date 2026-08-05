// Thin controller (§2.2). GET /cash-bank/book is a thin read wrapper over the same
// running-balance logic GET /gl/accounts/{id}/ledger uses (LedgerQueryService); POST
// /cash-bank/transfers creates + posts a transfer in one transaction, protected by
// @RequireIdempotencyKey (§7.5). "view"/"create" mirror the seeded cash_bank permission grid
// exactly (seed.ts: "view" = "View a cash/bank account's book"; "create" = "Open a cash/bank
// account or record a transfer").
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { CashBankReconciliationService } from "../application/cash-bank-reconciliation.service.js";
import { CashBankService } from "../application/cash-bank.service.js";
import {
  CashBankBookQueryDto,
  CompleteReconciliationDto,
  CreateCashBankTransferDto,
  ReconciliationIdParamDto,
  StartReconciliationDto,
} from "./dto/cash-bank.dto.js";

@Controller("cash-bank")
export class CashBankController {
  constructor(
    private readonly cashBankService: CashBankService,
    private readonly reconciliationService: CashBankReconciliationService,
  ) {}

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

  /** `POST /cash-bank/reconciliations` -- start a bank reconciliation. Reuses the already-seeded
   *  `cash_bank:create` grant ("Open a cash/bank account or record a transfer", accountant-only) --
   *  no new permission row needed. 422 `RECON.NOT_A_BANK_ACCOUNT` if the account isn't a
   *  `bank`-kind account. */
  @RequirePermission("cash_bank", "create")
  @RequireIdempotencyKey()
  @Post("reconciliations")
  @HttpCode(201)
  async startReconciliation(@Body() body: StartReconciliationDto, @CurrentActor() actor: Actor) {
    return this.reconciliationService.start(body, actor);
  }

  /** `POST /cash-bank/reconciliations/:id/complete` -- reuses the already-seeded `cash_bank:post`
   *  grant, whose own name ("Post a transfer or complete a reconciliation", accountant-only) was
   *  seeded anticipating exactly this endpoint -- activated, not reinvented, same R2.4 "dormant
   *  tables already model the concept" spirit this module's own header comment already cites for
   *  cash_bank_account/journal_line themselves. 422 `RECON.UNEXPLAINED_DIFFERENCE` unless the
   *  matched lines' net effect exactly equals the statement closing balance (see
   *  cash-bank-reconciliation.service.ts's own header comment on why `adjustments` never
   *  auto-resolves a non-zero difference in this wave). */
  @RequirePermission("cash_bank", "post")
  @RequireIdempotencyKey()
  @Post("reconciliations/:id/complete")
  async completeReconciliation(@Param() params: ReconciliationIdParamDto, @Body() body: CompleteReconciliationDto, @CurrentActor() actor: Actor) {
    return this.reconciliationService.complete(params.id, body, actor);
  }
}
