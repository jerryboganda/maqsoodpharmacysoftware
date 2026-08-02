// Blueprint: §2.5 -- exports only the public surface.
import { Module } from "@nestjs/common";

import { SettingsController } from "./api/settings.controller.js";
import { SettingsService } from "./application/settings.service.js";
import { OptionsRepository } from "./infrastructure/options.repository.js";

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, OptionsRepository],
  exports: [SettingsService],
})
export class SettingsModule {}
