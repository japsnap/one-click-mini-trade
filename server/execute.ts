/**
 * Turn a SetPlan into Aster orders, and (live mode only) send them.
 *
 * Since 2026-11-16 each entry is sent with its own take-profit AND its own stop as one
 * OTOCO strategy order ("One Triggers, One Cancels the Other", POST
 * /fapi/v3/placeStrategyOrder, exactly 3 legs):
 *   leg 1  entry (MARKET or LIMIT GTC)
 *   leg 2  take-profit, TAKE_PROFIT_MARKET, reduce-only, placed once leg 1 fills;
 *          cancelled if leg 3 fills
 *   leg 3  stop, STOP_MARKET at 85% of the liquidation distance (core/stop.ts),
 *          reduce-only, placed once leg 1 fills; cancelled if leg 2 fills
 * Both exits trigger on the MARK price (one odd trade cannot fire them; Aster liquidates
 * on the mark price too, so the stop and liquidation are compared on the same price).
 *
 * The V3 doc lists OTOCO and the secondDrivenId / secondDrivenOn / secondTrigger fields
 * but prints no OTOCO example; the leg wiring below is our reading of those fields and
 * is unproven until the first live $10 Set (README "Open items").
 *
 * After a fill, reconcileStop() re-reads the venue's own liquidation price
 * (signed GET /fapi/v3/positionRisk) and moves the stop to 85% of THAT distance when the
 * pre-fill estimate was off by more than one tick.
 */
import type { SetPlan } from "../src/core/plan";
import type { SymbolRules } from "../src/core/types";
import { formatToStep, isOnStep } from "../src/core/rounding";
import { parsePositionRisk, stopFromPositionRisk, type AsterClient, type StrategySubOrder } from "../src/exchange/aster";

/** One entry with its two exits, ready to sign as one OTOCO. */
export interface SetLegs {
  entry: StrategySubOrder;
  takeProfit: StrategySubOrder;
  stop: StrategySubOrder;
}

/**
 * Pure conversion from plan to the exact strategy legs Aster expects.
 * Why separate from sending: the trial mode shows these legs, and tests check them.
 * hedgeMode: the account's position mode (Hedge needs positionSide and forbids reduceOnly).
 */
export function planToSetLegs(plan: SetPlan, rules: SymbolRules, hedgeMode: boolean): SetLegs[] {
  const openSide: "BUY" | "SELL" = plan.input.side === "buy" ? "BUY" : "SELL";
  const closeSide: "BUY" | "SELL" = plan.input.side === "buy" ? "SELL" : "BUY";
  const positionSide: "LONG" | "SHORT" | undefined = hedgeMode ? (plan.input.side === "buy" ? "LONG" : "SHORT") : undefined;
  const out: SetLegs[] = [];
  plan.orders.entries.forEach((e, i) => {
    const tp = plan.orders.takeProfits[i];
    const sl = plan.orders.stops[i];
    if (!tp) throw new Error(`plan has no take-profit for entry ${i + 1}`);
    if (!sl) throw new Error(`plan has no stop for entry ${i + 1}`);
    const qtyStep = e.type === "MARKET" ? rules.marketStepSize : rules.stepSize;
    // Last safety checks before signing: values on the exchange grid, exits on the right sides.
    if (!isOnStep(e.qty, qtyStep)) throw new Error(`entry ${i + 1} quantity ${e.qty} is off the step ${qtyStep}`);
    if (e.price !== null && !isOnStep(e.price, rules.tickSize)) throw new Error(`entry ${i + 1} price ${e.price} is off the tick ${rules.tickSize}`);
    if (!isOnStep(tp.stopPrice, rules.tickSize)) throw new Error(`take-profit ${i + 1} price is off the tick`);
    if (!isOnStep(sl.stopPrice, rules.tickSize)) throw new Error(`stop ${i + 1} price is off the tick`);
    const ref = e.price ?? plan.entry.expectedFillPrice;
    const isLong = plan.input.side === "buy";
    if (isLong ? !(sl.stopPrice < ref && tp.stopPrice > ref) : !(sl.stopPrice > ref && tp.stopPrice < ref)) {
      throw new Error(`leg ${i + 1}: stop ${sl.stopPrice} and take-profit ${tp.stopPrice} are not on opposite sides of entry ${ref}`);
    }
    if (isLong ? !(sl.stopPrice > plan.liquidationPrice) : !(sl.stopPrice < plan.liquidationPrice)) {
      // Draw legs each carry their own stop, so only the single-entry modes are held to the plan's liquidation.
      if (plan.orders.entries.length === 1) throw new Error(`stop ${sl.stopPrice} is beyond the liquidation estimate ${plan.liquidationPrice}`);
    }

    const entry: StrategySubOrder = {
      strategySubId: "1",
      securityType: "USDT_FUTURES",
      symbol: rules.symbol,
      side: openSide,
      type: e.type,
      quantity: formatToStep(e.qty, qtyStep),
      ...(positionSide ? { positionSide } : {}),
      ...(e.type === "LIMIT" && e.price !== null ? { price: formatToStep(e.price, rules.tickSize), timeInForce: "GTC" as const } : {}),
    };
    // Shared fields of the two exits. One-way mode: reduce-only so an exit can only shrink
    // the position. Hedge mode: positionSide does that job (reduceOnly is not allowed there).
    const exitBase = {
      securityType: "USDT_FUTURES" as const,
      symbol: rules.symbol,
      side: closeSide,
      workingType: "MARK_PRICE" as const,
      ...(positionSide ? { positionSide } : { reduceOnly: "true" as const }),
      // Placed by leg 1 as soon as the entry is partly or fully filled.
      firstDrivenId: "1",
      firstDrivenOn: "PARTIALLY_FILLED_OR_FILLED" as const,
      firstTrigger: "PLACE_ORDER" as const,
      secondDrivenOn: "FILLED" as const,
      secondTrigger: "CANCEL_ORDER" as const,
    };
    const takeProfit: StrategySubOrder = {
      ...exitBase,
      strategySubId: "2",
      type: "TAKE_PROFIT_MARKET",
      quantity: formatToStep(tp.qty, rules.stepSize),
      stopPrice: formatToStep(tp.stopPrice, rules.tickSize),
      secondDrivenId: "3", // the stop filling cancels the take-profit
    };
    const stop: StrategySubOrder = {
      ...exitBase,
      strategySubId: "3",
      type: "STOP_MARKET",
      quantity: formatToStep(sl.qty, rules.stepSize),
      stopPrice: formatToStep(sl.stopPrice, rules.tickSize),
      secondDrivenId: "2", // the take-profit filling cancels the stop
    };
    out.push({ entry, takeProfit, stop });
  });
  return out;
}

