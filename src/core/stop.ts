/**
 * The stop: a reduce-only stop-market order placed just before liquidation.
 *
 * Rule (decided 2026-11-16): the stop sits at 85% of the distance from entry to the
 * liquidation price.
 *   Buy:  stop = entry - 0.85 x (entry - liquidation)
 *   Sell: stop = entry + 0.85 x (liquidation - entry)
 *
 * Why a stop at all, when isolated margin already caps the loss at the ticket:
 *  1. Smaller loss. Stopped at 85% of the way, the user loses about 85% of the margin
 *     that liquidation would take, and keeps the rest. Liquidation takes all of it, and
 *     Aster also charges a liquidation fee on top (exchangeInfo "liquidationFee", 0.025
 *     = 2.5% of notional for BTCUSDT on 2026-11-16).
 *  2. Builder fee. A stop is a normal signed order, so Blackboard's builder fields ride
 *     on it and the close earns the builder fee. A forced liquidation is executed by
 *     the venue, not by a signed order of ours, so it most likely carries no builder fee.
 *
 * Where the liquidation price comes from:
 *  - BEFORE the fill (planning): an estimate (liquidation.ts) using the maintenance
 *    margin rate from Aster's leverage brackets when we have them (signed endpoint,
 *    live mode only), else an ASSUMED rate (DEFAULT_ASSUMED_MAINTENANCE_RATE). The
 *    assumption matters: with no maintenance margin at all, the estimate puts
 *    liquidation too far away, and 85% of a too-long distance can land BEYOND the real
 *    liquidation, where the stop would never fire. Example, 100x with a real rate of
 *    0.4%: plain distance 1%, real distance 0.6%, 85% of the plain one = 0.85%.
 *  - AFTER the fill: the exchange's own figure, Aster GET /fapi/v3/positionRisk
 *    "liquidationPrice" (signed). The stop is then re-computed from it (see
 *    stopFromPositionRisk in src/exchange/aster.ts and reconcileStop in server/execute.ts).
 *
 * The take-profit ratio is measured against the STOP distance, because that is the
 * real loss (see takeProfit.ts).
 */
import { estimateLiquidationPrice, liquidationDistance } from "./liquidation";
import { roundToTick } from "./rounding";
import type { LeverageBracket, Side } from "./types";

/** Share of the liquidation distance at which the stop sits. 0.85 = 85%. */
export const STOP_FRACTION_OF_LIQUIDATION = 0.85;

/**
 * Maintenance margin rate assumed when Aster's brackets are not available (trial mode,
 * or a Blackboard deployment that has not fetched them). 0.005 = 0.5%.
 * Why 0.5%: a little ABOVE the usual first-bracket rate on Binance-style venues (0.4%
 * for BTC), so the estimated liquidation sits a little NEARER than the real one and the
 * 85% stop stays in front of it. A Set's position is at most $100 x 100 = $10,000, the
 * first bracket on every major symbol. Must stay below 1/leverage (1% at 100x).
 */
export const DEFAULT_ASSUMED_MAINTENANCE_RATE = 0.005;

/** Where the maintenance rate came from, shown in the plan and the log. */
export type MaintenanceSource = "brackets" | "assumed";

/** Thrown when the stop cannot sit strictly between entry and liquidation. */
export class InvalidStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStopError";
  }
}

/**
 * The maintenance margin rate for a position of `notionalUsd`.
 * Uses the bracket whose [notionalFloor, notionalCap) holds the notional; refuses a
 * leverage above that bracket's initialLeverage (the venue would reject the order).
 * Without brackets, the assumed rate is used.
 * Units: notionalUsd USD; leverage multiplier; result a decimal fraction.
 */
