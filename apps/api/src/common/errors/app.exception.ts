// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.4, rule E-1.
//
// Expected failures (insufficient stock, price below cost, permission denied, version
// conflict, ...) are typed domain results, not thrown strings. `AppException` is the one
// throwable shape that carries everything `GlobalExceptionFilter` needs to build an RFC 9457
// problem document. Domain/application code should construct one of these (or a subclass)
// rather than Nest's generic `HttpException` so every error in the system carries a stable
// `code` (E-2) and, where relevant, field-level detail (E-4).
import { HttpException, HttpStatus } from "@nestjs/common";

import type { ProblemFieldError } from "./problem-details.js";

export interface AppExceptionParams {
  /** HTTP status per the E-7 mapping table (400/401/403/404/409/422/429/503). */
  readonly status: number;
  /** Stable, machine-readable code, namespaced by module, e.g. "INVENTORY.INSUFFICIENT_STOCK". */
  readonly code: string;
  /** Short summary of the problem type, e.g. "Not enough stock". */
  readonly title: string;
  /** Plain-language detail for this occurrence (E-3) -- no jargon, no internals (E-5). */
  readonly detail: string;
  /** Slug appended to PROBLEM_TYPE_BASE, e.g. "insufficient-stock". Defaults to a kebab-case
   *  rendering of `code`. */
  readonly typeSlug?: string;
  /** Field-level errors driving client focus management (E-4). */
  readonly errors?: readonly ProblemFieldError[] | undefined;
}

/** The one throwable used across the API for expected, typed failures (E-1). */
export class AppException extends HttpException {
  readonly code: string;
  readonly typeSlug: string;
  readonly detailMessage: string;
  readonly fieldErrors?: readonly ProblemFieldError[] | undefined;

  constructor(params: AppExceptionParams) {
    super(params.title, params.status);
    this.code = params.code;
    this.detailMessage = params.detail;
    this.fieldErrors = params.errors;
    this.typeSlug = params.typeSlug ?? params.code.toLowerCase().replace(/[._]/g, "-");
  }
}

/** 401 -- no valid session/credential presented (E-7). */
export class UnauthenticatedException extends AppException {
  constructor(detail = "You must sign in to continue.") {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: "AUTH.UNAUTHENTICATED",
      title: "Sign-in required",
      detail,
    });
  }
}

/** 403 -- deny-by-default authorization failure (§9.2, T8). */
export class ForbiddenActionException extends AppException {
  constructor(resource: string, action: string) {
    super({
      status: HttpStatus.FORBIDDEN,
      code: "AUTHZ.FORBIDDEN",
      title: "Not permitted",
      detail: `You do not have permission to ${action} on ${resource}.`,
    });
  }
}

/** 401 -- username/password did not match (09 §I.5). Deliberately does not say which of the two
 *  was wrong, so a caller cannot use the error to enumerate valid usernames. */
export class InvalidCredentialsException extends AppException {
  constructor() {
    super({
      status: HttpStatus.UNAUTHORIZED,
      code: "AUTH.INVALID_CREDENTIALS",
      title: "Invalid credentials",
      detail: "The username or password is incorrect.",
    });
  }
}

/** 423 -- five failed attempts tripped the lockout (09 §I.5). Distinct status/code from
 *  `InvalidCredentialsException` so the client can show "try again in N minutes" instead of
 *  implying the just-submitted password was wrong. */
export class AccountLockedException extends AppException {
  constructor(lockedUntil: Date) {
    super({
      status: HttpStatus.LOCKED,
      code: "AUTH.ACCOUNT_LOCKED",
      title: "Account locked",
      detail: `Too many failed sign-in attempts. Try again after ${lockedUntil.toISOString()}.`,
    });
  }
}

/** 409 -- optimistic-concurrency conflict (§7.4). */
export class VersionConflictException extends AppException {
  constructor(resourceType: string, resourceId: string) {
    super({
      status: HttpStatus.CONFLICT,
      code: "CONCURRENCY.VERSION_CONFLICT",
      title: "Someone else changed this",
      detail: `${resourceType} ${resourceId} was changed by someone else while you were editing it.`,
    });
  }
}

/** 422 -- a business-rule invariant was violated (E-1). */
export class BusinessRuleException extends AppException {
  constructor(code: string, title: string, detail: string, errors?: readonly ProblemFieldError[]) {
    super({ status: HttpStatus.UNPROCESSABLE_ENTITY, code, title, detail, errors });
  }
}
