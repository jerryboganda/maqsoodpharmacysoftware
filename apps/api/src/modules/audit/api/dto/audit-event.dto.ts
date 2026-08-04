// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T20 `audit_event`;
// docs/system-analysis/18-api-plan.md (audit read surface). Mirrors expense.dto.ts's shape
// conventions (§6.3 boundary 3 -- zIntString/zDateString wire helpers, offset/limit paging).
// This module is READ-ONLY against `audit_log` (packages/db/schema/audit.ts) -- no create/update
// schemas here; the only writer is apps/api/src/common/audit (AuditService/AuditInterceptor,
// cross-cutting, out of this module's scope).
import { createZodDto } from "nestjs-zod";
import { z } from "zod";

const zIntString = z.string().regex(/^\d+$/, "must be a positive integer").transform(Number);
const zDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

export const AuditEventIdParamSchema = z.object({ id: zIntString });
export class AuditEventIdParamDto extends createZodDto(AuditEventIdParamSchema) {}

/**
 * GET /audit/events -- `entityType`/`action` are free-text (audit_log.entity_type/action are
 * plain admin-extensible varchars, not structural ENUMs -- audit.ts's own column comment), so
 * these are validated only for shape/length here, not against a fixed enum. `dateFrom`/`dateTo`
 * filter `occurredAt`, a real DATETIME(3) (not a date-only column like expense.expenseDate) --
 * `dateTo` is treated as inclusive of the whole calendar day (service resolves it to `< dateTo +
 * 1 day`, not `<= dateTo T00:00:00`, which would silently exclude every event on that day).
 * `limit` capped at 200 service-side, mirroring every other list endpoint in this codebase.
 */
export const ListAuditEventsQuerySchema = z.object({
  entityType: z.string().min(1).max(48).optional(),
  entityId: zIntString.optional(),
  actorUserId: zIntString.optional(),
  action: z.string().min(1).max(48).optional(),
  dateFrom: zDateString.optional(),
  dateTo: zDateString.optional(),
  offset: zIntString.optional(),
  limit: zIntString.optional(),
});
export class ListAuditEventsQueryDto extends createZodDto(ListAuditEventsQuerySchema) {}
