/**
 * Take-profit placement.
 *
 * The take-profit is measured against the RISK distance, which since 2026-11-16 is the
 * distance from entry to the STOP (stop.ts, 85% of the way to liquidation), because the
 * stop is where the user really loses:
 *   ratio = take-profit distance / stop distance
 * A ratio of 2 means "if I win, I win twice what I lose if stopped".
 *
 * Modes (minimum ratio): Shy >= 1x, Deserved >= 2x (default), Greedy >= 4x.
 * No Set is ever allowed below 1x: risking more than you can win is rejected.
 *
 * How the price is chosen (owner rule 2026-11-16). Copied traders' own take-profits are
 * rarely visible, so the target aims at a VOLUME ZONE instead:
 *  1. Minimum target = entry + minRatio x risk distance (Buy; minus for Sell).
 *  2. Look beyond it, up to zoneReach (1.5) times that distance, for the heaviest
 *     bucket of resting volume on the OPPOSITE side of the book: asks (sellers) above a
 *     Buy, bids (buyers) below a Sell. Price tends to stall at such a wall, because the
 *     resting orders there absorb the move, so a target just IN FRONT of it fills before
 *     the stall. Buckets are 0.05% of the entry price wide.
 *     Data sources, merged into one list of levels by the caller:
 *       a. Aster's public order book, GET https://fapi.asterdex.com/fapi/v3/depth
 *          (limit 1000; the venue the Set trades on, so this is real resting liquidity;
 *          on 2026-11-16 it reached about 5.4% above and 6.1% below the BTC price);
 *       b. skilled Hyperliquid traders' resting limit orders (src/levels/hyperliquid.ts,
 *          "frontendOpenOrders"), on the matching side.
 *  3. Place the take-profit just in front of the wall: zoneFrontGap (0.03%) before the
 *     wall's first price, moved at random by up to +-zoneJitter (0.03%), so it lands
 *     between 0% and 0.06% in front. Never below the minimum target.
 *  4. No zone heavy enough (zoneMinWeightUsd) -> the older round-number snap: the
 *     nearest round number (or visible trader take-profit) at or beyond the minimum,
 *     within +35% of the target distance; none of those -> the exact minimum price.
 * Rounding to the tick never breaks the mode's minimum.
 */
import { liquidationDistance } from "./liquidation";
import { roundToTick } from "./rounding";
import type { Level, RandomSource, Side, TpMode } from "./types";
import { activeRules, DEFAULT_RULES, type SetRules } from "../rules/rules";

/** Minimum reward-to-risk ratio of each mode in a rule set. Units: plain multiplier. */
export function tpMinRatios(r: SetRules = activeRules()): Readonly<Record<TpMode, number>> {
  return { shy: r.target.shy, deserved: r.target.deserved, greedy: r.target.greedy };
}
/** The default ratios (1, 2, 4). pickTakeProfit reads the active rules. */
export const TP_MIN_RATIO: Readonly<Record<TpMode, number>> = tpMinRatios(DEFAULT_RULES);

/** Default tolerance for the round-number snap: up to 35% of the target distance beyond the exact target. */
export const DEFAULT_SNAP_TOLERANCE = DEFAULT_RULES.target.roundNumberReach;

/** Volume-zone search knobs. Units: decimal fractions unless named Usd. */
export interface TpZoneOptions {
  /** How far beyond the minimum to look, as a multiple of the minimum distance. Default 1.5. */
  zoneReach: number;
  /** Bucket width as a fraction of the entry price. Default 0.0005 (0.05%). */
  zoneBucketWidth: number;
  /** Smallest bucket notional that counts as a wall. Default $25,000. */
  zoneMinWeightUsd: number;
  /** Gap in front of the wall, fraction of the wall's price. Default 0.0003 (0.03%). */
  zoneFrontGap: number;
  /** Random move either side of that spot, fraction of price. Default 0.0003 (0.03%). */
  zoneJitter: number;
}

/** The wall-search knobs of a rule set. */
export function tpZoneOptionsFromRules(r: SetRules = activeRules()): TpZoneOptions {
  return {
    zoneReach: r.target.wallSearchReach,
    zoneBucketWidth: r.target.wallBandWidth,
    zoneMinWeightUsd: r.target.wallMinUsd,
    zoneFrontGap: r.target.wallFrontGap,
    zoneJitter: r.target.wallJitter,
  };
}
export const DEFAULT_TP_ZONE_OPTIONS: TpZoneOptions = tpZoneOptionsFromRules(DEFAULT_RULES);

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
 * Exact take-profit price for a given ratio against a stop (or any risk price).
 * Units: prices in quote per base; ratio a plain multiplier.
 * Buy:  tp = entry + ratio x (entry - stop)
 * Sell: tp = entry - ratio x (stop - entry)
 */
