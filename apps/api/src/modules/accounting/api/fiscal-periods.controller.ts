// Thin controller (§2.2). Wave 9 (R-013, CRITICAL): the missing admin half of period control --
// see fiscal-period.dto.ts's header comment and FiscalPeriodService's own "Wave 9" comment for the
// full context. `close`/`reopen` carry `@RequireIdempotencyKey()`, matching every other real
// state-changing action in this codebase (gl.voucher cancel/reverse, sale.cash cancel/reverse).
import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { FiscalPeriodService } from "../../../common/docflow/fiscal-period.service.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";
import { CloseFiscalPeriodDto, FiscalPeriodIdParamDto, ReopenFiscalPeriodDto } from "./dto/fiscal-period.dto.js";

@Controller("fiscal-periods")
export class FiscalPeriodsController {
  constructor(
    private readonly fiscalPeriods: FiscalPeriodService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** `GET /fiscal-periods` -- every period for the actor's tenant, oldest first. Same read-role
   *  set `gl.account`/`gl.voucher` already use (owner/pharmacy_manager/accountant/auditor). */
  @RequirePermission("accounting.fiscal_period", "list")
  @Get()
  async list(@CurrentActor() actor: Actor) {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    return this.fiscalPeriods.listForTenant(tenantId);
  }

  /** `POST /fiscal-periods/:id/close`. 422 `PERIOD.ALREADY_CLOSED` if not currently `open`. */
  @RequirePermission("accounting.fiscal_period", "close")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/close")
  async close(@Param() params: FiscalPeriodIdParamDto, @Body() _body: CloseFiscalPeriodDto, @CurrentActor() actor: Actor) {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    return this.fiscalPeriods.close(tenantId, params.id, Number(actor.userId));
  }

  /** `POST /fiscal-periods/:id/reopen`. 422 `PERIOD.NOT_CLOSED` if not currently `closed`. */
  @RequirePermission("accounting.fiscal_period", "reopen")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/reopen")
  async reopen(@Param() params: FiscalPeriodIdParamDto, @Body() _body: ReopenFiscalPeriodDto, @CurrentActor() actor: Actor) {
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    return this.fiscalPeriods.reopen(tenantId, params.id, Number(actor.userId));
  }
}
