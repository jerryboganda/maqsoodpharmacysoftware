// Blueprint: 17-technical-blueprint.md §2.2 -- thin controller: validate params, resolve the
// actor, call exactly one application service.
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { CustomersService, type CustomerRow } from "../application/customers.service.js";
import { CreateCustomerDto, CustomerIdParamDto, ListCustomersQueryDto } from "./dto/customer.dto.js";

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
}
