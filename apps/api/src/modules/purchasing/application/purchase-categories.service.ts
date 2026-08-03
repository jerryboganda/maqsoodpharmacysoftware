// Read-only lookup so /purchase-invoices create forms have real, admin-curated category
// choices (purchase_category, §T84).
import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { getDb, purchaseCategories } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";

@Injectable()
export class PurchaseCategoriesService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const rows = await db
      .select({
        purchaseCategoryId: purchaseCategories.purchaseCategoryId,
        code: purchaseCategories.code,
        name: purchaseCategories.name,
        description: purchaseCategories.description,
        qtyBasis: purchaseCategories.qtyBasis,
        counterparty: purchaseCategories.counterparty,
        isReturn: purchaseCategories.isReturn,
        isOpening: purchaseCategories.isOpening,
        isDefault: purchaseCategories.isDefault,
        sortOrder: purchaseCategories.sortOrder,
      })
      .from(purchaseCategories)
      .where(and(eq(purchaseCategories.tenantId, tenantId), eq(purchaseCategories.isEnabled, true)))
      .orderBy(asc(purchaseCategories.sortOrder));
    return { purchaseCategories: rows };
  }
}
