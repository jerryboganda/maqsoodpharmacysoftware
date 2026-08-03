// Inventory module (§2.3 module #4). DocflowModule is @Global() -- DocNumberService,
// FiscalPeriodService and JournalService are injected directly without an import here.
// StockService + CostingService are exported: purchasing and sales post THROUGH them (they are
// the only writers of stock_movement / item_cost_snapshot).
import { Module } from "@nestjs/common";

import { StockAdjustmentService } from "./application/stock-adjustment.service.js";
import { StockQueryService } from "./application/stock-query.service.js";
import { StockAdjustmentsController } from "./api/stock-adjustments.controller.js";
import { StockController } from "./api/stock.controller.js";
import { CostingService } from "./infrastructure/costing.service.js";
import { StockService } from "./infrastructure/stock.service.js";
import { TenantContextService } from "./infrastructure/tenant-context.service.js";

@Module({
  controllers: [StockController, StockAdjustmentsController],
  providers: [StockService, CostingService, TenantContextService, StockQueryService, StockAdjustmentService],
  exports: [StockService, CostingService],
})
export class InventoryModule {}
