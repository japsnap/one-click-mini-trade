/**
 * Tests for src/core. Every function is exercised, with negative tests for each rule
 * (ratio below 1, nudge band, fallbacks, bucket windows, min notional, fee on a loss,
 * stop between entry and liquidation, brackets).
 * All REAL: pure functions, asserting on returned values that ARE the artifact.
 * Randomness: always an injected sequence or seededRandom, never Math.random.
 * The Aster order book used for the take-profit zone is the real capture in
 * tests/fixtures/aster-depth-BTCUSDT.json (2026-11-16).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDepth, parseKlines } from "../src/exchange/aster";
import { DEFAULT_RULES } from "../src/rules/rules";
import {
  assertRatioAtLeastOne,
  buildSetPlan,
  decimalsOf,
  estimateLiquidationPrice,
  evaluatePrice,
  exactTakeProfitPrice,
  findLiquidationCluster,
  findLiquidationClusterWithCounts,
  chaseCheck,
  chooseTarget,
  frontOfBrake,
  planHeadline,
  realizedVol1h,
  remeasureAfterFill,
  swingLevels,
  InvalidStopError,
  nearbyBuckets,
  pickNearbyLevel,
  planStop,
  resolveMaintenanceRate,
  seededRandom,
  stopPriceFromLiquidation,
  LEVERAGES,
  CARD_LEVERAGES,
  DEFAULT_CHOICES,
  floorToStep,
  formatToStep,
  INITIAL_WATCH_STATE,
  InvalidBandsError,
  InvalidSetInputError,
  isOnStep,
  liquidationDistance,
  nudgePrice,
  parseSetInput,
  pickEntry,
  pickTakeProfit,
  progressToTakeProfit,
  RatioBelowOneError,
  roundNumberStep,
  roundNumbersBetween,
  roundToTick,
  splitDraw,
  splitFees,
  spreadAcross,
  TicketTooSmallError,
  validateBands,
  withSymbolLeverage,
  type LiquidationLevel,
  type OpenSet,
  type SidedLevel,
  type SymbolRules,
  type TraderLevels,
} from "../src/core";

/** Real BTCUSDT rules on Aster (tests/fixtures/aster-exchangeInfo.json, 2026-11-16). */
const BTC: SymbolRules = {
  symbol: "BTCUSDT",
  tickSize: 0.1,
  stepSize: 0.001,
  minQty: 0.001,
  marketStepSize: 0.001,
  marketMinQty: 0.001,
  minNotionalUsd: 5,
};
const NO_LEVELS: TraderLevels = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };

/** Deterministic random: cycles through the given values. */
const seq = (...v: number[]) => {
  let i = 0;
  return () => v[i++ % v.length] as number;
};
/** Seeded PRNG for property-style loops (the same one the core exports). */
const mulberry32 = seededRandom;
/** Real Aster BTCUSDT order book, captured 2026-11-16 (1,000 levels a side, mid about 64,426). */
const DEPTH = parseDepth(JSON.parse(readFileSync(new URL("./fixtures/aster-depth-BTCUSDT.json", import.meta.url), "utf8")));

describe("rounding", () => {
  it("counts decimals of steps, including exponent form", () => {
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(5)).toBe(0);
    expect(decimalsOf(1e-7)).toBe(7);
    expect(() => decimalsOf(0)).toThrow(RangeError);
  });
  it("rounds to tick without float noise, in each direction", () => {
    expect(roundToTick(64312.4499, 0.1)).toBe(64312.4);
    expect(roundToTick(64312.41, 0.1, "up")).toBe(64312.5);
    expect(roundToTick(64312.49, 0.1, "down")).toBe(64312.4);
    expect(roundToTick(0.30000000000000004, 0.1, "up")).toBe(0.3); // float noise does not bump a tick
    expect(floorToStep(0.0046999, 0.001)).toBe(0.004);
    expect(formatToStep(0.1 + 0.2, 0.01)).toBe("0.30");
    expect(isOnStep(64312.4, 0.1)).toBe(true);
    expect(isOnStep(64312.45, 0.1)).toBe(false);
  });
});

describe("liquidation", () => {
  it("plain estimate: entry x (1 -/+ 1/leverage)", () => {
    expect(estimateLiquidationPrice(100, 50, "buy")).toBeCloseTo(98);
    expect(estimateLiquidationPrice(100, 50, "sell")).toBeCloseTo(102);
    expect(estimateLiquidationPrice(100, 100, "buy")).toBeCloseTo(99);
  });
  it("maintenance margin moves liquidation closer", () => {
    expect(estimateLiquidationPrice(100, 50, "buy", 0.005)).toBeCloseTo(98.5);
    expect(estimateLiquidationPrice(100, 50, "sell", 0.005)).toBeCloseTo(101.5);
    expect(liquidationDistance(100, 98.5)).toBeCloseTo(1.5);
  });
  it("rejects nonsense inputs", () => {
    expect(() => estimateLiquidationPrice(0, 50, "buy")).toThrow(RangeError);
    expect(() => estimateLiquidationPrice(100, 0.5, "buy")).toThrow(RangeError);
    expect(() => estimateLiquidationPrice(100, 50, "buy", 0.02)).toThrow(RangeError); // m >= 1/L
  });
});

describe("stop", () => {
  it("sits at 85% of the liquidation distance, rounded toward entry", () => {
    // Buy 100 with liq 98: distance 2, stop 100 - 1.7 = 98.3.
    expect(stopPriceFromLiquidation(100, 98, "buy", 0.01)).toBeCloseTo(98.3);
    expect(stopPriceFromLiquidation(100, 102, "sell", 0.01)).toBeCloseTo(101.7);
    // Tick rounding moves it toward entry, never toward liquidation: 98.3 on a 1.0 tick -> 99.
    expect(stopPriceFromLiquidation(100, 98, "buy", 1)).toBe(99);
    expect(stopPriceFromLiquidation(100, 102, "sell", 1)).toBe(101);
  });
  it("rejects a stop that cannot sit strictly between entry and liquidation (negative)", () => {
    expect(() => stopPriceFromLiquidation(100, 101, "buy", 0.01)).toThrow(InvalidStopError); // liq above a long
    expect(() => stopPriceFromLiquidation(100, 99, "sell", 0.01)).toThrow(InvalidStopError); // liq below a short
    expect(() => stopPriceFromLiquidation(100, 99.99, "buy", 1)).toThrow(InvalidStopError); // distance under one tick
    expect(() => stopPriceFromLiquidation(100, 98, "buy", 0.01, 1)).toThrow(InvalidStopError); // fraction must be < 1
    expect(() => stopPriceFromLiquidation(100, 98, "buy", 0.01, 0)).toThrow(InvalidStopError);
  });
  it("maintenance rate: brackets when given, else the assumed 0.5%, never >= 1/leverage", () => {
    const brackets = [
      { notionalFloor: 0, notionalCap: 50_000, initialLeverage: 125, maintMarginRatio: 0.004 },
      { notionalFloor: 50_000, notionalCap: 250_000, initialLeverage: 100, maintMarginRatio: 0.005 },
    ];
    expect(resolveMaintenanceRate({ notionalUsd: 300, leverage: 30, brackets })).toEqual({ rate: 0.004, source: "brackets" });
    expect(resolveMaintenanceRate({ notionalUsd: 300, leverage: 30 })).toEqual({ rate: 0.005, source: "assumed" });
    expect(() => resolveMaintenanceRate({ notionalUsd: 300, leverage: 30, brackets: [{ ...brackets[0]!, initialLeverage: 20 }] })).toThrow(/above the venue/);
    expect(() => resolveMaintenanceRate({ notionalUsd: 9e9, leverage: 30, brackets })).toThrow(/no leverage bracket/);
    expect(() => resolveMaintenanceRate({ notionalUsd: 300, leverage: 100, assumedRate: 0.01 })).toThrow(/not below 1\/leverage/);
  });
  it("with the assumed rate the stop stays in front of a real liquidation at 0.4% (the reason the rate is assumed)", () => {
    // 100x long at 64,000. Real liq with a 0.4% rate: 64,000 x (1 - 0.01 + 0.004) = 63,616.
    const realLiq = estimateLiquidationPrice(64000, 100, "buy", 0.004);
    const s = planStop({ entry: 64000, side: "buy", leverage: 100, tickSize: 0.1, maintenanceMarginRate: 0.005, maintenanceSource: "assumed" });
    expect(s.stopPrice).toBeGreaterThan(realLiq);
    // Without any maintenance margin the 85% stop would sit BELOW that real liquidation: never fires.
    const naive = stopPriceFromLiquidation(64000, estimateLiquidationPrice(64000, 100, "buy", 0), "buy", 0.1);
    expect(naive).toBeLessThan(realLiq);
  });
});

describe("take-profit", () => {
  it("rejects a ratio below 1 everywhere", () => {
    expect(() => assertRatioAtLeastOne(0.99)).toThrow(RatioBelowOneError);
    expect(() => assertRatioAtLeastOne(Number.NaN)).toThrow(RatioBelowOneError);
    expect(() => exactTakeProfitPrice(100, 98, "buy", 0.5)).toThrow(RatioBelowOneError);
    expect(() => pickTakeProfit({ entry: 100, side: "buy", stopPrice: 98, mode: "shy", tickSize: 0.01, minRatioOverride: 0.8 })).toThrow(
      RatioBelowOneError,
    );
    // A stop on the profit side is nonsense and refused.
    expect(() => pickTakeProfit({ entry: 100, side: "buy", stopPrice: 101, mode: "shy", tickSize: 0.01 })).toThrow(RangeError);
    expect(() => assertRatioAtLeastOne(1)).not.toThrow();
  });
  it("exact price at a ratio", () => {
    expect(exactTakeProfitPrice(100, 98, "buy", 2)).toBeCloseTo(104);
    expect(exactTakeProfitPrice(100, 102, "sell", 4)).toBeCloseTo(92);
  });
  it("round-number steps by magnitude", () => {
    expect(roundNumberStep(64000)).toBe(500);
    expect(roundNumberStep(3200)).toBe(50);
    expect(roundNumberStep(150)).toBe(5);
    expect(roundNumberStep(24)).toBe(0.5);
    expect(roundNumberStep(0.25)).toBe(0.005);
    expect(roundNumbersBetween(64100, 65100, 64000)).toEqual([64500, 65000]);
  });
  it("Greedy keeps the 3.9x slack line for shorts too", () => {
    const tp = pickTakeProfit({ entry: 3000, side: "sell", stopPrice: 3085, mode: "greedy", tickSize: 0.01, sigma1h: 0.007 });
    expect(tp.ratio).toBeGreaterThanOrEqual(3.9);
    expect(tp.price).toBeLessThan(3000);
  });
});

