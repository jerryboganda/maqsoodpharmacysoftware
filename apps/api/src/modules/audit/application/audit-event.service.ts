// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T20 `audit_event`;
// docs/system-analysis/09-roles-permissions.md §I.5 (audit immutability, retention). Read-only
// service over `audit_log` (packages/db/schema/audit.ts) -- the only writer is
// apps/api/src/common/audit/audit.service.ts (AuditService, invoked globally by AuditInterceptor
// on every successful mutating request); this service never inserts/updates/deletes that table.
// Structural mirror of expense.service.ts's list()/getById() shape and gl-account.service.ts's
// single-row getById() (no child rows to join -- audit_log is already flat, so getById returns
// the row as-is, mirroring cash-bank.service.ts/payment-method.service.ts's own single-table
// convention).
import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { auditLog, getDb } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { AppException } from "../../../common/errors/index.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface ListAuditEventsParams {
  readonly entityType?: string | undefined;
  readonly entityId?: number | undefined;
  readonly actorUserId?: number | undefined;
  readonly action?: string | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

@Injectable()
export class AuditEventService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** GET /audit/events -- tenant-scoped (same `TenantContextService.resolveScope` contract every
   *  other module's list() uses), newest-first, offset/limit paged (capped at 200). */
  async list(params: ListAuditEventsParams, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);

    const conditions = [eq(auditLog.tenantId, tenantId)];
    if (params.entityType !== undefined) conditions.push(eq(auditLog.entityType, params.entityType));
    if (params.entityId !== undefined) conditions.push(eq(auditLog.entityId, params.entityId));
    if (params.actorUserId !== undefined) conditions.push(eq(auditLog.actorUserId, params.actorUserId));
    if (params.action !== undefined) conditions.push(eq(auditLog.action, params.action));
    if (params.dateFrom !== undefined) conditions.push(gte(auditLog.occurredAt, new Date(`${params.dateFrom}T00:00:00`)));
    if (params.dateTo !== undefined) conditions.push(lt(auditLog.occurredAt, addOneDay(params.dateTo)));

    const limit = Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = params.offset ?? 0;
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.auditLogId))
      .limit(limit)
      .offset(offset);
    return { events: rows, offset, limit };
  }

  /** GET /audit/events/:id -- one row, including the full beforeJson/afterJson/changedFields
   *  (already plain columns on this flat table -- no child rows to join, unlike expense/gl.account
   *  above it in this module tree). */
  async getById(auditLogId: number, actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.auditLogId, auditLogId)));
    if (!row) {
      throw new AppException({
        status: 404,
        code: "AUDIT.NOT_FOUND",
        title: "Audit event not found",
        detail: `No audit event with id ${auditLogId} exists.`,
      });
    }
    return row;
  }
}

/** `YYYY-MM-DD` -> the following calendar day at midnight, local server time -- the exclusive
 *  upper bound for an inclusive `dateTo` filter against a real timestamp column (see
 *  audit-event.dto.ts's ListAuditEventsQuerySchema comment for why this differs from the
 *  date-only-column `lte(..., dateTo T00:00:00)` pattern used elsewhere in this codebase). */
function addOneDay(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d;
}
