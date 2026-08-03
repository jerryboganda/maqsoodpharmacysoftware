// Thin controller (§2.2). Read-only -- see items.service.ts's header comment for scope.
import { Controller, Get, Param, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { ItemsService } from "../application/items.service.js";
import { ItemIdParamDto, ListItemsQueryDto } from "./dto/item.dto.js";

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
}
