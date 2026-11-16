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
 * but still never allows a take-profit below 1x the risk.
 *
 * Stops (2026-11-16): every entry leg gets its own reduce-only stop-market at 85% of
 * THAT leg's liquidation distance (stop.ts), paired by index with the entry and its
 * take-profit, same quantity. Each leg's ratio is measured against its own stop:
 *   ratio_i = |takeProfit_i - entry_i| / |entry_i - stop_i|, and the smallest must be >= 1.
 * Why per leg: a leg may fill alone, and a stop computed from the average of all legs
 * can sit beyond the liquidation of the leg that filled first. Known limit: when
 * several legs fill, the combined position's liquidation is at their average entry,
 * which can be nearer than the lowest leg's stop (Buy) on a wide In band; the stop
 * re-check after each fill (server/execute.ts reconcileStop, using Aster's real
 * positionRisk liquidationPrice) is what closes that gap.
 */
import { estimateLiquidationPrice } from "./liquidation";
import { nudgePrice, DEFAULT_NUDGE_FRACTION } from "./nudge";
import { floorToStep, roundToTick } from "./rounding";
import { DEFAULT_ASSUMED_MAINTENANCE_RATE, planStop, type MaintenanceSource } from "./stop";
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
  /** Reduce-only stop-markets, one per entry (same index, same qty), each at 85% of that leg's liquidation distance. */
  stops: DrawLeg[];
  /** Estimated liquidation price of each leg on its own (same index as entries). */
  legLiquidationPrices: number[];
  /** Quantity-weighted average entry price. Units: quote per base. */
  averageEntry: number;
  /** Liquidation estimate at the average entry, assuming every entry fills. */
  liquidationPrice: number;
  /** Smallest per-leg ratio, take-profit distance vs that leg's stop distance. Always >= 1. */
  minRatio: number;
  /** Loss if every leg fills and every stop fires. Units: USD, positive number. */
  lossAtStopsUsd: number;
  /** Maintenance margin rate used for the liquidation estimates (decimal) and where it came from. */
  maintenanceMarginRate: number;
  maintenanceSource: MaintenanceSource;
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
  /** Maintenance margin rate for the liquidation estimates. Default: the assumed 0.5% (stop.ts). */
  maintenanceMarginRate?: number;
  maintenanceSource?: MaintenanceSource;
}): DrawPlan {
  const mmr = args.maintenanceMarginRate ?? DEFAULT_ASSUMED_MAINTENANCE_RATE;
  const mmrSource: MaintenanceSource = args.maintenanceSource ?? "assumed";
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
    const liq = estimateLiquidationPrice(averageEntry, args.leverage, side, mmr);
    // One stop per leg, from that leg's own entry (see the header for why).
    const legStops = entries.map((e) =>
      planStop({ entry: e.price, side, leverage: args.leverage, tickSize: rules.tickSize, maintenanceMarginRate: mmr, maintenanceSource: mmrSource }),
    );
    const stops: DrawLeg[] = legStops.map((st, i) => ({ price: st.stopPrice, qty: entries[i]?.qty ?? 0 }));
    // Every leg must still pay at least 1x its own risk (reward / stop distance).
    const ratios = takeProfits.map((t, i) => {
      const e = entries[i] as DrawLeg;
      const reward = side === "buy" ? t.price - e.price : e.price - t.price;
      return reward / (legStops[i] as { riskDistance: number }).riskDistance;
    });
    const minRatio = cleanRatio(Math.min(...ratios));
    if (!(minRatio >= 1)) throw new RatioBelowOneError(minRatio);
    const lossAtStopsUsd = entries.reduce((s, e, i) => s + e.qty * (legStops[i] as { riskDistance: number }).riskDistance, 0);
    return {
      entries,
      takeProfits,
      stops,
      legLiquidationPrices: legStops.map((st) => st.liquidationPrice),
      averageEntry,
      liquidationPrice: liq,
      minRatio,
      lossAtStopsUsd,
      maintenanceMarginRate: mmr,
      maintenanceSource: mmrSource,
      totalQty,
      totalNotionalUsd,
    };
  }
  throw new TicketTooSmallError(notional, perOrderMin);
}
