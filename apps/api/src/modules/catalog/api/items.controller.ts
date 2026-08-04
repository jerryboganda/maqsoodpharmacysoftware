// Thin controller (§2.2). See items.service.ts's header comment for scope -- list/view plus the
// narrow edit + deactivate surface on an item's own already-existing fields.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { ItemsService } from "../application/items.service.js";
import { ItemIdParamDto, ListItemsQueryDto, PatchItemDto } from "./dto/item.dto.js";

@Controller("items")
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @RequirePermission("catalog.item", "list")
  @Get()
  async list(@Query() query: ListItemsQueryDto, @CurrentActor() actor: Actor) {
    return this.items.list(query, actor);
  }

  @RequirePermission("catalog.item", "view")
  @Get(":id")
  async getById(@Param() params: ItemIdParamDto, @CurrentActor() actor: Actor) {
    return this.items.getById(params.id, actor);
  }

  /** Edits an existing item's own fields (name/pricing/etc) -- never `isActive` (see
   *  item.dto.ts's PatchItemSchema header comment) and never a create surface. */
  @RequirePermission("catalog.item", "edit")
  @Patch(":id")
  async update(@Param() params: ItemIdParamDto, @Body() body: PatchItemDto, @CurrentActor() actor: Actor) {
    return this.items.update(params.id, body, actor);
  }

  /** Deactivates the item (R1/00b D7: never a hard delete). Distinct `catalog.item:deactivate`
   *  permission from `catalog.item:edit` -- see permissions.ts's ACTION_KEYS comment. */
  @RequirePermission("catalog.item", "deactivate")
  @HttpCode(200)
  @Post(":id/deactivate")
  async deactivate(@Param() params: ItemIdParamDto, @CurrentActor() actor: Actor) {
    return this.items.deactivate(params.id, actor);
  }
}
