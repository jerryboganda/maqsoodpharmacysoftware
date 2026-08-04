// Blueprint: §2.5 -- exports only the public surface.
import { Module } from "@nestjs/common";

import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { SettingsController } from "./api/settings.controller.js";
import { SettingsService } from "./application/settings.service.js";
import { OptionsRepository } from "./infrastructure/options.repository.js";

@Module({
  controllers: [SettingsController],
  // TenantContextService is provided per-module (InventoryModule does not export it) -- the
  // same pattern purchasing.module.ts/sales.module.ts already use.
  providers: [SettingsService, OptionsRepository, TenantContextService],
  exports: [SettingsService],
})
export class SettingsModule {}
