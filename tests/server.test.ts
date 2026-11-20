/**
 * Server-side parts: config validation (REAL, plain objects, never the real environment),
 * plan-to-Aster-order conversion (REAL), and the preview planner with its plan log (HYBRID, below).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../server/config";
import { appendPlanLog, createPlanner, sourcesForLog } from "../server/planning";
import { parseKlines, parseSymbolRules } from "../src/exchange/aster";
import { HyperliquidLevelSource } from "../src/levels/hyperliquid";
import { planToSetLegs } from "../server/execute";
import { buildSetPlan } from "../src/core/plan";
import type { SymbolRules } from "../src/core/types";

const BTC: SymbolRules = { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
const A = "0x" + "a".repeat(40);
const K = "0x" + "1".repeat(64);

describe("config", () => {
  it("defaults to trial mode with a $10 cap and no credentials", () => {
    const c = loadConfig({});
    expect(c.liveTrading).toBe(false);
    expect(c.maxLiveTicketUsd).toBe(10);
    expect(c.credentials).toBeNull();
    expect(c.baseUrl).toBe("https://fapi.asterdex.com");
  });
  it("rejects typos and partial settings loudly (negative)", () => {
    expect(() => loadConfig({ LIVE_TRADING: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ LIVE_TRADING: "true" })).toThrow(/needs ASTER_USER/);
    expect(() => loadConfig({ ASTER_USER: A })).toThrow(/all three/);
    expect(() => loadConfig({ ASTER_USER: A, ASTER_SIGNER: A, ASTER_SIGNER_PRIVATE_KEY: "0x12" })).toThrow(/64 hex/);
    expect(() => loadConfig({ MAX_LIVE_TICKET_USD: "-5" })).toThrow(ConfigError);
    expect(() => loadConfig({ ASTER_BUILDER_ADDRESS: A })).toThrow(/both/);
    expect(() => loadConfig({ ASTER_BUILDER_ADDRESS: A, ASTER_BUILDER_FEE_RATE: "0.01" })).toThrow(/at most/);
    expect(() => loadConfig({ ASTER_BASE_URL: "http://insecure" })).toThrow(/https/);
  });
  it("ASTER_EXIT_REDUCE_ONLY defaults to true (proven live 2026-11-19); only true or false are accepted (negative)", () => {
    expect(loadConfig({}).reduceOnlyExits).toBe(true);
    expect(loadConfig({ ASTER_EXIT_REDUCE_ONLY: "false" }).reduceOnlyExits).toBe(false);
    expect(() => loadConfig({ ASTER_EXIT_REDUCE_ONLY: "yes" })).toThrow(/ASTER_EXIT_REDUCE_ONLY/);
  });
  it("never prints a secret value", () => {
    const c = loadConfig({ ASTER_USER: A, ASTER_SIGNER: A, ASTER_SIGNER_PRIVATE_KEY: K, LIVE_TRADING: "true" });
    const line = describeConfig(c);
    expect(line).toContain("mode=LIVE");
    expect(line).not.toContain(K.slice(2, 12));
    expect(line).not.toContain(A.slice(2, 12));
  });
});

describe("plan -> Aster OTOCO legs (entry, take-profit, stop)", () => {
  const plan = buildSetPlan({
    input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, tpMode: "deserved", entryMode: "nearby" },
    currentPrice: 64000,
    rules: BTC,
    levels: { limitLevels: [{ price: 63900, weightUsd: 1e6, side: "buy" }], takeProfitLevels: [], liquidationLevels: [] },
    random: () => 0.5,
  });
  // Changed 2026-11-16 (many Sets at once): one-way exits are plain opposite-side orders, no
  // longer reduce-only, so a Buy Set and a Sell Set on one coin cannot block each other's exits.
  it("one-way mode: LIMIT GTC entry; plain (not reduce-only) TP and STOP_MARKET on mark price, both driven by the entry, each cancelling the other", () => {
    const [l] = planToSetLegs(plan, BTC, false);
    // Nearby with r = 0.5: middle of bucket 3 (0.15%-0.2%) = 63,888, nudge 0 -> 63,888.0
    expect(l!.entry).toMatchObject({ strategySubId: "1", type: "LIMIT", side: "BUY", timeInForce: "GTC", price: "63888.0", quantity: "0.023" });
    expect(l!.takeProfit).toMatchObject({
      strategySubId: "2",
      type: "TAKE_PROFIT_MARKET",
      side: "SELL",
      workingType: "MARK_PRICE",
      firstDrivenId: "1",
      firstDrivenOn: "PARTIALLY_FILLED_OR_FILLED",
      firstTrigger: "PLACE_ORDER",
      secondDrivenId: "3",
      secondDrivenOn: "FILLED",
      secondTrigger: "CANCEL_ORDER",
      quantity: "0.023",
    });
    expect(l!.stop).toMatchObject({
      strategySubId: "3",
      type: "STOP_MARKET",
      side: "SELL",
      workingType: "MARK_PRICE",
      firstDrivenId: "1",
      secondDrivenId: "2",
      secondTrigger: "CANCEL_ORDER",
      quantity: "0.023",
      stopPrice: plan.stop.price.toFixed(1),
    });
    expect(Number(l!.stop.stopPrice)).toBeLessThan(63888);
    expect(Number(l!.stop.stopPrice)).toBeGreaterThan(plan.liquidationPrice);
    expect(l!.takeProfit.reduceOnly).toBeUndefined(); // one-way: not reduce-only (see above)
    expect(l!.stop.reduceOnly).toBeUndefined();
    expect(l!.takeProfit.positionSide).toBeUndefined(); // one-way: BOTH by default
    expect(l!.takeProfit.price).toBeUndefined(); // TAKE_PROFIT_MARKET must not carry price
    expect(l!.stop.price).toBeUndefined(); // nor STOP_MARKET
  });
  it("hedge mode: positionSide LONG on all three legs and no reduceOnly", () => {
    const [l] = planToSetLegs(plan, BTC, true);
    expect(l!.entry.positionSide).toBe("LONG");
    expect(l!.takeProfit.positionSide).toBe("LONG");
    expect(l!.stop.positionSide).toBe("LONG");
    expect(l!.takeProfit.reduceOnly).toBeUndefined();
    expect(l!.stop.reduceOnly).toBeUndefined();
  });
  it("reduce-only exits when switched on: one-way only, both exits carry reduceOnly \"true\", the entry never; hedge mode never (Aster forbids it there)", () => {
    const [on] = planToSetLegs(plan, BTC, false, "set_ro1", { reduceOnlyExits: true });
    expect(on!.takeProfit.reduceOnly).toBe("true");
    expect(on!.stop.reduceOnly).toBe("true");
    expect(on!.entry.reduceOnly).toBeUndefined();
    const [hedge] = planToSetLegs(plan, BTC, true, "set_ro2", { reduceOnlyExits: true });
    expect(hedge!.takeProfit.reduceOnly).toBeUndefined();
    expect(hedge!.stop.reduceOnly).toBeUndefined();
    expect(hedge!.stop.positionSide).toBe("LONG");
  });
  it("refuses off-tick prices, a missing stop, and a stop beyond liquidation before signing (negative)", () => {
    const broken = { ...plan, orders: { ...plan.orders, entries: [{ type: "LIMIT" as const, price: 63900.05, qty: 0.023 }] } };
    expect(() => planToSetLegs(broken, BTC, false)).toThrow(/off the tick/);
    expect(() => planToSetLegs({ ...plan, orders: { ...plan.orders, stops: [] } }, BTC, false)).toThrow(/no stop/);
    const beyond = { ...plan, orders: { ...plan.orders, stops: [{ stopPrice: 60000, qty: 0.023 }] } };
    expect(() => planToSetLegs(beyond, BTC, false)).toThrow(/beyond the liquidation/);
    const wrongSide = { ...plan, orders: { ...plan.orders, stops: [{ stopPrice: 64500, qty: 0.023 }] } };
    expect(() => planToSetLegs(wrongSide, BTC, false)).toThrow(/opposite sides/);
  });
});

/**
 * The preview path (server/planning.ts) with the target's market data (Sets_Rules.md E2).
 * HYBRID: the planner, buildSetPlan, the real HyperliquidLevelSource and the real plan log
 * writer run for real; Aster is a FAKE object (fakeAsterPublic, no network) and Hyperliquid
 * a FAKE fetch. Its answers are fixtures: the captured leaderboard (3 accounts) and the
 * captured clearinghouseState with the ETH short's liquidation price EDITED to 1,950.4 so it
 * lands in the target window (shape unchanged). Candles are SYNTHETIC (alternating +-0.7%).
 * It proves the wiring (candles -> sigma1h and swings, liquidation map -> clusters, reason
 * -> response and plans.jsonl), not the venues' real answers (the live smoke does).
 */
