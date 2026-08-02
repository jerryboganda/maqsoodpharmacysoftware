// Blueprint: docs/system-analysis/17-technical-blueprint.md §2.5 "NestJS module graph" --
// exports only the public surface; anything not exported is unreachable from other modules.
import { Module } from "@nestjs/common";

import { IdentityController } from "./api/identity.controller.js";
import { IdentityService } from "./application/identity.service.js";
import { UserRepository } from "./infrastructure/user.repository.js";

@Module({
  controllers: [IdentityController],
  providers: [IdentityService, UserRepository],
  exports: [IdentityService],
})
export class IdentityModule {}
