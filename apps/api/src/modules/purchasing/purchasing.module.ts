// Blueprint §2.5 -- exports only the public surface. DocNumber/FiscalPeriod/Journal services
// come from the global DocflowModule (no import needed); Stock/Costing come from
// InventoryModule (built in parallel; it exports both).
import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { PurchaseCategoriesController } from "./api/purchase-categories.controller.js";
import { PurchaseInvoicesController } from "./api/purchase-invoices.controller.js";
import { PurchaseOrdersController } from "./api/purchase-orders.controller.js";
import { PurchaseReturnsController } from "./api/purchase-returns.controller.js";
import { SuppliersController } from "./api/suppliers.controller.js";
import { PurchaseCategoriesService } from "./application/purchase-categories.service.js";
import { PurchaseInvoiceService } from "./application/purchase-invoice.service.js";
import { PurchaseOrderService } from "./application/purchase-order.service.js";
import { PurchaseReturnService } from "./application/purchase-return.service.js";
import { SupplierService } from "./application/supplier.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [
    SuppliersController,
    PurchaseInvoicesController,
    PurchaseOrdersController,
    PurchaseReturnsController,
    PurchaseCategoriesController,
  ],
  // TenantContextService is provided per-module (InventoryModule does not export it) -- the
  // same dev-tenancy resolution pattern the inventory module uses, not a hard-coded 1/1.
  providers: [
    SupplierService,
    PurchaseInvoiceService,
    PurchaseOrderService,
    PurchaseReturnService,
    PurchaseCategoriesService,
    TenantContextService,
  ],
  exports: [SupplierService, PurchaseInvoiceService, PurchaseOrderService, PurchaseReturnService],
})
export class PurchasingModule {}
