/**
 * Alerts for an open Set, driven by a stream of prices.
 *
 * Two kinds of event:
 *  - "halfway": price has covered half the way from entry to take-profit
 *    (fires once per Set, and never after the result is in);
 *  - "result": the take-profit was hit, the stop fired (2026-11-16: a stop-market at
 *    85% of the liquidation distance), or, for a Set without a stop, the liquidation
 *    price was reached (fires once; after it, the Set is closed and nothing else fires).
 *
 * The function is pure: you pass the previous state and a new price, and get the
 * new state plus any events. That keeps it framework-free and testable; the card
 * (or Blackboard's push service) owns where prices come from and where events go.
 */
import { splitFees, type FeeSplit } from "./fees";
import type { Side } from "./types";

/** The fixed facts of an open Set. Units: prices quote per base; qty base units. */
export interface OpenSet {
  side: Side;
  /** Average fill price of the entry. */
  entry: number;
  takeProfit: number;
  liquidation: number;
  /** Stop trigger price. When set, the stop closes the Set before liquidation can. */
  stop?: number;
  /** Filled quantity. */
  qty: number;
}

/** What has already fired. Start with INITIAL_WATCH_STATE. */
export interface WatchState {
  halfwayFired: boolean;
  result: null | SetOutcome;
}

/** How a Set ended. "stopped" = our stop fired; "liquidated" = the venue closed it (no stop, or a gap past the stop). */
export type SetOutcome = "take-profit" | "stopped" | "liquidated";

export const INITIAL_WATCH_STATE: WatchState = { halfwayFired: false, result: null };

/** An alert event. */
export type SetAlertEvent =
  | { type: "halfway"; price: number; progress: number }
  | { type: "result"; outcome: SetOutcome; price: number; pnlUsd: number; fees: FeeSplit };

/**
 * Share of the way from entry to take-profit, clamped to [0, 1].
 * Why: drives the progress bar and the halfway alert.
 * Units: a fraction; 0 at entry (or worse), 1 at the take-profit.
 */
export function progressToTakeProfit(set: OpenSet, price: number): number {
  const total = set.takeProfit - set.entry; // positive for a long, negative for a short
  if (total === 0) return 0;
  const p = (price - set.entry) / total; // the sign of total makes this work for both sides
  return Math.min(1, Math.max(0, p));
}

/**
 * Profit or loss of the Set at a price, before the profit-share split and exchange fees.
 * Units: USD.
 */
export function pnlAt(set: OpenSet, price: number): number {
  const sign = set.side === "buy" ? 1 : -1;
  return sign * (price - set.entry) * set.qty;
}

/**
 * Feed one new price; get the new state and any events.
 * Why: one place decides "halfway" and "result", so the UI, push alerts and logs agree.
 * Units: price in quote per base.
 */
export function evaluatePrice(set: OpenSet, state: WatchState, price: number): { state: WatchState; events: SetAlertEvent[] } {
  if (state.result !== null || !Number.isFinite(price)) return { state, events: [] }; // closed or bad tick: nothing fires
  const events: SetAlertEvent[] = [];
  const isLong = set.side === "buy";
  // Take-profit orders trigger when price reaches the level (>= for a long, <= for a short).
  const hitTp = isLong ? price >= set.takeProfit : price <= set.takeProfit;
  // Liquidation happens when price reaches the liquidation level against us.
  const hitLiq = isLong ? price <= set.liquidation : price >= set.liquidation;
  // The stop sits between entry and liquidation, so on a falling (long) path it is met first.
  const hitStop = set.stop !== undefined && (isLong ? price <= set.stop : price >= set.stop);

  if (hitTp || hitStop || hitLiq) {
    // A price feed that jumps past both the stop and liquidation between two ticks is
    // reported as "stopped" at the stop: the stop order was resting and triggers first
    // on the venue's mark price. (A real gap can still fill a stop-market worse.)
    const outcome: SetOutcome = hitTp ? "take-profit" : hitStop ? "stopped" : "liquidated";
    // Settle at the level itself (the order's trigger), not the tick that crossed it.
    const settle = hitTp ? set.takeProfit : hitStop ? (set.stop as number) : set.liquidation;
    const pnlUsd = pnlAt(set, settle);
    events.push({ type: "result", outcome, price: settle, pnlUsd, fees: splitFees(pnlUsd) });
    return { state: { ...state, result: outcome }, events };
  }

  const progress = progressToTakeProfit(set, price);
  if (!state.halfwayFired && progress >= 0.5) {
    events.push({ type: "halfway", price, progress });
    return { state: { ...state, halfwayFired: true }, events };
  }
  return { state, events };
}