/**
 * Target v2 (Sets_Rules.md section A, build step E1). Shared setup of the spec: tick 0.01,
 * random 0.5, Deserved, sigma1h 0.007, entry 1,805.73 Buy, stop 1,758.19: s = 47.54, slack
 * line 1,896.06, floor 1,900.81, top 1,995.89. Every pick asserts price, ratio, source and
 * reason text, and reads the counts. REAL: pure functions, the returned pick IS the artifact.
 */
describe("target v2 (Sets_Rules.md E1)", () => {
  const E = 1805.73;
  const base = { entry: E, side: "buy" as const, stopPrice: 1758.19, mode: "deserved" as const, tickSize: 0.01, sigma1h: 0.007, random: () => 0.5 };
  const short = (price: number, weightUsd: number): LiquidationLevel => ({ price, weightUsd, positionSide: "short" });
  const fuelB = [short(1901.5, 150_000), short(1950.4, 900_000), short(1951.1, 800_000), short(1951.9, 800_000)];
  const scoreAt = (tp: ReturnType<typeof pickTakeProfit>, kind: string, price: number) => tp.scored.find((c) => c.kind === kind && c.price === price);

  it("the window of the 2026-11-19 Set: slack line 1,896.06, floor 1,900.81, top 1,995.89", () => {
    const tp = pickTakeProfit(base);
    expect(tp.window.lo).toBeCloseTo(1.9, 9);
    expect(tp.window.hi).toBe(4);
    expect(tp.window.linePrice).toBeCloseTo(1896.056, 3);
    expect(tp.window.floorPrice).toBeCloseTo(1900.81, 6);
    expect(tp.window.topPrice).toBeCloseTo(1995.89, 6);
  });

  it("(a) replay of 2026-11-19: no clusters, walls or swings: in front of 1,900 at 1.971x, not 12 cents behind it", () => {
    const tp = pickTakeProfit(base);
    expect(tp.price).toBe(1899.43);
    expect(tp.ratio).toBeCloseTo(1.971, 3);
    expect(tp.source).toBe("round-number");
    expect(tp.reason).toContain("1,900");
    expect(tp.reason).toContain("no liquidation cluster between 1.9x and 4x");
    expect(tp.reason).toBe("Long from 1,805.73; take profit (sell) at 1,899.43, 1.97x the stop (sell at 1,758.19), within the 0.1x slack of the 2x floor: no liquidation cluster between 1.9x and 4x, so the sale sits just in front of 1,900 (a round number)");
    expect(tp.counts.liquidationLevelsRead).toBe(0);
    expect(tp.counts).toMatchObject({ clustersFound: 0, roundNumbers: 2, brakesFound: 2, candidatesScored: 2, horizonHours: 48, sigma1h: 0.007, sigmaSource: "measured" });
    expect(tp.counts.winner).toMatchObject({ kind: "round-number", pull: 0.5, pass: 1 });
  });

  it("(b) the 3x cluster wins: $2.5M of 3 traders beats the $150k one, placed in front of 1,950", () => {
    const tp = pickTakeProfit({ ...base, liquidationLevels: fuelB });
    expect(tp.price).toBe(1949.41);
    expect(tp.ratio).toBeCloseTo(3.022, 3);
    expect(tp.source).toBe("liquidation-cluster");
    for (const part of ["$2.5M", "3 accounts", "1,950"]) expect(tp.reason).toContain(part);
    expect(tp.reason).toBe("Long from 1,805.73; take profit (sell) at 1,949.41, 3.02x the stop (sell at 1,758.19): the sale sits just in front of 1,950 (a round number) at the edge of a cluster where $2.5M of 3 accounts' shorts get liquidated (1,950.4 to 1,951.9; the largest holds 36%)");
    // The spec's worked scores: 0.74 against 1.38. Since A11 (2026-11-21) the $150k one-account cluster is
    // kept out of the race (it would not have won, so the reason does not name it).
    expect(tp.scored.some((c) => c.kind === "liquidation-cluster" && c.price === 1899.43)).toBe(false);
    expect(Math.abs(scoreAt(tp, "liquidation-cluster", 1949.41)!.score - 1.38)).toBeLessThan(0.02);
    expect(scoreAt(tp, "liquidation-cluster", 1949.41)!.pass).toBeCloseTo(0.8, 9); // 1,900 is in the way
    expect(tp.counts).toMatchObject({ liquidationLevelsRead: 4, liquidationsOnProfitSide: 4, liquidationsInWindow: 4, clustersFound: 1, clustersLoneTrader: 1 });
    expect(tp.reason).not.toContain("does not count");
  });

  it("(c) quieter market (sigma1h 0.0045): the near $150k level would win but is one account's (A11), so 1,900 wins; the $2.5M one is out of reach", () => {
    const tp = pickTakeProfit({ ...base, liquidationLevels: fuelB, sigma1h: 0.0045 });
    expect(tp.price).toBe(1899.43);
    expect(tp.ratio).toBeCloseTo(1.971, 3);
    expect(tp.source).toBe("round-number");
    expect(tp.reason).toContain("a $150k cluster at 1,901.5 was one account's and does not count");
    expect(Math.abs(tp.wouldHaveWon!.score - 0.25)).toBeLessThan(0.02); // the spec's 0.25, now scored aside
    expect(tp.counts.clustersLoneTrader).toBe(1);
    const far = scoreAt(tp, "liquidation-cluster", 1949.41)!;
    expect(far.dropped).toBe("out of reach");
    expect(far.reach).toBeCloseTo(0.011, 3);
    expect(tp.counts.candidatesOutOfReach).toBe(2); // the $2.5M cluster and the bare 1,950 in front of it
  });

  it("(d) Greedy: the $400k two-trader cluster at 2,000.5 wins at 4.074x, above the 3.9x line", () => {
    const tp = pickTakeProfit({ ...base, mode: "greedy", liquidationLevels: [short(2000.5, 250_000), short(2001.2, 150_000)] });
    expect(tp.price).toBe(1999.4);
    expect(tp.ratio).toBeCloseTo(4.074, 3);
    expect(tp.source).toBe("liquidation-cluster");
    expect(tp.reason).toContain("$400k of 2 accounts' shorts get liquidated (2,000.5 to 2,001.2; the largest holds 63%)");
    expect(tp.counts).toMatchObject({ horizonHours: 96, roundNumbers: 4, clustersFound: 1 });
  });

  it("(e) a $4M wall beats a lighter cluster, then A5 pulls it in front of 1,900", () => {
    const tp = pickTakeProfit({ ...base, oppositeVolume: [{ price: 1902, weightUsd: 4_000_000 }], liquidationLevels: [short(1925, 300_000)] });
    const wall = tp.scored.find((c) => c.kind === "wall")!;
    // The $300k at 1,925 is one account's: since A11 it is scored aside (0.56) and never in the race.
    expect(tp.scored.some((c) => c.kind === "liquidation-cluster")).toBe(false);
    expect(tp.counts.clustersLoneTrader).toBe(1);
    const cluster = pickTakeProfit({ ...base, oppositeVolume: [{ price: 1902, weightUsd: 4_000_000 }], liquidationLevels: [short(1925, 180_000), short(1925.5, 120_000)] }).scored.find((c) => c.kind === "liquidation-cluster")!;
    expect(Math.abs(wall.score - 1.62)).toBeLessThan(0.02);
    expect(wall.pass).toBeCloseTo(0.8, 9);
    expect(Math.abs(cluster.score - 0.62)).toBeLessThan(0.02); // two accounts: the density bonus lifts the spec's 0.56 to 0.62
    expect(cluster.pass).toBeCloseTo(0.64, 9); // 1,900 and the wall in the way
    expect(tp.price).toBe(1899.43);
    expect(tp.source).toBe("wall");
    expect(tp.pulledInFrontOf).toEqual({ kind: "round-number", price: 1900, restingUsd: 0 });
    expect(tp.reason).toContain("$4.0M");
    expect(tp.reason).toContain("in front of 1,900");
    expect(tp.counts).toMatchObject({ walls: 1, levelsRead: 1, levelsInWindow: 1 });
  });

  it("(f) Sell mirror of (a): in front of 1,700 at 2.213x; 1,750 inside the slack line is not a candidate", () => {
    const tp = pickTakeProfit({ ...base, side: "sell", stopPrice: 1853.27 });
    expect(tp.price).toBe(1700.51);
    expect(tp.ratio).toBeCloseTo(2.213, 3);
    expect(tp.source).toBe("round-number");
    expect(tp.reason).toContain("in front of 1,700");
    expect(tp.scored.map((c) => c.price)).toEqual([1700.51, 1650.5]);
  });

  it("(g) nothing to choose from: the bare 2x; next to a round number it is pulled in front of it", () => {
    const args = { entry: E, stopPrice: 1758.19, side: "buy" as const, mode: "deserved" as const, tickSize: 0.01, sigma1h: 0.007 };
    const bare = chooseTarget({ ...args, candidates: [], brakes: [] });
    expect(bare.price).toBe(1900.81);
    expect(bare.source).toBe("exact-ratio");
    expect(bare.ratio).toBe(2);
    expect(bare.reason).toBe("Long from 1,805.73; take profit (sell) at 1,900.81, 2x the stop (sell at 1,758.19): the bare 2x: no liquidation cluster, wall, round number or swing high between 1.9x and 4x within reach");
    const near = chooseTarget({ ...args, candidates: [], brakes: [{ kind: "round-number", price: 1900, restingUsd: 0 }] });
    expect(near.price).toBe(1899.43); // 1,900.81 is 0.043% beyond 1,900, inside the 0.1% gap
    expect(near.source).toBe("exact-ratio");
    expect(near.reason).toContain(": the bare 2x, pulled in front of 1,900 (a round number): no liquidation cluster");
    expect(near.reason).toContain("pulled in front of 1,900");
  });

  it("(h) minReach: a $30M cluster at 1,995 in a dead market is out of reach; the bare floor pulled in front of 1,900", () => {
    const tp = pickTakeProfit({ ...base, sigma1h: 0.002, liquidationLevels: [short(1995, 15_000_000), short(1995.5, 15_000_000)] }); // two accounts (A11)
    expect(scoreAt(tp, "liquidation-cluster", 1994)!.reach).toBeLessThan(0.00001);
    expect(scoreAt(tp, "round-number", 1899.43)!.reach).toBeCloseTo(0.00018, 5);
    expect(tp.price).toBe(1899.43);
    expect(tp.source).toBe("exact-ratio");
    expect(tp.reason).toContain("the $30M cluster at 1,995 is out of reach within 48 h");
    expect(tp.counts).toMatchObject({ candidatesOutOfReach: 3, candidatesScored: 3, winner: null });
  });

  it("(i) slack line: a $5M cluster at 1,897.0 (1.92x) is accepted, clamped to the line 1,896.06", () => {
    const tp = pickTakeProfit({ ...base, liquidationLevels: [short(1897, 3_000_000), short(1897.4, 2_000_000)] }); // two accounts (A11)
    expect(tp.price).toBe(1896.06);
    expect(tp.ratio).toBeGreaterThanOrEqual(1.9);
    expect(tp.ratio).toBeCloseTo(1.9, 3);
    expect(tp.source).toBe("liquidation-cluster");
    expect(tp.reason).toContain("$5.0M");
  });

  it("(i) slack line: a cluster starting at 1,890.0 (1.77x) is clamped only while its far edge reaches the line, else dropped (negative)", () => {
    // Five accounts, 1,890.0 to 1,897.0 (inside 1.5% of 1,890): the clamp 1,896.06 lies inside the cluster.
    const run = [short(1890, 4_000_000), short(1891.9, 250_000), short(1893.7, 250_000), short(1895.5, 250_000), short(1897, 250_000)];
    const kept = pickTakeProfit({ ...base, liquidationLevels: run });
    expect(kept.price).toBe(1896.06);
    expect(kept.source).toBe("liquidation-cluster");
    expect(kept.reason).toContain("1,890 to 1,897");
    // Without the 1,897.0 level the far edge is 1,895.5, inside the line: dropped, counted.
    const dropped = pickTakeProfit({ ...base, liquidationLevels: run.slice(0, 4) });
    expect(dropped.source).toBe("round-number");
    expect(dropped.price).toBe(1899.43);
    expect(dropped.counts).toMatchObject({ clustersFound: 0, clustersBelowSlackLine: 1 });
  });

  it("(j) realizedVol1h: alternating +-0.7% log returns give 0.0070; 10 closes give the floor and say too few candles", () => {
    const closes = [100];
    for (let i = 1; i < 73; i++) closes.push((closes[i - 1] as number) * Math.exp(i % 2 ? 0.007 : -0.007));
    const v = realizedVol1h(closes);
    expect(Math.abs(v.sigma1h - 0.007)).toBeLessThan(0.0001);
    expect(v).toMatchObject({ returnsUsed: 72, tooFewCandles: false, floored: false });
    const few = realizedVol1h(closes.slice(0, 10));
    expect(few).toMatchObject({ sigma1h: 0.002, returnsUsed: 9, tooFewCandles: true, floored: true, measured: null });
    // A flat market is floored too (negative): zero movement never means "every level is reachable".
    expect(realizedVol1h(new Array(73).fill(100)).sigma1h).toBe(0.002);
  });

  it("(k) a seeded source reproduces the pick; the jitter stays in [gap - jitter, gap + jitter) in front of a brake and never on it", () => {
    const a = pickTakeProfit({ ...base, liquidationLevels: fuelB, random: seededRandom(9) });
    const b = pickTakeProfit({ ...base, liquidationLevels: fuelB, random: seededRandom(9) });
    expect(a.price).toBe(b.price);
    expect(a.reason).toBe(b.reason);
    const rnd = seededRandom(7);
    for (let i = 0; i < 500; i++) {
      const p = frontOfBrake(1900, "buy", 0.01, rnd());
      expect(p).toBeLessThan(1900); // strictly in front, never on or beyond
      expect(p).toBeGreaterThanOrEqual(1900 * (1 - 0.0006) - 0.01);
      expect(isOnStep(p, 0.01)).toBe(true);
      const q = frontOfBrake(1700, "sell", 0.01, rnd());
      expect(q).toBeGreaterThan(1700);
      expect(q).toBeLessThanOrEqual(1700 * (1 + 0.0006) + 0.01);
    }
    expect(() => frontOfBrake(1900, "buy", 0.01, 1)).toThrow(RangeError); // a bad source fails loudly (negative)
  });

  it("(l) on the real Aster book (BTC, mid 64,426.1, 30x Deserved, no fuel): a wall or round number, at least 1.9x", () => {
    const mid = 64426.1;
    const s = planStop({ entry: mid, side: "buy", leverage: 30, tickSize: 0.1, maintenanceMarginRate: 0.005, maintenanceSource: "assumed" });
    const tp = pickTakeProfit({ entry: mid, side: "buy", stopPrice: s.stopPrice, mode: "deserved", tickSize: 0.1, oppositeVolume: DEPTH.asks, sigma1h: 0.007, random: seededRandom(1) });
    expect(["wall", "round-number"]).toContain(tp.source);
    expect(tp.ratio).toBeGreaterThanOrEqual(1.9);
    expect(tp.counts.levelsRead).toBe(1000);
    expect(tp.counts.levelsInWindow).toBeGreaterThan(0);
    expect(tp.reason.length).toBeGreaterThan(20);
    expect(isOnStep(tp.price, 0.1)).toBe(true);
  });

  it("the liquidation map unavailable: brakes alone, and the reason says so (A6.3)", () => {
    const tp = pickTakeProfit({ ...base, liquidationLevels: fuelB, fuelMap: "unavailable" });
    expect(tp.source).toBe("round-number");
    expect(tp.reason).toContain(": liquidation map unavailable, so the sale sits just in front of 1,900");
    expect(tp.counts).toMatchObject({ fuelMap: "unavailable", liquidationLevelsRead: 0 });
  });

  it("a swing high and a trader's take-profit are brakes; trader take-profits do not count as stalls in the way", () => {
    const tp = pickTakeProfit({ ...base, swingHighs: [1930, 1700], traderTakeProfits: [{ price: 1915, weightUsd: 0 }] });
    expect(tp.counts).toMatchObject({ swingHighs: 1, traderTakeProfits: 1, brakesFound: 4 }); // 1,700 is not in the window
    expect(tp.brakes.map((b) => [b.kind, b.price])).toEqual([["round-number", 1900], ["trader-tp", 1915], ["swing", 1930], ["round-number", 1950]]);
    expect(scoreAt(tp, "swing", 1929.42)!.brakesInWay).toBe(1); // only 1,900; the trader's take-profit at 1,915 is not a stall
    expect(swingLevels([{ high: 10, low: 8 }, { high: 12, low: 9 }], [{ high: 15, low: 5 }], { "1h": 1, "4h": 1 })).toEqual({ highs: [12, 15], lows: [9, 5] });
  });

  it("Shy never goes below 1x: the 0.9x slack of the spec is held at the 1x rule (negative)", () => {
    // Stop 50 below 1,805.73; a round number at 1,850 is 0.89x: never a Shy target.
    const tp = pickTakeProfit({ entry: E, side: "buy", stopPrice: 1755.73, mode: "shy", tickSize: 0.01, sigma1h: 0.007 });
    expect(tp.window.lo).toBe(1);
    expect(tp.ratio).toBeGreaterThanOrEqual(1);
    expect(tp.scored.some((c) => c.price < 1855.73)).toBe(false);
  });

  it("(E3) against the real fill: 23 cents above plan keeps the target; 3 dollars above re-chooses the next level, 1,949.41", () => {
    const plan = pickTakeProfit(base);
    const keep = remeasureAfterFill({ basis: plan.basis, side: "buy", fill: 1805.96, stopPrice: 1758.19, takeProfitPrice: plan.price, tickSize: 0.01 });
    expect(keep.action).toBe("keep");
    expect(keep.realRatio).toBeCloseTo(1.9567, 4);
    expect(keep.message).toContain("1.96x against the real fill, at or above 1.9x: kept");
    const moved = remeasureAfterFill({ basis: plan.basis, side: "buy", fill: 1808.73, stopPrice: 1758.19, takeProfitPrice: plan.price, tickSize: 0.01 });
    expect(moved.action).toBe("re-choose");
    expect(moved.realRatio).toBeCloseTo(1.7946, 4);
    expect(moved.choice!.price).toBe(1949.41);
    expect(moved.choice!.ratio).toBeGreaterThanOrEqual(1.9);
    expect(moved.choice!.scored.find((c) => c.price === 1899.43)!.dropped).toBe("below the slack line");
  });
});

