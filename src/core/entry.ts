/**
 * Entry price selection for the "When" modes Now, Nearby and Patient.
 * (Draw has its own file, drawSplit.ts, because it creates several orders.)
 *
 *  - Now: market order at the current price.
 *  - Nearby: a limit at the closest meaningful resting order of skilled traders on
 *    the favourable side (below the price for Buy, above it for Sell), within 0.5%
 *    and at least 0.05% away (closer than one nudge is not a level to wait at).
 *    Their resting orders show where serious money wants to trade, so price often
 *    touches and respects those levels. None qualifies -> fall back to Now.
 *  - Patient: a limit at the heaviest liquidation cluster 1% to 5% away.
 *    For Buy we look at the liquidation prices of other traders' LONG positions
 *    below the price. When price falls into such a cluster, those longs are force
 *    sold one after another (a cascade), which pushes price into and through the
 *    cluster; once the forced selling is spent, price often snaps back. A buy limit
 *    resting inside the cluster tends to fill near the bottom of that wick.
 *    Sell mirrors it with SHORT liquidations above the price. None -> fall back to Nearby.
 *
 * This file returns the raw level price. The caller nudges it (nudge.ts) and rounds it.
 */
import type { EntryMode, LiquidationLevel, Side, SidedLevel, TraderLevels } from "./types";

/** Options with their defaults. All fractions are decimal (0.005 = 0.5%). */
export interface EntryOptions {
  /** Nearby: how far from the price a resting order may sit. Default 0.005 (0.5%). */
  nearbyMaxDistance: number;
  /**
   * Nearby: how close a resting order may sit. Default 0.0005 (0.05%), the nudge width:
   * a level closer than one nudge could be pushed across the price by the nudge and fill
   * at once as a market order, so it is not a meaningful "wait here" level.
   */
  nearbyMinDistance: number;
  /** Nearby: the smallest USD notional at one price that counts as "meaningful". Default 5,000. */
  nearbyMinWeightUsd: number;
  /** Patient: nearest edge of the liquidation search window. Default 0.01 (1%). */
  patientMinDistance: number;
  /** Patient: farthest edge of the window. Default 0.05 (5%). */
  patientMaxDistance: number;
  /** Patient: bucket width as a fraction of the current price. Default 0.001 (0.1%). */
  patientBucketWidth: number;
}

export const DEFAULT_ENTRY_OPTIONS: EntryOptions = {
  nearbyMaxDistance: 0.005,
  nearbyMinDistance: 0.0005,
  nearbyMinWeightUsd: 5_000,
  patientMinDistance: 0.01,
  patientMaxDistance: 0.05,
  patientBucketWidth: 0.001,
};

/** The decision for one Set's entry. */
export interface EntryDecision {
  /** Mode the user asked for. */
  requestedMode: Exclude<EntryMode, "draw">;
  /** Mode that actually produced the entry after any fallback. */
  usedMode: Exclude<EntryMode, "draw">;
  /** "market" for Now, "limit" otherwise. */
  orderType: "market" | "limit";
  /** Raw entry price before nudge and tick rounding. For market, the current price (an estimate). Units: quote per base. */
  price: number;
  /** USD notional behind the chosen level (0 for market). */
  levelWeightUsd: number;
  /** Plain-English explanation for the card and the log. */
  reason: string;
  /** Fallback chain, e.g. ["patient", "nearby"] when Patient fell back to Nearby and then Now. */
  fellBackFrom: Exclude<EntryMode, "draw">[];
}

/**
 * Pick the entry for Now, Nearby or Patient.
 * Why: one function the card and the server share, so the shown plan is the placed plan.
 * Units: currentPrice in quote per base; level weights in USD.
 */
export function pickEntry(args: {
  mode: Exclude<EntryMode, "draw">;
  side: Side;
  currentPrice: number;
  levels: TraderLevels;
  options?: Partial<EntryOptions>;
}): EntryDecision {
  const o: EntryOptions = { ...DEFAULT_ENTRY_OPTIONS, ...args.options };
  const { side, currentPrice } = args;
  if (!(currentPrice > 0)) throw new RangeError(`currentPrice must be > 0, got ${currentPrice}`);
  const fellBackFrom: Exclude<EntryMode, "draw">[] = [];
  let mode = args.mode;

  if (mode === "patient") {
    const cluster = findLiquidationCluster(args.levels.liquidationLevels, side, currentPrice, o);
    if (cluster) {
      return {
        requestedMode: args.mode,
        usedMode: "patient",
        orderType: "limit",
        price: cluster.centre,
        levelWeightUsd: cluster.weightUsd,
        reason: `waiting at a liquidation cluster ${pct(cluster.centre, currentPrice)} away, $${fmtUsd(cluster.weightUsd)} of ${side === "buy" ? "long" : "short"} positions liquidate there`,
        fellBackFrom,
      };
    }
    fellBackFrom.push("patient");
    mode = "nearby";
  }

  if (mode === "nearby") {
    const level = findNearbyLevel(args.levels.limitLevels, side, currentPrice, o);
    if (level) {
      return {
        requestedMode: args.mode,
        usedMode: "nearby",
        orderType: "limit",
        price: level.price,
        levelWeightUsd: level.weightUsd,
        reason: `${prefix(fellBackFrom)}next to $${fmtUsd(level.weightUsd)} of skilled traders' ${side === "buy" ? "buy" : "sell"} orders ${pct(level.price, currentPrice)} away`,
        fellBackFrom,
      };
    }
    fellBackFrom.push("nearby");
  }

  return {
    requestedMode: args.mode,
    usedMode: "now",
    orderType: "market",
    price: currentPrice,
    levelWeightUsd: 0,
    reason: `${prefix(fellBackFrom)}market order at the current price`,
    fellBackFrom,
  };
}

