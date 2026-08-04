// Blueprint: docs/system-analysis/05a-workflows-sales.md (cash sale S-1);
// 17-technical-blueprint.md §2.2 (thin controller), §7.5 (Idempotency-Key on every financial
// POST -- see common/idempotency).
//
// Wave 7 lifecycle actions -- see application/sale-invoices.service.ts's own header comment for
// why there is no `POST /sale-invoices/:id/post` (creation is already atomic create-and-post) and
// for the cancel-vs-reverse guard/mechanics. Route shapes below:
//   POST /sale-invoices/preview        -- dry run, sale.cash:view (reading, not writing)
//   POST /sale-invoices/:id/cancel     -- sale.cash:cancel, guarded by active sale_return rows
//   POST /sale-invoices/:id/reverse    -- sale.cash:reverse, unconditional
//   GET  /sale-invoices/:id/print      -- sale.cash:print, read-only JSON receipt
//   POST /sale-invoices/:id/reprint    -- same payload as print, but a POST so the global
//                                         AuditInterceptor (mutating methods only -- see its own
//                                         header comment) actually records the reprint. GET routes
//                                         get no audit coverage in this codebase today, and this
//                                         is a real "worth a trail" action per the task's own
//                                         framing, hence POST instead of a second GET alias.
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import {
  SaleInvoicesService,
  type CreateSaleInvoiceResult,
  type SaleInvoiceLineRow,
  type SaleInvoicePaymentRow,
  type SaleInvoicePreviewResult,
  type SaleInvoicePrintResult,
  type SaleInvoiceRow,
} from "../application/sale-invoices.service.js";
import {
  CancelSaleInvoiceDto,
  CreateSaleInvoiceDto,
  ListSaleInvoicesQueryDto,
  ReverseSaleInvoiceDto,
  SaleInvoiceIdParamDto,
} from "./dto/sale-invoice.dto.js";

@Controller("sale-invoices")
export class SaleInvoicesController {
  constructor(private readonly saleInvoices: SaleInvoicesService) {}

  /** The atomic cash-sale transaction (S-1). Returns 201 with the posted document. */
  @RequirePermission("sale.cash", "create")
  @RequireIdempotencyKey()
  @Post()
  async create(@Body() body: CreateSaleInvoiceDto, @CurrentActor() actor: Actor): Promise<CreateSaleInvoiceResult> {
    return this.saleInvoices.createCashSale(body, actor);
  }

  /** DRY RUN of `create` -- same body shape, same validation/pricing/FEFO/payment checks, but
   *  never opens a write transaction: no doc number allocated, nothing inserted. `sale.cash:view`
   *  (reading, not writing) -- no `@RequireIdempotencyKey()`, this has no financial side effect
   *  to de-duplicate. */
  @RequirePermission("sale.cash", "view")
  @HttpCode(200)
  @Post("preview")
  async preview(@Body() body: CreateSaleInvoiceDto, @CurrentActor() actor: Actor): Promise<SaleInvoicePreviewResult> {
    return this.saleInvoices.preview(body, actor);
  }

  @RequirePermission("sale.cash", "list")
  @Get()
  async list(
    @Query() query: ListSaleInvoicesQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ saleInvoices: SaleInvoiceRow[]; limit: number; offset: number }> {
    return this.saleInvoices.list(query, actor);
  }

  @RequirePermission("sale.cash", "view")
  @Get(":id")
  async getById(
    @Param() params: SaleInvoiceIdParamDto,
    @CurrentActor() actor: Actor,
  ): Promise<{
    saleInvoice: SaleInvoiceRow;
    lines: SaleInvoiceLineRow[];
    payments: SaleInvoicePaymentRow[];
  }> {
    return this.saleInvoices.getById(params.id, actor);
  }

  /** Void a posted invoice -- 422 `SALES.HAS_ACTIVE_RETURNS` if a `sale_return` already
   *  references it (use `reverse` instead). See SaleInvoicesService.cancel's own comment for the
   *  full guard/mechanics. */
  @RequirePermission("sale.cash", "cancel")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/cancel")
  async cancel(
    @Param() params: SaleInvoiceIdParamDto,
    @Body() body: CancelSaleInvoiceDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ saleInvoice: SaleInvoiceRow; lines: SaleInvoiceLineRow[]; payments: SaleInvoicePaymentRow[] }> {
    return this.saleInvoices.cancel(params.id, body, actor);
  }

  /** An unconditional compensating entry for a posted invoice -- reachable even when a
   *  sale_return already references it (unlike cancel). See SaleInvoicesService.reverse's own
   *  comment. */
  @RequirePermission("sale.cash", "reverse")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/reverse")
  async reverse(
    @Param() params: SaleInvoiceIdParamDto,
    @Body() body: ReverseSaleInvoiceDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ saleInvoice: SaleInvoiceRow; lines: SaleInvoiceLineRow[]; payments: SaleInvoicePaymentRow[] }> {
    return this.saleInvoices.reverse(params.id, body, actor);
  }

  /** A structured JSON receipt payload (`printFormat: "standard_receipt"`) -- not a PDF/ESC-POS
   *  render this wave (see SaleInvoicesService.print's own comment). Read-only. */
  @RequirePermission("sale.cash", "print")
  @Get(":id/print")
  async print(@Param() params: SaleInvoiceIdParamDto, @CurrentActor() actor: Actor): Promise<SaleInvoicePrintResult> {
    return this.saleInvoices.print(params.id, actor);
  }

  /** Same rendering as `print`, exposed as a POST so the global AuditInterceptor (mutating
   *  methods only) leaves a trail of the reprint -- see this file's header comment. */
  @RequirePermission("sale.cash", "print")
  @HttpCode(200)
  @Post(":id/reprint")
  async reprint(@Param() params: SaleInvoiceIdParamDto, @CurrentActor() actor: Actor): Promise<SaleInvoicePrintResult> {
    return this.saleInvoices.print(params.id, actor);
  }
}
