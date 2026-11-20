/**
 * Take-profit (target) placement, v2 (spec: VAULT 120 AI Workbench/_meta/prds/Sets_Rules.md,
 * section A, 2026-11-20).
 *
 * The ratio is measured against the STOP distance s (stop.ts, 85% of the way to liquidation):
 *   ratio = |target - entry| / s
 * Floors stay: Shy 1x, Deserved 2x, Greedy 4x. No Set is ever below 1x.
 *
 * What changed from v1 (owner's rulings of 2026-11-20): v1 took the heaviest wall just past
 * the floor, else the nearest round number past it, else the bare floor; on 2026-11-19 that
 * put the target 12 cents BEHIND the round number 1,900 ("merely a 2x"). v2 looks at the
 * whole window from (floor - 0.1) to 2 x floor and picks the most REASONABLE level, not the
 * nearest one ("nearest one is the wrong and the most lazy option"):
 *
 *  Fuel   other traders' liquidation prices on the profit side (shorts above a Buy). When
 *         price reaches them the positions are force-closed one after another, which drags
 *         price into the cluster. Grouped in 0.1% bands, neighbours merged up to 5 bands,
 *         a cluster counts from $100k. The target sits 0.05% inside its near edge, or in
 *         front of a wall / round number that sits just before that edge.
 *  Brakes where price tends to stall: walls of resting orders (Aster's book plus skilled
 *         traders' limits, 0.05% bands, from $25k), round numbers, the recent swing high,
 *         visible take-profits of skilled traders. A target sits just IN FRONT of a brake.
 *
 *  score = pull x reach x pass x ratio^power
 *    pull   how strongly the level pulls: log2(1 + usd / $100k) for a cluster (plus 10% per
 *           extra trader, up to 4), half of max(1, log2(1 + usd / $25k)) for a brake;
 *    reach  the chance price gets there within H hours (24 / 48 / 96 by greed), from the
 *           reflection rule of a random walk: 2 x (1 - Phi(distance / (sigma1h x sqrt(H))));
 *           below 3% the level is dropped;
 *    pass   0.8 for each wall, round number or swing high in the way (at most 3);
 *    power  0.5 Shy, 1 Deserved, 1.5 Greedy.
 *  The highest score wins (ties: the nearer). Nothing scored: the bare floor. Then the
 *  target is never left within 0.1% behind a brake (moved in front when that keeps the
 *  slack line). Every pick carries one plain sentence saying why, and its counts.
 *
 * Pure: no network, no clock. The only randomness is ONE draw for the jitter in front of a
 * brake (the same draw serves every brake of one pick), so a seed reproduces a Set.
 * Everything below is written for a Buy; a Sell mirrors it through `sign`.
 * Units: prices quote per base; USD for weights; ratios plain multipliers.
 */
import { liquidationDistance } from "./liquidation";
import { decimalsOf, roundToTick } from "./rounding";
import type { Level, LiquidationLevel, RandomSource, Side, TpMode } from "./types";
import { activeRules, DEFAULT_RULES, type SetRules } from "../rules/rules";

/** Minimum reward-to-risk ratio of each mode in a rule set. Units: plain multiplier. */
export function tpMinRatios(r: SetRules = activeRules()): Readonly<Record<TpMode, number>> {
  return { shy: r.target.shy, deserved: r.target.deserved, greedy: r.target.greedy };
}
/** The default ratios (1, 2, 4). pickTakeProfit reads the active rules. */
export const TP_MIN_RATIO: Readonly<Record<TpMode, number>> = tpMinRatios(DEFAULT_RULES);

/** Thrown when a requested ratio is below 1x. A Set never risks more than it can win. */
export class RatioBelowOneError extends Error {
  constructor(public readonly ratio: number) {
    super(`take-profit ratio ${ratio} is below 1x; a Set never risks more than it aims to win`);
    this.name = "RatioBelowOneError";
  }
}

/**
 * Clean float noise from a ratio: 3.999999999999982 becomes 4. Rounds to 9 decimal places,
 * far below any tick. Units: plain multiplier.
 */
export function cleanRatio(ratio: number): number {
  return Math.round(ratio * 1e9) / 1e9;
}

/** Reject any ratio below 1 (or not a number): the product rule "never below 1x anywhere". */
export function assertRatioAtLeastOne(ratio: number): void {
  if (!Number.isFinite(ratio) || ratio < 1) throw new RatioBelowOneError(ratio);
}

/**
 * Exact take-profit price for a given ratio against a stop.
 * Buy: tp = entry + ratio x (entry - stop); Sell: tp = entry - ratio x (stop - entry).
 */
export function exactTakeProfitPrice(entry: number, stopPrice: number, side: Side, ratio: number): number {
  assertRatioAtLeastOne(ratio);
  const dist = liquidationDistance(entry, stopPrice) * ratio;
  return side === "buy" ? entry + dist : entry - dist;
}

/**
 * The round-number step for a price: 5 x 10^(digits before the decimal point - 3).
 * 64,000 -> 500, 3,200 -> 50, 150 -> 5, 24 -> 0.5, 1.2 -> 0.05, 0.25 -> 0.005.
 */
export function roundNumberStep(price: number): number {
  if (!(price > 0)) throw new RangeError(`price must be > 0, got ${price}`);
  const magnitude = Math.floor(Math.log10(price));
  return Number((5 * Math.pow(10, magnitude - 2)).toPrecision(12));
}

/** All round numbers between two prices (inclusive), on the step for `refPrice`. */
export function roundNumbersBetween(low: number, high: number, refPrice: number): number[] {
  const step = roundNumberStep(refPrice);
  const out: number[] = [];
  for (let n = Math.ceil(low / step - 1e-9); n * step <= high + 1e-9; n++) out.push(Number((n * step).toPrecision(12)));
  return out;
}