describe("nudge", () => {
  it("always within +-0.05% and on the tick (2,000 random draws)", () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 2000; i++) {
      const price = 1000 + rnd() * 99000;
      const r = nudgePrice(price, 0.1, rnd);
      expect(Math.abs(r.price - price)).toBeLessThanOrEqual(price * 0.0005 + 1e-9);
      expect(isOnStep(r.price, 0.1)).toBe(true);
    }
  });
  it("extremes of the random source stay inside the band", () => {
    const lo = nudgePrice(64000, 0.1, () => 0);
    const hi = nudgePrice(64000, 0.1, () => 0.999999999);
    expect(lo.price).toBe(63968); // 64,000 x (1 - 0.0005)
    expect(hi.price).toBe(64032);
  });
  it("reports a band too narrow for the tick and rejects a bad random source", () => {
    const r = nudgePrice(1.234, 1, () => 0.9);
    expect(r.bandTooNarrow).toBe(true);
    expect(r.price).toBe(1);
    expect(() => nudgePrice(100, 0.1, () => 1)).toThrow(RangeError);
    expect(() => nudgePrice(100, 0.1, () => -0.1)).toThrow(RangeError);
  });
});

describe("entry: nearby (bucketed, weighted, random)", () => {
  // Price 64,000; buckets are 0.05% = 32 wide, counted down from 64,000.
  const bids: SidedLevel[] = [
    { price: 63950, weightUsd: 4000, side: "buy" }, // 0.078% -> bucket 1, total 4k + 2k = 6k
    { price: 63940, weightUsd: 2000, side: "buy" }, // 0.094% -> bucket 1
    { price: 63900, weightUsd: 30_000, side: "buy" }, // 0.156% -> bucket 3
    { price: 63800, weightUsd: 60_000, side: "buy" }, // 0.3125% -> bucket 6
    { price: 63700, weightUsd: 10_000, side: "buy" }, // 0.469% -> bucket 9
    { price: 63990, weightUsd: 9e6, side: "buy" }, // 0.016%: closer than one nudge, ignored
    { price: 63500, weightUsd: 9e6, side: "buy" }, // 0.78%: beyond 0.5%, ignored
    { price: 64050, weightUsd: 9e6, side: "buy" }, // above the price: wrong side for a Buy
    { price: 63850, weightUsd: 9e6, side: "sell" }, // an ask: ignored for a Buy
  ];
  it("keeps the heaviest 3 buckets inside 0.05%..0.5%, heaviest first", () => {
    const { buckets, counts } = nearbyBuckets(bids, "buy", 64000);
    expect(buckets.map((b) => [b.index, b.weightUsd])).toEqual([
      [6, 60_000],
      [3, 30_000],
      [9, 10_000],
    ]);
    expect(counts).toEqual({ ordersRead: 9, ordersInWindow: 5 });
    const b6 = buckets[0]!;
    expect(b6.high).toBeCloseTo(64000 * (1 - 0.003)); // nearer edge
    expect(b6.low).toBeCloseTo(64000 * (1 - 0.0035));
  });
  it("picks a bucket weighted by USD, then a uniform price inside it (exact with injected numbers)", () => {
    // Total 100k: [0, 0.6) -> bucket 6, [0.6, 0.9) -> bucket 3, [0.9, 1) -> bucket 9.
    const a = pickNearbyLevel(bids, "buy", 64000, seq(0.1, 0.5));
    expect(a.chosen?.bucket.index).toBe(6);
    expect(a.chosen?.price).toBeCloseTo(64000 * (1 - 0.00325)); // middle of the bucket
    expect(pickNearbyLevel(bids, "buy", 64000, seq(0.7, 0)).chosen?.bucket.index).toBe(3);
    expect(pickNearbyLevel(bids, "buy", 64000, seq(0.95, 0)).chosen?.bucket.index).toBe(9);
  });
  it("is not the nearest level: over 3,000 seeded picks each kept bucket appears in proportion to its USD", () => {
    const rnd = seededRandom(123);
    const n: Record<number, number> = {};
    for (let i = 0; i < 3000; i++) {
      const c = pickNearbyLevel(bids, "buy", 64000, rnd).chosen!;
      n[c.bucket.index] = (n[c.bucket.index] ?? 0) + 1;
      expect(c.price).toBeGreaterThanOrEqual(c.bucket.low);
      expect(c.price).toBeLessThanOrEqual(c.bucket.high);
    }
    expect(n[1]).toBeUndefined(); // the nearest bucket (6k) is not in the top 3
    expect(n[6]! / 3000).toBeCloseTo(0.6, 1);
    expect(n[3]! / 3000).toBeCloseTo(0.3, 1);
    expect(n[9]! / 3000).toBeCloseTo(0.1, 1);
  });
  it("the same seed gives the same price; a bad random source fails loudly (negative)", () => {
    const p1 = pickNearbyLevel(bids, "buy", 64000, seededRandom(5)).chosen!.price;
    const p2 = pickNearbyLevel(bids, "buy", 64000, seededRandom(5)).chosen!.price;
    expect(p1).toBe(p2);
    expect(() => pickNearbyLevel(bids, "buy", 64000, () => 1)).toThrow(RangeError);
  });
  it("buckets under $5k do not count; none left -> fall back to Now with a plain reason (negative)", () => {
    const small: SidedLevel[] = [{ price: 63950, weightUsd: 4999, side: "buy" }];
    expect(nearbyBuckets(small, "buy", 64000).buckets).toEqual([]);
    const d = pickEntry({ mode: "nearby", side: "buy", currentPrice: 64000, levels: { ...NO_LEVELS, limitLevels: small }, random: seq(0.5) });
    expect(d.usedMode).toBe("now");
    expect(d.orderType).toBe("market");
    expect(d.price).toBe(64000);
    expect(d.fellBackFrom).toEqual(["nearby"]);
    expect(d.reason).toMatch(/Nearby found no heavy order area within 0.5%/);
    expect(d.diagnostics).toEqual({ ordersRead: 1, ordersInWindow: 1, nearbyBucketsKept: 0 });
  });
  it("Sell mirrors: above the price, asks only", () => {
    const asks: SidedLevel[] = [
      { price: 64100, weightUsd: 9000, side: "sell" },
      { price: 63900, weightUsd: 9e6, side: "sell" }, // below price: wrong side
    ];
    const d = pickEntry({ mode: "nearby", side: "sell", currentPrice: 64000, levels: { ...NO_LEVELS, limitLevels: asks }, random: seq(0.5) });
    expect(d.usedMode).toBe("nearby");
    expect(d.price).toBeGreaterThan(64000 * 1.0015);
    expect(d.price).toBeLessThan(64000 * 1.002); // inside bucket 3 (0.15%..0.2%)
  });
});

