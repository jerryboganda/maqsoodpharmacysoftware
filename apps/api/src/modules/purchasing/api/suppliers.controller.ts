// Thin controller (§2.2): validates the DTO, resolves the actor, calls exactly one
// application service. No business logic, no SQL, no money maths.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { SupplierService } from "../application/supplier.service.js";
import {
  CreateSupplierDto,
  DeactivateSupplierDto,
  ListSuppliersQueryDto,
  SupplierIdParamDto,
  SupplierLedgerQueryDto,
  UpdateSupplierDto,
} from "./dto/supplier.dto.js";

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

  /** Edits the supplier's own editable fields. Never touches glAccountId (fixed at create) or
   *  isActive (its own endpoint, below) -- see UpdateSupplierDto's doc comment. */
  @RequirePermission("purchase.supplier", "edit")
  @Patch(":id")
  async update(@Param() params: SupplierIdParamDto, @Body() body: UpdateSupplierDto, @CurrentActor() actor: Actor) {
    return this.supplierService.update(params.id, body, actor);
  }

  /** Retires the supplier without deleting it (no hard-delete of a party). */
  @RequirePermission("purchase.supplier", "deactivate")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/deactivate")
  async deactivate(@Param() params: SupplierIdParamDto, @Body() body: DeactivateSupplierDto, @CurrentActor() actor: Actor) {
    return this.supplierService.deactivate(params.id, body, actor);
  }

  /** The supplier's AP sub-ledger -- journal lines posted against its own GL control account,
   *  oldest first, with a running balance (see SupplierService.getLedger's doc comment for the
   *  documented running-balance simplification). */
  @RequirePermission("purchase.supplier", "view_ledger")
  @Get(":id/ledger")
  async getLedger(@Param() params: SupplierIdParamDto, @Query() query: SupplierLedgerQueryDto, @CurrentActor() actor: Actor) {
    return this.supplierService.getLedger(params.id, query, actor);
  }
}
