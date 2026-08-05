import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { ItemsController } from "./api/items.controller.js";
import { VisibilityController } from "./api/visibility.controller.js";
import { ItemsService } from "./application/items.service.js";
import { VisibilityService } from "./application/visibility.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [ItemsController, VisibilityController],
  providers: [ItemsService, VisibilityService, TenantContextService],
  exports: [ItemsService, VisibilityService],
})
export class CatalogModule {}
