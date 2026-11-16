/**
 * Draw mode: split one ticket into a small ladder of orders.
 *
 * The user paints two bands on a vertical price strip: an In band (where to
 * enter) and an Out band (where to take profit). Only price matters, not time.
 * The ticket's position size (ticket x leverage) is split into the SMALLEST set of
 * orders the market allows, at most 5:
 *   N = min(5, floor(notional / per-order minimum))
 * where the per-order minimum is the larger of the exchange's MIN_NOTIONAL and
 * minQty x the highest In-band price (the order with the smallest quantity).
 * N entry limits are spread evenly across the In band, each nudged (nudge.ts),
 * and N reduce-only take-profits are spread evenly across the Out band, one per
 * entry with the same quantity, so a partly filled ladder only closes what it opened.
 * A $10 ticket on BTC can end up as a single order.
 *
 * Draw ignores the Shy/Deserved/Greedy minimum (the user chose the Out band),
 * but still never allows a take-profit below 1x the liquidation distance.
 */
import { estimateLiquidationPrice, liquidationDistance } from "./liquidation";
import { nudgePrice, DEFAULT_NUDGE_FRACTION } from "./nudge";
import { floorToStep, roundToTick } from "./rounding";
import { cleanRatio, RatioBelowOneError } from "./takeProfit";
import type { DrawBands, PriceBand, RandomSource, Side, SymbolRules } from "./types";

/** Hard cap on the number of entry orders per Set. */
export const MAX_DRAW_ORDERS = 5;

/** One leg of the ladder. Units: price quote per base; qty base units. */
export interface DrawLeg {
  price: number;
  qty: number;
}

/** Result of splitDraw. */
export interface DrawPlan {
  /** Entry limits, lowest price first. */
  entries: DrawLeg[];
  /** Reduce-only take-profits, lowest price first, paired by index with entries (same qty). */
  takeProfits: DrawLeg[];
  /** Quantity-weighted average entry price. Units: quote per base. */
  averageEntry: number;
  /** Liquidation estimate at the average entry, assuming every entry fills. */
  liquidationPrice: number;
  /** Smallest ratio among the take-profits vs the liquidation distance. Always >= 1. */
  minRatio: number;
  /** Total quantity across entries. Units: base. */
  totalQty: number;
  /** Total notional at entry prices. Units: USD. */
  totalNotionalUsd: number;
}

/** Thrown when the ticket cannot make even one order the exchange would accept. */
export class TicketTooSmallError extends Error {
  constructor(notionalUsd: number, perOrderMinUsd: number) {
    super(`position $${notionalUsd.toFixed(2)} is below the smallest allowed order $${perOrderMinUsd.toFixed(2)}`);
    this.name = "TicketTooSmallError";
  }
}

/** Thrown when the painted bands are invalid (wrong order, overlapping, non-positive). */
export class InvalidBandsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBandsError";
  }
}

/**
 * Evenly spaced prices across a band: 1 price -> the middle; n prices -> both edges and n-2 between.
 * Units: quote per base.
 */
export function spreadAcross(band: PriceBand, n: number): number[] {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`n must be a positive integer, got ${n}`);
  if (n === 1) return [(band.low + band.high) / 2];
  const gap = (band.high - band.low) / (n - 1);
  return Array.from({ length: n }, (_, i) => band.low + i * gap);
}

/**
 * Check the two bands make sense for the side.
 * Buy: the whole Out band must sit above the whole In band. Sell: below it.
 */
export function validateBands(side: Side, bands: DrawBands): void {
  const named: Array<[string, PriceBand]> = [
    ["In", bands.inBand],
    ["Out", bands.outBand],
  ];
  for (const [name, b] of named) {
    if (!Number.isFinite(b.low) || !Number.isFinite(b.high) || !(b.low > 0) || !(b.high > 0)) {
      throw new InvalidBandsError(`${name} band prices must be positive numbers`);
    }
    if (b.low > b.high) throw new InvalidBandsError(`${name} band low is above its high`);
  }
  if (side === "buy" && !(bands.outBand.low > bands.inBand.high)) {
    throw new InvalidBandsError("for a Buy, the Out band must sit entirely above the In band");
  }
  if (side === "sell" && !(bands.outBand.high < bands.inBand.low)) {
    throw new InvalidBandsError("for a Sell, the Out band must sit entirely below the In band");
  }
}