export function resolveMaintenanceRate(args: {
  notionalUsd: number;
  leverage: number;
  brackets?: LeverageBracket[] | null;
  assumedRate?: number;
}): { rate: number; source: MaintenanceSource } {
  const { notionalUsd, leverage } = args;
  let rate: number;
  let source: MaintenanceSource;
  const brackets = (args.brackets ?? []).filter(
    (b) => Number.isFinite(b.maintMarginRatio) && b.maintMarginRatio >= 0 && b.notionalCap > b.notionalFloor,
  );
  if (brackets.length > 0) {
    const b = brackets.find((x) => notionalUsd >= x.notionalFloor && notionalUsd < x.notionalCap);
    if (!b) throw new RangeError(`no leverage bracket holds a $${notionalUsd} position`);
    if (leverage > b.initialLeverage) {
      throw new RangeError(`leverage ${leverage}x is above the venue's ${b.initialLeverage}x for a $${notionalUsd} position`);
    }
    rate = b.maintMarginRatio;
    source = "brackets";
  } else {
    rate = args.assumedRate ?? DEFAULT_ASSUMED_MAINTENANCE_RATE;
    source = "assumed";
  }
  // A rate at or above 1/leverage would liquidate the position the moment it opens.
  if (!(rate >= 0 && rate < 1 / leverage)) {
    throw new RangeError(`maintenance rate ${rate} is not below 1/leverage (${1 / leverage}) at ${leverage}x`);
  }
  return { rate, source };
}

/**
 * Stop price from an entry and a liquidation price.
 * Rounded to the tick TOWARD the entry (up for a long, down for a short): the stop can
 * only move away from liquidation, never past it.
 * Units: prices quote per base; fraction a decimal (0.85 = 85%).
 */
export function stopPriceFromLiquidation(
  entry: number,
  liquidationPrice: number,
  side: Side,
  tickSize: number,
  fraction: number = STOP_FRACTION_OF_LIQUIDATION,
): number {
  if (!(entry > 0) || !(liquidationPrice > 0)) throw new InvalidStopError("entry and liquidation must be positive prices");
  if (!(fraction > 0 && fraction < 1)) throw new InvalidStopError(`stop fraction must be between 0 and 1, got ${fraction}`);
  const liqOnRightSide = side === "buy" ? liquidationPrice < entry : liquidationPrice > entry;
  if (!liqOnRightSide) throw new InvalidStopError(`liquidation ${liquidationPrice} is on the wrong side of entry ${entry} for a ${side}`);
  const dist = liquidationDistance(entry, liquidationPrice) * fraction; // price units
  const raw = side === "buy" ? entry - dist : entry + dist;
  const stop = roundToTick(raw, tickSize, side === "buy" ? "up" : "down");
  // Must sit strictly between liquidation and entry, or it is useless (at liquidation)
  // or fires at once (at entry). A distance under one tick ends up here.
  const between = side === "buy" ? stop > liquidationPrice && stop < entry : stop < liquidationPrice && stop > entry;
  if (!between) throw new InvalidStopError(`stop ${stop} is not strictly between entry ${entry} and liquidation ${liquidationPrice}`);
  return stop;
}

/** Everything the plan needs about the downside of one entry. Units: quote per base. */
export interface StopPlan {
  /** Estimated liquidation price at this entry. */
  liquidationPrice: number;
  /** The reduce-only stop-market trigger price. */
  stopPrice: number;
  /** |entry - stop|: the real loss distance, the yardstick of the take-profit ratio. */
  riskDistance: number;
  /** Maintenance margin rate used for the liquidation estimate (decimal). */
  maintenanceMarginRate: number;
  maintenanceSource: MaintenanceSource;
  /** Share of the liquidation distance the stop sits at (0.85). */
  fractionOfLiquidation: number;
}

/**
 * Liquidation estimate plus stop for one entry, before the fill.
 * Units: entry quote per base; leverage multiplier; rate decimal.
 */
export function planStop(args: {
  entry: number;
  side: Side;
  leverage: number;
  tickSize: number;
  maintenanceMarginRate: number;
  maintenanceSource: MaintenanceSource;
  fraction?: number;
}): StopPlan {
  const fraction = args.fraction ?? STOP_FRACTION_OF_LIQUIDATION;
  const liquidationPrice = estimateLiquidationPrice(args.entry, args.leverage, args.side, args.maintenanceMarginRate);
  const stopPrice = stopPriceFromLiquidation(args.entry, liquidationPrice, args.side, args.tickSize, fraction);
  return {
    liquidationPrice,
    stopPrice,
    riskDistance: Math.abs(args.entry - stopPrice),
    maintenanceMarginRate: args.maintenanceMarginRate,
    maintenanceSource: args.maintenanceSource,
    fractionOfLiquidation: fraction,
  };
}
