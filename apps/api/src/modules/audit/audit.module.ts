// Wave 6 "lay the shared foundation" skeleton, now built out by the audit follow-up agent (same
// pattern Wave 5 used for accounting/payments/expenses, see app.module.ts's own comment on that
// precedent). Owns the read/browse surface over `audit_log` (packages/db/schema/audit.ts, written
// by apps/api/src/common/audit/audit.service.ts -- AuditService/AuditInterceptor already exist
// and run globally as of Wave 6, this module is just the HTTP read API in front of the table they
// fill). RESOURCE_KEYS "audit", permissions seeded in packages/db/scripts/seed.ts's PERMISSIONS
// block: audit:list/audit:view.
//
// NOT to be confused with `common/audit` (the writer infrastructure, cross-cutting, lives outside
// the modules/ tree, untouched by this module) -- this `modules/audit` is the reader/reporting
// side only, and never writes to `audit_log` itself.
//
// InventoryModule is imported (not exported by it) purely for TenantContextService's shape --
// mirrors expenses.module.ts/purchasing.module.ts's identical import, and TenantContextService is
// re-provided per-module below for the same reason those modules do (InventoryModule does not
// export it).
import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { AuditEventsController } from "./api/audit-events.controller.js";
import { AuditEventService } from "./application/audit-event.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [AuditEventsController],
  providers: [AuditEventService, TenantContextService],
  exports: [AuditEventService],
})
export class AuditModule {}
