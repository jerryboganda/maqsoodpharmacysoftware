// Blueprint: docs/system-analysis/17-technical-blueprint.md Part 10 "Implementing P1: options
// are data, not code" -- the admin-facing counterpart to settings.controller.ts's single-key,
// enabled-only, app-facing `GET /settings/options/:key`. This controller is what curates the
// `option_list`/`option_item` rows that endpoint (and every other module reading via
// `SettingsService.listOptions`) ultimately serves. Kept as its own controller rather than folded
// into `SettingsController` -- five routes with real business-rule branching is enough surface
// area to earn its own file, same call every other LK-pack module in this codebase already made
// (payment-methods.controller.ts, expense-categories.controller.ts each get their own).
//
// Thin controller (§2.2): validates params/body via DTO, resolves the actor, calls exactly one
// SettingsService method per handler. `createItem` (the one mutating POST with a real body)
// carries `@RequireIdempotencyKey()`, matching every create-with-body POST in this codebase
// (§7.5) -- PATCH does not, same convention payment-methods.controller.ts/
// expense-categories.controller.ts already establish. `set-default` (a bodyless POST) does NOT
// carry it -- see that handler's own comment for the real bug this sidesteps and the
// already-established codebase convention (bodyless + naturally-idempotent -> skip it) it
// follows instead.
import { Body, Controller, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { SettingsService } from "../application/settings.service.js";
import { CreateOptionItemDto, ListCodeParamDto, OptionItemParamsDto, UpdateOptionItemDto } from "./dto/option-item.dto.js";

@Controller("option-lists")
export class OptionListsController {
  constructor(private readonly settings: SettingsService) {}

  /** Every option list this tenant has, plus its metadata and a computed item count. */
  @RequirePermission("settings.option", "list")
  @Get()
  async listSets(@CurrentActor() actor: Actor) {
    return this.settings.listOptionLists(actor);
  }

  /** Every item in one list, INCLUDING disabled ones -- the admin view. See
   *  `GET /settings/options/:key` (settings.controller.ts) for the enabled-only, app-facing
   *  counterpart of this read. */
  @RequirePermission("settings.option", "list")
  @Get(":listCode/items")
  async listItems(@Param() params: ListCodeParamDto, @CurrentActor() actor: Actor) {
    return this.settings.listOptionListItems(params.listCode, actor);
  }

  /** 422 `OPTION_LIST.NOT_ADMIN_EXTENSIBLE` if the parent list is fixed/system-defined. */
  @RequirePermission("settings.option", "create")
  @RequireIdempotencyKey()
  @Post(":listCode/items")
  @HttpCode(201)
  async createItem(@Param() params: ListCodeParamDto, @Body() body: CreateOptionItemDto, @CurrentActor() actor: Actor) {
    return this.settings.createOptionItem(params.listCode, body, actor);
  }

  /** `code` is immutable (see UpdateOptionItemDto's header comment). 422
   *  `OPTION_ITEM.SYSTEM_ITEM_CANNOT_BE_DISABLED` / `OPTION_LIST.DISABLE_NOT_ALLOWED` if the
   *  caller is trying to set `isEnabled: false` and either guard applies. */
  @RequirePermission("settings.option", "edit")
  @Patch(":listCode/items/:optionItemId")
  async updateItem(@Param() params: OptionItemParamsDto, @Body() body: UpdateOptionItemDto, @CurrentActor() actor: Actor) {
    return this.settings.updateOptionItem(params.listCode, params.optionItemId, body, actor);
  }

  /** Atomically moves `isDefault` from whichever item currently holds it (if any) to this one --
   *  see `OptionsRepository.setDefault`'s own comment for why the swap must be one transaction.
   *  422 `OPTION_ITEM.CANNOT_DEFAULT_DISABLED` if the target is disabled.
   *
   *  No `@RequireIdempotencyKey()` -- this route has no body (nothing to hash/replay against;
   *  `IdempotencyInterceptor.intercept` hashes `request.body`, which Fastify leaves `undefined`
   *  for a bodyless POST, and `JSON.stringify(undefined)` -> `undefined` crashes
   *  `createHash().update()` with a real, reproducible 500 -- confirmed live against this exact
   *  route before this comment was written). Same convention every other naturally-idempotent,
   *  bodyless mutating POST in this codebase already follows instead of inventing a body just to
   *  satisfy the interceptor: expenses.controller.ts's bodyless `POST /:id/cancel`,
   *  notifications.controller.ts's `POST /read-all` (see that file's own header comment --
   *  "naturally safe to retry ... a repeat call is a no-op"). Retrying set-default with the same
   *  `optionItemId` is likewise a no-op: the target ends up `isDefault: true` either way. */
  @RequirePermission("settings.option", "edit")
  @Post(":listCode/items/:optionItemId/set-default")
  @HttpCode(200)
  async setDefault(@Param() params: OptionItemParamsDto, @CurrentActor() actor: Actor) {
    return this.settings.setDefaultOptionItem(params.listCode, params.optionItemId, actor);
  }
}
