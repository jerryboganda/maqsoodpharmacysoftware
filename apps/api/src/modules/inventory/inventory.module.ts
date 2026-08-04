// Inventory module (§2.3 module #4). DocflowModule is @Global() -- DocNumberService,
// FiscalPeriodService and JournalService are injected directly without an import here.
// StockService + CostingService are exported: purchasing and sales post THROUGH them (they are
// the only writers of stock_movement / item_cost_snapshot).
import { Module } from "@nestjs/common";

import { AdjustmentReasonsService } from "./application/adjustment-reasons.service.js";
import { StockAdjustmentService } from "./application/stock-adjustment.service.js";
import { StockLotService } from "./application/stock-lot.service.js";
import { StockQueryService } from "./application/stock-query.service.js";
import { StockTakeService } from "./application/stock-take.service.js";
import { AdjustmentReasonsController } from "./api/adjustment-reasons.controller.js";
import { ExpiryController } from "./api/expiry.controller.js";
import { StockAdjustmentsController } from "./api/stock-adjustments.controller.js";
import { StockController } from "./api/stock.controller.js";
import { StockTakesController } from "./api/stock-takes.controller.js";
import { CostingService } from "./infrastructure/costing.service.js";
import { StockService } from "./infrastructure/stock.service.js";
import { TenantContextService } from "./infrastructure/tenant-context.service.js";

@Module({
  controllers: [
    StockController,
    StockAdjustmentsController,
    AdjustmentReasonsController,
    ExpiryController,
    StockTakesController,
  ],
  providers: [
    StockService,
    CostingService,
    TenantContextService,
    StockQueryService,
    StockAdjustmentService,
    AdjustmentReasonsService,
    StockLotService,
    // Thin orchestration over StockAdjustmentService -- see stock-take.service.ts's header
    // comment. Depends on it directly (same module, both providers) rather than through
    // `exports` (that array is for OTHER modules; within this module, Nest wires providers to
    // each other's constructors regardless of the exports list).
    StockTakeService,
  ],
  exports: [StockService, CostingService],
})
export class InventoryModule {}
