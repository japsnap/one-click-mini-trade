/**
 * Take-profit placement.
 *
 * The take-profit is measured against the liquidation distance:
 *   ratio = take-profit distance / liquidation distance
 * A ratio of 2 means "if I win, I win twice what I risked to the stop".
 *
 * Modes (minimum ratio): Shy >= 1x, Deserved >= 2x (default), Greedy >= 4x.
 * No Set is ever allowed below 1x: risking more than you can win is rejected.
 *
 * After the exact ratio price is computed, it snaps to the nearest "key level"
 * that sits at or beyond it and within a tolerance (default +35% of the target
 * distance). Key levels are:
 *   1. round numbers (65,000 / 65,500 for BTC): many traders park orders there,
 *      so price often reacts at them, and a target just there tends to fill;
 *   2. take-profit prices skilled traders hold right now (from Hyperliquid).
 * Snapping only ever moves the target further away (never below the minimum
 * ratio), so the mode's promise holds. If no key level fits, the exact price is used.
 */
import { estimateLiquidationPrice, liquidationDistance } from "./liquidation";
import { roundToTick } from "./rounding";
import type { Level, Side, TpMode } from "./types";

/** Minimum reward-to-risk ratio for each mode. Units: plain multiplier. */
export const TP_MIN_RATIO: Readonly<Record<TpMode, number>> = { shy: 1, deserved: 2, greedy: 4 };

/** Default tolerance for snapping: a key level may sit up to 35% of the target distance beyond the exact target. */
export const DEFAULT_SNAP_TOLERANCE = 0.35;

/** Thrown when a requested ratio is below 1x. A Set never risks more than it can win. */
export class RatioBelowOneError extends Error {
  constructor(public readonly ratio: number) {
    super(`take-profit ratio ${ratio} is below 1x; a Set never risks more than it aims to win`);
    this.name = "RatioBelowOneError";
  }
}

/**
 * Clean float noise from a ratio: 3.999999999999982 (a target exactly at 4x, computed
 * through binary floats) becomes 4. Rounds to 9 decimal places, far below any tick.
 * Units: plain multiplier.
 */
export function cleanRatio(ratio: number): number {
  return Math.round(ratio * 1e9) / 1e9;
}

/**
 * Reject any ratio below 1 (or not a number).
 * Why: the product rule "never below 1x anywhere".
 * Units: plain multiplier.
 */
export function assertRatioAtLeastOne(ratio: number): void {
  if (!Number.isFinite(ratio) || ratio < 1) throw new RatioBelowOneError(ratio);
}

/**
 * Exact take-profit price for a given ratio.
 * Units: prices in quote per base; ratio a plain multiplier.
 * Buy:  tp = entry + ratio x (entry - liq)
 * Sell: tp = entry - ratio x (liq - entry)
 */
export function exactTakeProfitPrice(entry: number, liquidationPrice: number, side: Side, ratio: number): number {
  assertRatioAtLeastOne(ratio);
  const dist = liquidationDistance(entry, liquidationPrice) * ratio;
  return side === "buy" ? entry + dist : entry - dist;
}

/**
 * The round-number step for a price, chosen by the price's order of magnitude.
 * Rule: 5 x 10^(digits before the decimal point - 3), i.e. half a unit of the
 * third significant digit. Examples: 64,000 -> 500, 3,200 -> 50, 150 -> 5,
 * 24 -> 0.5, 1.2 -> 0.05, 0.25 -> 0.005.
 * Why: these are the numbers humans (and their orders) cluster at.
 * Units: quote per base.
 */
export function roundNumberStep(price: number): number {
  if (!(price > 0)) throw new RangeError(`price must be > 0, got ${price}`);
  const magnitude = Math.floor(Math.log10(price)); // 64,000 -> 4, 3,200 -> 3, 0.25 -> -1
  // toPrecision cleans float noise such as 5 * 10^-3 = 0.005000000000000001.
  return Number((5 * Math.pow(10, magnitude - 2)).toPrecision(12));
}

/**
 * All round numbers between two prices (inclusive), on the step for `refPrice`.
 * Units: quote per base.
 */
export function roundNumbersBetween(low: number, high: number, refPrice: number): number[] {
  const step = roundNumberStep(refPrice);
  const out: number[] = [];
  // Start at the first multiple of step at or above low; walk up to high.
  for (let n = Math.ceil(low / step - 1e-9); n * step <= high + 1e-9; n++) {
    out.push(Number((n * step).toPrecision(12)));
  }
  return out;
}

