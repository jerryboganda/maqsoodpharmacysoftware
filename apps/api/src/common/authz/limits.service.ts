// Blueprint: 18-api-plan.md §0.13.3 (Wave 10e, R-007 CRITICAL) -- "Limits (role_limit) ... are
// evaluated INSIDE the transaction that writes the document, returning 403 AUTHZ.LIMIT_EXCEEDED
// with meta.limitKey, meta.limitValue, meta.attemptedValue, and no database side effect."
//
// Multi-role semantics (a real judgement call, not in the doc): the EFFECTIVE limit for a key is
// the MINIMUM configured value across every one of the actor's roles that has a `role_limit` row
// for that key; a role with NO row for a key imposes no restriction of its own (does not grant an
// exemption from a DIFFERENT role's configured limit). This is the opposite of permission grants'
// own "union of grants, a single granting role is enough" rule (permissions.service.ts) --
// deliberately so: a permission grant is additive (what CAN this actor do at all), a limit is
// restrictive (how FAR can they go), and for a financial control the safe default when roles
// disagree is the tighter cap, not the looser one. Until an owner/sys_admin actually configures a
// role_limit row through `PUT /roles/:roleKey/limits`, this check is a no-op for every actor --
// zero behavioural change to any existing flow.
import { Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, roleLimits, roles } from "@pharmacy/db";
import { Money } from "@pharmacy/money";

import type { Actor } from "../auth/actor.js";
import { AppException } from "../errors/index.js";

export type LimitKey = "max_txn_value" | "max_qty" | "max_line_disc_pct" | "max_inv_flat_disc" | "max_price_delta_pct";

@Injectable()
export class LimitsService {
  /** Throws 403 `AUTHZ.LIMIT_EXCEEDED` if `attemptedValue` exceeds the actor's effective limit for
   *  `limitKey`; a no-op (including zero extra queries beyond the one lookup) when no role_limit
   *  row exists for any of the actor's roles. `attemptedValue` is a plain decimal string (Rule M --
   *  never a JS number), same convention as every other money/quantity value in this codebase. */
  async check(actor: Actor, limitKey: LimitKey, attemptedValue: string): Promise<void> {
    if (actor.roles.length === 0) return;
    const db = getDb();
    const rows = await db
      .select({ limitValue: roleLimits.limitValue })
      .from(roleLimits)
      .innerJoin(roles, eq(roleLimits.roleId, roles.roleId))
      .where(and(isNull(roles.tenantId), inArray(roles.roleKey, [...actor.roles]), eq(roleLimits.limitKey, limitKey)));
    if (rows.length === 0) return; // no role_limit configured for this key on any of the actor's roles -- unlimited

    let effectiveLimit = Money.fromDb(rows[0]!.limitValue);
    for (const row of rows.slice(1)) {
      const candidate = Money.fromDb(row.limitValue);
      if (candidate.compare(effectiveLimit) < 0) effectiveLimit = candidate;
    }

    const attempted = Money.fromDb(attemptedValue);
    if (attempted.compare(effectiveLimit) > 0) {
      throw new AppException({
        status: 403,
        code: "AUTHZ.LIMIT_EXCEEDED",
        title: "Over your role's limit",
        detail: `This action's value (${attempted.toDb()}) exceeds your role's "${limitKey}" limit of ${effectiveLimit.toDb()}.`,
        errors: [{ path: limitKey, code: "AUTHZ.LIMIT_EXCEEDED", message: `attempted ${attempted.toDb()} > limit ${effectiveLimit.toDb()}` }],
      });
    }
  }
}
