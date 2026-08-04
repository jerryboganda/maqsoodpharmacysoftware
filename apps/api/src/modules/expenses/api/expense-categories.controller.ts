// Thin controller (§2.2), mirroring payment-methods.controller.ts's shape.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { ExpenseCategoryService } from "../application/expense-category.service.js";
import {
  CreateExpenseCategoryDto,
  ExpenseCategoryIdParamDto,
  ListExpenseCategoriesQueryDto,
  UpdateExpenseCategoryDto,
} from "./dto/expense-category.dto.js";

@Controller("expense-categories")
export class ExpenseCategoriesController {
  constructor(private readonly expenseCategoryService: ExpenseCategoryService) {}

  @RequirePermission("expense_category", "list")
  @Get()
  async list(@Query() query: ListExpenseCategoriesQueryDto, @CurrentActor() actor: Actor) {
    return this.expenseCategoryService.list(query, actor);
  }

  /** Not in the task's literal endpoint list -- added so PATCH has a way to fetch current state,
   *  same addition (and same justification) as PaymentMethodsController's own GET /:id. */
  @RequirePermission("expense_category", "view")
  @Get(":id")
  async getById(@Param() params: ExpenseCategoryIdParamDto, @CurrentActor() actor: Actor) {
    return this.expenseCategoryService.getById(params.id, actor);
  }

  @RequirePermission("expense_category", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateExpenseCategoryDto, @CurrentActor() actor: Actor) {
    return this.expenseCategoryService.create(body, actor);
  }

  @RequirePermission("expense_category", "edit")
  @Patch(":id")
  async update(@Param() params: ExpenseCategoryIdParamDto, @Body() body: UpdateExpenseCategoryDto, @CurrentActor() actor: Actor) {
    return this.expenseCategoryService.update(params.id, body, actor);
  }
}
