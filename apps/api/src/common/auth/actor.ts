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

// Wave 10b (`POST/PATCH /roles`): widened past the closed 8-key union so an admin-created custom
// role (access.ts `roles`, `tenantId` NULL, `isSystem` false) type-checks everywhere a `RoleKey`
// already flows -- same `(string & {})` widening trick `permissions.ts`'s `ResourceKey` already
// uses, for the identical reason (real validation happens at the DB layer -- see
// user-admin.repository.ts's `resolveRoleIds` -- not by TypeScript narrowing at the type level).
export type RoleKey = (typeof ROLE_KEYS)[number] | (string & {});

/** The authenticated actor for the current request. */
export interface Actor {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /** Many-to-many, union semantics (09 §I.1 principle 5) -- never a single role. */
  readonly roles: readonly RoleKey[];
  readonly sessionId: string;
  /** Denormalised onto `user_session` at login time from the user's own `app_user` row
   *  (session.repository.ts's `create`) -- `null` for a platform-level user (D21: the owner
   *  administers across every tenant, so has no single tenant of their own). Convenience/audit
   *  data on the actor; tenant-context.service.ts still resolves scope its own way (a DB lookup
   *  with a tenant-default-branch fallback) rather than trusting this field blindly, because a
   *  user whose own `default_branch_id` is unset would otherwise wrongly resolve to no branch at
   *  all instead of falling back to the tenant's default. */
  readonly tenantId: number | null;
  readonly branchId: number | null;
  /** True only for the dev-mode stub actor (session.guard.ts) -- never true once real
   *  authentication is wired. Lets downstream code and logs make the stub impossible to miss. */
  readonly isDevStub: boolean;
}