describe("entry: patient", () => {
  const liqs: LiquidationLevel[] = [
    // bucket of 0.1% width counted from 64,000 downward
    { price: 62700, weightUsd: 400_000, positionSide: "long" }, // 2.03% away -> bucket 20
    { price: 62690, weightUsd: 400_000, positionSide: "long" }, // 2.05% -> bucket 20 (sum 800k)
    { price: 63000, weightUsd: 700_000, positionSide: "long" }, // 1.56% -> bucket 15
    { price: 63800, weightUsd: 9e9, positionSide: "long" }, // 0.31%: inside 0.5%, ignored
    { price: 63600, weightUsd: 100_000, positionSide: "long" }, // 0.625%: inside the NEW window (0.5%-5%), bucket 6
    { price: 60000, weightUsd: 9e9, positionSide: "long" }, // 6.25%: beyond 5%, ignored
    { price: 62700, weightUsd: 9e9, positionSide: "short" }, // shorts do not liquidate below: ignored for Buy
  ];
  it("counts what it read: all, on the waiting side, inside 0.5%-5%", () => {
    expect(findLiquidationClusterWithCounts(liqs, "buy", 64000).counts).toEqual({ liquidationsRead: 7, liquidationsOnSide: 6, liquidationsInWindow: 4 });
  });
  it("the window now starts at 0.5%: a lone cluster at 0.625% is found (it was ignored under the old 1% edge)", () => {
    const c = findLiquidationCluster([{ price: 63600, weightUsd: 1, positionSide: "long" }], "buy", 64000);
    expect(c?.bucketIndex).toBe(6);
    expect(findLiquidationCluster([{ price: 63600, weightUsd: 1, positionSide: "long" }], "buy", 64000, { patientMinDistance: 0.01 })).toBeNull();
  });
  it("picks the heaviest 0.1% bucket within 0.5-5% and enters at its centre", () => {
    const c = findLiquidationCluster(liqs, "buy", 64000);
    expect(c?.bucketIndex).toBe(20);
    expect(c?.weightUsd).toBe(800_000);
    expect(c?.centre).toBeCloseTo(64000 * (1 - 0.0205)); // centre of [2.0%, 2.1%)
  });
  it("ignores levels outside 0.5-5% (none left -> fallback to Nearby, then Now), and says so (negative)", () => {
    const outside = liqs.filter((l) => l.price === 63800 || l.price === 60000);
    expect(findLiquidationCluster(outside, "buy", 64000)).toBeNull();
    const d = pickEntry({ mode: "patient", side: "buy", currentPrice: 64000, levels: { ...NO_LEVELS, liquidationLevels: outside }, random: seq(0.5) });
    expect(d.fellBackFrom).toEqual(["patient", "nearby"]);
    expect(d.usedMode).toBe("now");
    expect(d.reason).toMatch(/^Patient found no liquidation cluster 0.5% to 5% below the price/);
    expect(d.diagnostics.liquidationsInWindow).toBe(0);
  });
  it("falls back to Nearby when Nearby has a level", () => {
    const d = pickEntry({
      mode: "patient",
      side: "buy",
      currentPrice: 64000,
      levels: { ...NO_LEVELS, limitLevels: [{ price: 63950, weightUsd: 50_000, side: "buy" }] },
      random: seq(0.5),
    });
    expect(d.usedMode).toBe("nearby");
    expect(d.fellBackFrom).toEqual(["patient"]);
    expect(d.reason).toMatch(/so waiting in an area holding \$50.0k/);
  });
  it("Sell mirrors with SHORT liquidations above", () => {
    const c = findLiquidationCluster([{ price: 65000, weightUsd: 1, positionSide: "short" }], "sell", 64000);
    expect(c?.bucketIndex).toBe(15); // 1.5625% above
    expect(c!.centre).toBeGreaterThan(64000);
  });
});

