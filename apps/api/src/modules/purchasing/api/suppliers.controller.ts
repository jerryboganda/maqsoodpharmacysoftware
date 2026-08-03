// Thin controller (§2.2): validates the DTO, resolves the actor, calls exactly one
// application service. No business logic, no SQL, no money maths.
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { SupplierService } from "../application/supplier.service.js";
import { CreateSupplierDto, ListSuppliersQueryDto, SupplierIdParamDto } from "./dto/supplier.dto.js";

@Controller("suppliers")
export class SuppliersController {
  constructor(private readonly supplierService: SupplierService) {}

  @RequirePermission("purchase.supplier", "list")
  @Get()
  async list(@Query() query: ListSuppliersQueryDto, @CurrentActor() actor: Actor) {
    return this.supplierService.list(query, actor);
  }

  @RequirePermission("purchase.supplier", "view")
  @Get(":id")
  async getById(@Param() params: SupplierIdParamDto, @CurrentActor() actor: Actor) {
    return this.supplierService.getById(params.id, actor);
  }

  /** Creates the supplier's GL control account + the supplier row in one transaction. */
  @RequirePermission("purchase.supplier", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateSupplierDto, @CurrentActor() actor: Actor) {
    return this.supplierService.create(body, actor);
  }
}
