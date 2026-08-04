// Blueprint: docs/system-analysis/17-technical-blueprint.md §10.2 (schema), §10.5 (P1 areas),
// Part 10 "Implementing P1: options are data, not code". Admin CRUD counterpart to
// option-value.dto.ts's app-facing, enabled-only `GET /settings/options/:key` shape -- these DTOs
// back `OptionListsController`'s `/option-lists/...` admin surface instead.
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

/** Mirrors `OptionSetKeyParamSchema` (option-value.dto.ts) -- same "module.concept" naming
 *  convention (e.g. "sale.tender_method", "supplier_payment.method"), because both endpoints key
 *  off the exact same `option_list.list_code` column. */
export const ListCodeParamSchema = z.object({
  listCode: z.string().min(1).max(48).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'must look like "module.concept", e.g. "sale.tender_method"'),
});
export class ListCodeParamDto extends createZodDto(ListCodeParamSchema) {}

// Mirrors payment-method.dto.ts's `zIntString` helper -- `option_item_id` is a BIGINT UNSIGNED
// idPk (options.ts), never negative/fractional.
const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);

export const OptionItemParamsSchema = ListCodeParamSchema.extend({
  optionItemId: zIntString,
});
export class OptionItemParamsDto extends createZodDto(OptionItemParamsSchema) {}

/**
 * POST /option-lists/:listCode/items. `isDefault` and `isSystem` are deliberately not accepted
 * here:
 *   - `isDefault` has its own atomic `POST .../set-default` endpoint -- P1.2's one-default-per-
 *     list invariant needs an unset-old/set-new swap done together, not a plain create-time flag
 *     that could leave a list with zero defaults (create false) or race a concurrent create-as-
 *     default against another item's existing default (create true) without the swap discipline
 *     `OptionsRepository.setDefault` provides. A brand-new list simply has no default until an
 *     admin explicitly calls set-default once.
 *   - `isSystem` is seed-only (options.repository.ts's `createItem` always writes `isSystem:
 *     false`) -- an API-created row can never claim to be one of the seeded rows the application
 *     depends on (options.ts's own comment on the column).
 */
export const CreateOptionItemSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(120),
  nameUr: z.string().max(120).optional(),
  description: z.string().max(255).optional(),
  groupLabel: z.string().max(64).optional(),
  sortOrder: z.number().int().min(0).max(65535).default(100),
  isEnabled: z.boolean().default(true),
});
export class CreateOptionItemDto extends createZodDto(CreateOptionItemSchema) {}
export type CreateOptionItemInput = z.infer<typeof CreateOptionItemSchema>;

/**
 * PATCH /option-lists/:listCode/items/:optionItemId -- every field this endpoint is allowed to
 * touch (task spec: "edit name/nameUr/description/groupLabel/sortOrder/isEnabled"), all optional
 * (at least one required, enforced by `.refine` below, same convention as
 * `UpdatePaymentMethodSchema`).
 *
 * `code` is immutable via this endpoint -- mirrors `UpdatePaymentMethodDto`'s own treatment of
 * `code` (payment-method.dto.ts's header comment: "is what ... any hardcoded integration would
 * key off, so it is not exposed for edit here"). The exact same reasoning applies here, doubled:
 * `option_item.code` is both the DB's own uniqueness key within a list
 * (`uk_option_item_list_code`, options.ts) AND, per P1.1's whole premise, the one stable value
 * other modules are meant to store as a foreign key/reference -- renaming it out from under a
 * historical reference would silently break every document that ever recorded this option's code.
 *
 * `isDefault` is excluded for the same reason CreateOptionItemSchema excludes it -- see this
 * file's `POST` header comment; `set-default` is the only endpoint that ever flips it.
 *
 * `isSystem` is excluded because it is a seed-only classification, not an editable business field
 * -- but note it still GATES what `isEnabled: false` is allowed to do (SettingsService blocks
 * disabling any row where `isSystem` is true; see that file's own comment for why).
 */
export const UpdateOptionItemSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    nameUr: z.string().max(120).nullable().optional(),
    description: z.string().max(255).nullable().optional(),
    groupLabel: z.string().max(64).nullable().optional(),
    sortOrder: z.number().int().min(0).max(65535).optional(),
    isEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field must be provided" });
export class UpdateOptionItemDto extends createZodDto(UpdateOptionItemSchema) {}
export type UpdateOptionItemInput = z.infer<typeof UpdateOptionItemSchema>;