// ---------------------------------------------------------------------------
// Volatility and the chance of reaching a level
// ---------------------------------------------------------------------------

/**
 * Standard deviation of the hourly log returns of the last `lookbackHours` one-hour closes
 * (Aster klines), floored at `floor`. Sample standard deviation (n - 1).
 * Fewer than half the lookback in returns: the floor is used and tooFewCandles is true.
 * Units: closes quote per base; sigma1h a share of the price per hour (0.007 = 0.7%).
 */
export function realizedVol1h(
  closes: number[],
  opts: { lookbackHours?: number; floor?: number } = {},
): { sigma1h: number; measured: number | null; returnsUsed: number; floored: boolean; tooFewCandles: boolean } {
  const lookback = opts.lookbackHours ?? activeRules().target.volLookbackHours;
  const floor = opts.floor ?? activeRules().target.volFloor;
  const clean = closes.filter((c) => Number.isFinite(c) && c > 0).slice(-(lookback + 1));
  const rets: number[] = [];
  for (let i = 1; i < clean.length; i++) rets.push(Math.log((clean[i] as number) / (clean[i - 1] as number)));
  if (rets.length < Math.max(2, Math.ceil(lookback / 2))) {
    return { sigma1h: floor, measured: null, returnsUsed: rets.length, floored: true, tooFewCandles: true };
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
  return { sigma1h: Math.max(sd, floor), measured: sd, returnsUsed: rets.length, floored: sd < floor, tooFewCandles: false };
}

/**
 * The recent swing levels for the target (A1 e): the highest high and the lowest low of the
 * last `swingLookback["1h"]` one-hour candles and of the last `swingLookback["4h"]` four-hour
 * candles. Highs serve a Buy's target, lows a Sell's. Duplicates removed.
 * Units: quote per base.
 */
export function swingLevels(
  candles1h: Array<{ high: number; low: number }>,
  candles4h: Array<{ high: number; low: number }>,
  lookback: { "1h": number; "4h": number } = activeRules().target.swingLookback,
): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (const [candles, n] of [
    [candles1h, lookback["1h"]],
    [candles4h, lookback["4h"]],
  ] as const) {
    const last = n > 0 ? candles.slice(-n) : [];
    if (last.length === 0) continue;
    const h = Math.max(...last.map((c) => c.high));
    const l = Math.min(...last.map((c) => c.low));
    if (h > 0 && !highs.includes(h)) highs.push(h);
    if (l > 0 && !lows.includes(l)) lows.push(l);
  }
  return { highs, lows };
}

/** Complementary error function, Abramowitz and Stegun 7.1.26 (absolute error under 1.5e-7). */
export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-x * x);
}

/**
 * Chance that the high of the next `hours` reaches a level `distanceFraction` away (a share
 * of the entry), for a random walk with hourly sigma: 2 x (1 - Phi(z)) = erfc(z / sqrt 2),
 * z = distance / (sigma1h x sqrt(hours)). The reflection rule.
 */
