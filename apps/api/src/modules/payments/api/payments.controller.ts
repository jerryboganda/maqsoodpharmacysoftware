// Thin controller (§2.2), mirroring purchase-returns.controller.ts's shape. POST / creates AND
// posts in one transaction (mirrors purchase invoices/returns -- no separate draft/post flow).
//
// @RequireIdempotencyKey is applied exactly where the task specified (POST /, POST /:id/
// allocations) and deliberately NOT on /:id/allocations/:allocationId/reverse or /:id/cancel --
// both of those are already safe against an accidental double-submit by construction: each is
// guarded by a state check (PAYMENT.ALLOCATION_ALREADY_REVERSED / PAYMENT.ALREADY_CANCELLED) that
// 422s a retry instead of double-applying it, unlike a plain create which would insert a second
// row without idempotency-key dedup.
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { PaymentService } from "../application/payment.service.js";
import {
  AddPaymentAllocationsDto,
  AllocationCandidatesQueryDto,
  CancelPaymentDto,
  CreatePaymentDto,
  ListPaymentsQueryDto,
  PaymentAllocationIdParamDto,
  PaymentIdParamDto,
} from "./dto/payment.dto.js";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentService: PaymentService) {}

  @RequirePermission("payment", "list")
  @Get()
  async list(@Query() query: ListPaymentsQueryDto, @CurrentActor() actor: Actor) {
    return this.paymentService.list(query, actor);
  }

  /**
   * Registered before ":id" -- Fastify/Nest route matching is declaration-order sensitive within
   * a controller, and "allocation-candidates" would otherwise be swallowed by GET /payments/:id.
   * Gated on "create" (not "list"): purchase_officer/sales_officer can create payments (seed row
   * grants them `payment:create`) but not list them (`payment:list` is owner/pharmacy_manager/
   * accountant/auditor only) -- browsing candidates is a sub-step of creating a payment, so it
   * needs to be reachable by whoever can create one.
   */
  @RequirePermission("payment", "create")
  @Get("allocation-candidates")
  async allocationCandidates(@Query() query: AllocationCandidatesQueryDto, @CurrentActor() actor: Actor) {
    return this.paymentService.getAllocationCandidates(query, actor);
  }

  @RequirePermission("payment", "view")
  @Get(":id")
  async getById(@Param() params: PaymentIdParamDto, @CurrentActor() actor: Actor) {
    return this.paymentService.getById(params.id, actor);
  }

  /** Create + post: Dr/Cr the party and cash/bank legs -- one transaction. */
  @RequirePermission("payment", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async createAndPost(@Body() body: CreatePaymentDto, @CurrentActor() actor: Actor) {
    return this.paymentService.createAndPost(body, actor);
  }

  @RequirePermission("payment", "edit")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/allocations")
  async addAllocations(@Param() params: PaymentIdParamDto, @Body() body: AddPaymentAllocationsDto, @CurrentActor() actor: Actor) {
    return this.paymentService.addAllocations(params.id, body, actor);
  }

  @RequirePermission("payment", "reverse")
  @HttpCode(200)
  @Post(":id/allocations/:allocationId/reverse")
  async reverseAllocation(@Param() params: PaymentAllocationIdParamDto, @CurrentActor() actor: Actor) {
    return this.paymentService.reverseAllocation(params.id, params.allocationId, actor);
  }

  /** Only reachable with zero active allocations (422 PAYMENT.HAS_ACTIVE_ALLOCATIONS otherwise --
   *  reverse them first). Posts a reversing journal entry and marks the payment cancelled. */
  @RequirePermission("payment", "cancel")
  @HttpCode(200)
  @Post(":id/cancel")
  async cancel(@Param() params: PaymentIdParamDto, @Body() body: CancelPaymentDto, @CurrentActor() actor: Actor) {
    return this.paymentService.cancel(params.id, body, actor);
  }
}