describe("preview with candles and the liquidation map (server/planning.ts)", () => {
  const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  const ETH: SymbolRules = parseSymbolRules(fx("aster-exchangeInfo.json"), "ETHUSDT");
  const CS = fx("hl-clearinghouseState.json");
  for (const ap of CS.assetPositions) if (ap.position.coin === "ETH") Object.assign(ap.position, { liquidationPx: "1950.4", positionValue: "2500000.0" });

  /** Aster-shaped kline rows (strings), closes alternating +-0.7% and ending at `last`. */
  function klineRows(n: number, last: number, stepMs: number) {
    const closes = [last];
    for (let i = 1; i < n; i++) closes.unshift((closes[0] as number) / Math.exp(i % 2 ? 0.007 : -0.007));
    const t0 = 1_763_600_000_000; // 2025-11-20, any real time works
    return closes.map((c, i) => [t0 + i * stepMs, String(c), String(c * 1.001), String(c * 0.999), String(c), "1", t0 + i * stepMs + stepMs - 1]);
  }
  const fakeAsterPublic = {
    getPrice: async (symbol: string) => ({ symbol, price: 1805.73, time: 1 }),
    getSymbolRules: async () => ETH,
    getDepth: async () => ({ bids: [{ price: 1800, weightUsd: 1000 }], asks: [{ price: 1810, weightUsd: 1000 }], skipped: 0 }),
    getKlines: async (_s: string, interval: "1h" | "4h", limit: number) => parseKlines(klineRows(limit, 1805.73, interval === "1h" ? 3_600_000 : 14_400_000)).klines,
  };

  async function readyLevels() {
    let now = 0;
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes("leaderboard")) return new Response(JSON.stringify(fx("hl-leaderboard.json")));
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(body.type === "clearinghouseState" ? CS : fx("hl-frontendOpenOrders.json")));
    };
    const src = new HyperliquidLevelSource({ fetch: f, now: () => now, sleep: async (ms) => void (now += ms), log: () => undefined, minAccountValueUsd: 1, minAccountValueForVolumeUsd: 1, fuelMap: { topN: 600, refreshMinutes: 5, minAccountValueUsd: 1 } });
    await src.refreshFuelMap();
    return src;
  }

  it("the preview carries the reason, the top candidates and the counts, and plans.jsonl carries the same reason", async () => {
    const levels = await readyLevels();
    const lines: string[] = [];
    const planner = createPlanner({ aster: fakeAsterPublic, levels, bracketsFor: async () => null, random: () => 0.5, log: (l) => lines.push(l), warn: (l) => lines.push(l) });
    const { plan, sources } = await planner.planFromBody({ symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now", seed: 1 }, true);
    expect(plan.takeProfit.source).toBe("liquidation-cluster");
    expect(plan.takeProfit.reason).toContain("$7.5M of 3 traders' shorts get liquidated (1,950.4)");
    // In front of the round number 1,950 (the cluster edge 1,950.4 sits 0.02% behind it), moved by the seeded jitter.
    expect(plan.takeProfit.price).toBeLessThan(1950);
    expect(plan.takeProfit.price).toBeGreaterThanOrEqual(1950 * (1 - 0.0006) - 0.01);
    expect(plan.takeProfit.candidates.length).toBeGreaterThan(1);
    expect(plan.takeProfit.counts).toMatchObject({ liquidationLevelsRead: 3, liquidationsInWindow: 3, clustersFound: 1, sigmaSource: "measured", fuelMap: "ok" });
    expect(plan.takeProfit.counts!.sigma1h).toBeCloseTo(0.00705, 4);
    expect(sources.klines).toMatchObject({ candles1h: 73, candles4h: 42, returnsUsed: 72, tooFewCandles: false });
    expect(sources.fuelMap).toMatchObject({ status: "ok", addressesWithFreshAnswer: 3, liquidationLevels: 3 });
    expect(lines.some((l) => l.startsWith("[counts] ETHUSDT buy now") && l.includes("clusters 1") && l.includes("winner liquidation-cluster"))).toBe(true);

    const dir = mkdtempSync(path.join(tmpdir(), "plans-log-"));
    const file = path.join(dir, "plans.jsonl");
    expect(existsSync(file)).toBe(false); // before: no log
    await appendPlanLog(dir, "preview", plan, { sources: sourcesForLog(sources) }, (l) => lines.push(l));
    const written = readFileSync(file, "utf8").trim().split("\n");
    expect(written).toHaveLength(1);
    const line = JSON.parse(written[0]!);
    expect(line.takeProfit.reason).toBe(plan.takeProfit.reason);
    expect(line.takeProfit.candidates[0]).toMatchObject({ kind: "liquidation-cluster", price: plan.takeProfit.price });
    expect(line.takeProfit.counts.clustersFound).toBe(1);
    // What the plan was built from rides on the same line (review 2026-11-20).
    expect(line.sources.fuelMap).toEqual({ status: "ok", note: null, fresh: 3, inSample: 3, asked: 3, answered: 3, failed: 0, skippedByBudget: 0, levelsOnCoin: 3 });
    expect(line.sources.klines).toMatchObject({ available: true, candles1h: 73, candles4h: 42, tooFewCandles: false });
    expect(line.sources.depth).toEqual({ bids: 1, asks: 1, skipped: 0 });
    expect(line.sources.maintenance).toBe("assumed");
    expect(lines.some((l) => l.startsWith("[plan] preview ETHUSDT buy") && l.endsWith(plan.takeProfit.reason))).toBe(true);
  });

  it("candles failing and the map not read yet: the plan still builds and says so (negative)", async () => {
    const lines: string[] = [];
    const cold = new HyperliquidLevelSource({ log: () => undefined, fuelMap: { topN: 600, refreshMinutes: 5 }, fetch: async () => new Response("down", { status: 503 }) });
    const broken = { ...fakeAsterPublic, getKlines: async () => { throw new Error("klines down"); } };
    const planner = createPlanner({ aster: broken, levels: cold, bracketsFor: async () => null, random: () => 0.5, log: (l) => lines.push(l), warn: (l) => lines.push(l) });
    const { plan, sources } = await planner.planFromBody({ symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, false);
    expect(sources.klines).toEqual({ unavailable: "klines down" });
    expect(sources.levels).toMatchObject({ unavailable: expect.any(String) });
    expect(sources.fuelMap).toMatchObject({ status: "unavailable", note: expect.stringMatching(/not read yet/) });
    expect(plan.takeProfit.counts).toMatchObject({ sigmaSource: "not given", fuelMap: "unavailable" });
    expect(plan.takeProfit.reason).toMatch(/liquidation map unavailable/);
    expect(lines.some((l) => l.includes("[klines] ETHUSDT candles unavailable"))).toBe(true);
    expect(sourcesForLog(sources)).toMatchObject({ klines: { available: false, error: "klines down" }, fuelMap: { status: "unavailable", fresh: 0 } });
  });

  it("a thin map from the level source reaches the plan's reason (FAKE level source declaring 12 of 600)", async () => {
    const fakeThinLevels = {
      getLevels: async () => ({ levels: { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] }, report: {} as never }),
      getFuelLevels: () => ({
        levels: [{ price: 1950.4, weightUsd: 2_500_000, positionSide: "short" as const }],
        status: "unavailable" as const,
        note: "thin: 12 of 600 accounts",
        report: { addressesWithFreshAnswer: 12, addressesInSample: 600 } as never,
      }),
    };
    const planner = createPlanner({ aster: fakeAsterPublic, levels: fakeThinLevels, bracketsFor: async () => null, random: () => 0.5, log: () => undefined, warn: () => undefined });
    const { plan, sources } = await planner.planFromBody({ symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, false);
    expect(plan.takeProfit.reason).toMatch(/^liquidation map unavailable \(thin: 12 of 600 accounts\), so target/);
    expect(plan.takeProfit.source).not.toBe("liquidation-cluster");
    expect(sources.fuelMap).toMatchObject({ status: "unavailable", note: "thin: 12 of 600 accounts" });
  });
});
