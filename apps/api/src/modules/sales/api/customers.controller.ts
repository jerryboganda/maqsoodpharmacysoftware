// Blueprint: 17-technical-blueprint.md §2.2 -- thin controller: validate params, resolve the
// actor, call exactly one application service.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { CustomersService, type CustomerRow } from "../application/customers.service.js";
import {
  CreateCustomerDto,
  CustomerIdParamDto,
  CustomerLedgerQueryDto,
  DeactivateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from "./dto/customer.dto.js";

@Controller("customers")
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermission("sale.customer", "list")
  @Get()
  async list(
    @Query() query: ListCustomersQueryDto,
    @CurrentActor() actor: Actor,
  ): Promise<{ customers: CustomerRow[]; limit: number; offset: number }> {
    return this.customers.list(query, actor);
  }

  @RequirePermission("sale.customer", "view")
  @Get(":id")
  async getById(@Param() params: CustomerIdParamDto, @CurrentActor() actor: Actor): Promise<CustomerRow> {
    return this.customers.getById(params.id, actor);
  }

  /** Creates the customer AND its GL control leaf (Module D: a party IS a ledger account). */
  @RequirePermission("sale.customer", "create")
  @RequireIdempotencyKey()
  @Post()
  async create(@Body() body: CreateCustomerDto, @CurrentActor() actor: Actor): Promise<CustomerRow> {
    return this.customers.create(body, actor);
  }

  /** Edits the customer's own editable fields. Never touches glAccountId (fixed at create) or
   *  isActive (its own endpoint, below) -- see UpdateCustomerDto's doc comment. */
  @RequirePermission("sale.customer", "edit")
  @Patch(":id")
  async update(
    @Param() params: CustomerIdParamDto,
    @Body() body: UpdateCustomerDto,
    @CurrentActor() actor: Actor,
  ): Promise<CustomerRow> {
    return this.customers.update(params.id, body, actor);
  }

  /** Retires the customer without deleting it (no hard-delete of a party). */
  @RequirePermission("sale.customer", "deactivate")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/deactivate")
  async deactivate(
    @Param() params: CustomerIdParamDto,
    @Body() body: DeactivateCustomerDto,
    @CurrentActor() actor: Actor,
  ): Promise<CustomerRow> {
    return this.customers.deactivate(params.id, body, actor);
  }

  /** The customer's AR sub-ledger -- journal lines posted against its own GL control account,
   *  oldest first, with a running balance (see CustomersService.getLedger's doc comment for the
   *  documented running-balance simplification). */
  @RequirePermission("sale.customer", "view_ledger")
  @Get(":id/ledger")
  async getLedger(@Param() params: CustomerIdParamDto, @Query() query: CustomerLedgerQueryDto, @CurrentActor() actor: Actor) {
    return this.customers.getLedger(params.id, query, actor);
  }
}
