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
import { parseDepth } from "../src/exchange/aster";
import {
  assertRatioAtLeastOne,
  buildSetPlan,
  decimalsOf,
  estimateLiquidationPrice,
  evaluatePrice,
  exactTakeProfitPrice,
  findLiquidationCluster,
  findLiquidationClusterWithCounts,
  findVolumeZone,
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
  it("no volume zone: Deserved on a BTC long snaps to the round number just beyond 2x the stop distance", () => {
    // Stop 62,720 (distance 1,280); 2x target 66,560; window to 66,560 + 0.35 x 2,560 = 67,456.
    const tp = pickTakeProfit({ entry: 64000, side: "buy", stopPrice: 62720, mode: "deserved", tickSize: 0.1 });
    expect(tp.exactPrice).toBeCloseTo(66560);
    expect(tp.price).toBe(66500 + 500); // 66,500 is below the 2x minimum, so 67,000
    expect(tp.source).toBe("round-number");
    expect(tp.ratio).toBeGreaterThanOrEqual(2);
    expect(tp.zone).toBeNull();
  });
  it("a trader TP nearer the exact target beats a round number", () => {
    const tp = pickTakeProfit({
      entry: 64000,
      side: "buy",
      stopPrice: 62720,
      mode: "deserved",
      tickSize: 0.1,
      traderTakeProfits: [{ price: 66600, weightUsd: 1 }, { price: 66000, weightUsd: 1e9 }], // 66,000 is below 2x: ignored
    });
    expect(tp.price).toBe(66600);
    expect(tp.source).toBe("trader-tp");
  });
  it("falls back to the exact ratio when no key level fits, rounding away from entry", () => {
    // Sell at 64,010 with the stop 640.1 above: Shy 1x target 63,369.9; window down to 63,145.865: no round number (63,000 is outside).
    const tp = pickTakeProfit({ entry: 64010, side: "sell", stopPrice: 64650.1, mode: "shy", tickSize: 0.1 });
    expect(tp.source).toBe("exact-ratio");
    expect(tp.price).toBeLessThanOrEqual(tp.exactPrice);
    expect(tp.ratio).toBeGreaterThanOrEqual(1);
    expect(isOnStep(tp.price, 0.1)).toBe(true);
  });
  it("Greedy keeps >= 4x for shorts too", () => {
    const tp = pickTakeProfit({ entry: 3000, side: "sell", stopPrice: 3085, mode: "greedy", tickSize: 0.01 });
    expect(tp.ratio).toBeGreaterThanOrEqual(4);
    expect(tp.price).toBeLessThan(3000);
  });
});

