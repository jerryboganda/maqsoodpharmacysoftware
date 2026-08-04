// Thin controller (§2.2), mirroring gl-accounts.controller.ts's read-only shape (list + getById,
// no writes -- this module is the read/browse surface over `audit_log`; the only writer is
// apps/api/src/common/audit, out of scope here per this task's own instruction).
import { Controller, Get, Param, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { AuditEventService } from "../application/audit-event.service.js";
import { AuditEventIdParamDto, ListAuditEventsQueryDto } from "./dto/audit-event.dto.js";

@Controller("audit/events")
export class AuditEventsController {
  constructor(private readonly auditEventService: AuditEventService) {}

  @RequirePermission("audit", "list")
  @Get()
  async list(@Query() query: ListAuditEventsQueryDto, @CurrentActor() actor: Actor) {
    return this.auditEventService.list(query, actor);
  }

  @RequirePermission("audit", "view")
  @Get(":id")
  async getById(@Param() params: AuditEventIdParamDto, @CurrentActor() actor: Actor) {
    return this.auditEventService.getById(params.id, actor);
  }
}
