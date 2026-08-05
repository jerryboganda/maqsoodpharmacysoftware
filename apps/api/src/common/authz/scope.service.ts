// Blueprint: 18-api-plan.md §0.13.3 ("Scope (role_scope) is a mandatory WHERE clause injected by
// the repository layer -- warehouse, cash account, price tier, supplier category, voucher
// category ... A denial is 403 AUTHZ.SCOPE_DENIED on write and an invisible row on read.") and
// F-4 ("Row-level scope is applied AFTER the client's filters as a mandatory AND. A client cannot
// widen its own scope by omitting a filter.").
//
// Multi-role semantics (documented judgement call, same shape as limits.service.ts's own but
// INVERTED for the reason below): the actor's effective allowed-id set for a scopeType is the
// UNION of every role_scope row across every one of the actor's roles that HAS a row for that
// type. A role with NO row for that type contributes nothing to the union -- it does NOT grant a
// blanket exemption via some other, unconfigured role. Concretely: if NONE of the actor's roles
// has ever been scoped for this type, the actor is fully UNRESTRICTED (returns `null` -- the
// "zero behavioural change until an owner/sys_admin configures a row" property this whole feature
// was built to preserve, same as limits.service.ts). The moment ANY one of the actor's roles gets
// an explicit scope row for this type, the actor's access narrows to the union of what's been
// explicitly granted across their roles -- an unrelated, never-configured OTHER role held by the
// same actor does not silently widen it back out. This is the inverse of limits.service.ts's
// "tightest role wins" (a numeric ceiling is safest when narrow), because scope is a membership
// set, not a ceiling: "union of what my roles grant me visibility into" is the natural reading of
// permission grants everywhere else in this codebase (permissions.service.ts's own "union of
// grants, a single granting role is enough"), and role_scope is how visibility/access is granted
// per resource, not restricted from an implicit "everything" baseline once someone opts in.
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, roleScopes, roles } from "@pharmacy/db";

import type { Actor } from "../auth/actor.js";
import { AppException } from "../errors/index.js";

export type ScopeType = "warehouse" | "cash_bank_account" | "price_type" | "supplier_category" | "voucher_category";

@Injectable()
export class ScopeService {
  /** The actor's effective allowed-id set for `scopeType`, or `null` when the actor is
   *  UNRESTRICTED for that type (no role_scope row exists for any of the actor's roles). Never
   *  returns an empty non-null Set as "unrestricted" -- an empty Set is a real, deliberate
   *  "nothing allowed" result (e.g. every scope row for this role was just cleared to `[]`). */
  async getAllowedIds(actor: Actor, scopeType: ScopeType): Promise<Set<number> | null> {
    if (actor.roles.length === 0) return null;
    const db = getDb();
    const rows = await db
      .select({ scopeRefId: roleScopes.scopeRefId })
      .from(roleScopes)
      .innerJoin(roles, eq(roleScopes.roleId, roles.roleId))
      .where(and(isNull(roles.tenantId), inArray(roles.roleKey, [...actor.roles]), eq(roleScopes.scopeType, scopeType)));
    if (rows.length === 0) return null;
    return new Set(rows.map((r) => r.scopeRefId));
  }

  /** Throws `403 AUTHZ.SCOPE_DENIED` if `id` is outside the actor's effective scope for
   *  `scopeType` -- a no-op (including zero extra queries' worth of behavioural effect) when the
   *  actor is unrestricted for that type. Use on every WRITE path that targets one specific
   *  scoped-type resource id (creating/posting a document against it, starting a reconciliation
   *  on it, etc.). */
  async assertAllowed(actor: Actor, scopeType: ScopeType, id: number, path: string): Promise<void> {
    const allowed = await this.getAllowedIds(actor, scopeType);
    if (allowed === null || allowed.has(id)) return;
    throw new AppException({
      status: 403,
      code: "AUTHZ.SCOPE_DENIED",
      title: "Outside your role's scope",
      detail: `You do not have "${scopeType}" scope for id ${id}.`,
      errors: [{ path, code: "AUTHZ.SCOPE_DENIED", message: `id ${id} is outside the actor's effective ${scopeType} scope` }],
    });
  }

  /** True when the actor may SEE `id` under `scopeType` -- unrestricted, or `id` is in the
   *  allowed set. Use this to mask a single-row GET as a plain `404 *.NOT_FOUND` (the doc's
   *  "invisible row on read") -- never to gate a write; use `assertAllowed` there so the caller
   *  gets the more informative `403 AUTHZ.SCOPE_DENIED`. */
  async isReadAllowed(actor: Actor, scopeType: ScopeType, id: number): Promise<boolean> {
    const allowed = await this.getAllowedIds(actor, scopeType);
    return allowed === null || allowed.has(id);
  }
}
