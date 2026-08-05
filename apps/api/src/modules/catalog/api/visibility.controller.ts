// Blueprint: 17-technical-blueprint.md §2.2 (thin controller); 18-api-plan.md §1.6 `/admin/
// visibility/*` (R1, 00b-owner-decisions-and-requirements.md D7).
import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { VisibilityService } from "../application/visibility.service.js";
import {
  BulkOperationIdParamDto,
  BulkVisibilityDto,
  EffectiveVisibilityQueryDto,
  ItemIdParamDto,
  SetItemVisibilityDto,
  UndoBulkVisibilityDto,
  VisibilityWorkbenchQueryDto,
} from "./dto/visibility.dto.js";

@Controller()
export class VisibilityController {
  constructor(private readonly visibility: VisibilityService) {}

  /** `GET /admin/visibility/items` -- the curation workbench (MGR SYS OWN AUD). */
  @RequirePermission("catalog.visibility", "list")
  @Get("admin/visibility/items")
  async workbench(@Query() query: VisibilityWorkbenchQueryDto, @CurrentActor() actor: Actor) {
    return this.visibility.workbench(query, actor);
  }

  /** `GET /admin/visibility/effective/:itemId?scope=...` -- "why is this item hidden?" */
  @RequirePermission("catalog.visibility", "list")
  @Get("admin/visibility/effective/:itemId")
  async effective(@Param() params: ItemIdParamDto, @Query() query: EffectiveVisibilityQueryDto, @CurrentActor() actor: Actor) {
    return this.visibility.effective(params.itemId, query.scope, actor);
  }

  /** `PUT /items/:itemId/visibility` -- set per-scope visibility for one item (MGR SYS). */
  @RequirePermission("catalog.visibility", "edit")
  @Put("items/:itemId/visibility")
  async setItemVisibility(@Param() params: ItemIdParamDto, @Body() body: SetItemVisibilityDto, @CurrentActor() actor: Actor) {
    return this.visibility.setItemVisibility(params.itemId, body, actor);
  }

  /** `POST /admin/visibility/bulk` -- `dryRun: true` returns the live affected count only (MGR SYS). */
  @RequirePermission("catalog.visibility", "edit")
  @Post("admin/visibility/bulk")
  async bulkApply(@Body() body: BulkVisibilityDto, @CurrentActor() actor: Actor) {
    return this.visibility.bulkApply(body, actor);
  }

  /** `POST /admin/visibility/bulk/:bulkOperationId/undo` -- single-click undo (R1.4, MGR SYS).
   *  422 `VISIBILITY.ALREADY_UNDONE` on a second attempt. */
  @RequirePermission("catalog.visibility", "edit")
  @Post("admin/visibility/bulk/:bulkOperationId/undo")
  async undoBulk(@Param() params: BulkOperationIdParamDto, @Body() _body: UndoBulkVisibilityDto, @CurrentActor() actor: Actor) {
    return this.visibility.undoBulk(params.bulkOperationId, actor);
  }
}
