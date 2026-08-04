// Blueprint: docs/system-analysis/18-api-plan.md Part 5 §5.2 "Module `payments` -- expenses"
// (R2.2), row "GET/POST/PATCH /api/v1/expense-categories". Mirrors payment-method.dto.ts's shape
// (payments module, same Wave 5 foundation) -- expense_category is the identical "LK-pack CRUD +
// one real FK the legacy system got wrong" shape as payment_method, just with `glAccountId`
// (mandatory, §5.2's own fix -- see packages/db/schema/expenses.ts's header comment on why a
// nullable GL binding is exactly the bug class that already broke adjustment_reason) instead of
// an optional `defaultCashBankAccountId`.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

export const ExpenseCategoryIdParamSchema = z.object({ id: zIntString });
export class ExpenseCategoryIdParamDto extends createZodDto(ExpenseCategoryIdParamSchema) {}

export const ListExpenseCategoriesQuerySchema = z.object({
  /** Default false -- disabled categories (P1.3: disable, never delete) are hidden from an
   *  ordinary expense-entry picker unless explicitly asked for (an admin screen managing the
   *  full catalogue). Mirrors ListPaymentMethodsQuerySchema's identical flag. */
  includeDisabled: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export class ListExpenseCategoriesQueryDto extends createZodDto(ListExpenseCategoriesQuerySchema) {}

/**
 * POST /expense-categories. `glAccountId` is mandatory (§5.2's own fix, mirrored by
 * packages/db/schema/expenses.ts's NOT NULL column) -- service-side validated against a real,
 * postable, active gl_account (the deeper "does it exist" check needs the DB, same shape-here/
 * value-there split every other create DTO in this codebase uses). `isSystem` is NOT exposed
 * here -- only the Wave 5 seed inserts `isSystem: true` rows (the six default categories: RENT/
 * UTILITIES/SALARIES_WAGES/REPAIRS_MAINTENANCE/OFFICE_SUPPLIES/MISCELLANEOUS); every category
 * created through this API is a plain, non-system row by construction
 * (ExpenseCategoryService.create always inserts `isSystem: false`).
 */
export const CreateExpenseCategorySchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  description: z.string().max(255).optional(),
  glAccountId: z.number().int().positive(),
  isEnabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(65535).default(100),
  remarks: z.string().max(1000).optional(),
});
export class CreateExpenseCategoryDto extends createZodDto(CreateExpenseCategorySchema) {}
export type CreateExpenseCategoryInput = z.infer<typeof CreateExpenseCategorySchema>;

/**
 * PATCH /expense-categories/:id -- every editable field, all optional. `code` is immutable via
 * this endpoint, same treatment as UpdatePaymentMethodDto's `code` (identity-shaped fields are
 * fixed-at-create in this codebase, not exposed for edit). `isSystem` is likewise not editable
 * here. Disabling (`isEnabled: false`) an `isSystem` row that already has `expense_line` usage is
 * rejected service-side (422 `EXPENSE_CATEGORY.IN_USE`) -- see ExpenseCategoryService.update's own
 * comment for why the guard is scoped to `isSystem` rows specifically (the task's exact ask).
 */
export const UpdateExpenseCategorySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(255).optional(),
    glAccountId: z.number().int().positive().optional(),
    isEnabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(65535).optional(),
    remarks: z.string().max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export class UpdateExpenseCategoryDto extends createZodDto(UpdateExpenseCategorySchema) {}
export type UpdateExpenseCategoryInput = z.infer<typeof UpdateExpenseCategorySchema>;
