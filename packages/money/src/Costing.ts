// Blueprint: docs/system-analysis/08-inventory-logic.md §8.2-§8.3 (the canonical moving-average
// formulas, Verified against 113,561 purchase lines) and 17-technical-blueprint.md §6.2/§6.5
// (AVG_COST DECIMAL(15,5); costing rounds at exactly 5 dp with ROUND_HALF_UP at BOTH steps --
// incoming unit cost and new average -- identical to the legacy T-SQL).
//
// Lives in packages/money because Rule M (17 §6.1) bans decimal arithmetic anywhere else. These
// are pure functions over decimal strings: DB DECIMAL -> string -> here -> string -> DB.
import { Decimal } from "./config.js";

const COST_SCALE = 5; // AVG_COST archetype -- the fifth decimal is load-bearing (C-10 replay gate)

function round5(value: Decimal): string {
  return value.toDecimalPlaces(COST_SCALE, Decimal.ROUND_HALF_UP).toFixed(COST_SCALE);
}

/**
 * 08 §8.2: `UnitCostIn = ROUND(costBasisPrice / packUnits, 5)` -- the per-loose-unit cost of an
 * inbound line. `costBasisPrice` is NetRate when the document's cost_basis is 'net_rate'
 * (bonus-diluted upstream, C-3/C-4), else the gross purchase price -- the CALLER picks which,
 * because it is a per-document accounting policy (08 §8.3), not a global.
 */
export function unitCostIn(costBasisPrice: string, packUnits: number): string {
  if (packUnits < 1 || !Number.isInteger(packUnits)) throw new RangeError(`packUnits must be a positive integer, got ${packUnits}`);
  return round5(new Decimal(costBasisPrice).div(packUnits));
}

/**
 * 08 §8.2: `NewAvgCost = ROUND((StockBefore × AvgBefore + QtyIn × UnitCostIn) / (StockBefore +
 * QtyIn), 5)`. `stockBefore` is the item's total on-hand across all locations in loose units;
 * `qtyIn` includes bonus units (cost-diluting, C-3). When the denominator is zero or negative
 * the incoming cost wins outright (fresh stock after a stock-out).
 */
export function movingAverage(params: {
  readonly stockBefore: string;
  readonly avgBefore: string;
  readonly qtyIn: string;
  readonly unitCostIn: string;
}): string {
  const stockBefore = new Decimal(params.stockBefore);
  const qtyIn = new Decimal(params.qtyIn);
  const denominator = stockBefore.plus(qtyIn);
  if (denominator.lessThanOrEqualTo(0)) return round5(new Decimal(params.unitCostIn));
  const numerator = stockBefore.times(params.avgBefore).plus(qtyIn.times(params.unitCostIn));
  return round5(numerator.div(denominator));
}

/**
 * Extend a per-unit cost to a line cost amount at Money's document scale (15,2 -- 17 §6.2),
 * ROUND_HALF_UP. Used for stock_movement.cost_amount / COGS line amounts.
 */
export function costAmount(qty: string, unitCost: string): string {
  return new Decimal(qty).times(unitCost).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
