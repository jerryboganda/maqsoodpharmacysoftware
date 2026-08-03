// Resolves the tenant/branch scope for the current actor.
//
// TODO(real tenancy): like session.guard.ts's dev-mode stub, this resolves scope honestly from
// the seeded data rather than hard-coding `1`/`1` -- the actor's `app_user` row carries its
// tenant, and the tenant's default branch is the working branch. Once `Actor` carries
// tenantId/branchId (real session + branch selection UI), delete this service and read them off
// the actor instead. Multi-branch request scoping (a till selecting its branch) is a real gap
// tracked here, not silently assumed away (same contract as settings' OptionsRepository header).
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { appUsers, branches, getDb } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { BusinessRuleException } from "../../../common/errors/index.js";

export interface TenantBranchScope {
  readonly tenantId: number;
  readonly branchId: number;
}

@Injectable()
export class TenantContextService {
  async resolveScope(actor: Actor): Promise<TenantBranchScope> {
    const db = getDb();
    const userId = Number(actor.userId);
    if (!Number.isInteger(userId)) {
      throw new BusinessRuleException("TENANCY.UNRESOLVED", "Unknown actor", "The current actor has no usable user id.");
    }

    const [user] = await db
      .select({ tenantId: appUsers.tenantId })
      .from(appUsers)
      .where(eq(appUsers.userId, userId));
    if (!user || user.tenantId === null) {
      throw new BusinessRuleException(
        "TENANCY.UNRESOLVED",
        "No tenant",
        "The current user is not attached to a tenant; inventory is tenant-scoped.",
      );
    }

    const [branch] = await db
      .select({ branchId: branches.branchId })
      .from(branches)
      .where(and(eq(branches.tenantId, user.tenantId), eq(branches.isDefault, true)));
    if (!branch) {
      throw new BusinessRuleException(
        "TENANCY.NO_DEFAULT_BRANCH",
        "No default branch",
        "The tenant has no default branch configured.",
      );
    }

    return { tenantId: user.tenantId, branchId: branch.branchId };
  }
}
