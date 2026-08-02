// Blueprint: docs/system-analysis/17-technical-blueprint.md Part 9.4 "Error handling".
//
// RFC 9457 (application/problem+json) is the wire shape for every error response in this
// API. It replaces the legacy's 2,880 modal `MessageBox` strings (04 §9.2 A9) with a typed,
// machine-readable, plain-language, focus-manageable contract (E-1..E-7).

/** A single field-level validation/business error, driving client-side focus management (E-4). */
export interface ProblemFieldError {
  /** Dot/bracket path into the request body, e.g. "lines[3].qty". */
  readonly path: string;
  /** Stable, machine-readable code -- never changes once shipped (E-2). */
  readonly code: string;
  /** Plain-language, localisable message for this field (E-3). */
  readonly message: string;
  /** Optional structured context, e.g. { available: "12.0000" }. */
  readonly meta?: Record<string, unknown>;
}

/**
 * RFC 9457 problem document. `code`, `type` and `status` are the contract; `title`/`detail`
 * are UX and may be rewritten or translated without breaking clients (E-2).
 */
export interface ProblemDetails {
  /** A URI identifying the problem type. Not required to be dereferenceable (RFC 9457 §3.1). */
  readonly type: string;
  /** Short, human-readable summary of the problem type. */
  readonly title: string;
  /** The HTTP status code, repeated here per RFC 9457. */
  readonly status: number;
  /** Stable, machine-readable application error code (E-2). */
  readonly code: string;
  /** Plain-language detail specific to this occurrence (E-3). No jargon, no internals (E-5). */
  readonly detail: string;
  /** The request path this problem originated from. */
  readonly instance: string;
  /** Correlates this response to the structured server log (E-5). */
  readonly traceId: string;
  /** Field-level errors, present for validation/business-rule failures (E-4). */
  readonly errors?: readonly ProblemFieldError[] | undefined;
}

/** Base URI for problem `type` links. Not required to resolve to real documentation yet. */
export const PROBLEM_TYPE_BASE = "https://errors.pharmacy.local";

export function problemType(slug: string): string {
  return `${PROBLEM_TYPE_BASE}/${slug}`;
}
