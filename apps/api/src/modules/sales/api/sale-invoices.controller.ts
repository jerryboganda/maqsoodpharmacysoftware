// Blueprint: docs/system-analysis/05a-workflows-sales.md (cash sale S-1);
// 17-technical-blueprint.md §2.2 (thin controller), §7.5 (Idempotency-Key on every financial
// POST -- see common/idempotency).
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import {
  SaleInvoicesService,
  type CreateSaleInvoiceResult,
  type SaleInvoiceLineRow,
  type SaleInvoicePaymentRow,
  type SaleInvoiceRow,
} from "../application/sale-invoices.service.js";
import { CreateSaleInvoiceDto, ListSaleInvoicesQueryDto, SaleInvoiceIdParamDto } from "./dto/sale-invoice.dto.js";

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
}
