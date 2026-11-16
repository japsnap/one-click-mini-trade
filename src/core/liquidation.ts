/**
 * Liquidation price estimate for an isolated-margin perpetual position.
 *
 * A Set has no stop-loss on purpose: the liquidation price IS the stop, and the
 * ticket (the margin) is the most the user can lose. This file estimates where
 * that liquidation sits, so the take-profit can be placed at a multiple of the
 * same distance (see takeProfit.ts).
 *
 * The basic estimate ignores maintenance margin:
 *   Buy (long):   liq = entry x (1 - 1/leverage)
 *   Sell (short): liq = entry x (1 + 1/leverage)
 * At 50x a long is liquidated after a 2% fall (1/50 = 0.02).
 *
 * Optional maintenance-margin adjustment. The exchange liquidates a little earlier,
 * when the remaining margin falls to the maintenance margin (a percentage of the
 * position value, "maintMarginRatio" in Aster's leverage brackets). With
 * maintenance margin rate m the isolated estimate becomes:
 *   Buy:  liq = entry x (1 - 1/leverage + m)
 *   Sell: liq = entry x (1 + 1/leverage - m)
 * So at 50x with m = 0.005 a long is liquidated after a 1.5% fall, not 2%.
 * Fees and funding move the real price slightly; the exchange's own figure
 * (positionRisk.liquidationPrice) is the truth once the position is open.
 */
import type { Side } from "./types";

/**
 * Estimate the liquidation price of an isolated position.
 * Why: it is the Set's stop and the yardstick for the take-profit distance.
 * Units: entry and result in quote currency per base unit; leverage a plain multiplier (50 = 50x);
 * maintenanceMarginRate a decimal fraction (0.005 = 0.5%), default 0 (the plain estimate).
 */
export function estimateLiquidationPrice(
  entry: number,
  leverage: number,
  side: Side,
  maintenanceMarginRate = 0,
): number {
  if (!(entry > 0)) throw new RangeError(`entry must be > 0, got ${entry}`);
  if (!(leverage >= 1)) throw new RangeError(`leverage must be >= 1, got ${leverage}`);
  if (maintenanceMarginRate < 0 || maintenanceMarginRate >= 1 / leverage) {
    // A maintenance rate at or above 1/leverage would liquidate the position the moment it opens.
    throw new RangeError(`maintenanceMarginRate must be in [0, 1/leverage), got ${maintenanceMarginRate}`);
  }
  // Fraction of the entry price the market can move against us before liquidation.
  const adverseMove = 1 / leverage - maintenanceMarginRate;
  return side === "buy" ? entry * (1 - adverseMove) : entry * (1 + adverseMove);
}

/**
 * Distance from entry to liquidation, always positive.
 * Units: quote currency per base unit (USDT per BTC).
 */
export function liquidationDistance(entry: number, liquidationPrice: number): number {
  return Math.abs(entry - liquidationPrice);
}
