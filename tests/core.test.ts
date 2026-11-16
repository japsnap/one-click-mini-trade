/**
 * Tests for src/core. Every function is exercised, with negative tests for each rule
 * (ratio below 1, nudge band, fallbacks, bucket window, min notional, fee on a loss).
 * All REAL: pure functions, asserting on returned values that ARE the artifact.
 */
import { describe, expect, it } from "vitest";
import {
  assertRatioAtLeastOne,
  buildSetPlan,
  decimalsOf,
  estimateLiquidationPrice,
  evaluatePrice,
  exactTakeProfitPrice,
  findLiquidationCluster,
  findNearbyLevel,
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
/** Small seeded PRNG (mulberry32) for property-style loops. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

describe("take-profit", () => {
  it("rejects a ratio below 1 everywhere", () => {
    expect(() => assertRatioAtLeastOne(0.99)).toThrow(RatioBelowOneError);
    expect(() => assertRatioAtLeastOne(Number.NaN)).toThrow(RatioBelowOneError);
    expect(() => exactTakeProfitPrice(100, 98, "buy", 0.5)).toThrow(RatioBelowOneError);
    expect(() => pickTakeProfit({ entry: 100, side: "buy", leverage: 50, mode: "shy", tickSize: 0.01, minRatioOverride: 0.8 })).toThrow(
      RatioBelowOneError,
    );
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
  it("Deserved on a BTC long snaps to the round number just beyond 2x", () => {
    // 50x at 64,000: liq 62,720, distance 1,280; 2x target 66,560; window to 66,560 + 0.35 x 2,560 = 67,456.
    const tp = pickTakeProfit({ entry: 64000, side: "buy", leverage: 50, mode: "deserved", tickSize: 0.1 });
    expect(tp.exactPrice).toBeCloseTo(66560);
    expect(tp.price).toBe(66500 + 500); // 66,500 is below the 2x minimum, so 67,000
    expect(tp.source).toBe("round-number");
    expect(tp.ratio).toBeGreaterThanOrEqual(2);
  });
  it("a trader TP nearer the exact target beats a round number", () => {
    const tp = pickTakeProfit({
      entry: 64000,
      side: "buy",
      leverage: 50,
      mode: "deserved",
      tickSize: 0.1,
      traderTakeProfits: [{ price: 66600, weightUsd: 1 }, { price: 66000, weightUsd: 1e9 }], // 66,000 is below 2x: ignored
    });
    expect(tp.price).toBe(66600);
    expect(tp.source).toBe("trader-tp");
  });
  it("falls back to the exact ratio when no key level fits, rounding away from entry", () => {
    // Sell 100x at 64,010: liq distance 640.1, Shy 1x target 63,369.9; window down to 63,145.865: no round number (63,000 is outside).
    const tp = pickTakeProfit({ entry: 64010, side: "sell", leverage: 100, mode: "shy", tickSize: 0.1 });
    expect(tp.source).toBe("exact-ratio");
    expect(tp.price).toBeLessThanOrEqual(tp.exactPrice);
    expect(tp.ratio).toBeGreaterThanOrEqual(1);
    expect(isOnStep(tp.price, 0.1)).toBe(true);
  });
  it("Greedy keeps >= 4x for shorts too", () => {
    const tp = pickTakeProfit({ entry: 3000, side: "sell", leverage: 30, mode: "greedy", tickSize: 0.01 });
    expect(tp.ratio).toBeGreaterThanOrEqual(4);
    expect(tp.price).toBeLessThan(3000);
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

describe("entry: nearby", () => {
  const bids: SidedLevel[] = [
    { price: 63900, weightUsd: 3000, side: "buy" }, // too small alone
    { price: 63900, weightUsd: 3000, side: "buy" }, // ...but summed with the one above: $6k qualifies
    { price: 63950, weightUsd: 1000, side: "buy" }, // closer but too small
    { price: 63500, weightUsd: 1e6, side: "buy" }, // big but 0.78% away: outside 0.5%
    { price: 64050, weightUsd: 1e6, side: "buy" }, // above price: wrong side for a Buy
    { price: 63990, weightUsd: 1e6, side: "sell" }, // an ask: ignored for a Buy
  ];
  it("picks the closest meaningful level on the favourable side, summing same-price orders", () => {
    expect(findNearbyLevel(bids, "buy", 64000)).toEqual({ price: 63900, weightUsd: 6000 });
  });
  it("ignores a level closer than one nudge width (0.05%)", () => {
    const tooClose: SidedLevel[] = [{ price: 63990, weightUsd: 1e6, side: "buy" }]; // 0.016% away
    expect(findNearbyLevel(tooClose, "buy", 64000)).toBeNull();
  });
  it("falls back to Now when no level qualifies", () => {
    const d = pickEntry({ mode: "nearby", side: "buy", currentPrice: 64000, levels: { ...NO_LEVELS, limitLevels: bids.slice(2, 3) } });
    expect(d.usedMode).toBe("now");
    expect(d.orderType).toBe("market");
    expect(d.price).toBe(64000);
    expect(d.fellBackFrom).toEqual(["nearby"]);
    expect(d.reason).toMatch(/no nearby level found/);
  });
  it("Sell mirrors: above the price, asks only", () => {
    const asks: SidedLevel[] = [
      { price: 64100, weightUsd: 9000, side: "sell" },
      { price: 63900, weightUsd: 9e6, side: "sell" }, // below price: wrong side
    ];
    const d = pickEntry({ mode: "nearby", side: "sell", currentPrice: 64000, levels: { ...NO_LEVELS, limitLevels: asks } });
    expect(d.usedMode).toBe("nearby");
    expect(d.price).toBe(64100);
  });
});

describe("entry: patient", () => {
  const liqs: LiquidationLevel[] = [
    // bucket of 0.1% width counted from 64,000 downward
    { price: 62700, weightUsd: 400_000, positionSide: "long" }, // 2.03% away -> bucket 20
    { price: 62690, weightUsd: 400_000, positionSide: "long" }, // 2.05% -> bucket 20 (sum 800k)
    { price: 63000, weightUsd: 700_000, positionSide: "long" }, // 1.56% -> bucket 15
    { price: 63800, weightUsd: 9e9, positionSide: "long" }, // 0.31%: inside 1%, ignored
    { price: 60000, weightUsd: 9e9, positionSide: "long" }, // 6.25%: beyond 5%, ignored
    { price: 62700, weightUsd: 9e9, positionSide: "short" }, // shorts do not liquidate below: ignored for Buy
  ];
  it("picks the heaviest 0.1% bucket within 1-5% and enters at its centre", () => {
    const c = findLiquidationCluster(liqs, "buy", 64000);
    expect(c?.bucketIndex).toBe(20);
    expect(c?.weightUsd).toBe(800_000);
    expect(c?.centre).toBeCloseTo(64000 * (1 - 0.0205)); // centre of [2.0%, 2.1%)
  });
  it("ignores levels outside 1-5% (none left -> fallback to Nearby, then Now)", () => {
    const outside = liqs.filter((l) => l.price === 63800 || l.price === 60000);
    expect(findLiquidationCluster(outside, "buy", 64000)).toBeNull();
    const d = pickEntry({ mode: "patient", side: "buy", currentPrice: 64000, levels: { ...NO_LEVELS, liquidationLevels: outside } });
    expect(d.fellBackFrom).toEqual(["patient", "nearby"]);
    expect(d.usedMode).toBe("now");
  });
  it("falls back to Nearby when Nearby has a level", () => {
    const d = pickEntry({
      mode: "patient",
      side: "buy",
      currentPrice: 64000,
      levels: { ...NO_LEVELS, limitLevels: [{ price: 63950, weightUsd: 50_000, side: "buy" }] },
    });
    expect(d.usedMode).toBe("nearby");
    expect(d.fellBackFrom).toEqual(["patient"]);
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
    // 30x: liq distance about 3.3%; an Out band only 1% above is below 1x.
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
  it("Buy $30 50x Deserved Now: market qty floored, liquidation 2% below, TP >= 2x", () => {
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
    expect(p.liquidationPrice).toBeCloseTo(64442.8 * 0.98);
    expect(p.takeProfit.ratio).toBeGreaterThanOrEqual(2);
    expect(p.expected.lossAtLiquidationUsd).toBeCloseTo(-0.023 * 64442.8 * 0.02, 1);
    expect(p.expected.feeSplitOnWin.blackboardUsd).toBeCloseTo(p.expected.profitAtTpUsd * 0.05, 1);
  });
  it("a nudged Buy limit never ends at or above the current price", () => {
    const p = buildSetPlan({
      input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, tpMode: "deserved", entryMode: "nearby" },
      currentPrice: 64000,
      rules: BTC,
      levels: { ...NO_LEVELS, limitLevels: [{ price: 63999, weightUsd: 1e6, side: "buy" }] },
      random: () => 0.999, // pushes the nudge up by almost +0.05% (would be 64,030)
      options: { entry: { nearbyMinDistance: 0 } }, // let the too-close level through to test the safety clamp
    });
    expect(p.entry.nudgedPrice!).toBeLessThan(64000);
    expect(p.orders.entries[0]!.type).toBe("LIMIT");
  });
});

describe("input validation", () => {
  it("accepts a good body and defaults tpMode to deserved", () => {
    expect(parseSetInput({ symbol: "btcusdt", side: "buy", ticketUsd: 30, leverage: 50, entryMode: "now" }).tpMode).toBe("deserved");
  });
  it("rejects values outside the card's choices", () => {
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 20, leverage: 50, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "long", ticketUsd: 30, leverage: 50, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 125, entryMode: "now" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, entryMode: "draw" })).toThrow(InvalidSetInputError);
    expect(() => parseSetInput(null)).toThrow(InvalidSetInputError);
  });
});
