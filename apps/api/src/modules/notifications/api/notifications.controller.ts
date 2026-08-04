// Thin controller (§2.2), mirroring expenses.controller.ts's shape. No `@RequireIdempotencyKey`
// on either POST -- both `markRead`/`markAllRead` are naturally safe to retry (they only ever
// move `readAt` from null to "now"; a repeat call is a no-op, see notification.service.ts's own
// comment on `markRead`), the same reasoning expenses.controller.ts documents for skipping it on
// /cancel and /reverse.
import { Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { NotificationService } from "../application/notification.service.js";
import { ListNotificationsQueryDto, NotificationIdParamDto } from "./dto/notification.dto.js";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notificationService: NotificationService) {}

  /** Runs the materialized-alert scan for the actor's tenant first, then returns the actor's own
   *  visible notifications (own `recipientUserId` rows + every `recipientRoleKey` the actor
   *  holds), unread first. See NotificationService.scanForAlerts's header comment. */
  @RequirePermission("notification", "list")
  @Get()
  async list(@Query() query: ListNotificationsQueryDto, @CurrentActor() actor: Actor) {
    return this.notificationService.list(query, actor);
  }

  /** 404 if the notification doesn't belong to this actor by either `recipientUserId` or a
   *  `recipientRoleKey` the actor holds -- never leaks whether some OTHER user's/role's
   *  notification exists. */
  @RequirePermission("notification", "edit")
  @HttpCode(200)
  @Post(":id/read")
  async markRead(@Param() params: NotificationIdParamDto, @CurrentActor() actor: Actor) {
    return this.notificationService.markRead(params.id, actor);
  }

  /** Marks every one of the actor's currently-visible UNREAD notifications as read. */
  @RequirePermission("notification", "edit")
  @HttpCode(200)
  @Post("read-all")
  async markAllRead(@CurrentActor() actor: Actor) {
    return this.notificationService.markAllRead(actor);
  }
}
