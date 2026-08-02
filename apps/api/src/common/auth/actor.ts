// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.1 "Authentication", §9.2
// "Authorization / RBAC"; docs/system-analysis/09-roles-permissions.md Part I.
//
// The authenticated caller of a request, attached by `SessionGuard` and consumed by
// `PermissionGuard`, application services (permission + role_limit checks, §7.2 step "authz")
// and the audit interceptor. This shape is the target contract for a real session; today it
// is populated by a dev-mode stub (see session.guard.ts).

/** The eight roles from 09-roles-permissions.md §I.3 -- the seed catalogue, not invented names. */
export const ROLE_KEYS = [
  "owner",
  "sys_admin",
  "pharmacy_manager",
  "shift_incharge",
  "sales_officer",
  "purchase_officer",
  "accountant",
  "auditor",
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

/** The authenticated actor for the current request. */
export interface Actor {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /** Many-to-many, union semantics (09 §I.1 principle 5) -- never a single role. */
  readonly roles: readonly RoleKey[];
  readonly sessionId: string;
  /** True only for the dev-mode stub actor (session.guard.ts) -- never true once real
   *  authentication is wired. Lets downstream code and logs make the stub impossible to miss. */
  readonly isDevStub: boolean;
}
