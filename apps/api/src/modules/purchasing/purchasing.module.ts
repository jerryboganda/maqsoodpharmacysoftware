// Blueprint §2.5 -- exports only the public surface. DocNumber/FiscalPeriod/Journal services
// come from the global DocflowModule (no import needed); Stock/Costing come from
// InventoryModule (built in parallel; it exports both).
import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { PurchaseInvoicesController } from "./api/purchase-invoices.controller.js";
import { SuppliersController } from "./api/suppliers.controller.js";
import { PurchaseInvoiceService } from "./application/purchase-invoice.service.js";
import { SupplierService } from "./application/supplier.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [SuppliersController, PurchaseInvoicesController],
  // TenantContextService is provided per-module (InventoryModule does not export it) -- the
  // same dev-tenancy resolution pattern the inventory module uses, not a hard-coded 1/1.
  providers: [SupplierService, PurchaseInvoiceService, TenantContextService],
  exports: [SupplierService, PurchaseInvoiceService],
})
export class PurchasingModule {}
