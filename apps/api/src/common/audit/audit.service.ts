// Blueprint: docs/system-analysis/19-mysql-schema-blueprint.md §T20 `audit_event`;
// docs/system-analysis/09-roles-permissions.md §G.2 ("the critical gap list" -- login, permission
// change, price change, posting, export, and deletion of documents are not audited today), §I.5
// (audit immutability); docs/system-analysis/18-api-plan.md's security-class action list (login,
// grant, revoke, setting.change, ...).
//
// The one place anything in this codebase writes to `audit_log` (packages/db/schema/audit.ts --
// modelled since an earlier wave, never written to until this one). Two callers exist:
//   1. `AuditInterceptor` (audit.interceptor.ts) -- blanket coverage of every successful mutating
//      HTTP request, with no beforeJson/reason/amountImpact/changedFields (a generic interceptor
//      cannot know the pre-mutation state or business meaning of a diff).
//   2. Any future application service that wants a richer audit row (a real before/after diff, a
//      mandatory `reason`, an `amountImpact`) can inject this service directly and call `write()`
//      itself with those fields populated -- this method's input shape supports it, the
//      interceptor just doesn't happen to supply them today.
//
// BEST-EFFORT, NEVER THROWS (this task's explicit instruction): an audit row is important but is
// never allowed to be the reason a real business operation fails or rolls back. `write()` is
// deliberately NOT run inside the caller's own transaction -- it opens its own implicit
// single-statement insert via `getDb()` (never `tx`), and any failure (a bad column value, a
// transient connection error, audit_log itself being unavailable) is caught here and only
// console.error'd, never re-thrown. This trades "audit_log is not literally the same
// transactional guarantee as the business row it describes" for "audit logging can never take
// down a sale/purchase/payment/expense posting" -- an explicit, deliberate choice for this wave,
// not an oversight.
import { Injectable } from "@nestjs/common";
import { auditLog, getDb } from "@pharmacy/db";

export interface AuditWriteInput {
  /** Defaults to `null` (platform-level event) when omitted -- audit_log's own tenantId is
   *  nullable for exactly this reason (audit.ts's class comment). */
  readonly tenantId?: number | null;
  readonly branchId?: number | null;
  /** Defaults to `new Date()` (now) when omitted. */
  readonly occurredAt?: Date;
  readonly actorUserId?: number | null;
  readonly actorUsername: string;
  readonly sessionId?: string | null;
  /** e.g. "create", "update", "post", "cancel", "reverse", "grant", "revoke", "login", "export"
   *  -- a plain string, not the `ActionKey` union (audit.ts's own column comment: new auditable
   *  action kinds are added by new modules without needing new branching logic here). */
  readonly action: string;
  /** Target table/resource name, e.g. "expense", "purchase.order". */
  readonly entityType: string;
  readonly entityId?: number | null;
  readonly entityLabel?: string | null;
  readonly beforeJson?: unknown;
  readonly afterJson?: unknown;
  readonly changedFields?: readonly string[] | null;
  /** Decimal STRING, never a JS number (project rule -- see root CLAUDE.md "Money and
   *  quantities"). e.g. "1250.00". */
  readonly amountImpact?: string | null;
  readonly reason?: string | null;
  /** Accepted for forward-compatibility with callers that already have it (the interceptor reads
   *  it off the request), but NOT currently persisted -- `audit_log.ip_address` is
   *  `VARBINARY(16)` (MySQL's packed `INET6_ATON` shape) and drizzle-orm 0.36's `varbinary()`
   *  column type is fixed to a plain `string` at the type level with no verified-safe Buffer/
   *  packed-encoding insert path (same documented gap as
   *  apps/api/src/common/auth/session.repository.ts's own `ipAddress: null`, which this mirrors
   *  verbatim rather than re-deriving a possibly-wrong encoding). Tracked as a real follow-up,
   *  not silently dropped. */
  readonly ipAddress?: string | null;
  readonly machineName?: string | null;
  readonly requestId?: string | null;
  /** Security-class events (login, grant, revoke, setting.change, ...) per
   *  docs/system-analysis/18-api-plan.md -- defaults false. */
  readonly isSensitive?: boolean;
}

@Injectable()
export class AuditService {
  /** Inserts one `audit_log` row. Never throws -- see class header comment. Resolves once the
   *  (best-effort) write has been attempted, whether or not it succeeded. */
  async write(input: AuditWriteInput): Promise<void> {
    try {
      const db = getDb();
      await db.insert(auditLog).values({
        tenantId: input.tenantId ?? null,
        branchId: input.branchId ?? null,
        occurredAt: input.occurredAt ?? new Date(),
        actorUserId: input.actorUserId ?? null,
        actorUsername: input.actorUsername,
        sessionId: input.sessionId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityLabel: input.entityLabel ?? null,
        // JSON columns -- `undefined` is not valid JSON; normalise to `null`.
        beforeJson: input.beforeJson ?? null,
        afterJson: input.afterJson ?? null,
        changedFields: input.changedFields ?? null,
        amountImpact: input.amountImpact ?? null,
        reason: input.reason ?? null,
        // ipAddress intentionally not written -- see AuditWriteInput.ipAddress's own comment.
        ipAddress: null,
        machineName: input.machineName ?? null,
        requestId: input.requestId ?? null,
        isSensitive: input.isSensitive ?? false,
      });
    } catch (err) {
      // Best-effort by design (class header comment) -- log and move on, never throw.
      console.error("[AuditService] failed to write audit_log row (non-fatal):", err);
    }
  }
}