/** Where the final take-profit came from, for display and logs. */
export type TpSource = "round-number" | "trader-tp" | "exact-ratio";

/** Result of pickTakeProfit. */
export interface TakeProfitPick {
  /** Final take-profit price on the tick grid. Units: quote per base. */
  price: number;
  /** Achieved ratio = |price - entry| / |entry - liquidation|. Always >= the mode minimum. */
  ratio: number;
  /** The mode's minimum ratio. */
  minRatio: number;
  /** Exact price at the minimum ratio, before snapping. */
  exactPrice: number;
  /** Liquidation price used as the yardstick. */
  liquidationPrice: number;
  source: TpSource;
}

/** Inputs for pickTakeProfit. */
export interface PickTakeProfitInput {
  /** Entry price (quote per base). */
  entry: number;
  side: Side;
  /** Leverage multiplier, e.g. 50. */
  leverage: number;
  mode: TpMode;
  /** Symbol tick size, so the result is a valid order price. */
  tickSize: number;
  /** Take-profit prices of skilled traders (weights unused here; any listed TP counts as a key level). */
  traderTakeProfits?: Level[];
  /** Snap window beyond the exact target, as a fraction of the target distance. Default 0.35. */
  tolerance?: number;
  /** Optional maintenance margin rate for the liquidation estimate (see liquidation.ts). Default 0. */
  maintenanceMarginRate?: number;
  /** Optional override of the mode's minimum ratio (must be >= 1). */
  minRatioOverride?: number;
}

/**
 * Pick the take-profit price for a Set.
 * Why: a target at a key level fills more often than an arbitrary number, while
 * never giving up the mode's minimum reward-to-risk ratio.
 * Units: prices quote per base; returned ratio a plain multiplier.
 */
export function pickTakeProfit(input: PickTakeProfitInput): TakeProfitPick {
  const tolerance = input.tolerance ?? DEFAULT_SNAP_TOLERANCE;
  const minRatio = input.minRatioOverride ?? TP_MIN_RATIO[input.mode];
  assertRatioAtLeastOne(minRatio);
  const liq = estimateLiquidationPrice(input.entry, input.leverage, input.side, input.maintenanceMarginRate ?? 0);
  const liqDist = liquidationDistance(input.entry, liq);
  const exact = exactTakeProfitPrice(input.entry, liq, input.side, minRatio);
  const targetDist = Math.abs(exact - input.entry); // distance at the minimum ratio
  const sign = input.side === "buy" ? 1 : -1; // +1: profit is above entry; -1: below

  // Snap window: from the exact target outward by tolerance x target distance.
  const farEdge = exact + sign * tolerance * targetDist;
  // A hair of slack (1e-9 of the distance) so a key level sitting exactly on the
  // target is not lost to float noise in `exact`.
  const slack = targetDist * 1e-9;
  const lo = Math.min(exact, farEdge) - slack;
  const hi = Math.max(exact, farEdge) + slack;

  // Candidate key levels inside the window, tagged by source.
  const candidates: { price: number; source: TpSource }[] = [];
  for (const p of roundNumbersBetween(lo, hi, input.entry)) candidates.push({ price: p, source: "round-number" });
  for (const l of input.traderTakeProfits ?? []) {
    if (Number.isFinite(l.price) && l.price >= lo && l.price <= hi) candidates.push({ price: l.price, source: "trader-tp" });
  }

  // Nearest to the exact target wins (the smallest extra distance asked of the market).
  // On an exact tie a trader TP beats a round number: real money is resting there.
  candidates.sort((a, b) => {
    const d = Math.abs(a.price - exact) - Math.abs(b.price - exact);
    if (d !== 0) return d;
    return a.source === b.source ? 0 : a.source === "trader-tp" ? -1 : 1;
  });

  const chosen = candidates[0];
  // Round AWAY from entry (up for a long, down for a short), so tick rounding can
  // only increase the ratio and never break the mode's minimum.
  const awayMode = input.side === "buy" ? "up" : "down";
  const rawPrice = chosen ? chosen.price : exact;
  const price = roundToTick(rawPrice, input.tickSize, awayMode);
  const ratio = cleanRatio(Math.abs(price - input.entry) / liqDist);
  assertRatioAtLeastOne(ratio); // defensive: cannot fail given the maths above
  return {
    price,
    ratio,
    minRatio,
    exactPrice: exact,
    liquidationPrice: liq,
    source: chosen ? chosen.source : "exact-ratio",
  };
}
