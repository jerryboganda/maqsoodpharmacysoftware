// Wave 10a -- the `platform` module (18-api-plan.md §1.3/§1.4): health/ready probes + the D1
// feature-capability register. No dependency on any other module (health/ready deliberately
// avoid TenantContextService -- see platform.service.ts's own comment on why liveness stays
// DB-free).
import { Module } from "@nestjs/common";

import { PlatformController } from "./api/platform.controller.js";
import { PlatformService } from "./application/platform.service.js";

@Module({
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