export function reachChance(distanceFraction: number, sigma1h: number, hours: number): number {
  const z = Math.abs(distanceFraction) / (sigma1h * Math.sqrt(hours));
  return Math.min(1, erfc(z / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the final take-profit came from, for display and logs. */
export type TpSource = "liquidation-cluster" | "wall" | "round-number" | "swing" | "trader-tp" | "exact-ratio";
export type BrakeKind = "wall" | "round-number" | "swing" | "trader-tp";

/** A place where price may stall. price = the level itself (the wall's first order, the round number...). */
export interface Brake {
  kind: BrakeKind;
  price: number;
  /** Resting orders in the 0.05% band of the level (a bare round number: 0). USD. */
  restingUsd: number;
}

/** A cluster of liquidation prices on the profit side. */
export interface FuelCluster {
  /** The liquidation price nearest the entry, and the farthest. */
  nearEdge: number;
  farEdge: number;
  notionalUsd: number;
  /** Positions in the cluster (one position per trader and coin on Hyperliquid). */
  traders: number;
  bands: number;
}

/** One level the target may use (A3). price is already on the tick. */
export interface TargetCandidate {
  kind: "liquidation-cluster" | BrakeKind;
  price: number;
  pull: number;
  weightUsd: number;
  traders: number;
  /** The brake the target sits in front of (a brake candidate, or a cluster shadowed by one). */
  brake: Brake | null;
  cluster: FuelCluster | null;
  /** Moved outward to the slack line because it sat inside it. */
  clamped: boolean;
}

/** A candidate with its score parts against one entry and stop (A4). */
export interface ScoredCandidate extends TargetCandidate {
  ratio: number;
  reach: number;
  pass: number;
  brakesInWay: number;
  reward: number;
  score: number;
  /** Why it lost its chance, or null when it was in the race. */
  dropped: null | "out of reach" | "below the slack line" | "beyond the window top";
}

/** The ratio window of one pick (A2) in ratios and prices. */
export interface TargetWindow {
  floor: number;
  /** floor - ratioSlack, never below 1 (the 1x rule). */
  lo: number;
  /** floor x windowTop. */
  hi: number;
  linePrice: number;
  floorPrice: number;
  topPrice: number;
}

/** Structural counts of one pick, so a silent zero is visible in plans.jsonl. */
export interface TargetCounts {
  /** Liquidation levels handed in (the fuel map), on the profit side, inside the window. */
  liquidationLevelsRead: number;
  liquidationsOnProfitSide: number;
  liquidationsInWindow: number;
  /** Clusters that qualified, and those dropped: too small, or wholly inside the slack line. */
  clustersFound: number;
  clustersTooSmall: number;
  clustersBelowSlackLine: number;
  /** Opposite-side resting orders handed in (Aster book plus traders' limits), and inside the window. */
  levelsRead: number;
  levelsInWindow: number;
  walls: number;
  roundNumbers: number;
  swingHighs: number;
  traderTakeProfits: number;
  brakesFound: number;
  candidatesScored: number;
  candidatesOutOfReach: number;
  candidatesOutsideWindow: number;
  /** The volatility used (after the floor) and the hours of the reach. */
  sigma1h: number;
  sigmaSource: "measured" | "floor" | "not given";
  horizonHours: number;
  fuelMap: "ok" | "unavailable";
  /** Why the map is unavailable ("thin: 12 of 600 accounts", "not read yet ..."), or null. */
  fuelMapNote: string | null;
  winner: null | { kind: string; pull: number; reach: number; pass: number; score: number };
}

/** What a Set keeps so the target can be chosen again against the real fill (A7). */
export interface TargetBasis {
  mode: TpMode;
  floor: number;
  sigma1h: number;
  horizonHours: number;
  fuelMap: "ok" | "unavailable";
  /** Top candidates by score at plan time, and every brake of the window. */
  candidates: TargetCandidate[];
  brakes: Brake[];
}

/** Result of chooseTarget (and of pickTakeProfit, which adds the collection counts). */
export interface TakeProfitPick {
  /** Final take-profit price on the tick grid. */
  price: number;
  /** |price - entry| / |entry - stop|; at least the slack line (floor - 0.1, never below 1). */
  ratio: number;
  /** The mode's floor ratio. */
  minRatio: number;
  /** Exact price at the floor. */
  exactPrice: number;
  stopPrice: number;
  source: TpSource;
  /** One plain sentence: where the target sits and why. */
  reason: string;
  /** The top 5 by score (in the race only), for the log and the card. */
  candidates: ScoredCandidate[];
  /** Every candidate with its score or the reason it was dropped. */
  scored: ScoredCandidate[];
  brakes: Brake[];
  window: TargetWindow;
  counts: TargetCounts;
  /** The brake the target was moved in front of after the pick (A5), if any. */
  pulledInFrontOf: Brake | null;
  basis: TargetBasis;
}

/** Inputs for pickTakeProfit. */
export interface PickTakeProfitInput {
  entry: number;
  side: Side;
  /** The stop price (stop.ts). The ratio is measured against |entry - stop|. */
  stopPrice: number;
  mode: TpMode;
  tickSize: number;
  /**
   * Resting volume on the OPPOSITE side, any sources merged: asks for a Buy, bids for a
   * Sell (Aster depth + Hyperliquid traders' limits). Loss-side levels are ignored.
   */
  oppositeVolume?: Level[];
  /** Visible take-profit prices of skilled traders (each its own brake). */
  traderTakeProfits?: Level[];
  /** Liquidation prices of other traders (the fuel map). Only the profit side is used: shorts for a Buy. */
  liquidationLevels?: LiquidationLevel[];
  /** The recent swing high(s) for a Buy; for a Sell pass the swing low(s) here. */
  swingHighs?: number[];
  /** Hourly volatility (realizedVol1h). Missing: the floor is used and the counts say so. */
  sigma1h?: number | null;
  /** True when sigma1h is already the floor (realizedVol1h's `floored`), so the counts say "floor". */
  sigmaFloored?: boolean;
  /** "unavailable" when the liquidation map could not be read (the reason says so). */
  fuelMap?: "ok" | "unavailable";
  /** Why it is unavailable, carried into the reason (for example "thin: 12 of 600 accounts"). */
  fuelMapNote?: string | null;
  /** One draw for the jitter in front of a brake. Default: no jitter (always 0.5). */
  random?: RandomSource;
  /** Optional override of the mode's floor (must be >= 1). */
  minRatioOverride?: number;
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------

type T = SetRules["target"];

/** Profit-side helpers for one entry and stop. */
function geometry(entry: number, stopPrice: number, side: Side, floor: number, t: T) {
  const stopOnRightSide = side === "buy" ? stopPrice < entry : stopPrice > entry;
  if (!stopOnRightSide) throw new RangeError(`stop ${stopPrice} is on the wrong side of entry ${entry} for a ${side}`);
  const s = liquidationDistance(entry, stopPrice);
  const sign = side === "buy" ? 1 : -1;
  const lo = Math.max(1, floor - t.ratioSlack);
  const hi = floor * t.windowTop;
  /** Profit-side distance of a price from the entry (positive on the profit side). */
  const d = (p: number) => sign * (p - entry);
  const at = (dist: number) => entry + sign * dist;
  const ratioOf = (p: number) => cleanRatio(d(p) / s);
  const window: TargetWindow = { floor, lo, hi, linePrice: at(lo * s), floorPrice: at(floor * s), topPrice: at(hi * s) };
  return { s, sign, lo, hi, d, at, ratioOf, window };
}

/** Round toward the entry; if that falls inside the slack line, away from it. */
function roundKeepingLine(raw: number, side: Side, tickSize: number, lineDist: number, d: (p: number) => number): number {
  const toward = roundToTick(raw, tickSize, side === "buy" ? "down" : "up");
  if (d(toward) >= lineDist - 1e-9) return toward;
  return roundToTick(raw, tickSize, side === "buy" ? "up" : "down");
}

/**
 * The spot just in front of a brake: gap +- jitter before it, on the tick toward the entry,
 * and always strictly in front (one tick nearer when rounding lands on it).
 * r in [0, 1): r = 0.5 is exactly the gap. Range [gap - jitter, gap + jitter).
 */
export function frontOfBrake(brakePrice: number, side: Side, tickSize: number, r: number, t: Pick<T, "wallFrontGap" | "wallJitter"> = activeRules().target): number {
  if (!(r >= 0 && r < 1)) throw new RangeError(`random source must return [0, 1), got ${r}`);
  const sign = side === "buy" ? 1 : -1;
  const offset = Math.max(0, t.wallFrontGap + (r * 2 - 1) * t.wallJitter);
  let p = roundToTick(brakePrice * (1 - sign * offset), tickSize, side === "buy" ? "down" : "up");
  if (sign * (p - brakePrice) >= 0) p = roundToTick(brakePrice - sign * tickSize, tickSize, side === "buy" ? "down" : "up");
  return p;
}

// ---------------------------------------------------------------------------
// A3: candidates
// ---------------------------------------------------------------------------

/** Counts of the collection step. */
export type CollectCounts = Omit<TargetCounts, "candidatesScored" | "candidatesOutOfReach" | "candidatesOutsideWindow" | "sigma1h" | "sigmaSource" | "horizonHours" | "fuelMap" | "fuelMapNote" | "winner">;

/** Output of collectTargetCandidates. */
export interface CollectedTargets {
  candidates: TargetCandidate[];
  brakes: Brake[];
  clusters: FuelCluster[];
  window: TargetWindow;
  counts: CollectCounts;
}

/**
 * Collect the fuel clusters and brakes of the window and turn each into a placed candidate (A3).
 * r: the one jitter draw in [0, 1).
 */
export function collectTargetCandidates(args: {
  entry: number;
  stopPrice: number;
  side: Side;
  mode: TpMode;
  tickSize: number;
  fuelLevels?: LiquidationLevel[];
  bookLevels?: Level[];
  traderTakeProfits?: Level[];
  swingHighs?: number[];
  r?: number;
  minRatioOverride?: number;
  rules?: SetRules;
}): CollectedTargets {
  const t = (args.rules ?? activeRules()).target;
  const floor = args.minRatioOverride ?? t[args.mode];
  assertRatioAtLeastOne(floor);
  const { entry, side, tickSize } = args;
  const r = args.r ?? 0.5;
  const g = geometry(entry, args.stopPrice, side, floor, t);
  const { s, d, at, window } = g;
  const dLine = g.lo * s;
  const dTop = g.hi * s;
  // Brakes are looked for a hair inside the line too, so the never-just-behind rule (A5)
  // sees a brake the slack line itself sits behind.
  const dExt = dLine - window.linePrice * t.sameSpotGap;

  // ---- brakes ----
  const book = (args.bookLevels ?? []).filter((l) => l.price > 0 && l.weightUsd > 0);
  const width = entry * t.wallBandWidth;
  const bands = new Map<number, { usd: number; front: number; absorbed: boolean }>();
  let levelsInWindow = 0;
  for (const l of book) {
    const dist = d(l.price);
    if (dist < dExt || dist > dTop) continue;
    if (dist >= dLine) levelsInWindow++;
    const k = Math.floor(dist / width + 1e-9);
    const b = bands.get(k);
    if (b) bands.set(k, { usd: b.usd + l.weightUsd, front: d(l.price) < d(b.front) ? l.price : b.front, absorbed: false });
    else bands.set(k, { usd: l.weightUsd, front: l.price, absorbed: false });
  }
  const brakes: Brake[] = [];
  /**
   * A round number or swing high takes the resting orders of its own band (one stall, not
   * two), unless a wall in that band starts before it: then the wall stays its own brake,
   * so the target sits in front of the first resting money.
   */
  const pointBrake = (kind: "round-number" | "swing", price: number) => {
    const k = Math.floor(d(price) / width + 1e-9);
    const b = bands.get(k);
    let restingUsd = 0;
    const wallFirst = b !== undefined && b.usd >= t.wallMinUsd && d(b.front) < d(price) - 1e-9;
    if (b && !b.absorbed && !wallFirst) {
      restingUsd = b.usd;
      b.absorbed = true;
    }
    brakes.push({ kind, price, restingUsd });
  };
  const ext = at(dExt);
  const top = at(dTop);
  const rounds = roundNumbersBetween(Math.min(ext, top), Math.max(ext, top), entry);
  for (const p of rounds) pointBrake("round-number", p);
  let swings = 0;
  for (const p of args.swingHighs ?? []) {
    if (!(p > 0)) continue;
    const dist = d(p);
    if (dist < dExt || dist > dTop) continue;
    if (brakes.some((b) => Math.abs(b.price - p) < tickSize / 2)) continue; // same price as a round number
    swings++;
    pointBrake("swing", p);
  }
  let walls = 0;
  for (const b of bands.values()) {
    if (b.absorbed || b.usd < t.wallMinUsd) continue;
    walls++;
    brakes.push({ kind: "wall", price: b.front, restingUsd: b.usd });
  }
  let tps = 0;
  for (const l of args.traderTakeProfits ?? []) {
    if (!(l.price > 0)) continue;
    const dist = d(l.price);
    if (dist < dExt || dist > dTop) continue;
    tps++;
    brakes.push({ kind: "trader-tp", price: l.price, restingUsd: l.weightUsd > 0 ? l.weightUsd : 0 });
  }
  brakes.sort((a, b) => d(a.price) - d(b.price));

  // ---- fuel clusters ----
  const wanted = side === "buy" ? "short" : "long";
  const fuel = args.fuelLevels ?? [];
  const fw = entry * t.fuelBandWidth;
  const fb = new Map<number, { usd: number; n: number; near: number; far: number }>();
  let onSide = 0;
  let fuelInWindow = 0;
  for (const l of fuel) {
    if (l.positionSide !== wanted || !(l.price > 0) || !(l.weightUsd > 0)) continue;
    const dist = d(l.price);
    if (!(dist > 0)) continue;
    onSide++;
    if (dist > dTop) continue;
    if (dist >= dLine) fuelInWindow++;
    const k = Math.floor(dist / fw + 1e-9);
    const b = fb.get(k);
    if (b) fb.set(k, { usd: b.usd + l.weightUsd, n: b.n + 1, near: d(l.price) < d(b.near) ? l.price : b.near, far: d(l.price) > d(b.far) ? l.price : b.far });
    else fb.set(k, { usd: l.weightUsd, n: 1, near: l.price, far: l.price });
  }
  const keys = [...fb.keys()].sort((a, b) => a - b);
  const clusters: FuelCluster[] = [];
  let tooSmall = 0;
  let belowLine = 0;
  for (let i = 0; i < keys.length; ) {
    // One run of neighbouring non-empty bands, cut into pieces of at most fuelMaxBands.
    const chunk: number[] = [keys[i] as number];
    let j = i + 1;
    while (j < keys.length && (keys[j] as number) === (keys[j - 1] as number) + 1 && chunk.length < t.fuelMaxBands) chunk.push(keys[j++] as number);
    i = j;
    const parts = chunk.map((k) => fb.get(k) as { usd: number; n: number; near: number; far: number });
    const c: FuelCluster = {
      nearEdge: (parts[0] as { near: number }).near,
      farEdge: (parts[parts.length - 1] as { far: number }).far,
      notionalUsd: parts.reduce((x, p) => x + p.usd, 0),
      traders: parts.reduce((x, p) => x + p.n, 0),
      bands: chunk.length,
    };
    if (c.notionalUsd < t.fuelMinUsd) {
      tooSmall++;
      continue;
    }
    if (d(c.farEdge) < dLine) {
      belowLine++;
      continue; // wholly inside the slack line: never a target
    }
    clusters.push(c);
  }

  // ---- candidates ----
  const candidates: TargetCandidate[] = [];
  const place = (raw: number) => {
    let p = raw;
    let clamped = false;
    if (d(p) < dLine) {
      p = window.linePrice;
      clamped = true;
    }
    return { price: roundKeepingLine(p, side, tickSize, dLine, d), clamped };
  };
  let clampedPast = 0;
  for (const c of clusters) {
    let raw = c.nearEdge * (1 - g.sign * t.fuelInset);
    // A brake just in front of the edge: the target goes in front of the first such brake.
    const shadow = brakes.find((b) => d(b.price) <= d(c.nearEdge) && (d(c.nearEdge) - d(b.price)) / c.nearEdge <= t.brakeShadow);
    if (shadow) raw = frontOfBrake(shadow.price, side, tickSize, r, t);
    const pl = place(raw);
    if (pl.clamped && d(pl.price) > d(c.farEdge)) {
      clampedPast++;
      continue; // the clamp lands beyond the cluster's far edge: dropped (A3)
    }
    const pull = Math.log2(1 + c.notionalUsd / t.fuelMinUsd) * (1 + t.fuelDensityBonus * Math.min(c.traders - 1, 4));
    // Clamped to the line: the target no longer sits in front of the shadowing brake, so it is not named as such.
    candidates.push({ kind: "liquidation-cluster", price: pl.price, pull, weightUsd: c.notionalUsd, traders: c.traders, brake: pl.clamped ? null : (shadow ?? null), cluster: c, clamped: pl.clamped });
  }
  for (const b of brakes) {
    if (d(b.price) < dLine - 1e-9) continue; // inside the slack line: only watched by A5
    const pl = place(frontOfBrake(b.price, side, tickSize, r, t));
    const pull = t.brakeWeight * Math.max(1, Math.log2(1 + b.restingUsd / t.wallMinUsd));
    candidates.push({ kind: b.kind, price: pl.price, pull, weightUsd: b.restingUsd, traders: 0, brake: b, cluster: null, clamped: pl.clamped });
  }

  return {
    candidates,
    brakes,
    clusters,
    window,
    counts: {
      liquidationLevelsRead: fuel.length,
      liquidationsOnProfitSide: onSide,
      liquidationsInWindow: fuelInWindow,
      clustersFound: clusters.length - clampedPast,
      clustersTooSmall: tooSmall,
      clustersBelowSlackLine: belowLine + clampedPast,
      levelsRead: (args.bookLevels ?? []).length,
      levelsInWindow,
      walls,
      roundNumbers: rounds.length,
      swingHighs: swings,
      traderTakeProfits: tps,
      brakesFound: brakes.length,
    },
  };
}

// ---------------------------------------------------------------------------
// A4 to A6: the choice
// ---------------------------------------------------------------------------

/** Brake kinds that cost a candidate 0.8 each when in the way (trader take-profits do not). */
const STALLS: readonly BrakeKind[] = ["wall", "round-number", "swing"];

/**
 * Score every candidate against this entry and stop and pick the best (A4); no candidate:
 * the bare floor (A6); then never just behind a brake (A5). Candidates keep their prices,
 * so a re-choice against the real fill (A7) reuses the stored list.
 * r: the jitter draw used to place in front of a brake by A5 (default 0.5).
 */
export function chooseTarget(args: {
  candidates: TargetCandidate[];
  brakes: Brake[];
  entry: number;
  stopPrice: number;
  side: Side;
  mode: TpMode;
  tickSize: number;
  sigma1h?: number | null;
  /** The sigma passed was already floored by realizedVol1h. */
  sigmaFloored?: boolean;
  r?: number;
  fuelMap?: "ok" | "unavailable";
  fuelMapNote?: string | null;
  minRatioOverride?: number;
  rules?: SetRules;
  /** Counts of the collection step, carried into the result. */
  collected?: CollectCounts;
}): TakeProfitPick {
  const t = (args.rules ?? activeRules()).target;
  const floor = args.minRatioOverride ?? t[args.mode];
  assertRatioAtLeastOne(floor);
  const { entry, side, tickSize } = args;
  const r = args.r ?? 0.5;
  const g = geometry(entry, args.stopPrice, side, floor, t);
  const { s, d, ratioOf, window } = g;
  const dLine = g.lo * s;
  const H = t.horizonHours[args.mode];
  const power = t.rewardPower[args.mode];
  const sigmaSource: TargetCounts["sigmaSource"] = args.sigma1h == null ? "not given" : args.sigmaFloored || args.sigma1h <= t.volFloor ? "floor" : "measured";
  const sigma = Math.max(args.sigma1h ?? 0, t.volFloor);
  const fuelMap = args.fuelMap ?? "ok";

  const scored: ScoredCandidate[] = args.candidates.map((c) => {
    const ratio = ratioOf(c.price);
    const reach = reachChance(d(c.price) / entry, sigma, H);
    const inWay = args.brakes.filter((b) => STALLS.includes(b.kind) && d(b.price) > dLine + 1e-9 && d(b.price) < d(c.price) - 1e-9).length;
    const pass = Math.pow(t.brakePass, Math.min(3, inWay));
    const reward = ratio > 0 ? Math.pow(ratio, power) : 0;
    let dropped: ScoredCandidate["dropped"] = null;
    if (ratio < g.lo - 1e-9) dropped = "below the slack line";
    else if (ratio > g.hi + 1e-9) dropped = "beyond the window top";
    else if (reach < t.minReach) dropped = "out of reach";
    return { ...c, ratio, reach, pass, brakesInWay: inWay, reward, score: c.pull * reach * pass * reward, dropped };
  });
  const live = scored.filter((c) => c.dropped === null);
  // Highest score first; a tie goes to the nearer level (reached sooner).
  live.sort((a, b) => (Math.abs(b.score - a.score) > 1e-12 ? b.score - a.score : d(a.price) - d(b.price)));
  const best = live[0] ?? null;

  let price: number;
  let source: TpSource;
  if (best) {
    price = best.price;
    source = best.kind;
  } else {
    price = roundToTick(window.floorPrice, tickSize, side === "buy" ? "up" : "down"); // the full floor: nothing earns the slack
    source = "exact-ratio";
  }

  // ---- A5: never within sameSpotGap behind a brake ----
  let pulledInFrontOf: Brake | null = null;
  let stuckBehind: Brake | null = null;
  for (let guard = 0; guard < 5; guard++) {
    const behind = args.brakes.find((b) => d(b.price) <= d(price) + 1e-9 && (d(price) - d(b.price)) / b.price <= t.sameSpotGap);
    if (!behind) break;
    const front = frontOfBrake(behind.price, side, tickSize, r, t);
    if (d(front) >= dLine - 1e-9) {
      price = front;
      pulledInFrontOf = behind;
    } else {
      stuckBehind = behind;
      break;
    }
  }
  const ratio = ratioOf(price);
  assertRatioAtLeastOne(ratio); // defensive: the line is never below 1x

  const clustersFound = args.collected?.clustersFound ?? args.candidates.filter((c) => c.kind === "liquidation-cluster").length;
  const counts: TargetCounts = {
    ...(args.collected ?? {
      liquidationLevelsRead: 0,
      liquidationsOnProfitSide: 0,
      liquidationsInWindow: 0,
      clustersFound,
      clustersTooSmall: 0,
      clustersBelowSlackLine: 0,
      levelsRead: 0,
      levelsInWindow: 0,
      walls: args.brakes.filter((b) => b.kind === "wall").length,
      roundNumbers: args.brakes.filter((b) => b.kind === "round-number").length,
      swingHighs: args.brakes.filter((b) => b.kind === "swing").length,
      traderTakeProfits: args.brakes.filter((b) => b.kind === "trader-tp").length,
      brakesFound: args.brakes.length,
    }),
    candidatesScored: scored.length,
    candidatesOutOfReach: scored.filter((c) => c.dropped === "out of reach").length,
    candidatesOutsideWindow: scored.filter((c) => c.dropped === "below the slack line" || c.dropped === "beyond the window top").length,
    sigma1h: sigma,
    sigmaSource,
    horizonHours: H,
    fuelMap,
    fuelMapNote: fuelMap === "unavailable" ? (args.fuelMapNote ?? null) : null,
    winner: best ? { kind: best.kind, pull: round4(best.pull), reach: round4(best.reach), pass: round4(best.pass), score: round4(best.score) } : null,
  };
  const top5 = live.slice(0, 5);
  const pick: TakeProfitPick = {
    price,
    ratio,
    minRatio: floor,
    exactPrice: window.floorPrice,
    stopPrice: args.stopPrice,
    source,
    reason: "",
    candidates: top5,
    scored,
    brakes: args.brakes,
    window,
    counts,
    pulledInFrontOf,
    basis: { mode: args.mode, floor, sigma1h: sigma, horizonHours: H, fuelMap, candidates: top5.map(stripScore), brakes: args.brakes },
  };
  pick.reason = targetReason({ pick, best, side, tickSize, stuckBehind, clustersFound, scored });
  return pick;
}

/** The candidate fields without its score (what the ledger stores). */
function stripScore(c: ScoredCandidate): TargetCandidate {
  return { kind: c.kind, price: c.price, pull: c.pull, weightUsd: c.weightUsd, traders: c.traders, brake: c.brake, cluster: c.cluster, clamped: c.clamped };
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// A9: the sentence
// ---------------------------------------------------------------------------

/** "1,949.41": thousands separators, at most the tick's decimals. */
function fmtPrice(p: number, tickSize: number): string {
  return p.toLocaleString("en-US", { maximumFractionDigits: decimalsOf(tickSize), minimumFractionDigits: 0 });
}
/** "$2.5M", "$30M", "$150k", "$900". */
export function fmtUsdShort(v: number): string {
  if (v >= 1e7) return `$${Math.round(v / 1e6)}M`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}
/** "2x", "1.9x", "3.02x". */
function fmtX(x: number): string {
  return `${Number(x.toFixed(2))}x`;
}

/** How a brake reads in a sentence. */
function brakePhrase(b: Brake, side: Side, tickSize: number, withResting: boolean): string {
  const orders = side === "buy" ? "sell orders" : "buy orders";
  const at = fmtPrice(b.price, tickSize);
  switch (b.kind) {
    case "round-number":
      return withResting && b.restingUsd >= 1000 ? `${at}, a round number with ${fmtUsdShort(b.restingUsd)} of ${orders} resting` : `${at} (a round number)`;
    case "wall":
      return `a wall of ${fmtUsdShort(b.restingUsd)} of ${orders} at ${at}`;
    case "swing":
      return `${at} (the recent swing ${side === "buy" ? "high" : "low"})`;
    case "trader-tp":
      return `${at}, where a skilled trader takes profit`;
  }
}

/** The cluster in words: "$2.5M of 3 traders' shorts get liquidated (1,950.4 to 1,951.9)". */
function clusterPhrase(c: FuelCluster, side: Side, tickSize: number): string {
  const who = c.traders === 1 ? "1 trader's" : `${c.traders} traders'`;
  const what = side === "buy" ? "shorts" : "longs";
  const span = c.nearEdge === c.farEdge ? fmtPrice(c.nearEdge, tickSize) : `${fmtPrice(c.nearEdge, tickSize)} to ${fmtPrice(c.farEdge, tickSize)}`;
  return `${fmtUsdShort(c.notionalUsd)} of ${who} ${what} get liquidated (${span})`;
}

/** "0.075%": how far a price sits beyond a brake. */
function pctBehind(b: Brake, price: number, side: Side): string {
  const sign = side === "buy" ? 1 : -1;
  return `${Number((((sign * (price - b.price)) / b.price) * 100).toFixed(3))}%`;
}

/**
 * One human sentence for a pick (A9). Forms:
 *  cluster: "target 1,949.41, just in front of 1,950 (a round number) at the edge of a cluster where $2.5M of 3 traders' shorts get liquidated (1,950.4 to 1,951.9), 3.02x the stop"
 *  brake:   "no liquidation cluster between 1.9x and 4x, so target 1,899.43, just in front of 1,900 (a round number), 1.97x the stop (floor 2x, slack 0.1x)"
 *  none:    "the bare 2x at 1,900.81: no liquidation cluster, wall, round number or swing high between 1.9x and 4x within reach"
 */
export function targetReason(a: {
  pick: TakeProfitPick;
  best: ScoredCandidate | null;
  side: Side;
  tickSize: number;
  stuckBehind: Brake | null;
  clustersFound: number;
  scored: ScoredCandidate[];
}): string {
  const { pick, best, side, tickSize } = a;
  const w = pick.window;
  const between = `between ${fmtX(w.lo)} and ${fmtX(w.hi)}`;
  const price = fmtPrice(pick.price, tickSize);
  const slack = pick.ratio < w.floor - 1e-9 ? ` (floor ${fmtX(w.floor)}, slack ${fmtX(w.floor - w.lo)})` : "";
  const ratioText = `${fmtX(pick.ratio)} the stop${slack}`;
  const pulled = pick.pulledInFrontOf ? `pulled in front of ${brakePhrase(pick.pulledInFrontOf, side, tickSize, false)}` : "";
  const stuck = a.stuckBehind ? `; it stays just behind ${brakePhrase(a.stuckBehind, side, tickSize, false)}, because in front of it would break the ${fmtX(w.lo)} line` : "";
  const mapGone = pick.counts.fuelMap === "unavailable";
  const mapText = `liquidation map unavailable${pick.counts.fuelMapNote ? ` (${pick.counts.fuelMapNote})` : ""}`;

  if (!best) {
    const head = `the bare ${fmtX(w.floor)} at ${price}${pulled ? `, ${pulled}` : ""}`;
    const what = `no liquidation cluster, wall, round number or swing high ${between} within reach`;
    // Name the heaviest cluster that was there but out of reach, so the choice is visible.
    const far = a.scored
      .filter((c) => c.kind === "liquidation-cluster" && c.dropped === "out of reach" && c.cluster)
      .sort((x, y) => y.weightUsd - x.weightUsd)[0];
    const farText = far?.cluster ? `; the ${fmtUsdShort(far.cluster.notionalUsd)} cluster at ${fmtPrice(far.cluster.nearEdge, tickSize)} is out of reach within ${pick.counts.horizonHours} h` : "";
    return `${head}: ${what}${farText}${mapGone ? `; ${mapText}` : ""}${stuck}`;
  }

  const prefix = mapGone ? `${mapText}, so ` : a.clustersFound === 0 ? `no liquidation cluster ${between}, so ` : "";
  if (best.kind === "liquidation-cluster" && best.cluster) {
    const edge = best.brake ? `just in front of ${brakePhrase(best.brake, side, tickSize, false)} at the edge of` : best.clamped ? "on the slack line inside" : "just inside the edge of";
    const head = pulled
      ? `target ${price}: the best level was a cluster where ${clusterPhrase(best.cluster, side, tickSize)}, ${pulled}`
      : `target ${price}, ${edge} a cluster where ${clusterPhrase(best.cluster, side, tickSize)}`;
    return `${prefix}${head}, ${ratioText}${stuck}`;
  }
  const b = best.brake as Brake;
  const head = pulled
    ? `target ${price}: the best level was ${brakePhrase(b, side, tickSize, true)}, ${pulled} because it sat ${pctBehind(pick.pulledInFrontOf as Brake, best.price, side)} behind it`
    : !best.clamped
      ? `target ${price}, just in front of ${brakePhrase(b, side, tickSize, true)}`
      : (side === "buy" ? best.price < b.price : best.price > b.price)
        ? `target ${price}, just in front of ${brakePhrase(b, side, tickSize, true)}, moved out to the ${fmtX(w.lo)} line`
        : `target ${price}, on the ${fmtX(w.lo)} line just past ${brakePhrase(b, side, tickSize, true)}`;
  return `${prefix}${head}, ${ratioText}${stuck}`;
}

// ---------------------------------------------------------------------------
// The whole pick
// ---------------------------------------------------------------------------

/**
 * Pick the take-profit price for a Set: collect (A3), choose (A4 to A6), explain (A9).
 * Draws exactly one random number (the jitter in front of a brake).
 */
export function pickTakeProfit(input: PickTakeProfitInput): TakeProfitPick {
  const floor = input.minRatioOverride ?? tpMinRatios()[input.mode];
  assertRatioAtLeastOne(floor);
  const r = (input.random ?? (() => 0.5))();
  if (!(r >= 0 && r < 1)) throw new RangeError(`random source must return [0, 1), got ${r}`);
  const collected = collectTargetCandidates({
    entry: input.entry,
    stopPrice: input.stopPrice,
    side: input.side,
    mode: input.mode,
    tickSize: input.tickSize,
    fuelLevels: input.fuelMap === "unavailable" ? [] : input.liquidationLevels,
    bookLevels: input.oppositeVolume,
    traderTakeProfits: input.traderTakeProfits,
    swingHighs: input.swingHighs,
    r,
    minRatioOverride: input.minRatioOverride,
  });
  return chooseTarget({
    candidates: collected.candidates,
    brakes: collected.brakes,
    entry: input.entry,
    stopPrice: input.stopPrice,
    side: input.side,
    mode: input.mode,
    tickSize: input.tickSize,
    sigma1h: input.sigma1h,
    sigmaFloored: input.sigmaFloored,
    r,
    fuelMap: input.fuelMap ?? "ok",
    fuelMapNote: input.fuelMapNote,
    minRatioOverride: input.minRatioOverride,
    collected: collected.counts,
  });
}

// ---------------------------------------------------------------------------
// A7: the real fill
// ---------------------------------------------------------------------------

/** What remeasureAfterFill decided. */
export interface FillRemeasure {
  /** |target - fill| / |fill - stop|. */
  realRatio: number;
  lo: number;
  /** "keep": at or above the slack line. "re-choose": another stored level wins. "no-better": below the line and nothing beats it. */
  action: "keep" | "re-choose" | "no-better";
  choice: TakeProfitPick | null;
  message: string;
}

/**
 * After the fill (and after the stop was re-set from it), measure the target against the real
 * fill; below the slack line, choose again from the stored candidates (A7). Never moves the
 * entry or the stop. Pure: the caller decides whether to re-place the order.
 */
export function remeasureAfterFill(args: {
  basis: TargetBasis;
  side: Side;
  fill: number;
  stopPrice: number;
  takeProfitPrice: number;
  tickSize: number;
  rules?: SetRules;
}): FillRemeasure {
  const t = (args.rules ?? activeRules()).target;
  const lo = Math.max(1, args.basis.floor - t.ratioSlack);
  const s = liquidationDistance(args.fill, args.stopPrice);
  const sign = args.side === "buy" ? 1 : -1;
  const realRatio = cleanRatio((sign * (args.takeProfitPrice - args.fill)) / s);
  const tp = fmtPrice(args.takeProfitPrice, args.tickSize);
  if (realRatio >= lo - 1e-9) {
    return { realRatio, lo, action: "keep", choice: null, message: `target ${tp} is ${fmtX(realRatio)} against the real fill, at or above ${fmtX(lo)}: kept` };
  }
  const choice = chooseTarget({
    candidates: args.basis.candidates,
    brakes: args.basis.brakes,
    entry: args.fill,
    stopPrice: args.stopPrice,
    side: args.side,
    mode: args.basis.mode,
    tickSize: args.tickSize,
    sigma1h: args.basis.sigma1h,
    fuelMap: args.basis.fuelMap,
    minRatioOverride: args.basis.floor,
    rules: args.rules,
  });
  if (Math.abs(choice.price - args.takeProfitPrice) < args.tickSize / 2) {
    return { realRatio, lo, action: "no-better", choice, message: `target ${tp} is ${fmtX(realRatio)} against the real fill, below ${fmtX(lo)}; no other stored level beats it` };
  }
  return { realRatio, lo, action: "re-choose", choice, message: `target ${tp} is ${fmtX(realRatio)} against the real fill, below ${fmtX(lo)}; re-chosen: ${choice.reason}` };
}