/**
 * Nearby: the closest meaningful resting order on the favourable side.
 * Orders at the same price are summed first (ten $1k orders at one price are one $10k level).
 * Units: prices quote per base; weights USD.
 */
export function findNearbyLevel(
  limitLevels: SidedLevel[],
  side: Side,
  currentPrice: number,
  options: Partial<EntryOptions> = {},
): { price: number; weightUsd: number } | null {
  const o: EntryOptions = { ...DEFAULT_ENTRY_OPTIONS, ...options };
  const byPrice = new Map<number, number>();
  for (const l of limitLevels) {
    if (l.side !== side) continue; // Buy follows other bids; Sell follows other asks
    if (!(l.price > 0) || !(l.weightUsd > 0)) continue;
    // Favourable side: strictly below the price for Buy, strictly above for Sell.
    const favourable = side === "buy" ? l.price < currentPrice : l.price > currentPrice;
    if (!favourable) continue;
    const distance = Math.abs(l.price - currentPrice) / currentPrice; // fraction of the price
    if (distance > o.nearbyMaxDistance || distance < o.nearbyMinDistance) continue;
    byPrice.set(l.price, (byPrice.get(l.price) ?? 0) + l.weightUsd);
  }
  let best: { price: number; weightUsd: number } | null = null;
  for (const [price, weightUsd] of byPrice) {
    if (weightUsd < o.nearbyMinWeightUsd) continue; // too small to matter
    if (!best || Math.abs(price - currentPrice) < Math.abs(best.price - currentPrice)) best = { price, weightUsd };
  }
  return best;
}

/**
 * Patient: the heaviest 0.1%-wide bucket of liquidation prices 1% to 5% away.
 * Buy reads LONG liquidations below the price; Sell reads SHORT liquidations above it.
 * Buckets are counted outward from the current price: bucket k covers distances
 * [k x width, (k+1) x width) of the price, so its centre is at (k + 0.5) x width.
 * Ties go to the bucket nearer the price (it is reached sooner).
 * Units: prices quote per base; weights USD (position notional).
 */
export function findLiquidationCluster(
  liquidationLevels: LiquidationLevel[],
  side: Side,
  currentPrice: number,
  options: Partial<EntryOptions> = {},
): { centre: number; weightUsd: number; bucketIndex: number } | null {
  const o: EntryOptions = { ...DEFAULT_ENTRY_OPTIONS, ...options };
  const wanted = side === "buy" ? "long" : "short";
  const buckets = new Map<number, number>();
  for (const l of liquidationLevels) {
    if (l.positionSide !== wanted) continue;
    if (!(l.price > 0) || !(l.weightUsd > 0)) continue;
    // Signed distance in the direction we wait: positive means "on the waiting side".
    const distance = side === "buy" ? (currentPrice - l.price) / currentPrice : (l.price - currentPrice) / currentPrice;
    if (distance < o.patientMinDistance || distance > o.patientMaxDistance) continue; // outside 1%..5%
    const k = Math.floor(distance / o.patientBucketWidth + 1e-9);
    buckets.set(k, (buckets.get(k) ?? 0) + l.weightUsd);
  }
  let bestK: number | null = null;
  let bestW = 0;
  for (const [k, w] of buckets) {
    if (w > bestW || (w === bestW && bestK !== null && k < bestK)) {
      bestK = k;
      bestW = w;
    }
  }
  if (bestK === null) return null;
  const centreDistance = (bestK + 0.5) * o.patientBucketWidth; // fraction of price
  const centre = side === "buy" ? currentPrice * (1 - centreDistance) : currentPrice * (1 + centreDistance);
  return { centre, weightUsd: bestW, bucketIndex: bestK };
}

/** "0.42%" distance label. */
function pct(price: number, ref: number): string {
  return `${((Math.abs(price - ref) / ref) * 100).toFixed(2)}%`;
}
/** "12.3k" style USD label. */
function fmtUsd(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(0);
}
/** Prefix that tells the user a fallback happened. */
function prefix(fellBackFrom: string[]): string {
  if (fellBackFrom.length === 0) return "";
  return `no ${fellBackFrom.join(" or ")} level found, so `;
}
