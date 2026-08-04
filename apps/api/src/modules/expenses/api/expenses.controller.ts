// Thin controller (§2.2), mirroring payments.controller.ts's shape. Unlike purchase-returns/
// payments (create-and-post-in-one-transaction), POST / here only creates a DRAFT -- posting is
// a distinct POST /:id/post call (this task's own instruction; see ExpenseService's header
// comment for why a draft still gets a real "EXP-" doc number at create time).
//
// @RequireIdempotencyKey is applied exactly where the task specified (POST /, POST /:id/post) and
// deliberately NOT on /:id/cancel or /:id/reverse -- both are already safe against an accidental
// double-submit by construction: each is guarded by a state check (EXPENSE.NOT_DRAFT /
// EXPENSE.NOT_POSTED) that 422s a retry instead of double-applying it, same reasoning
// payments.controller.ts documents for its own cancel/reverse endpoints.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { ExpenseService } from "../application/expense.service.js";
import { CreateExpenseDto, ExpenseIdParamDto, ListExpensesQueryDto, ReverseExpenseDto, UpdateExpenseDto } from "./dto/expense.dto.js";

@Controller("expenses")
export class ExpensesController {
  constructor(private readonly expenseService: ExpenseService) {}

  @RequirePermission("expense", "list")
  @Get()
  async list(@Query() query: ListExpensesQueryDto, @CurrentActor() actor: Actor) {
    return this.expenseService.list(query, actor);
  }

  @RequirePermission("expense", "view")
  @Get(":id")
  async getById(@Param() params: ExpenseIdParamDto, @CurrentActor() actor: Actor) {
    return this.expenseService.getById(params.id, actor);
  }

  /** Creates a DRAFT only -- no journal posting yet (see this file's header comment). */
  @RequirePermission("expense", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateExpenseDto, @CurrentActor() actor: Actor) {
    return this.expenseService.create(body, actor);
  }

  /** Draft only -- 422 EXPENSE.NOT_DRAFT once posted. */
  @RequirePermission("expense", "edit")
  @Patch(":id")
  async update(@Param() params: ExpenseIdParamDto, @Body() body: UpdateExpenseDto, @CurrentActor() actor: Actor) {
    return this.expenseService.update(params.id, body, actor);
  }

  /** Posts the journal entry: Dr each line's category account, one aggregate Cr the cash/bank
   *  account -- balance-checked unless the account allows going negative. */
  @RequirePermission("expense", "post")
  @RequireIdempotencyKey()
  @HttpCode(200)
  @Post(":id/post")
  async post(@Param() params: ExpenseIdParamDto, @CurrentActor() actor: Actor) {
    return this.expenseService.post(params.id, actor);
  }

  /** Draft only -- no journal impact to undo (ExpenseService.cancel's own comment); a posted
   *  expense must be reversed instead. */
  @RequirePermission("expense", "cancel")
  @HttpCode(200)
  @Post(":id/cancel")
  async cancel(@Param() params: ExpenseIdParamDto, @CurrentActor() actor: Actor) {
    return this.expenseService.cancel(params.id, actor);
  }

  /** Posted only -- posts a reversing journal entry (every leg swapped) and flips this row to
   *  status "reversed" (ExpenseService.reverse's own comment on the schema-shape decision). */
  @RequirePermission("expense", "reverse")
  @HttpCode(200)
  @Post(":id/reverse")
  async reverse(@Param() params: ExpenseIdParamDto, @Body() body: ReverseExpenseDto, @CurrentActor() actor: Actor) {
    return this.expenseService.reverse(params.id, body, actor);
  }
}
