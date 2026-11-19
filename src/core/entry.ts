/**
 * Entry price selection for the "When" modes Now, Nearby and Patient.
 * (Draw has its own file, drawSplit.ts, because it creates several orders.)
 *
 *  - Now: market order at the current price.
 *  - Nearby (rule of 2026-11-16: "reasonably around the same area", NOT the nearest level):
 *      1. Take skilled traders' resting limit orders on the favourable side (bids below
 *         the price for a Buy, asks above it for a Sell) between 0.05% and 0.5% away.
 *      2. Group them into 0.05%-wide buckets counted outward from the price, summing USD.
 *      3. Keep the heaviest few buckets (default top 3), each at least $5,000.
 *      4. Pick ONE of them at random, weighted by its USD (a $60k bucket is twice as
 *         likely as a $30k one), then a random price inside that bucket.
 *      5. The caller then applies the usual +-0.05% nudge (nudge.ts).
 *    Why: their resting orders show where serious money wants to trade, so price often
 *    touches and respects those areas; spreading Sets across the heavy areas instead of
 *    all on the single nearest level keeps them from stacking on one number.
 *    No bucket qualifies -> fall back to Now.
 *  - Patient: a limit at the heaviest liquidation cluster 0.5% to 5% away (was 1% to
 *    5% until 2026-11-16). For Buy we look at the liquidation prices of other traders'
 *    LONG positions below the price. When price falls into such a cluster, those longs
 *    are force sold one after another (a cascade), which pushes price into and through
 *    the cluster; once the forced selling is spent, price often snaps back. A buy limit
 *    resting inside the cluster tends to fill near the bottom of that wick.
 *    Sell mirrors it with SHORT liquidations above the price. None -> fall back to Nearby.
 *
 * Randomness comes only from the injected RandomSource, so a seeded source
 * (types.ts seededRandom) reproduces every pick exactly. Nearby draws TWO numbers, in
 * this order: (1) which bucket, (2) where inside it.
 *
 * This file returns the raw level price. The caller nudges it (nudge.ts) and rounds it.
 */
import type { EntryMode, LiquidationLevel, RandomSource, Side, SidedLevel, TraderLevels } from "./types";
import { activeRules, DEFAULT_RULES, type SetRules } from "../rules/rules";

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
  /** Nearby: bucket width as a fraction of the current price. Default 0.0005 (0.05%). */
  nearbyBucketWidth: number;
  /** Nearby: how many of the heaviest buckets stay in the draw. Default 3. */
  nearbyTopBuckets: number;
  /** Nearby: the smallest USD notional in one bucket that counts as "meaningful". Default 5,000. */
  nearbyMinWeightUsd: number;
  /** Patient: nearest edge of the liquidation search window. Default 0.005 (0.5%). */
  patientMinDistance: number;
  /** Patient: farthest edge of the window. Default 0.05 (5%). */
  patientMaxDistance: number;
  /** Patient: bucket width as a fraction of the current price. Default 0.001 (0.1%). */
  patientBucketWidth: number;
}

/** The entry knobs of a rule set (src/rules/defaultRules.ts). */
export function entryOptionsFromRules(r: SetRules = activeRules()): EntryOptions {
  return {
    nearbyMaxDistance: r.entry.nearbyMaxDistance,
    nearbyMinDistance: r.entry.nearbyMinDistance,
    nearbyBucketWidth: r.entry.nearbyBandWidth,
    nearbyTopBuckets: r.entry.nearbyTopBands,
    nearbyMinWeightUsd: r.entry.nearbyMinUsd,
    patientMinDistance: r.entry.patientMinDistance,
    patientMaxDistance: r.entry.patientMaxDistance,
    patientBucketWidth: r.entry.patientBandWidth,
  };
}

/** The defaults, for callers that read them directly. Functions here read the active rules. */
export const DEFAULT_ENTRY_OPTIONS: EntryOptions = entryOptionsFromRules(DEFAULT_RULES);

/**
 * Structural counts of the level search, printed by the server so a zero is loud.
 * Patient fields are filled only when Patient ran; Nearby fields only when Nearby ran.
 */