/**
 * Send a plan live: isolated margin, leverage, then one OTOCO per entry.
 * Stops at the first failure and reports what was already sent, so nothing is retried blindly
 * (after an unknown answer the caller must check open orders before trying again).
 */
export async function executeLive(client: AsterClient, plan: SetPlan, rules: SymbolRules) {
  const sent: unknown[] = [];
  await client.ensureIsolated(rules.symbol); // ticket = max loss only holds on isolated margin
  await client.changeLeverage(rules.symbol, plan.input.leverage);
  const hedge = await client.isHedgeMode();
  const legs = planToSetLegs(plan, rules, hedge);
  for (const [i, l] of legs.entries()) {
    try {
      sent.push(await client.placeOtoco(l.entry, l.takeProfit, l.stop, `set-${Date.now()}-${i + 1}`));
    } catch (e) {
      return { ok: false as const, sent, failedAt: i + 1, error: (e as Error).message, legs };
    }
  }
  return { ok: true as const, sent, legs };
}

/**
 * After a fill: compare the planned stop with 85% of the distance to Aster's REAL
 * liquidation price, and (only when `apply` is true) replace it.
 *  - Reads signed GET /fapi/v3/positionRisk.
 *  - No open position, or no liquidation price reported -> nothing changes, reason given.
 *  - Off by one tick or less -> nothing changes.
 *  - Otherwise, with apply: cancel the old stop (orderId from the strategy's sub-orders,
 *    passed in by the caller) and send a new reduce-only STOP_MARKET for the position's
 *    size; builder fields ride on it (AsterClient.newOrder adds them).
 * Live use only; never called by the demo server in trial mode.
 */
export async function reconcileStop(
  client: AsterClient,
  plan: SetPlan,
  rules: SymbolRules,
  opts: { currentStopPrice: number; currentStopOrderId?: string; hedgeMode: boolean; apply: boolean },
) {
  const hedgeSide: "LONG" | "SHORT" | undefined = opts.hedgeMode ? (plan.input.side === "buy" ? "LONG" : "SHORT") : undefined;
  const row = parsePositionRisk(await client.positionRisk(rules.symbol), rules.symbol, hedgeSide);
  if (!row) return { changed: false as const, reason: "no open position on the venue" };
  let target: number;
  try {
    target = stopFromPositionRisk(row, rules.tickSize).stopPrice;
  } catch (e) {
    return { changed: false as const, reason: `kept the planned stop: ${(e as Error).message}` };
  }
  if (Math.abs(target - opts.currentStopPrice) <= rules.tickSize + 1e-12) {
    return { changed: false as const, reason: "planned stop already within one tick of the venue's figure", target };
  }
  if (!opts.apply) return { changed: false as const, reason: "dry run", target, venueLiquidation: row.liquidationPrice };
  if (opts.currentStopOrderId) await client.cancelOrder(rules.symbol, opts.currentStopOrderId);
  const placed = await client.newOrder({
    symbol: rules.symbol,
    side: row.positionAmt > 0 ? "SELL" : "BUY",
    type: "STOP_MARKET",
    quantity: formatToStep(Math.abs(row.positionAmt), rules.stepSize),
    stopPrice: formatToStep(target, rules.tickSize),
    workingType: "MARK_PRICE",
    ...(hedgeSide ? { positionSide: hedgeSide } : { reduceOnly: "true" as const }),
  });
  return { changed: true as const, target, venueLiquidation: row.liquidationPrice, placed };
}