describe("take-profit volume zone", () => {
  // Buy at 64,000, stop 62,720 (1,280 away). Deserved minimum 66,560; zone window up to 1.5x = 67,840.
  const base = { entry: 64000, side: "buy" as const, stopPrice: 62720, mode: "deserved" as const, tickSize: 0.1 };
  const asks = [
    { price: 66400, weightUsd: 9e6 }, // below the minimum: never a target
    { price: 66700, weightUsd: 40_000 }, // 2,700 above entry: bucket floor(2700 / 32) = 84
    { price: 67210, weightUsd: 300_000 }, // k = floor(3210/32) = 100: the heaviest
    { price: 67220, weightUsd: 200_000 }, // same bucket (3220/32 = 100.6)
    { price: 67900, weightUsd: 9e6 }, // beyond 1.5x (67,840): ignored
  ];
  it("stops just in front of the heaviest wall beyond the minimum, within the jitter band", () => {
    const tp = pickTakeProfit({ ...base, oppositeVolume: asks, random: () => 0.5 });
    expect(tp.source).toBe("volume-zone");
    expect(tp.zone?.weightUsd).toBe(500_000);
    expect(tp.zone?.frontPrice).toBe(67210); // the wall starts at its nearest order
    // r = 0.5 -> exactly 0.03% in front: 67,210 x (1 - 0.0003) = 67,189.837 -> toward entry 67,189.8
    expect(tp.price).toBe(67189.8);
    expect(tp.ratio).toBeGreaterThanOrEqual(2);
    expect(tp.diagnostics).toEqual({ levelsRead: 5, levelsInWindow: 3, bucketsInWindow: 2, heaviestBucketUsd: 500_000 });
  });
  it("jitter stays between 0% and 0.06% in front of the wall and never inside it (500 seeded draws)", () => {
    const rnd = seededRandom(7);
    for (let i = 0; i < 500; i++) {
      const tp = pickTakeProfit({ ...base, oppositeVolume: asks, random: rnd });
      expect(tp.price).toBeLessThanOrEqual(67210);
      expect(tp.price).toBeGreaterThanOrEqual(67210 * (1 - 0.0006) - 0.1);
      expect(isOnStep(tp.price, 0.1)).toBe(true);
    }
  });
  it("never goes below the ratio minimum even when the wall sits right on it", () => {
    // Wall front exactly at the 2x minimum 66,560: 0.03% in front would be below 2x, so it clamps to the minimum.
    const tp = pickTakeProfit({ ...base, oppositeVolume: [{ price: 66560, weightUsd: 1e6 }], random: () => 0.99 });
    expect(tp.source).toBe("volume-zone");
    expect(tp.price).toBe(66560);
    expect(tp.ratio).toBe(2);
  });
  it("a wall lighter than $25k does not count; falls back to the round number (negative)", () => {
    const tp = pickTakeProfit({ ...base, oppositeVolume: [{ price: 67210, weightUsd: 24_999 }] });
    expect(tp.source).toBe("round-number");
    expect(tp.diagnostics.heaviestBucketUsd).toBe(24_999);
  });
  it("Sell mirrors: bids below, front is the HIGHEST bid of the wall, target above it", () => {
    // Sell at 64,000, stop 65,280: minimum 61,440, window down to 60,160.
    const z = findVolumeZone({ entry: 64000, side: "sell", levels: [{ price: 61000, weightUsd: 1e5 }, { price: 60990, weightUsd: 1e5 }, { price: 66000, weightUsd: 1e9 }], minDistance: 2560, maxDistance: 3840, bucketWidth: 0.0005, minWeightUsd: 25_000 });
    expect(z.zone?.frontPrice).toBe(61000);
    expect(z.diagnostics.levelsInWindow).toBe(2); // the 66,000 bid is on the loss side: ignored
    const tp = pickTakeProfit({ entry: 64000, side: "sell", stopPrice: 65280, mode: "deserved", tickSize: 0.1, oppositeVolume: [{ price: 61000, weightUsd: 1e5 }] });
    expect(tp.price).toBeGreaterThan(61000);
    expect(tp.price).toBeLessThanOrEqual(61440);
  });
  it("on the real Aster book: a 30x Deserved Buy finds a wall and keeps >= 2x", () => {
    const mid = 64426.1;
    const s = planStop({ entry: mid, side: "buy", leverage: 30, tickSize: 0.1, maintenanceMarginRate: 0.005, maintenanceSource: "assumed" });
    const tp = pickTakeProfit({ entry: mid, side: "buy", stopPrice: s.stopPrice, mode: "deserved", tickSize: 0.1, oppositeVolume: DEPTH.asks, random: seededRandom(1) });
    expect(DEPTH.asks.length).toBe(1000);
    expect(tp.ratio).toBeGreaterThanOrEqual(2);
    expect(tp.diagnostics.levelsRead).toBe(1000);
    // The book reaches about 5.4% up; the window starts at about 4.8%, so some asks are inside it.
    expect(tp.diagnostics.levelsInWindow).toBeGreaterThan(0);
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
  it("feeds the take-profit zone from Aster's asks plus traders' SELL limits only (a Buy)", () => {
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
    });
    expect(p.diagnostics.oppositeVolumeLevels).toEqual({ venueBook: 1000, traders: 2 }); // the bid is the wrong side for a Buy's target
    expect(p.takeProfit.ratio).toBeGreaterThanOrEqual(2);
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
