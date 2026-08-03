// The public surface of `inventory` (§2.5): the module plus the two posting services other
// document modules (purchasing, sales) call inside their own transactions.
export { InventoryModule } from "./inventory.module.js";
export { StockService } from "./infrastructure/stock.service.js";
export type { FefoAllocation, MovementInput } from "./infrastructure/stock.service.js";
export { CostingService } from "./infrastructure/costing.service.js";
export type { ApplyInboundCostInput } from "./infrastructure/costing.service.js";
