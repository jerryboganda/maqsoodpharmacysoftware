// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.2 "Module `payments` -- expenses"
// (R2.2). Owns `expense`/`expense_category`/`expense_line` (packages/db/schema/expenses.ts).
// JournalService/DocNumberService/FiscalPeriodService come from the globally-provided
// DocflowModule (apps/api/src/common/docflow) -- no import needed, constructor-injected directly
// into ExpenseService/ExpenseCategoryService. InventoryModule is imported (not exported by it)
// purely for TenantContextService's shape -- mirrors purchasing.module.ts/payments.module.ts's
// identical import, and TenantContextService is re-provided per-module below for the same reason
// those two modules do (InventoryModule does not export it).
import { Module } from "@nestjs/common";

import { ScopeService } from "../../common/authz/scope.service.js";
import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { ExpenseCategoriesController } from "./api/expense-categories.controller.js";
import { ExpensesController } from "./api/expenses.controller.js";
import { ExpenseCategoryService } from "./application/expense-category.service.js";
import { ExpenseService } from "./application/expense.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [ExpenseCategoriesController, ExpensesController],
  providers: [ExpenseCategoryService, ExpenseService, TenantContextService, ScopeService],
  exports: [ExpenseCategoryService, ExpenseService],
})
export class ExpensesModule {}