export function exactTakeProfitPrice(entry: number, stopPrice: number, side: Side, ratio: number): number {
  assertRatioAtLeastOne(ratio);
  const dist = liquidationDistance(entry, stopPrice) * ratio;
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
export type TpSource = "volume-zone" | "round-number" | "trader-tp" | "exact-ratio";

/** The wall the take-profit stops in front of. Units: prices quote per base; weight USD. */
export interface VolumeZone {
  /** Bucket number counted outward from entry: covers distances [k x width, (k+1) x width) of the entry. */
  bucketIndex: number;
  /** The bucket's price range. */
  low: number;
  high: number;
  /** Price of the wall's first resting order (the one nearest the entry). */
  frontPrice: number;
  /** Total resting notional in the bucket. */
  weightUsd: number;
}

/** Structural counts of the zone search, so an empty search is visible in the log. */
export interface TpZoneDiagnostics {
  /** Opposite-side levels handed in. */
  levelsRead: number;
  /** Of those, inside [minimum, reach x minimum]. */
  levelsInWindow: number;
  /** Non-empty buckets inside the window. */
  bucketsInWindow: number;
  /** Heaviest bucket's notional, 0 when none. Units: USD. */
  heaviestBucketUsd: number;
}

/** Result of pickTakeProfit. */
export interface TakeProfitPick {
  /** Final take-profit price on the tick grid. Units: quote per base. */
  price: number;
  /** Achieved ratio = |price - entry| / |entry - stop|. Always >= the mode minimum. */
  ratio: number;
  /** The mode's minimum ratio. */
  minRatio: number;
  /** Exact price at the minimum ratio (the floor of the target). */
  exactPrice: number;
  /** Stop price used as the yardstick. */
  stopPrice: number;
  source: TpSource;
  /** The wall used, when source is "volume-zone". */
  zone: VolumeZone | null;
  diagnostics: TpZoneDiagnostics;
}

/** Inputs for pickTakeProfit. */
export interface PickTakeProfitInput {
  /** Entry price (quote per base). */
  entry: number;
  side: Side;
  /** The stop price (stop.ts). The ratio is measured against |entry - stop|. */
  stopPrice: number;
  mode: TpMode;
  /** Symbol tick size, so the result is a valid order price. */
  tickSize: number;
  /**
   * Resting volume on the OPPOSITE side, any sources merged: asks for a Buy, bids for a
   * Sell (Aster depth + Hyperliquid traders' limits). Levels on the loss side of the
   * entry are ignored, so passing both sides by mistake cannot pick a wrong wall.
   */
  oppositeVolume?: Level[];
  /** Visible take-profit prices of skilled traders, used only by the round-number fallback. */
  traderTakeProfits?: Level[];
  /** Random source for the jitter in front of the wall. Default: no jitter (always 0.5). */
  random?: RandomSource;
  /** Round-number snap window beyond the exact target, fraction of the target distance. Default 0.35. */
  tolerance?: number;
  zone?: Partial<TpZoneOptions>;
  /** Optional override of the mode's minimum ratio (must be >= 1). */
  minRatioOverride?: number;
}

/**
 * The heaviest bucket of opposite-side volume between `minDistance` and
 * `maxDistance` from entry. Ties go to the bucket nearer the entry (reached sooner).
 * Units: prices quote per base; distances in price units; bucketWidth a fraction of entry; weights USD.
 */
export function findVolumeZone(args: {
  entry: number;
  side: Side;
  levels: Level[];
  minDistance: number;
  maxDistance: number;
  bucketWidth: number;
  minWeightUsd: number;
}): { zone: VolumeZone | null; diagnostics: TpZoneDiagnostics } {
  const { entry, side } = args;
  const width = entry * args.bucketWidth; // bucket width in price units
  const buckets = new Map<number, { weightUsd: number; frontPrice: number }>();
  let inWindow = 0;
  for (const l of args.levels) {
    if (!(l.price > 0) || !(l.weightUsd > 0)) continue;
    // Profit-side distance: positive above entry for a Buy, below entry for a Sell.
    const d = side === "buy" ? l.price - entry : entry - l.price;
    if (d < args.minDistance || d > args.maxDistance) continue;
    inWindow++;
    const k = Math.floor(d / width + 1e-9);
    const b = buckets.get(k);
    // frontPrice: the level nearest the entry inside this bucket (where the wall starts).
    const nearer = (a: number, c: number) => (side === "buy" ? Math.min(a, c) : Math.max(a, c));
    if (b) buckets.set(k, { weightUsd: b.weightUsd + l.weightUsd, frontPrice: nearer(b.frontPrice, l.price) });
    else buckets.set(k, { weightUsd: l.weightUsd, frontPrice: l.price });
  }
  let bestK: number | null = null;
  let best = { weightUsd: 0, frontPrice: 0 };
  for (const [k, b] of buckets) {
    if (b.weightUsd > best.weightUsd || (b.weightUsd === best.weightUsd && bestK !== null && k < bestK)) {
      bestK = k;
      best = b;
    }
  }
  const diagnostics: TpZoneDiagnostics = {
    levelsRead: args.levels.length,
    levelsInWindow: inWindow,
    bucketsInWindow: buckets.size,
    heaviestBucketUsd: best.weightUsd,
  };
  if (bestK === null || best.weightUsd < args.minWeightUsd) return { zone: null, diagnostics };
  const near = side === "buy" ? entry + bestK * width : entry - bestK * width;
  const far = side === "buy" ? entry + (bestK + 1) * width : entry - (bestK + 1) * width;
  return {
    zone: { bucketIndex: bestK, low: Math.min(near, far), high: Math.max(near, far), frontPrice: best.frontPrice, weightUsd: best.weightUsd },
    diagnostics,
  };
}

/**
 * Pick the take-profit price for a Set.
 * Why: a target just in front of a wall of resting volume fills before price stalls
 * there, while never giving up the mode's minimum reward-to-risk ratio.
 * Units: prices quote per base; returned ratio a plain multiplier.
 */
export function pickTakeProfit(input: PickTakeProfitInput): TakeProfitPick {
  const tolerance = input.tolerance ?? activeRules().target.roundNumberReach;
  const z: TpZoneOptions = { ...tpZoneOptionsFromRules(), ...input.zone };
  const minRatio = input.minRatioOverride ?? tpMinRatios()[input.mode];
  assertRatioAtLeastOne(minRatio);
  const { entry, side, tickSize } = input;
  const stopOnRightSide = side === "buy" ? input.stopPrice < entry : input.stopPrice > entry;
  if (!stopOnRightSide) throw new RangeError(`stop ${input.stopPrice} is on the wrong side of entry ${entry} for a ${side}`);
  const riskDist = liquidationDistance(entry, input.stopPrice); // the real loss distance
  const exact = exactTakeProfitPrice(entry, input.stopPrice, side, minRatio);
  const targetDist = Math.abs(exact - entry); // distance at the minimum ratio
  const sign = side === "buy" ? 1 : -1; // +1: profit is above entry; -1: below
  const awayMode = side === "buy" ? "up" : "down"; // rounding that can only raise the ratio
  const towardMode = side === "buy" ? "down" : "up";
  const ratioOf = (p: number) => cleanRatio(Math.abs(p - entry) / riskDist);

  // ---- 1. volume zone ----
  const { zone, diagnostics } = findVolumeZone({
    entry,
    side,
    levels: input.oppositeVolume ?? [],
    minDistance: targetDist,
    maxDistance: targetDist * z.zoneReach,
    bucketWidth: z.zoneBucketWidth,
    minWeightUsd: z.zoneMinWeightUsd,
  });
  if (zone) {
    const r = (input.random ?? (() => 0.5))();
    if (!(r >= 0 && r < 1)) throw new RangeError(`random source must return [0, 1), got ${r}`);
    // Offset in front of the wall: gap +- jitter, as a fraction of the wall price.
    // r = 0.5 gives exactly the gap (0.03%); the range is [gap - jitter, gap + jitter).
    const offset = Math.max(0, z.zoneFrontGap + (r * 2 - 1) * z.zoneJitter);
    let raw = zone.frontPrice * (1 - sign * offset);
    // Never closer than the mode's minimum.
    if (sign * (raw - exact) < 0) raw = exact;
    // Prefer rounding toward the entry (stays in front of the wall); if that breaks the
    // minimum, round away instead.
    let price = roundToTick(raw, tickSize, towardMode);
    if (ratioOf(price) < minRatio) price = roundToTick(raw, tickSize, awayMode);
    const ratio = ratioOf(price);
    assertRatioAtLeastOne(ratio);
    if (ratio < minRatio) throw new RatioBelowOneError(ratio); // defensive: the clamp above prevents it
    return { price, ratio, minRatio, exactPrice: exact, stopPrice: input.stopPrice, source: "volume-zone", zone, diagnostics };
  }

  // ---- 2. fallback: round-number (or visible trader TP) snap ----
  const farEdge = exact + sign * tolerance * targetDist;
  // A hair of slack (1e-9 of the distance) so a key level sitting exactly on the
  // target is not lost to float noise in `exact`.
  const slack = targetDist * 1e-9;
  const lo = Math.min(exact, farEdge) - slack;
  const hi = Math.max(exact, farEdge) + slack;
  const candidates: { price: number; source: TpSource }[] = [];
  for (const p of roundNumbersBetween(lo, hi, entry)) candidates.push({ price: p, source: "round-number" });
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
  // Round AWAY from entry so tick rounding can only increase the ratio.
  const price = roundToTick(chosen ? chosen.price : exact, tickSize, awayMode);
  const ratio = ratioOf(price);
  assertRatioAtLeastOne(ratio); // defensive: cannot fail given the maths above
  return {
    price,
    ratio,
    minRatio,
    exactPrice: exact,
    stopPrice: input.stopPrice,
    source: chosen ? chosen.source : "exact-ratio",
    zone: null,
    diagnostics,
  };
}
