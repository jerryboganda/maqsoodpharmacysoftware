// Wave 6 notifications module (built out from the empty skeleton the foundation pass left --
// see that skeleton's own header comment, preserved below for context). Owns `notification`
// (packages/db/schema/notifications.ts): a scan-on-read "materialized alerts" service plus
// list/mark-read/mark-all-read endpoints -- no admin CRUD, no delivery channels this wave (see
// notification.service.ts's own header comment for the full DEFERRED list).
//
// `InventoryModule` is imported (not exported by it) purely for `TenantContextService`'s shape --
// mirrors expenses.module.ts's/purchasing.module.ts's/payments.module.ts's identical import, and
// `TenantContextService` is re-provided per-module below for the same reason those modules do
// (InventoryModule does not export it).
import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { NotificationsController } from "./api/notifications.controller.js";
import { NotificationService } from "./application/notification.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [NotificationsController],
  providers: [NotificationService, TenantContextService],
  exports: [NotificationService],
})
export class NotificationsModule {}
