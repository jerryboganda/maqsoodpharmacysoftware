// Blueprint: §2.5 -- exports only the public surface. DocflowModule is @Global (doc numbers,
// fiscal periods, journal posting inject directly); InventoryModule exports StockService.
import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/index.js";
import { TenantContextService } from "../inventory/infrastructure/tenant-context.service.js";
import { CustomersController } from "./api/customers.controller.js";
import { LookupsController } from "./api/lookups.controller.js";
import { SaleInvoicesController } from "./api/sale-invoices.controller.js";
import { CustomersService } from "./application/customers.service.js";
import { LookupsService } from "./application/lookups.service.js";
import { SaleInvoicesService } from "./application/sale-invoices.service.js";

@Module({
  imports: [InventoryModule],
  controllers: [CustomersController, SaleInvoicesController, LookupsController],
  providers: [CustomersService, SaleInvoicesService, LookupsService, TenantContextService],
  exports: [SaleInvoicesService, CustomersService],
})
export class SalesModule {}
