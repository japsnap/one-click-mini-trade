/**
 * Turn a SetPlan into Aster orders, and (live mode only) send them.
 *
 * Each entry is sent with its own take-profit as one OTO strategy order
 * ("One Triggers the Other"): the take-profit leg is placed by Aster only once the
 * entry fills, so a take-profit never sits alone before there is a position.
 * The take-profit is TAKE_PROFIT_MARKET, triggered by the MARK price (one odd trade
 * cannot fire it), reduce-only, with the entry's exact quantity.
 *
 * There is deliberately NO stop-loss leg: the liquidation price is the stop and the
 * isolated margin (the ticket) is the most the user can lose.
 */
import type { SetPlan } from "../src/core/plan";
import type { SymbolRules } from "../src/core/types";
import { formatToStep, isOnStep } from "../src/core/rounding";
import type { AsterClient, StrategySubOrder } from "../src/exchange/aster";

/** One OTO pair ready to sign. */
export interface OtoPair {
  entry: StrategySubOrder;
  takeProfit: StrategySubOrder;
}

/**
 * Pure conversion from plan to the exact strategy legs Aster expects.
 * Why separate from sending: the trial mode shows these legs, and tests check them.
 * hedgeMode: the account's position mode (Hedge needs positionSide and forbids reduceOnly).
 */
export function planToOtoPairs(plan: SetPlan, rules: SymbolRules, hedgeMode: boolean): OtoPair[] {
  const openSide = plan.input.side === "buy" ? "BUY" : "SELL";
  const closeSide = plan.input.side === "buy" ? "SELL" : "BUY";
  const positionSide = hedgeMode ? (plan.input.side === "buy" ? "LONG" : "SHORT") : undefined;
  const pairs: OtoPair[] = [];
  plan.orders.entries.forEach((e, i) => {
    const tp = plan.orders.takeProfits[i];
    if (!tp) throw new Error(`plan has no take-profit for entry ${i + 1}`);
    const qtyStep = e.type === "MARKET" ? rules.marketStepSize : rules.stepSize;
    // Last safety check before signing: values must sit on the exchange grid.
    if (!isOnStep(e.qty, qtyStep)) throw new Error(`entry ${i + 1} quantity ${e.qty} is off the step ${qtyStep}`);
    if (e.price !== null && !isOnStep(e.price, rules.tickSize)) throw new Error(`entry ${i + 1} price ${e.price} is off the tick ${rules.tickSize}`);
    if (!isOnStep(tp.stopPrice, rules.tickSize)) throw new Error(`take-profit ${i + 1} price is off the tick`);

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
    const takeProfit: StrategySubOrder = {
      strategySubId: "2",
      securityType: "USDT_FUTURES",
      symbol: rules.symbol,
      side: closeSide,
      type: "TAKE_PROFIT_MARKET",
      quantity: formatToStep(tp.qty, rules.stepSize),
      stopPrice: formatToStep(tp.stopPrice, rules.tickSize),
      workingType: "MARK_PRICE",
      // One-way mode: reduce-only so the TP can only shrink the position. Hedge mode: positionSide does that job.
      ...(positionSide ? { positionSide } : { reduceOnly: "true" as const }),
      // Driven by leg 1: placed as soon as the entry is partly or fully filled.
      firstDrivenId: "1",
      firstDrivenOn: "PARTIALLY_FILLED_OR_FILLED",
      firstTrigger: "PLACE_ORDER",
    };
    pairs.push({ entry, takeProfit });
  });
  return pairs;
}

/**
 * Send a plan live: isolated margin, leverage, then one OTO per entry.
 * Stops at the first failure and reports what was already sent, so nothing is retried blindly
 * (after an unknown answer the caller must check open orders before trying again).
 */
export async function executeLive(client: AsterClient, plan: SetPlan, rules: SymbolRules) {
  const sent: unknown[] = [];
  await client.ensureIsolated(rules.symbol); // ticket = max loss only holds on isolated margin
  await client.changeLeverage(rules.symbol, plan.input.leverage);
  const hedge = await client.isHedgeMode();
  const pairs = planToOtoPairs(plan, rules, hedge);
  for (const [i, p] of pairs.entries()) {
    try {
      sent.push(await client.placeOto(p.entry, p.takeProfit, `set-${Date.now()}-${i + 1}`));
    } catch (e) {
      return { ok: false as const, sent, failedAt: i + 1, error: (e as Error).message, pairs };
    }
  }
  return { ok: true as const, sent, pairs };
}