/**
 * Split a Draw ticket into entry limits and matching take-profits.
 * Why: the fewest orders that still respect the exchange minimums keeps fees and
 * failure points low, while a ladder lets the user paint a zone instead of one number.
 * Units: ticketUsd and notional in USD; leverage a multiplier; prices quote per base; qty base.
 */
export function splitDraw(args: {
  side: Side;
  bands: DrawBands;
  ticketUsd: number;
  leverage: number;
  rules: SymbolRules;
  random: RandomSource;
  /** Max nudge fraction, default 0.0005 (0.05%). */
  nudgeFraction?: number;
  /** Optional maintenance margin rate for the liquidation estimate. */
  maintenanceMarginRate?: number;
}): DrawPlan {
  const { side, bands, rules } = args;
  validateBands(side, bands);
  const notional = args.ticketUsd * args.leverage; // position size in USD
  // Smallest notional one order may have: the exchange minimum, or minQty at the
  // highest entry price (that order gets the smallest quantity for its dollars).
  const perOrderMin = Math.max(rules.minNotionalUsd, rules.minQty * bands.inBand.high);
  const nMax = Math.min(MAX_DRAW_ORDERS, Math.floor(notional / perOrderMin));
  if (nMax < 1) throw new TicketTooSmallError(notional, perOrderMin);

  // Try the largest allowed N first, then fewer: step-size rounding can push a leg
  // just under the minimum, in which case one order fewer gives each leg more.
  for (let n = nMax; n >= 1; n--) {
    const entryPrices = spreadAcross(bands.inBand, n).map(
      (p) => nudgePrice(p, rules.tickSize, args.random, args.nudgeFraction ?? DEFAULT_NUDGE_FRACTION).price,
    );
    const entries: DrawLeg[] = entryPrices
      // Each leg gets an equal share of the dollars; quantity rounded DOWN so the ticket is never exceeded.
      .map((price) => ({ price, qty: floorToStep(notional / n / price, rules.stepSize) }))
      .sort((a, b) => a.price - b.price);
    // Take-profits rounded AWAY from the entries so tick rounding never shrinks the reward.
    const tpPrices = spreadAcross(bands.outBand, n)
      .map((p) => roundToTick(p, rules.tickSize, side === "buy" ? "up" : "down"))
      .sort((a, b) => a - b);
    const takeProfits: DrawLeg[] = tpPrices.map((price, i) => ({ price, qty: entries[i]?.qty ?? 0 }));

    // Every leg must pass LOT_SIZE.minQty and MIN_NOTIONAL (1e-9 absorbs float noise).
    const legOk = (l: DrawLeg) => l.qty >= rules.minQty && l.qty * l.price >= rules.minNotionalUsd - 1e-9;
    if (!entries.every(legOk) || !takeProfits.every(legOk)) continue;

    const totalQty = entries.reduce((s, l) => s + l.qty, 0);
    const totalNotionalUsd = entries.reduce((s, l) => s + l.qty * l.price, 0);
    const averageEntry = totalNotionalUsd / totalQty; // quantity-weighted average price
    const liq = estimateLiquidationPrice(averageEntry, args.leverage, side, args.maintenanceMarginRate ?? 0);
    const liqDist = liquidationDistance(averageEntry, liq);
    // The nearest take-profit sets the floor: it must still pay at least 1x the risk.
    const rewards = takeProfits.map((t) => (side === "buy" ? t.price - averageEntry : averageEntry - t.price));
    const minRatio = cleanRatio(Math.min(...rewards) / liqDist);
    if (!(minRatio >= 1)) throw new RatioBelowOneError(minRatio);
    return { entries, takeProfits, averageEntry, liquidationPrice: liq, minRatio, totalQty, totalNotionalUsd };
  }
  throw new TicketTooSmallError(notional, perOrderMin);
}