describe("draw split", () => {
  const bands = { inBand: { low: 63000, high: 63500 }, outBand: { low: 66000, high: 67000 } };
  it("respects min notional and minQty, up to 5 orders", () => {
    const d = splitDraw({ side: "buy", bands, ticketUsd: 100, leverage: 50, rules: BTC, random: seq(0.5) });
    expect(d.entries).toHaveLength(5); // $5,000 / max($5, 0.001 x 63,500 = $63.5) = 78 -> capped at 5
    for (const l of [...d.entries, ...d.takeProfits]) {
      expect(l.qty).toBeGreaterThanOrEqual(BTC.minQty);
      expect(l.qty * l.price).toBeGreaterThanOrEqual(BTC.minNotionalUsd);
      expect(isOnStep(l.price, BTC.tickSize)).toBe(true);
      expect(isOnStep(l.qty, BTC.stepSize)).toBe(true);
    }
    expect(d.totalNotionalUsd).toBeLessThanOrEqual(5000); // quantities rounded down: never above ticket x leverage
    expect(d.takeProfits.map((t) => t.qty)).toEqual(d.entries.map((e) => e.qty)); // each TP closes its own entry
    expect(d.minRatio).toBeGreaterThanOrEqual(1);
  });
  it("every leg gets its own stop between its entry and its own liquidation, same qty", () => {
    const d = splitDraw({ side: "buy", bands, ticketUsd: 100, leverage: 50, rules: BTC, random: seq(0.5) });
    expect(d.stops).toHaveLength(d.entries.length);
    d.entries.forEach((e, i) => {
      const st = d.stops[i]!;
      expect(st.qty).toBe(e.qty);
      expect(st.price).toBeLessThan(e.price);
      expect(st.price).toBeGreaterThan(d.legLiquidationPrices[i]!);
      expect(isOnStep(st.price, BTC.tickSize)).toBe(true);
      // 85% of that leg's liquidation distance, within one tick.
      expect(Math.abs(e.price - st.price - 0.85 * (e.price - d.legLiquidationPrices[i]!))).toBeLessThanOrEqual(BTC.tickSize);
    });
    expect(d.maintenanceSource).toBe("assumed");
    expect(d.lossAtStopsUsd).toBeGreaterThan(0);
    expect(d.lossAtStopsUsd).toBeLessThan(100); // less than the ticket
  });
  it("a tiny ticket becomes a single order", () => {
    // $10 x 30x = $300 position. On a market whose minimum order is $200, floor(300 / 200) = 1 order.
    const strict: SymbolRules = { ...BTC, minNotionalUsd: 200 };
    const d = splitDraw({ side: "buy", bands, ticketUsd: 10, leverage: 30, rules: strict, random: seq(0.5) });
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0]!.price).toBeCloseTo(63250, -1); // middle of the In band (+- nudge)
  });
  it("rejects a ticket below one order", () => {
    const huge: SymbolRules = { ...BTC, minNotionalUsd: 1000 };
    expect(() => splitDraw({ side: "buy", bands, ticketUsd: 10, leverage: 30, rules: huge, random: seq(0.5) })).toThrow(TicketTooSmallError);
  });
  it("rejects bands in the wrong order and a take-profit below 1x", () => {
    expect(() => validateBands("buy", { inBand: bands.outBand, outBand: bands.inBand })).toThrow(InvalidBandsError);
    expect(() => validateBands("sell", bands)).toThrow(InvalidBandsError);
    // 30x: stop distance about 2.4%; an Out band only 1% above is below 1x.
    expect(() =>
      splitDraw({ side: "buy", bands: { inBand: { low: 63000, high: 63000 }, outBand: { low: 63700, high: 63800 } }, ticketUsd: 100, leverage: 30, rules: BTC, random: seq(0.5) }),
    ).toThrow(RatioBelowOneError);
  });
  it("spreads evenly", () => {
    expect(spreadAcross({ low: 10, high: 20 }, 1)).toEqual([15]);
    expect(spreadAcross({ low: 10, high: 20 }, 3)).toEqual([10, 15, 20]);
  });
});

describe("fees", () => {
  it("5% + 5% of profit on a win", () => {
    expect(splitFees(100)).toEqual({ grossPnlUsd: 100, blackboardUsd: 5, traderUsd: 5, userNetUsd: 90 });
  });
  it("zero fees on a loss and on breakeven", () => {
    expect(splitFees(-30)).toEqual({ grossPnlUsd: -30, blackboardUsd: 0, traderUsd: 0, userNetUsd: -30 });
    expect(splitFees(0).blackboardUsd).toBe(0);
  });
  it("rejects bad shares", () => {
    expect(() => splitFees(10, { blackboard: 0.7, trader: 0.5 })).toThrow(RangeError);
  });
});

describe("alerts", () => {
  const set: OpenSet = { side: "buy", entry: 100, takeProfit: 104, liquidation: 98, qty: 10 };
  it("halfway fires once, then the result once, then nothing", () => {
    let s = INITIAL_WATCH_STATE;
    let r = evaluatePrice(set, s, 101.9);
    expect(r.events).toEqual([]);
    r = evaluatePrice(set, (s = r.state), 102.1);
    expect(r.events.map((e) => e.type)).toEqual(["halfway"]);
    r = evaluatePrice(set, (s = r.state), 102.5);
    expect(r.events).toEqual([]); // not again
    r = evaluatePrice(set, (s = r.state), 104.2);
    expect(r.events).toHaveLength(1);
    const ev = r.events[0]!;
    expect(ev.type === "result" && ev.outcome).toBe("take-profit");
    expect(ev.type === "result" && ev.pnlUsd).toBeCloseTo(40); // settles at the TP level: (104 - 100) x 10
    expect(ev.type === "result" && ev.fees.blackboardUsd).toBe(2);
    expect(evaluatePrice(set, r.state, 90).events).toEqual([]); // closed
  });
  it("with a stop, the stop closes the Set first: outcome stopped, loss at the stop, zero fees", () => {
    const withStop: OpenSet = { ...set, stop: 98.3 };
    const r = evaluatePrice(withStop, INITIAL_WATCH_STATE, 98.2);
    const ev = r.events[0]!;
    expect(ev.type === "result" && ev.outcome).toBe("stopped");
    expect(ev.type === "result" && ev.pnlUsd).toBeCloseTo(-17); // (98.3 - 100) x 10
    expect(ev.type === "result" && ev.fees.blackboardUsd).toBe(0);
    expect(evaluatePrice(withStop, INITIAL_WATCH_STATE, 98.31).events).toEqual([]); // just above: nothing
  });
  it("liquidation result with zero fees, for a short too", () => {
    const short: OpenSet = { side: "sell", entry: 100, takeProfit: 96, liquidation: 102, qty: 5 };
    const r = evaluatePrice(short, INITIAL_WATCH_STATE, 102.3);
    const ev = r.events[0]!;
    expect(ev.type === "result" && ev.outcome).toBe("liquidated");
    expect(ev.type === "result" && ev.pnlUsd).toBeCloseTo(-10);
    expect(ev.type === "result" && ev.fees.traderUsd).toBe(0);
    expect(progressToTakeProfit(short, 98)).toBeCloseTo(0.5);
  });
});

