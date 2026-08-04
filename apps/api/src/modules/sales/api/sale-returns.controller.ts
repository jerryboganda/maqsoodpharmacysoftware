// Thin controller (§2.2), mirroring purchase-returns.controller.ts exactly. POST creates AND
// posts in one transaction (a sale return is the reverse-direction sibling of a cash sale --
// same seriousness, same shape) -- protected by @RequireIdempotencyKey (§7.5; this exact route
// is named in require-idempotency-key.decorator.ts's own doc comment).
//
// Lifecycle actions added alongside sale-invoices.controller.ts's own Wave 7 cancel/reverse --
// see application/sale-returns.service.ts's own header/method comments for the cancel-vs-reverse
// guard reasoning (materially different from sale-invoices' own, because a return's stock
// direction is the mirror image -- see that file for the full argument). Route shapes below:
//   POST /sale-returns/lookup-invoice -- read-only search, sale.return:create (a sub-step of
//                                        creating a return -- mirrors payments.ts's own
//                                        getAllocationCandidates being gated on payment:create,
//                                        not payment:list, see that controller's comment); NOT
//                                        @RequireIdempotencyKey -- mutates nothing (18-api-plan.md
//                                        marks this route "n/a (read-only POST)").
//   POST /sale-returns/:id/cancel     -- sale.return:cancel, guarded by whether the stock lot(s)
//                                        this return added to are still untouched since it posted
//   POST /sale-returns/:id/reverse    -- sale.return:reverse, unconditional w.r.t. that guard
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { SaleReturnsService } from "../application/sale-returns.service.js";
import {
  CancelSaleReturnDto,
  CreateSaleReturnDto,
  ListSaleReturnsQueryDto,
  LookupInvoiceDto,
  ReverseSaleReturnDto,
  SaleReturnIdParamDto,
} from "./dto/sale-return.dto.js";

@Controller("sale-returns")
export class SaleReturnsController {
  constructor(private readonly saleReturns: SaleReturnsService) {}

  /** Create + post: inbound stock movement, reverses the Sales/Inventory-COGS/settlement legs --
   *  one transaction. */
  @RequirePermission("sale.return", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async createAndPost(@Body() body: CreateSaleReturnDto, @CurrentActor() actor: Actor) {
    return this.saleReturns.createAndPost(body, actor);
  }

  /** Find the original posted sale invoice to build a return form against (header + lines, each
   *  with `qtyAlreadyReturned`/`qtyReturnable`) -- read-only, mutates nothing. Gated on
   *  `sale.return:create`, not `:list` -- see this file's header comment. No route-order hazard
   *  with `GET /sale-returns/:id` below: this is `POST` at a different path depth
   *  (`/sale-returns/lookup-invoice`, not `/sale-returns/:id`), so Nest/Fastify's declaration-
   *  order sensitivity (payments.controller.ts's own comment on its "allocation-candidates" route)
   *  does not apply here. */
  @RequirePermission("sale.return", "create")
  @Post("lookup-invoice")
  async lookupInvoice(@Body() body: LookupInvoiceDto, @CurrentActor() actor: Actor) {
    return this.saleReturns.lookupInvoice(body, actor);
  }

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

  /** Void a posted return -- 422 `SALE_RETURN.STOCK_ALREADY_MOVED` if the specific stock lot(s)
   *  this return added to no longer hold at least what it added (use `reverse` instead). See
   *  SaleReturnsService.cancel's own comment for the full guard/mechanics. */
  @RequirePermission("sale.return", "cancel")
  @RequireIdempotencyKey()
  @Post(":id/cancel")
  async cancel(@Param() params: SaleReturnIdParamDto, @Body() body: CancelSaleReturnDto, @CurrentActor() actor: Actor) {
    return this.saleReturns.cancel(params.id, body, actor);
  }

  /** An unconditional (w.r.t. `cancel`'s own guard) compensating entry for a posted return --
   *  reachable even when `cancel` would refuse. See SaleReturnsService.reverse's own comment. */
  @RequirePermission("sale.return", "reverse")
  @RequireIdempotencyKey()
  @Post(":id/reverse")
  async reverse(@Param() params: SaleReturnIdParamDto, @Body() body: ReverseSaleReturnDto, @CurrentActor() actor: Actor) {
    return this.saleReturns.reverse(params.id, body, actor);
  }
}
