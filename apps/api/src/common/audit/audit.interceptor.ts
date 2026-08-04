// Blueprint: this task's own instruction -- "blanket audit coverage across every existing AND
// future mutating endpoint with zero per-module code". Registered globally as `APP_INTERCEPTOR`
// in app.module.ts, same pattern as the existing `IdempotencyInterceptor` (idempotency.
// interceptor.ts) -- read that file first if this one needs changing, the two are structural
// siblings (Reflector-driven metadata read, `next.handle().pipe(tap(...))` around the handler).
//
// On every SUCCESSFUL (the handler didn't throw) mutating request (POST/PATCH/PUT/DELETE), calls
// `AuditService.write()` with:
//   - actorUserId/actorUsername/sessionId/tenantId/branchId -- from `request.actor` (attached by
//     SessionGuard, same contract CurrentActor reads). A request with no actor (a `@Public()`
//     route, e.g. login) is skipped entirely -- there is no meaningful actor to attribute it to,
//     and login's own audit row is that endpoint's own concern once it exists, not this
//     interceptor's (see the interceptor's `run against every future endpoint automatically`
//     framing -- login is deliberately NOT one of those, it runs before an actor exists).
//   - action -- the `@RequirePermission()` decorator's `action` metadata (via `Reflector`,
//     reading `REQUIRE_PERMISSION_KEY` -- the exact key `PermissionGuard` itself reads, see
//     permission.guard.ts) if the route declares one, else falls back to the raw HTTP method
//     ("POST"/"PATCH"/"PUT"/"DELETE").
//   - entityType -- the decorator's `resource` metadata if present, else the route path.
//   - entityId -- tried, in order: `${resource}Id`/`${lastDotSegment}Id`/`id` on the response
//     body, then the route's own `:id` param. `undefined` (persisted as NULL) if none match.
//   - afterJson -- the response body, with sensitive-looking fields redacted (see
//     `redactSensitiveFields` below). Integration fix, found live: this was originally written
//     as a "forward-looking TODO, not a live gap" on the assumption no *current* mutating
//     endpoint returns a secret -- the audit module agent's own live-traffic verification proved
//     that wrong immediately: `POST /users` (`identity.user:create`) returns a plaintext
//     `temporaryPassword` in its response body (see user-admin.service.ts), which was landing
//     verbatim in `audit_log.after_json`, an append-only table, on every new-user creation. Fixed
//     by redacting any object key matching a sensitive-field pattern (password/token/secret/
//     hash/key-shaped names), recursively, before the body is ever passed to `AuditService`.
//   - requestId -- the inbound `X-Request-Id` header if present, else a freshly generated UUID.
//   - beforeJson/reason/amountImpact/changedFields are NOT set -- a generic interceptor has no
//     way to know a mutation's pre-image or business-level "why"; a module that wants those
//     populated calls `AuditService.write()` itself (see audit.service.ts's class comment).
import { randomUUID } from "node:crypto";

import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";

import type { Actor } from "../auth/actor.js";
import { REQUIRE_PERMISSION_KEY } from "../authz/require-permission.decorator.js";
import type { RequiredPermission } from "../authz/require-permission.decorator.js";
import { AuditService } from "./audit.service.js";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const REQUEST_ID_HEADER = "x-request-id";

/** Best-effort `${...}Id` lookup on a mutation's response body -- tries the decorator's own
 *  resource key first (e.g. "expense" -> "expenseId"), then the last dot-segment of a namespaced
 *  resource (e.g. "purchase.order" -> "orderId"), then a bare "id". Returns `undefined` (not a
 *  hard failure) if the body doesn't look like an object or none of the candidates are numeric. */
function extractEntityIdFromBody(entityType: string, body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const lastSegment = entityType.includes(".") ? entityType.slice(entityType.lastIndexOf(".") + 1) : entityType;
  const candidateKeys = [`${entityType}Id`, `${lastSegment}Id`, "id"];
  for (const key of candidateKeys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function extractEntityIdFromRouteParam(request: FastifyRequest): number | undefined {
  const params = request.params as Record<string, string> | undefined;
  const raw = params?.id;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const REDACTED = "[REDACTED]";
// Case-insensitive substring match against the field NAME, not the value -- deliberately broad
// (password/token/secret/hash/credential/apiKey-shaped names) since a blanket interceptor sees
// every current and future mutating endpoint's response body and has no per-endpoint allowlist.
// A false-positive redaction (e.g. a legitimate "passwordPolicy" object) is an acceptable
// trade-off against the alternative -- a real secret landing in an append-only audit table.
const SENSITIVE_KEY_PATTERN = /password|token|secret|passphrase|credential|apikey|api_key|privatekey|private_key/i;
const MAX_REDACT_DEPTH = 6;

/** Recursively walks a mutation response body and replaces the VALUE of any key whose name
 *  matches `SENSITIVE_KEY_PATTERN` with a fixed redaction marker, leaving every other field
 *  (ordinary business data -- the overwhelming majority of what this interceptor sees) untouched.
 *  Depth-capped defensively; this only ever runs against small JSON API response bodies, not
 *  arbitrary user content. */
function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth >= MAX_REDACT_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item, depth + 1));
  const record = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitiveFields(val, depth + 1);
  }
  return redacted;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const method = request.method.toUpperCase();

    if (!MUTATING_METHODS.has(method)) return next.handle();

    const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const action = required?.action ?? method;
    const entityType = required?.resource ?? (request.routeOptions?.url ?? request.url);

    const requestIdHeader = request.headers[REQUEST_ID_HEADER];
    const requestId = (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ?? randomUUID();

    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          const actor = request.actor;
          // No actor -- a @Public() route (e.g. login) ran before any actor existed. Nothing
          // meaningful to attribute the row to; see this file's header comment.
          if (!actor) return;

          const entityId = extractEntityIdFromBody(entityType, body) ?? extractEntityIdFromRouteParam(request);

          void this.audit.write({
            tenantId: actor.tenantId,
            branchId: actor.branchId,
            actorUserId: Number.isFinite(Number(actor.userId)) ? Number(actor.userId) : null,
            actorUsername: actor.username,
            sessionId: actor.sessionId,
            action,
            entityType,
            entityId: entityId ?? null,
            afterJson: redactSensitiveFields(body),
            requestId,
            ipAddress: request.ip,
          });
        },
        // A thrown handler (validation failure, business-rule 422, etc.) is deliberately NOT
        // audited -- "on every SUCCESSFUL mutating request" per this file's own header comment
        // and this task's explicit instruction. `IdempotencyInterceptor`'s sibling `error` branch
        // exists to release ITS OWN in-progress lock; this interceptor has no such state to
        // release, so there is nothing to do here.
      }),
    );
  }
}
