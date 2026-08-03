// Read-only lookups so /sale-invoices and /customers create forms have real, admin-curated
// choices instead of hardcoded ids: sale_category (§T74) and payment_method (§T94).
import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { getDb, paymentMethods, saleCategories } from "@pharmacy/db";

import type { Actor } from "../../../common/auth/actor.js";
import { TenantContextService } from "../../inventory/infrastructure/tenant-context.service.js";

@Injectable()
export class LookupsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async listSaleCategories(actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const rows = await db
      .select({
        saleCategoryId: saleCategories.saleCategoryId,
        code: saleCategories.code,
        name: saleCategories.name,
        description: saleCategories.description,
        counterparty: saleCategories.counterparty,
        isReturn: saleCategories.isReturn,
        affectsStock: saleCategories.affectsStock,
        isDefault: saleCategories.isDefault,
        sortOrder: saleCategories.sortOrder,
      })
      .from(saleCategories)
      .where(and(eq(saleCategories.tenantId, tenantId), eq(saleCategories.isEnabled, true)))
      .orderBy(asc(saleCategories.sortOrder));
    return { saleCategories: rows };
  }

  async listPaymentMethods(actor: Actor) {
    const db = getDb();
    const { tenantId } = await this.tenantContext.resolveScope(actor);
    const rows = await db
      .select({
        paymentMethodId: paymentMethods.paymentMethodId,
        code: paymentMethods.code,
        name: paymentMethods.name,
        description: paymentMethods.description,
        isCounterMethod: paymentMethods.isCounterMethod,
        requiresReference: paymentMethods.requiresReference,
        requiresChequeDetails: paymentMethods.requiresChequeDetails,
        isDefault: paymentMethods.isDefault,
        sortOrder: paymentMethods.sortOrder,
      })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.tenantId, tenantId), eq(paymentMethods.isEnabled, true)))
      .orderBy(asc(paymentMethods.sortOrder));
    return { paymentMethods: rows };
  }
}
