import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { ItemsController } from "./api/items.controller.js";
import { ItemsService } from "./application/items.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [ItemsController],
  providers: [ItemsService, TenantContextService],
  exports: [ItemsService],
})
export class CatalogModule {}