describe("plan", () => {
  it("Buy $30 50x Deserved Now: market qty floored, stop at 85% of liquidation, TP >= 2x the stop distance", () => {
    const p = buildSetPlan({
      input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, tpMode: "deserved", entryMode: "now" },
      currentPrice: 64442.8,
      rules: BTC,
      levels: NO_LEVELS,
      random: seq(0.5),
    });
    expect(p.notionalUsd).toBe(1500);
    expect(p.quantity).toBe(0.023); // 1,500 / 64,442.8 = 0.02327 -> 0.023
    expect(p.orders.entries[0]).toEqual({ type: "MARKET", price: null, qty: 0.023 });
    // Assumed maintenance 0.5%: liquidation 64,442.8 x (1 - 0.02 + 0.005) = 63,476.16.
    expect(p.stop.maintenanceSource).toBe("assumed");
    expect(p.liquidationPrice).toBeCloseTo(64442.8 * 0.985);
    // Stop: 64,442.8 - 0.85 x 966.642 = 63,621.15 -> toward entry 63,621.2.
    expect(p.stop.price).toBe(63621.2);
    expect(p.orders.stops).toEqual([{ stopPrice: 63621.2, qty: 0.023 }]);
    expect(p.takeProfit.ratio).toBeGreaterThanOrEqual(2);
    expect(p.takeProfit.price - 64442.8).toBeGreaterThanOrEqual(2 * (64442.8 - 63621.2) - 1e-6);
    expect(p.expected.lossAtStopUsd).toBeCloseTo(-0.023 * (64442.8 - 63621.2), 2);
    expect(p.expected.lossAtLiquidationUsd).toBeLessThan(p.expected.lossAtStopUsd); // liquidation would cost more
    expect(p.expected.feeSplitOnWin.blackboardUsd).toBeCloseTo(p.expected.profitAtTpUsd * 0.05, 1);
  });
  it("with Aster brackets the liquidation uses the bracket rate", () => {
    const p = buildSetPlan({
      input: { symbol: "BTCUSDT", side: "sell", ticketUsd: 10, leverage: 30, tpMode: "shy", entryMode: "now" },
      currentPrice: 64000,
      rules: BTC,
      levels: NO_LEVELS,
      brackets: [{ notionalFloor: 0, notionalCap: 50_000, initialLeverage: 125, maintMarginRatio: 0.004 }],
      random: seq(0.5),
    });
    expect(p.stop.maintenanceSource).toBe("brackets");
    expect(p.liquidationPrice).toBeCloseTo(64000 * (1 + 1 / 30 - 0.004));
    expect(p.stop.price).toBeGreaterThan(64000);
    expect(p.stop.price).toBeLessThan(p.liquidationPrice);
  });
  it("feeds the target's walls from Aster's asks plus traders' SELL limits only (a Buy)", () => {
    const p = buildSetPlan({
      input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" },
      currentPrice: 64426.1,
      rules: BTC,
      levels: {
        ...NO_LEVELS,
        limitLevels: [
          { price: 67000, weightUsd: 1, side: "sell" },
          { price: 67100, weightUsd: 1, side: "sell" },
          { price: 63000, weightUsd: 1, side: "buy" },
        ],
      },
      depth: DEPTH,
      random: seededRandom(3),
      market: { sigma1h: 0.007 },
    });
    expect(p.diagnostics.oppositeVolumeLevels).toEqual({ venueBook: 1000, traders: 2 }); // the bid is the wrong side for a Buy's target
    expect(p.diagnostics.takeProfit?.levelsRead).toBe(1002);
    expect(p.takeProfit.ratio).toBeGreaterThanOrEqual(1.9); // the 0.1x slack (owner's ruling 2026-11-20)
    expect(p.takeProfit.reason).toContain("the stop");
    expect(p.takeProfit.candidates.length).toBeGreaterThan(0);
    expect(p.takeProfit.candidates.length).toBeLessThanOrEqual(5);
  });
  it("a nudged Buy limit never ends at or above the current price", () => {
    const p = buildSetPlan({
      input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, tpMode: "deserved", entryMode: "nearby" },
      currentPrice: 64000,
      rules: BTC,
      levels: { ...NO_LEVELS, limitLevels: [{ price: 63999, weightUsd: 1e6, side: "buy" }] },
      random: seq(0, 0.999, 0.999), // bucket, price at the bucket's near edge (just under 64,000), nudge up by almost +0.05%
      options: { entry: { nearbyMinDistance: 0 } }, // let the too-close level through to test the safety clamp
    });
    expect(p.entry.nudgedPrice!).toBeLessThan(64000);
    expect(p.orders.entries[0]!.type).toBe("LIMIT");
  });
  it("the same seed reproduces the same Nearby plan exactly; another seed moves it", () => {
    const mk = (seed: number) =>
      buildSetPlan({
        input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "nearby" },
        currentPrice: 64000,
        rules: BTC,
        levels: { ...NO_LEVELS, limitLevels: [{ price: 63800, weightUsd: 1e5, side: "buy" }, { price: 63700, weightUsd: 1e5, side: "buy" }] },
        depth: DEPTH,
        random: seededRandom(seed),
      });
    expect(mk(11).orders).toEqual(mk(11).orders);
    expect(mk(11).entry.nudgedPrice).not.toBe(mk(12).entry.nudgedPrice);
  });
  it("Draw plans carry one stop per entry and a loss at the stops below the ticket", () => {
    const p = buildSetPlan({
      input: {
        symbol: "BTCUSDT",
        side: "buy",
        ticketUsd: 100,
        leverage: 30,
        tpMode: "deserved",
        entryMode: "draw",
        draw: { inBand: { low: 63000, high: 63500 }, outBand: { low: 67000, high: 68000 } },
      },
      currentPrice: 64000,
      rules: BTC,
      levels: NO_LEVELS,
      random: seq(0.5),
    });
    expect(p.orders.stops).toHaveLength(p.orders.entries.length);
    expect(p.expected.lossAtStopUsd).toBeLessThan(0);
    expect(p.expected.lossAtStopUsd).toBeGreaterThan(-100);
    expect(p.takeProfit.ratio).toBeGreaterThanOrEqual(1);
  });
});

describe("input validation", () => {
  it("accepts a good body and defaults tpMode to deserved", () => {
    expect(parseSetInput({ symbol: "btcusdt", side: "buy", ticketUsd: 30, leverage: 50, entryMode: "now" }).tpMode).toBe("deserved");
  });
  it("100x stays valid in core even though the card shows only 30x and 50x", () => {
    expect(parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 100, entryMode: "nearby" }).leverage).toBe(100);
    expect(LEVERAGES).toEqual([30, 50, 100]);
    expect(CARD_LEVERAGES).toEqual([30, 50]);
    expect(DEFAULT_CHOICES).toEqual({ side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "nearby" });
  });
  it("rejects values outside the card's choices", () => {
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 20, leverage: 50, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "long", ticketUsd: 30, leverage: 50, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 125, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 40, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 20, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 30, tpMode: "huge", entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 30, entryMode: "soon" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, entryMode: "draw" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput(null)).toThrow(InvalidSetInputError);
  });
});

describe("target v2: a round number and a wall in one band", () => {
  const base = { entry: 1805.73, side: "buy" as const, stopPrice: 1758.19, mode: "deserved" as const, tickSize: 0.01, sigma1h: 0.007, random: () => 0.5 };
  it("orders resting AT the round number join it ($41k at 1,900 reads as one brake with its money)", () => {
    const tp = pickTakeProfit({ ...base, oppositeVolume: [{ price: 1900, weightUsd: 41_000 }] });
    expect(tp.brakes.filter((b) => b.kind === "wall")).toHaveLength(0);
    expect(tp.brakes[0]).toEqual({ kind: "round-number", price: 1900, restingUsd: 41_000 });
    expect(tp.price).toBe(1899.43);
    expect(tp.reason).toContain("just in front of 1,900, a round number with $41k of sell orders resting");
  });
  it("a wall starting just before the round number stays its own brake, and the target sits in front of the wall", () => {
    // 1,899.7 and 1,900 share the 0.05% band [1,899.63, 1,900.53).
    const tp = pickTakeProfit({ ...base, oppositeVolume: [{ price: 1899.7, weightUsd: 400_000 }] });
    expect(tp.brakes.map((b) => [b.kind, b.price, b.restingUsd])).toEqual([["wall", 1899.7, 400_000], ["round-number", 1900, 0], ["round-number", 1950, 0]]);
    expect(tp.source).toBe("wall");
    expect(tp.price).toBeLessThan(1899.7);
    expect(tp.reason).toContain("a wall of $400k of sell orders at 1,899.7");
  });
});