export interface EntryDiagnostics {
  /** Liquidation levels handed in (all coins' positions with a liquidation price on this coin). */
  liquidationsRead?: number;
  /** Of those, on the waiting side (longs below for a Buy, shorts above for a Sell). */
  liquidationsOnSide?: number;
  /** Of those, inside the Patient window (0.5% to 5%). */
  liquidationsInWindow?: number;
  /** Resting limit orders handed in. */
  ordersRead?: number;
  /** Of those, on the favourable side and inside the Nearby window (0.05% to 0.5%). */
  ordersInWindow?: number;
  /** Buckets that passed the minimum weight and made the top-N draw. */
  nearbyBucketsKept?: number;
}

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
  /** USD notional behind the chosen level or bucket (0 for market). */
  levelWeightUsd: number;
  /** Plain-English explanation for the card and the log. */
  reason: string;
  /** Fallback chain, e.g. ["patient", "nearby"] when Patient fell back to Nearby and then Now. */
  fellBackFrom: Exclude<EntryMode, "draw">[];
  diagnostics: EntryDiagnostics;
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
  random: RandomSource;
  options?: Partial<EntryOptions>;
}): EntryDecision {
  const o: EntryOptions = { ...entryOptionsFromRules(), ...args.options };
  const { side, currentPrice } = args;
  if (!(currentPrice > 0)) throw new RangeError(`currentPrice must be > 0, got ${currentPrice}`);
  const fellBackFrom: Exclude<EntryMode, "draw">[] = [];
  const diagnostics: EntryDiagnostics = {};
  let mode = args.mode;

  if (mode === "patient") {
    const { cluster, counts } = findLiquidationClusterWithCounts(args.levels.liquidationLevels, side, currentPrice, o);
    Object.assign(diagnostics, counts);
    if (cluster) {
      return {
        requestedMode: args.mode,
        usedMode: "patient",
        orderType: "limit",
        price: cluster.centre,
        levelWeightUsd: cluster.weightUsd,
        reason: `waiting at a liquidation cluster ${pct(cluster.centre, currentPrice)} away, $${fmtUsd(cluster.weightUsd)} of ${side === "buy" ? "long" : "short"} positions liquidate there`,
        fellBackFrom,
        diagnostics,
      };
    }
    fellBackFrom.push("patient");
    mode = "nearby";
  }

  if (mode === "nearby") {
    const pick = pickNearbyLevel(args.levels.limitLevels, side, currentPrice, args.random, o);
    diagnostics.ordersRead = pick.counts.ordersRead;
    diagnostics.ordersInWindow = pick.counts.ordersInWindow;
    diagnostics.nearbyBucketsKept = pick.buckets.length;
    if (pick.chosen) {
      return {
        requestedMode: args.mode,
        usedMode: "nearby",
        orderType: "limit",
        price: pick.chosen.price,
        levelWeightUsd: pick.chosen.bucket.weightUsd,
        reason: `${prefix(fellBackFrom, side, o)}waiting in an area holding $${fmtUsd(pick.chosen.bucket.weightUsd)} of skilled traders' ${side === "buy" ? "buy" : "sell"} orders, ${pct(pick.chosen.price, currentPrice)} away`,
        fellBackFrom,
        diagnostics,
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
    reason: `${prefix(fellBackFrom, side, o)}a market order at the current price`,
    fellBackFrom,
    diagnostics,
  };
}

/** One Nearby bucket. Units: prices quote per base; weight USD; index counts 0.05% steps outward. */
export interface NearbyBucket {
  /** Bucket k covers distances [k x width, (k+1) x width) of the current price. */
  index: number;
  /** Price range of the bucket (low < high). */
  low: number;
  high: number;
  weightUsd: number;
}

/**
 * The heaviest Nearby buckets, heaviest first (ties: nearer the price first).
 * Deterministic: no randomness here, so tests can check the candidate list itself.
 * Units: prices quote per base; weights USD.
 */
export function nearbyBuckets(
  limitLevels: SidedLevel[],
  side: Side,
  currentPrice: number,
  options: Partial<EntryOptions> = {},
): { buckets: NearbyBucket[]; counts: { ordersRead: number; ordersInWindow: number } } {
  const o: EntryOptions = { ...entryOptionsFromRules(), ...options };
  const width = o.nearbyBucketWidth;
  // Highest bucket index inside the window: distance 0.5% exactly lands in the last bucket.
  const lastIndex = Math.max(0, Math.ceil(o.nearbyMaxDistance / width - 1e-9) - 1);
  const sums = new Map<number, number>();
  let inWindow = 0;
  for (const l of limitLevels) {
    if (l.side !== side) continue; // Buy follows other bids; Sell follows other asks
    if (!(l.price > 0) || !(l.weightUsd > 0)) continue;
    // Favourable side: strictly below the price for Buy, strictly above for Sell.
    const distance = side === "buy" ? (currentPrice - l.price) / currentPrice : (l.price - currentPrice) / currentPrice;
    if (!(distance > 0)) continue;
    if (distance > o.nearbyMaxDistance + 1e-12 || distance < o.nearbyMinDistance - 1e-12) continue;
    inWindow++;
    const k = Math.min(lastIndex, Math.floor(distance / width + 1e-9));
    sums.set(k, (sums.get(k) ?? 0) + l.weightUsd);
  }
  const buckets: NearbyBucket[] = [];
  for (const [k, weightUsd] of sums) {
    if (weightUsd < o.nearbyMinWeightUsd) continue; // too small to matter
    // Clip the bucket to the window, so a random price inside it stays inside 0.05%..0.5%.
    const dNear = Math.max(k * width, o.nearbyMinDistance);
    const dFar = Math.min((k + 1) * width, o.nearbyMaxDistance);
    const a = side === "buy" ? currentPrice * (1 - dNear) : currentPrice * (1 + dNear);
    const b = side === "buy" ? currentPrice * (1 - dFar) : currentPrice * (1 + dFar);
    buckets.push({ index: k, low: Math.min(a, b), high: Math.max(a, b), weightUsd });
  }
  buckets.sort((x, y) => y.weightUsd - x.weightUsd || x.index - y.index);
  return { buckets: buckets.slice(0, Math.max(1, o.nearbyTopBuckets)), counts: { ordersRead: limitLevels.length, ordersInWindow: inWindow } };
}

/**
 * Nearby: choose one heavy bucket (weighted by USD) and a random price inside it.
 * Draws exactly two random numbers when a bucket exists, none otherwise.
 * Units: prices quote per base; weights USD.
 */
export function pickNearbyLevel(
  limitLevels: SidedLevel[],
  side: Side,
  currentPrice: number,
  random: RandomSource,
  options: Partial<EntryOptions> = {},
): {
  chosen: { price: number; bucket: NearbyBucket } | null;
  buckets: NearbyBucket[];
  counts: { ordersRead: number; ordersInWindow: number };
} {
  const { buckets, counts } = nearbyBuckets(limitLevels, side, currentPrice, options);
  if (buckets.length === 0) return { chosen: null, buckets, counts };
  const r1 = draw(random);
  const total = buckets.reduce((s, b) => s + b.weightUsd, 0);
  // Walk the cumulative weights: bucket i is chosen when r1 x total falls in its slice.
  let target = r1 * total;
  let bucket = buckets[buckets.length - 1] as NearbyBucket;
  for (const b of buckets) {
    if (target < b.weightUsd) {
      bucket = b;
      break;
    }
    target -= b.weightUsd;
  }
  const r2 = draw(random);
  const price = bucket.low + r2 * (bucket.high - bucket.low); // uniform inside the bucket
  return { chosen: { price, bucket }, buckets, counts };
}

/**
 * Patient: the heaviest 0.1%-wide bucket of liquidation prices 0.5% to 5% away.
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
  return findLiquidationClusterWithCounts(liquidationLevels, side, currentPrice, options).cluster;
}

/** findLiquidationCluster plus the structural counts the server logs. */
export function findLiquidationClusterWithCounts(
  liquidationLevels: LiquidationLevel[],
  side: Side,
  currentPrice: number,
  options: Partial<EntryOptions> = {},
): {
  cluster: { centre: number; weightUsd: number; bucketIndex: number } | null;
  counts: { liquidationsRead: number; liquidationsOnSide: number; liquidationsInWindow: number };
} {
  const o: EntryOptions = { ...entryOptionsFromRules(), ...options };
  const wanted = side === "buy" ? "long" : "short";
  const buckets = new Map<number, number>();
  let onSide = 0;
  let inWindow = 0;
  for (const l of liquidationLevels) {
    if (l.positionSide !== wanted) continue;
    if (!(l.price > 0) || !(l.weightUsd > 0)) continue;
    // Signed distance in the direction we wait: positive means "on the waiting side".
    const distance = side === "buy" ? (currentPrice - l.price) / currentPrice : (l.price - currentPrice) / currentPrice;
    if (!(distance > 0)) continue;
    onSide++;
    if (distance < o.patientMinDistance || distance > o.patientMaxDistance) continue; // outside 0.5%..5%
    inWindow++;
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
  const counts = { liquidationsRead: liquidationLevels.length, liquidationsOnSide: onSide, liquidationsInWindow: inWindow };
  if (bestK === null) return { cluster: null, counts };
  const centreDistance = (bestK + 0.5) * o.patientBucketWidth; // fraction of price
  const centre = side === "buy" ? currentPrice * (1 - centreDistance) : currentPrice * (1 + centreDistance);
  return { cluster: { centre, weightUsd: bestW, bucketIndex: bestK }, counts };
}

/** One random draw, checked: a bad source must fail loudly, not bend a price. */
function draw(random: RandomSource): number {
  const r = random();
  if (!(r >= 0 && r < 1)) throw new RangeError(`random source must return [0, 1), got ${r}`);
  return r;
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
/** Prefix that tells the user a fallback happened, in plain words. */
function prefix(fellBackFrom: string[], side: Side, o: EntryOptions): string {
  if (fellBackFrom.length === 0) return "";
  const parts: string[] = [];
  if (fellBackFrom.includes("patient")) {
    const where = side === "buy" ? "below" : "above";
    parts.push(`Patient found no liquidation cluster ${pctOf(o.patientMinDistance)} to ${pctOf(o.patientMaxDistance)} ${where} the price`);
  }
  if (fellBackFrom.includes("nearby")) parts.push(`Nearby found no heavy order area within ${pctOf(o.nearbyMaxDistance)}`);
  return `${parts.join("; ")}, so `;
}
/** 0.005 -> "0.5%". */
function pctOf(f: number): string {
  return `${Number((f * 100).toFixed(2))}%`;
}
