// Blueprint: 17-technical-blueprint.md §2.2 (thin controller); 18-api-plan.md §1.3/§1.4.
import { Body, Controller, Get, Param, Patch } from "@nestjs/common";

import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import type { Actor } from "../../../common/auth/actor.js";
import { Public } from "../../../common/authz/public.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { PlatformService } from "../application/platform.service.js";
import { FeatureCapabilityCodeParamDto, UpdateFeatureCapabilityDto } from "./dto/platform.dto.js";

@Controller()
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /** `GET /health` -- public liveness probe, no session, no permission (18-api-plan.md §1.3). */
  @Public()
  @Get("health")
  health() {
    return this.platform.health();
  }

  /** `GET /ready` -- readiness probe. No dedicated "internal-only" transport exists in this
   *  codebase yet (no separate internal network/mTLS boundary) -- `@Public()` for the same
   *  reason `/health` is, matching identity.controller.ts's own precedent for probe endpoints.
   *  Exposes no tenant data, only aggregate platform-level booleans. */
  @Public()
  @Get("ready")
  async ready() {
    return this.platform.ready();
  }

  /** `GET /admin/feature-capabilities` -- the D1 register. */
  @RequirePermission("platform.feature_capability", "list")
  @Get("admin/feature-capabilities")
  async listFeatureCapabilities() {
    return this.platform.listFeatureCapabilities();
  }

  /** `PATCH /admin/feature-capabilities/:code` -- record an owner decision. Sensitive (seed.ts). */
  @RequirePermission("platform.feature_capability", "edit")
  @Patch("admin/feature-capabilities/:code")
  async updateFeatureCapability(
    @Param() params: FeatureCapabilityCodeParamDto,
    @Body() body: UpdateFeatureCapabilityDto,
    @CurrentActor() actor: Actor,
  ) {
    return this.platform.updateFeatureCapability(params.code, body, actor);
  }
}