describe("target v2: review fixes of 2026-11-20", () => {
  const E = 1805.73;
  const base = { entry: E, side: "buy" as const, stopPrice: 1758.19, mode: "deserved" as const, tickSize: 0.01, sigma1h: 0.007, random: () => 0.5 };
  const liq = (price: number, weightUsd: number, positionSide: "long" | "short"): LiquidationLevel => ({ price, weightUsd, positionSide });
  const ETH: SymbolRules = { symbol: "ETHUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };

  it("a Sell reads LONG liquidations below: the $2.0M two-trader cluster at 1,699.1 to 1,699.6, in front of 1,700; shorts are ignored", () => {
    const tp = pickTakeProfit({ ...base, side: "sell", stopPrice: 1853.27, liquidationLevels: [liq(1699.6, 1_200_000, "long"), liq(1699.1, 800_000, "long"), liq(1720, 5_000_000, "short")] });
    expect(tp.price).toBe(1700.51);
    expect(tp.ratio).toBeCloseTo(2.213, 3);
    expect(tp.source).toBe("liquidation-cluster");
    expect(tp.reason).toBe("Short from 1,805.73; take profit (buy back) at 1,700.51, 2.21x the stop (buy back at 1,853.27): the buy-back sits just in front of 1,700 (a round number) at the edge of a cluster where $2.0M of 2 accounts' longs get liquidated (1,699.6 to 1,699.1; the largest holds 60%)");
    expect(tp.counts).toMatchObject({ liquidationLevelsRead: 3, liquidationsOnProfitSide: 2, clustersFound: 1 });
  });

  it("A5 'stays': clamped to the 1.9x line just behind a wall that the line itself passes; the reason says why it stays", () => {
    const tp = pickTakeProfit({ ...base, oppositeVolume: [{ price: 1895.5, weightUsd: 30_000 }], liquidationLevels: [liq(1897, 3_000_000, "short"), liq(1897.4, 2_000_000, "short")] });
    expect(tp.price).toBe(1896.06);
    expect(tp.source).toBe("liquidation-cluster");
    expect(tp.pulledInFrontOf).toBeNull();
    expect(tp.reason).toBe(
      "Long from 1,805.73; take profit (sell) at 1,896.06, 1.9x the stop (sell at 1,758.19), within the 0.1x slack of the 2x floor: the sale sits on the slack line inside a cluster where $5.0M of 2 accounts' shorts get liquidated (1,897 to 1,897.4; the largest holds 60%); it stays just behind a wall of $30k of sell orders at 1,895.5, because in front of it would break the 1.9x line",
    );
  });

  it("two brakes inside one 0.3% shadow (wall 1,946 $30k and round 1,950 before the edge 1,950.4): the target sits in front of the nearer one", () => {
    const tp = pickTakeProfit({ ...base, oppositeVolume: [{ price: 1946, weightUsd: 30_000 }], liquidationLevels: [liq(1950.4, 900_000, "short"), liq(1951.1, 800_000, "short"), liq(1951.9, 800_000, "short")] });
    expect(tp.brakes.map((b) => [b.kind, b.price])).toEqual([["round-number", 1900], ["wall", 1946], ["round-number", 1950]]);
    expect(tp.price).toBe(1945.41);
    expect(tp.source).toBe("liquidation-cluster");
    expect(tp.reason).toContain("just in front of a wall of $30k of sell orders at 1,946 at the edge of a cluster where $2.5M of 3 accounts' shorts");
  });

  it("sigmaSource says floor when the sigma passed was already floored", () => {
    expect(pickTakeProfit({ ...base, sigma1h: 0.002, sigmaFloored: true }).counts.sigmaSource).toBe("floor");
    expect(pickTakeProfit({ ...base, sigma1h: 0.0021, sigmaFloored: true }).counts.sigmaSource).toBe("floor"); // the flag wins even above the floor value
    expect(pickTakeProfit({ ...base, sigma1h: 0.007 }).counts.sigmaSource).toBe("measured");
    expect(pickTakeProfit({ ...base, sigma1h: null }).counts.sigmaSource).toBe("not given");
    const flat = realizedVol1h(new Array(73).fill(1805.73));
    const p = buildSetPlan({ input: { symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, currentPrice: E, rules: ETH, levels: NO_LEVELS, random: () => 0.5, market: { sigma1h: flat.sigma1h, sigmaFloored: flat.floored } });
    expect(p.takeProfit.counts?.sigmaSource).toBe("floor");
  });

  it("a thin liquidation map reads as unavailable and the reason carries the count", () => {
    const tp = pickTakeProfit({ ...base, liquidationLevels: [liq(1950.4, 2_500_000, "short")], fuelMap: "unavailable", fuelMapNote: "thin: 12 of 600 accounts" });
    expect(tp.source).toBe("round-number");
    expect(tp.reason).toContain(": liquidation map unavailable (thin: 12 of 600 accounts), so the sale sits just in front of 1,900");
    expect(tp.counts).toMatchObject({ fuelMap: "unavailable", fuelMapNote: "thin: 12 of 600 accounts", liquidationLevelsRead: 0 });
  });

  it("withSymbolLeverage re-chooses the target against the tighter stop: price, ratio and reason agree (50x on a 30x plan)", () => {
    const plan = buildSetPlan({ input: { symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, currentPrice: E, rules: ETH, levels: NO_LEVELS, random: () => 0.5, market: { sigma1h: 0.007 } });
    expect([plan.takeProfit.price, plan.stop.price]).toEqual([1899.43, 1762.25]);
    const w = withSymbolLeverage(plan, ETH, 50);
    expect(w.stop.price).toBe(1782.71);
    // The old 1,899.43 would be 4.07x, beyond the 4x top: the 1,850 round number of the new window is used.
    expect(w.takeProfit.price).toBe(1849.47);
    expect(w.orders.takeProfits).toEqual([{ stopPrice: 1849.47, qty: 0.166 }]);
    const ratio = (1849.47 - E) / (E - 1782.71);
    expect(w.takeProfit.ratio).toBeCloseTo(ratio, 6);
    expect(w.takeProfit.reason).toContain(`${Number(ratio.toFixed(2))}x the stop`);
    expect(w.takeProfit.reason).toContain("in front of 1,850");
    expect(w.takeProfit.reason).toContain("re-chosen for the symbol's 50x");
    expect(w.expected.profitAtTpUsd).toBeCloseTo(0.166 * (1849.47 - E), 2);
    // A smaller pull-in keeps the level and only moves the ratio, in the reason too.
    const w40 = withSymbolLeverage(plan, ETH, 40);
    expect(w40.takeProfit.price).toBe(1899.43);
    expect(w40.takeProfit.reason).toContain(`${Number(w40.takeProfit.ratio.toFixed(2))}x the stop`);
    expect(withSymbolLeverage(plan, ETH, 30)).toBe(plan); // not higher: unchanged
  });
});

/** Fixtures of 2026-11-20 and 2026-11-21 (public data only: Hyperliquid account answers and Aster candles; tests/fixtures/SOURCES.txt). */
const PROBE = JSON.parse(readFileSync(new URL("./fixtures/hl-fuel-2026-11-21.json", import.meta.url), "utf8")) as {
  at: string;
  positions: Array<{ coin: string; side: "long" | "short"; liq: number; notional: number }>;
  market: Record<string, { price: number; k1h: unknown[] }>;
};
const K1121 = parseKlines(JSON.parse(readFileSync(new URL("./fixtures/aster-klines-ETHUSDT-2026-11-21.json", import.meta.url), "utf8"))).klines;
const K1120 = parseKlines(JSON.parse(readFileSync(new URL("./fixtures/aster-klines-ETHUSDT-2026-11-20-0131.json", import.meta.url), "utf8"))).klines;
const AS_OF_1121 = Date.parse(PROBE.at); // 2026-11-20T19:13:41.906Z (04:13 JST on the 21st)
const AS_OF_1120 = Date.parse("2026-11-20T01:31:00Z");

describe("breadth: a cluster is a crowd (A11, E9)", () => {
  const L = (price: number, weightUsd: number, positionSide: "long" | "short"): LiquidationLevel => ({ price, weightUsd, positionSide });
  const eth = { entry: 1765, side: "buy" as const, stopPrice: 1722.5, mode: "deserved" as const, tickSize: 0.01, sigma1h: 0.00626, random: () => 0.5 };
  const btc = (() => {
    const s = planStop({ entry: 58140, side: "buy", leverage: 30, tickSize: 0.1, maintenanceMarginRate: 0.005, maintenanceSource: "assumed" });
    return { entry: 58140, side: "buy" as const, stopPrice: s.stopPrice, mode: "deserved" as const, tickSize: 0.1, sigma1h: 0.007, random: () => 0.5 };
  })();

  it("(a) one account's $25M at 1,908.34 alone is no cluster; counted as a lone trader and named, since it would have won", () => {
    const tp = pickTakeProfit({ ...eth, liquidationLevels: [L(1908.34, 25_000_000, "short")] });
    expect(tp.source).not.toBe("liquidation-cluster");
    expect(tp.counts).toMatchObject({ clustersFound: 0, clustersLoneTrader: 1, clustersWhaleOnly: 0 });
    expect(tp.reason).toContain("a $25M cluster at 1,908.34 was one account's and does not count");
    expect(tp.wouldHaveWon!.score).toBeGreaterThan(tp.counts.winner!.score);
  });

  it("(b) $117M of one account plus $2.8M of two within 0.2% fails (share 98%); with $23M of three more at 62,739 it passes (6 accounts, 82%, rest $26M)", () => {
    const whale = [L(62437, 117_000_000, "short"), L(62480, 1_500_000, "short"), L(62540, 1_300_000, "short")];
    const no = pickTakeProfit({ ...btc, liquidationLevels: whale });
    expect(no.counts).toMatchObject({ clustersFound: 0, clustersWhaleOnly: 1 });
    expect(no.reason).toContain("a $120M cluster at 62,437 was mostly one account's (98%) and does not count");
    const yes = pickTakeProfit({ ...btc, liquidationLevels: [...whale, L(62739, 8_000_000, "short"), L(62739.5, 8_000_000, "short"), L(62740, 7_000_000, "short")] });
    expect(yes.counts).toMatchObject({ clustersFound: 1, clustersWhaleOnly: 0 });
    const c = yes.scored.find((x) => x.kind === "liquidation-cluster")!.cluster!;
    expect(c).toMatchObject({ traders: 6, nearEdge: 62437, farEdge: 62740 });
    expect(c.share).toBeCloseTo(117 / 142.8, 3);
    expect(c.restUsd).toBeCloseTo(25_800_000, -3);
    expect(yes.source).toBe("liquidation-cluster");
    expect(yes.reason).toContain("$143M of 6 accounts' shorts get liquidated (62,437 to 62,740; the largest holds 82%)");
  });

  it("(c) $1.1M of 2 accounts with the largest at 71% passes; with the second at $20k it fails (the rest is under $100k)", () => {
    const sell = { entry: 1598.96, side: "sell" as const, stopPrice: 1637.46, mode: "deserved" as const, tickSize: 0.01, sigma1h: 0.0085, random: () => 0.5 };
    const ok = pickTakeProfit({ ...sell, liquidationLevels: [L(1445.77, 781_000, "long"), L(1445.63, 319_000, "long")] });
    expect(ok.counts).toMatchObject({ clustersFound: 1, clustersWhaleOnly: 0 });
    expect(ok.source).toBe("liquidation-cluster");
    expect(ok.reason).toContain("$1.1M of 2 accounts' longs get liquidated (1,445.77 to 1,445.63; the largest holds 71%)");
    const thin = pickTakeProfit({ ...sell, liquidationLevels: [L(1445.77, 781_000, "long"), L(1445.63, 20_000, "long")] });
    expect(thin.counts).toMatchObject({ clustersFound: 0, clustersWhaleOnly: 1 });
    expect(thin.source).not.toBe("liquidation-cluster");
  });

  it("(d) replay of the 2026-11-20 01:31Z ETH Short: the $10M one-account cluster drops; the buy-back falls to the brakes with the A6 reason", () => {
    const vol = realizedVol1h(K1120.map((k) => k.close));
    const tp = pickTakeProfit({ entry: 1764.96, side: "sell", stopPrice: 1807.46, mode: "deserved", tickSize: 0.01, sigma1h: vol.sigma1h, random: () => 0.5, liquidationLevels: [L(1666.69, 10_000_000, "long")] });
    expect(tp.source).toBe("round-number");
    expect(tp.price).not.toBe(1667.52);
    expect(tp.counts.clustersLoneTrader).toBe(1);
    expect(tp.reason).toMatch(/^Short from 1,764\.96; take profit \(buy back\) at [\d,.]+, [\d.]+x the stop \(buy back at 1,807\.46\)/);
    expect(tp.reason).toContain("no liquidation cluster between 1.9x and 4x, so the buy-back sits just in front of");
    expect(tp.reason).toContain("a $10M cluster at 1,666.69 was one account's and does not count");
  });

  it("(e) on the 2026-11-21 probe (600 accounts): ETH Long Deserved picks the $11.2M two-account cluster; BTC Short Deserved picks one of the three crowds", () => {
    const pick = (sym: string, coin: string, side: "buy" | "sell", tick: number) => {
      const m = PROBE.market[sym]!;
      const vol = realizedVol1h(parseKlines(m.k1h).klines.map((k) => k.close));
      const s = planStop({ entry: m.price, side, leverage: 30, tickSize: tick, maintenanceMarginRate: 0.005, maintenanceSource: "assumed" });
      const fuel = PROBE.positions.filter((p) => p.coin === coin).map((p) => L(p.liq, p.notional, p.side));
      return pickTakeProfit({ entry: m.price, side, stopPrice: s.stopPrice, mode: "deserved", tickSize: tick, liquidationLevels: fuel, sigma1h: vol.sigma1h, random: () => 0.5 });
    };
    expect(PROBE.positions.length).toBe(230);
    const ethLong = pick("ETHUSDT", "ETH", "buy", 0.01);
    expect(ethLong.source).toBe("liquidation-cluster");
    const ec = ethLong.scored.find((c) => c.price === ethLong.price && c.kind === "liquidation-cluster")!.cluster!;
    expect(ec.notionalUsd / 1e6).toBeCloseTo(11.2, 1);
    expect(ec.traders).toBe(2);
    expect(Math.round(ec.share * 100)).toBe(66);
    expect((ec.nearEdge - 1598.96) / 1598.96).toBeCloseTo(0.0627, 3);
    const btcShort = pick("BTCUSDT", "BTC", "sell", 0.1);
    expect(btcShort.source).toBe("liquidation-cluster");
    const bc = btcShort.scored.find((c) => c.price === btcShort.price && c.kind === "liquidation-cluster")!.cluster!;
    expect(["2.3", "5.9", "18.6"]).toContain((bc.notionalUsd / 1e6).toFixed(1));
    expect(bc.traders).toBeGreaterThanOrEqual(3);
    expect(bc.share).toBeLessThanOrEqual(0.9);
  });
});

describe("anti-chase guard (A12, E10)", () => {
  const sigma1121 = realizedVol1h(K1121.map((k) => k.close)).sigma1h;
  const sigma1120 = realizedVol1h(K1120.map((k) => k.close)).sigma1h;

  it("(a) 2026-11-21 ETH: a Short at 1,598.96 is refused (10.3% in a day, below the 3-day low); a Long is allowed", () => {
    const s = chaseCheck(1598.96, "sell", K1121, sigma1121, undefined, { asOf: AS_OF_1121, coin: "ETH" });
    expect(s).toMatchObject({ chase: true, edge: true, fast: true });
    expect(s.sentence).toBe("ETH fell 10.3% in a day, below its 3-day low.\nA Short here would follow the move at its edge.");
    expect(s.numbers).toMatchObject({ low72: 1608.55, high72: 1835.18, high24: 1782.14, candles: 72 }); // the 19:00 candle was still forming
    expect(s.numbers!.fastThreshold).toBeCloseTo(0.063, 3);
    expect(chaseCheck(1598.96, "buy", K1121, sigma1121, undefined, { asOf: AS_OF_1121, coin: "ETH" }).chase).toBe(false);
  });

  it("(b) 2026-11-20 01:31Z ETH: the Short at 1,764.96 was not a chase (30% up its range, 2.9% below the 24 h high against 4.6%)", () => {
    const s = chaseCheck(1764.96, "sell", K1120, sigma1120, undefined, { asOf: AS_OF_1120, coin: "ETH" });
    expect(s).toMatchObject({ chase: false, edge: false, fast: false, sentence: null });
    expect(s.numbers!.position).toBeCloseTo(0.297, 3);
    expect(s.numbers!.dayMove).toBeCloseTo(0.0287, 4);
    expect(s.numbers!.fastThreshold).toBeCloseTo(0.046, 3);
  });

  it("(c) a Patient Short waiting 3% above the 2026-11-21 price is not a chase (the entry, not the price, is judged)", () => {
    const s = chaseCheck(1598.96 * 1.03, "sell", K1121, sigma1121, undefined, { asOf: AS_OF_1121, coin: "ETH" });
    expect(s.chase).toBe(false);
    expect(s.edge).toBe(false);
  });

  // Synthetic candles: 72 hours, one per hour, made up here.
  const candles = (path: (h: number) => number) =>
    Array.from({ length: 72 }, (_, h) => {
      const c = path(h);
      return { openTime: h * 3_600_000, high: c * 1.001, low: c * 0.999, close: c };
    });

  it("(d) an edge without speed (a slow 3-day drift to the low, 1% in the last day) is allowed", () => {
    const k = candles((h) => (h < 48 ? 1700 - (85 * h) / 47 : 1615 - (15 * (h - 48)) / 23));
    const s = chaseCheck(1599, "sell", k, 0.006, undefined, { coin: "ETH" });
    expect(s.edge).toBe(true);
    expect(s.fast).toBe(false);
    expect(s.numbers!.dayMove).toBeLessThan(0.015);
    expect(s.chase).toBe(false);
  });

  it("(e) speed without an edge (a 7% drop that bounced back to mid-range) is allowed", () => {
    const k = candles((h) => (h < 10 ? 1600 + h * 20 : h < 60 ? 1800 : h < 64 ? 1800 - (h - 59) * 31.5 : 1700));
    const s = chaseCheck(1700, "sell", k, 0.006, undefined, { coin: "ETH" });
    expect(s.fast).toBe(true);
    expect(s.edge).toBe(false);
    expect(s.numbers!.position).toBeCloseTo(0.5, 1);
    expect(s.chase).toBe(false);
  });

  it("(f) chase.enabled false never refuses; the numbers and the sentence are still there for the log", () => {
    const s = chaseCheck(1598.96, "sell", K1121, sigma1121, { ...DEFAULT_RULES.chase, enabled: false }, { asOf: AS_OF_1121, coin: "ETH" });
    expect(s).toMatchObject({ chase: false, edge: true, fast: true, enabled: false });
    expect(s.sentence).toContain("10.3%");
    expect(s.numbers).not.toBeNull();
  });

  it("too few completed candles: the guard cannot judge and says so (negative)", () => {
    const s = chaseCheck(1598.96, "sell", K1121.slice(0, 10), sigma1121, undefined, { coin: "ETH" });
    expect(s.chase).toBe(false);
    expect(s.note).toMatch(/too few completed one-hour candles \(10\)/);
  });
});

describe("wording: the position and every price's action (A13, E11)", () => {
  const E = 1805.73;
  const buy = { entry: E, side: "buy" as const, stopPrice: 1758.19, mode: "deserved" as const, tickSize: 0.01, sigma1h: 0.007, random: () => 0.5 };
  const sell = { ...buy, side: "sell" as const, stopPrice: 1853.27 };
  const S = (price: number, weightUsd: number): LiquidationLevel => ({ price, weightUsd, positionSide: "short" });
  const fuelB = [S(1901.5, 150_000), S(1950.4, 900_000), S(1951.1, 800_000), S(1951.9, 800_000)];
  const longs = [
    pickTakeProfit(buy),
    pickTakeProfit({ ...buy, liquidationLevels: fuelB }),
    pickTakeProfit({ ...buy, liquidationLevels: fuelB, sigma1h: 0.0045 }),
    pickTakeProfit({ ...buy, mode: "greedy", liquidationLevels: [S(2000.5, 250_000), S(2001.2, 150_000)] }),
    pickTakeProfit({ ...buy, oppositeVolume: [{ price: 1902, weightUsd: 4_000_000 }], liquidationLevels: [S(1925, 300_000)] }),
    pickTakeProfit({ ...buy, sigma1h: 0.002, liquidationLevels: [S(1995, 15_000_000), S(1995.5, 15_000_000)] }),
    pickTakeProfit({ ...buy, liquidationLevels: [S(1897, 3_000_000), S(1897.4, 2_000_000)] }),
    pickTakeProfit({ ...buy, liquidationLevels: fuelB, fuelMap: "unavailable" }),
    chooseTarget({ candidates: [], brakes: [], entry: E, stopPrice: 1758.19, side: "buy", mode: "deserved", tickSize: 0.01, sigma1h: 0.007 }),
  ];
  const shorts = [
    pickTakeProfit(sell),
    pickTakeProfit({ ...sell, liquidationLevels: [{ price: 1699.6, weightUsd: 1_200_000, positionSide: "long" }, { price: 1699.1, weightUsd: 800_000, positionSide: "long" }] }),
  ];

  it("every reason of the E1 picks opens with the position, its entry and the take profit's action", () => {
    for (const p of [...longs, ...shorts]) expect(p.reason).toMatch(/^(Long|Short) from [\d,.]+; take profit \((sell|buy back)\) at /);
    for (const p of longs) {
      expect(p.reason.startsWith("Long from 1,805.73; take profit (sell) at ")).toBe(true);
      expect(p.reason).not.toContain("(buy back)");
    }
    for (const p of shorts) {
      expect(p.reason.startsWith("Short from 1,805.73; take profit (buy back) at ")).toBe(true);
      expect(p.reason).not.toContain("(sell)");
      expect(p.reason).toContain("(buy back at 1,853.27)");
    }
  });

  it("the summary line of the 01:31Z ETH Short is exactly the A13 headline", () => {
    expect(planHeadline({ symbol: "ETHUSDT", side: "sell", entry: 1764.96, takeProfit: 1667.52, ratio: 2.293294, stop: 1807.46 })).toBe("ETH Short from 1,764.96, buy back 1,667.52 (2.29x), stop 1,807.46");
    expect(planHeadline({ symbol: "BTCUSDT", side: "buy", entry: 62438.7, takeProfit: 65343.3, ratio: 1.932, stop: 60935 })).toBe("BTC Long from 62,438.7, sell 65,343.3 (1.93x), stop 60,935");
  });
});

describe("withSymbolLeverage keeps the breadth sentence (architect's review 2026-11-21)", () => {
  it("a lone account's cluster that would have won is still named after the stop is pulled in (33x on a 30x plan)", () => {
    const ETHR: SymbolRules = { symbol: "ETHUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
    const plan = buildSetPlan({
      input: { symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" },
      currentPrice: 1765,
      rules: ETHR,
      levels: NO_LEVELS,
      random: () => 0.5,
      market: { sigma1h: 0.00626, fuel: { status: "ok", levels: [{ price: 1908.34, weightUsd: 25_000_000, positionSide: "short" }] } },
    });
    expect(plan.takeProfit.reason).toContain("a $25M cluster at 1,908.34 was one account's and does not count");
    expect(plan.takeProfit.wouldHaveWon?.cluster?.notionalUsd).toBe(25_000_000);
    expect(plan.takeProfit.basis?.rejected).toHaveLength(1);
    const w = withSymbolLeverage(plan, ETHR, 33);
    expect(w.stop.price).toBeGreaterThan(plan.stop.price);
    expect(w.takeProfit.reason).toContain("a $25M cluster at 1,908.34 was one account's and does not count");
    expect(w.takeProfit.reason).toContain("re-chosen for the symbol's 33x");
    expect(w.takeProfit.wouldHaveWon?.cluster?.nearEdge).toBe(1908.34);
  });
});
