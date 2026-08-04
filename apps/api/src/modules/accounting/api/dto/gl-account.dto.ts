// Blueprint: 17-technical-blueprint.md §9.3 layer 1 (Edge); 18-api-plan.md §5.4's
// `/gl/accounts`, `/gl/accounts/{id}`, `/gl/accounts/{id}/ledger` rows. Mirrors
// purchase-return.dto.ts's shape conventions exactly (zIntString/zDateString/query pagination).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");
const zBoolString = z.enum(["true", "false"]).transform((v) => v === "true");

export const GlAccountIdParamSchema = z.object({ id: zIntString });
export class GlAccountIdParamDto extends createZodDto(GlAccountIdParamSchema) {}

/** GET /gl/accounts -- flat list by default; `tree=true` returns the 4-level hierarchy instead
 *  (gl_account_main > gl_account_category > gl_account_sub > gl_account, leaves only postable
 *  filtering is honoured at the leaf level). */
export const ListGlAccountsQuerySchema = z.object({
  tree: zBoolString.optional(),
  isPostable: zBoolString.optional(),
  isActive: zBoolString.optional(),
  q: z.string().min(1).max(160).optional(),
});
export class ListGlAccountsQueryDto extends createZodDto(ListGlAccountsQuerySchema) {}

/** GET /gl/accounts/{id}/ledger -- date range narrows which already-posted journal_line rows
 *  are folded into the running balance (see ledger-query.service.ts's doc comment for why
 *  `openingBalance` is 0.00 at the very first line of the *filtered* window, not a true
 *  as-of-date historical balance -- same documented simplification purchasing's
 *  supplier.service.ts#getLedger already uses). */
export const GlAccountLedgerQuerySchema = z.object({
  from: zDateString.optional(),
  to: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class GlAccountLedgerQueryDto extends createZodDto(GlAccountLedgerQuerySchema) {}

export type ListGlAccountsQuery = z.infer<typeof ListGlAccountsQuerySchema>;
export type GlAccountLedgerQuery = z.infer<typeof GlAccountLedgerQuerySchema>;
