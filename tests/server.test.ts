/**
 * Server-side parts: config validation (REAL, plain objects, never the real environment),
 * plan-to-Aster-order conversion (REAL), and the preview planner with its plan log (HYBRID, below).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "./helpers/fakeClock";
import { ConfigError, describeConfig, loadConfig } from "../server/config";
import { appendPlanLog, createPlanner, sourcesForLog } from "../server/planning";
import { AsterApiError, parseKlines, parseSymbolRules } from "../src/exchange/aster";
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
    expect(plan.takeProfit.reason).toContain("$7.5M of 3 accounts' shorts get liquidated (1,950.4; the largest holds 33%)");
    expect(plan.takeProfit.reason).toMatch(/^Long from 1,805.73; take profit \(sell\) at /);
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
    expect(line.sources.fuelMap).toEqual({ status: "ok", stage: "full", note: null, reading: null, usable: 3, fresh: 3, inSample: 3, asked: 3, answered: 3, failed: 0, skippedByBudget: 0, levelsOnCoin: 3 });
    expect(line.headline).toBe(`ETH Long from 1,805.73, sell ${plan.takeProfit.price.toLocaleString("en-US")} (${Number(plan.takeProfit.ratio.toFixed(2))}x), stop 1,762.25`);
    expect(line.sources.chase).toMatchObject({ chase: false, enabled: true });
    expect(line.sources.klines).toMatchObject({ available: true, candles1h: 73, candles4h: 42, tooFewCandles: false });
    expect(line.sources.depth).toEqual({ bids: 1, asks: 1, skipped: 0 });
    expect(line.sources.maintenance).toBe("assumed");
    expect(lines.some((l) => l.startsWith("[plan] preview ETH Long from 1,805.73, sell ") && l.endsWith(plan.takeProfit.reason))).toBe(true); // A13 headline, never "<side>: <price>"
  });

  it("candles failing (Aster klines answer 503): preview and place of an ETH Short, and a Long, are refused and nothing is sent (negative)", async () => {
    // Changed 2026-11-21 (architect's review): without candles the anti-chase guard cannot judge,
    // so the Set is refused instead of built with a warning.
    const lines: string[] = [];
    let hlRequests = 0;
    const cold = new HyperliquidLevelSource({
      log: () => undefined,
      fuelMap: { topN: 600, refreshMinutes: 5 },
      fetch: async () => {
        hlRequests++;
        return new Response("{}");
      },
    });
    const broken = {
      ...fakeAsterPublic,
      getKlines: async () => {
        throw new AsterApiError(503, null, "Service Unavailable", "/fapi/v3/klines");
      },
    };
    const planner = createPlanner({ aster: broken, levels: cold, bracketsFor: async () => null, random: () => 0.5, log: (l) => lines.push(l), warn: (l) => lines.push(l) });
    for (const [side, allowSeed] of [["sell", true], ["sell", false], ["buy", false]] as const) {
      const out = await planner.planFromBody({ symbol: "ETHUSDT", side, ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, allowSeed);
      expect(out.refusal).toMatchObject({ status: "refused: guard unavailable", hint: null, chase: null });
      expect(out.refusal!.message.split("\n")[0]).toBe("No Set now: the anti-chase check could not load Aster's hourly prices.");
      expect(out.refusal!.message.split("\n")[1]).toMatch(/^Error: .*503.*Service Unavailable/); // names the klines error
      expect(out.sources.fuelMap).toBeNull(); // the map was never asked for
      expect(out.sources.levels).toBeNull();
    }
    expect(hlRequests).toBe(0); // nothing sent to Hyperliquid
    expect(cold.requestsSent()).toEqual({ leaderboard: 0, info: 0 });
    expect(lines.filter((l) => l.includes("guard unavailable, refused"))).toHaveLength(3);
  });

  it("a thin map from the level source reaches the plan's reason (FAKE level source declaring 12 of 600)", async () => {
    const fakeThinLevels = {
      getLevels: async () => ({ levels: { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] }, report: {} as never }),
      ensureFuelMap: async () => ({}) as never,
      getFuelLevels: () => ({
        levels: [{ price: 1950.4, weightUsd: 2_500_000, positionSide: "short" as const }],
        status: "unavailable" as const,
        note: "thin: 12 of 600 accounts",
        reading: null,
        report: { addressesWithFreshAnswer: 12, addressesInSample: 600 } as never,
      }),
    };
    const planner = createPlanner({ aster: fakeAsterPublic, levels: fakeThinLevels, bracketsFor: async () => null, random: () => 0.5, log: () => undefined, warn: () => undefined });
    const { plan, sources } = await planner.planFromBody({ symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, false);
    expect(plan.takeProfit.reason).toContain(": liquidation map unavailable (thin: 12 of 600 accounts), so the sale sits just in front of 1,900");
    expect(plan.takeProfit.source).not.toBe("liquidation-cluster");
    expect(sources.fuelMap).toMatchObject({ status: "unavailable", note: "thin: 12 of 600 accounts" });
  });
});

/**
 * The planner with the anti-chase guard (A12) and the on-demand map (A10). HYBRID: the real
 * planner, plan builder, guard and level source; Aster is a FAKE object serving the captured
 * 2026-11-21 ETH candles; Hyperliquid a FAKE fetch over a SYNTHETIC 700-row leaderboard and the
 * captured clearinghouseState; time is a FakeClock. Trader levels come from a FAKE getLevels
 * (empty, instant) so only the liquidation map touches the fake fetch.
 */
describe("planner: anti-chase refusal and the on-demand map (A10, A12)", () => {
  const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  const ETH: SymbolRules = parseSymbolRules(fx("aster-exchangeInfo.json"), "ETHUSDT");
  const K1121 = fx("aster-klines-ETHUSDT-2026-11-21.json");
  const AS_OF = Date.parse("2026-11-20T19:13:41.906Z");
  const aster1121 = {
    getPrice: async (symbol: string) => ({ symbol, price: 1598.96, time: AS_OF }),
    getSymbolRules: async () => ETH,
    getDepth: async () => ({ bids: [{ price: 1598, weightUsd: 1000 }], asks: [{ price: 1600, weightUsd: 1000 }], skipped: 0 }),
    getKlines: async () => parseKlines(K1121).klines,
  };
  const LB700 = {
    leaderboardRows: Array.from({ length: 700 }, (_, i) => ({
      ethAddress: "0x" + (i + 1).toString(16).padStart(40, "0"),
      accountValue: "50000",
      windowPerformances: [["month", { pnl: "900", roi: "0.01", vlm: String(1e9 - i * 1000) }]],
    })),
  };
  const CS = fx("hl-clearinghouseState.json");

  function setup(opts: { hang?: boolean } = {}) {
    const clock = new FakeClock();
    clock.t = AS_OF;
    const calls: number[] = [];
    const f = async (url: string) => {
      if (url.includes("leaderboard")) return new Response(JSON.stringify(LB700));
      calls.push(clock.now() - AS_OF);
      if (opts.hang) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify(CS));
    };
    const real = new HyperliquidLevelSource({ fetch: f, now: clock.now, sleep: clock.sleep, log: () => undefined, fuelMap: { topN: 600, refreshMinutes: 5, quickN: 200, waitMs: 8000, ttlMinutes: 5, idleMinutes: 10 } });
    let ensured = 0;
    const levels = {
      getLevels: async () => ({ levels: { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] }, report: { fromCache: true } as never }), // FAKE, instant
      getFuelLevels: (coin: string, price?: number) => real.getFuelLevels(coin, price),
      ensureFuelMap: (o?: { wait?: boolean }) => {
        ensured++;
        return real.ensureFuelMap(o);
      },
    };
    const lines: string[] = [];
    const planner = createPlanner({ aster: aster1121, levels, bracketsFor: async () => null, random: () => 0.5, log: (l) => lines.push(l), warn: (l) => lines.push(l), now: clock.now });
    return { clock, calls, planner, lines, ensured: () => ensured };
  }
  const body = (side: "buy" | "sell") => ({ symbol: "ETHUSDT", side, ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" });

  it("a Short at the 2026-11-21 edge is refused before the map is asked for; the hint previews a Long, never placed by itself", async () => {
    const { planner, calls, ensured, lines } = setup();
    const out = await planner.planFromBody(body("sell"), false);
    expect(out.refusal).toMatchObject({
      status: "refused: chasing",
      message: "ETH fell 10.3% in a day, below its 3-day low.\nA Short here would follow the move at its edge.",
      hint: { label: "preview a Long instead", input: { side: "buy", symbol: "ETHUSDT", tpMode: "deserved", entryMode: "now" } },
    });
    expect(ensured()).toBe(0);
    expect(calls).toHaveLength(0); // no Hyperliquid request for a refused Set
    expect(out.sources.chase).toMatchObject({ chase: true, edge: true, fast: true });
    expect(lines.some((l) => l.startsWith("[chase] ETHUSDT Short from 1598.96 refused"))).toBe(true);
    expect(sourcesForLog(out.sources)).toMatchObject({ chase: { chase: true } });
  });

  it("(E8 b) the first preview reads exactly the quick map (200) inside the first 8 s; the counts say stage quick, 200 of 600", async () => {
    const { planner, calls, clock, ensured } = setup();
    const out = await planner.planFromBody(body("buy"), false);
    expect(out.refusal).toBeNull();
    expect(ensured()).toBe(1);
    await clock.advance(7_999);
    expect(calls.filter((t) => t < 8_000)).toHaveLength(200);
    expect(out.sources.fuelMap).toMatchObject({ status: "ok", stage: "quick", fresh: 200, addressesWithFreshAnswer: 200, addressesInSample: 600, reading: null });
    expect(out.plan.takeProfit.reason).toMatch(/^Long from 1,598.96; take profit \(sell\) at /);
    expect(out.plan.takeProfit.reason).not.toContain("still reading");
  });

  it("(E8 g) a quick map that never answers: the preview builds after 8 s, unavailable, and the reason ends with how far it got", async () => {
    const { planner, clock } = setup({ hang: true });
    let settled = false;
    const pending = planner.planFromBody(body("buy"), false).then((o) => {
      settled = true;
      return o;
    });
    await clock.flush();
    expect(settled).toBe(false); // waiting for the quick map
    await clock.advance(8_000);
    const out = await pending;
    expect(out.sources.fuelMap).toMatchObject({ status: "unavailable", stage: "reading", reading: "liquidation map: 0 of 600 accounts, still reading" });
    expect(out.plan.takeProfit.reason.endsWith("; liquidation map: 0 of 600 accounts, still reading")).toBe(true);
    expect(out.plan.takeProfit.reason).toMatch(/^Long from 1,598.96; take profit \(sell\) at /);
  });
});

/**
 * Budget sharing between the trader sample and the liquidation map (decision 2026-11-21) and the
 * stale-but-present account list. HYBRID: the real planner and ONE real HyperliquidLevelSource
 * (trader sample and map share its per-minute budget, as on the server) over a FAKE fetch: a
 * SYNTHETIC 700-row leaderboard (accounts of $200k, so the orders set fills) and the captured
 * clearinghouseState and frontendOpenOrders for every account. Aster is the FAKE object above
 * (synthetic candles); time is a FakeClock.
 */
describe("trader sample cached 5 minutes; the map is not starved; a stale account list never blocks", () => {
  const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  const ETH: SymbolRules = parseSymbolRules(fx("aster-exchangeInfo.json"), "ETHUSDT");
  const CS = fx("hl-clearinghouseState.json");
  const OO = fx("hl-frontendOpenOrders.json");
  const LB = {
    leaderboardRows: Array.from({ length: 700 }, (_, i) => ({
      ethAddress: "0x" + (i + 1).toString(16).padStart(40, "0"),
      accountValue: "200000",
      windowPerformances: [["month", { pnl: String(900_000 - i), roi: "0.01", vlm: String(1e9 - i * 1000) }]],
    })),
  };
  const closes = Array.from({ length: 73 }, (_, i) => 1805.73 * Math.exp(i % 2 ? 0.007 : 0));
  const asterFake = {
    getPrice: async (symbol: string) => ({ symbol, price: 1805.73, time: 1 }),
    getSymbolRules: async () => ETH,
    getDepth: async () => ({ bids: [{ price: 1800, weightUsd: 1000 }], asks: [{ price: 1810, weightUsd: 1000 }], skipped: 0 }),
    getKlines: async () => closes.map((c, i) => ({ openTime: 1_700_000_000_000 + i * 3_600_000, high: c * 1.001, low: c * 0.999, close: c })),
  };

  function setup(opts: { leaderboard?: "ok" | "hang"; disk?: string | null } = {}) {
    const clock = new FakeClock();
    clock.t = 1_800_000_000_000;
    const t0 = clock.t;
    const chs: number[] = [];
    const ords: number[] = [];
    let lbCalls = 0;
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes("leaderboard")) {
        lbCalls++;
        if (opts.leaderboard === "hang") return new Promise<Response>(() => undefined);
        return new Response(JSON.stringify(LB));
      }
      const type = JSON.parse(String(init?.body)).type;
      (type === "clearinghouseState" ? chs : ords).push(clock.now() - t0);
      return new Response(JSON.stringify(type === "clearinghouseState" ? CS : OO));
    };
    const lines: string[] = [];
    const src = new HyperliquidLevelSource({
      fetch: f,
      now: clock.now,
      sleep: clock.sleep,
      log: (l) => lines.push(l),
      minAccountValueUsd: 100_000,
      fuelMap: { topN: 600, refreshMinutes: 5, quickN: 200, waitMs: 8000, ttlMinutes: 5, idleMinutes: 10 },
      ...(opts.disk !== undefined ? { diskCache: { read: async () => opts.disk ?? null, write: async () => undefined } } : {}),
    });
    const planner = createPlanner({ aster: asterFake, levels: src, bracketsFor: async () => null, random: () => 0.5, log: (l) => lines.push(l), warn: (l) => lines.push(l), now: clock.now, sleep: clock.sleep });
    return { clock, t0, chs, ords, lines, src, planner, lbCalls: () => lbCalls };
  }
  const body = { symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" };

  it("previews every 30 s for 6 minutes: one trader read per 5 minutes; the quick map gets 200 of 200 and the full map 600 within 3 minutes", async () => {
    const { clock, t0, chs, ords, src, planner } = setup();
    const at: Record<number, number> = {};
    for (let i = 0; i <= 12; i++) {
      const out = await planner.planFromBody(body, false);
      if (i === 0) {
        expect(out.sources.fuelMap).toMatchObject({ stage: "quick", fresh: 200 }); // the quick map, untouched by the trader read
        expect(out.sources.levels).toMatchObject({ fromCache: false });
      }
      if (i === 2) expect(out.sources.levels).toMatchObject({ fromCache: true, ageMs: 60_000 });
      at[(clock.now() - t0) / 1000] = src.getFuelLevels("ETH").report.addressesWithFreshAnswer;
      await clock.advance(30_000);
    }
    // Trader reads, seen as bursts of frontendOpenOrders requests: at 0 s and at 5 minutes, nothing between.
    const bursts = [...new Set(ords.map((t) => Math.floor(t / 60_000)))];
    expect(bursts).toEqual([0, 5]);
    // The map: 200 of the quick map answered at once, at least 540 of 600 within 3 minutes.
    expect(chs.filter((t) => t === 0).length).toBeGreaterThanOrEqual(200);
    expect(at[0]).toBeGreaterThanOrEqual(190);
    expect(at[180]).toBeGreaterThanOrEqual(540);
    expect(at[60]).toBeLessThanOrEqual(at[120]!);
  });

  it("an expired account list (disk copy 7 hours old) is used at once while a fresh one downloads", async () => {
    const old = JSON.stringify({ at: 1_800_000_000_000 - 7 * 3_600_000, key: "", traders: [], fuelTraders: [] });
    // Build the matching key from a source with the same options, then write the copy with it.
    const probe = setup({ disk: null });
    await probe.src.getTopTraders();
    const keyed = JSON.parse(old);
    keyed.key = (probe.src as unknown as { selectionKey(): string }).selectionKey();
    keyed.traders = (await probe.src.getTopTraders()).slice(0, 50);
    keyed.fuelTraders = (await probe.src.getFuelTraders()).slice(0, 600);
    const { src, lines, lbCalls, clock } = setup({ leaderboard: "hang", disk: JSON.stringify(keyed) });
    const traders = await src.getTopTraders(); // returns although the download never answers
    expect(traders).toHaveLength(50);
    await clock.flush();
    expect(lbCalls()).toBe(1); // the fresh download started in the background
    expect(lines.some((l) => /leaderboard copy is 420 min old: using it while a fresh one downloads/.test(l))).toBe(true);
  });

  it("no copy of the account list at all: the first preview still returns after 8 s and the reason says the list is downloading", async () => {
    const { clock, planner } = setup({ leaderboard: "hang" });
    let settled = false;
    const pending = planner.planFromBody(body, false).then((o) => {
      settled = true;
      return o;
    });
    await clock.flush();
    expect(settled).toBe(false);
    await clock.advance(8_000);
    const out = await pending;
    expect(out.sources.levels).toEqual({ unavailable: "traders' levels not ready after 8 s: the account list is still downloading (no cached copy yet)" });
    expect(out.plan.takeProfit.reason.endsWith("; liquidation map: the account list is still downloading (no cached copy yet), 0 of 600 accounts read")).toBe(true);
    expect(out.plan.takeProfit.reason).toMatch(/^Long from 1,805.73; take profit \(sell\) at /);
  });
});

/**
 * Map first in every mode (architect's review 2026-11-21): a cold Nearby preview. HYBRID: the real
 * planner and one real HyperliquidLevelSource (map and trader sample share its budget) over a
 * FAKE fetch with SYNTHETIC per-account answers: every account holds one ETH short liquidated
 * between 1,950 and 1,965 ($200k each, so the window has a broad crowd) and one ETH bid at 1,800
 * ($18k, for Nearby). Aster is a FAKE object with synthetic calm candles. Time is a FakeClock.
 */
describe("map first for Nearby: a cold Nearby preview is not starved", () => {
  const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  const ETH: SymbolRules = parseSymbolRules(fx("aster-exchangeInfo.json"), "ETHUSDT");
  const LB = {
    leaderboardRows: Array.from({ length: 700 }, (_, i) => ({
      ethAddress: "0x" + (i + 1).toString(16).padStart(40, "0"),
      accountValue: "200000",
      windowPerformances: [["month", { pnl: String(900_000 - i), roi: "0.01", vlm: String(1e9 - i * 1000) }]],
    })),
  };
  const closes = Array.from({ length: 73 }, (_, i) => 1805.73 * Math.exp(i % 2 ? 0.007 : 0));
  const asterFake = {
    getPrice: async (symbol: string) => ({ symbol, price: 1805.73, time: 1 }),
    getSymbolRules: async () => ETH,
    getDepth: async () => ({ bids: [{ price: 1800, weightUsd: 1000 }], asks: [{ price: 1810, weightUsd: 1000 }], skipped: 0 }),
    getKlines: async () => closes.map((c, i) => ({ openTime: 1_700_000_000_000 + i * 3_600_000, high: c * 1.001, low: c * 0.999, close: c })),
  };

  it("cold Nearby Long: the quick map gets at least 190 of 200 inside 8 s and the plan uses a liquidation cluster", async () => {
    const clock = new FakeClock();
    clock.t = 1_800_000_000_000;
    const t0 = clock.t;
    const chs: number[] = [];
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes("leaderboard")) return new Response(JSON.stringify(LB));
      const b = JSON.parse(String(init?.body));
      const idx = parseInt(String(b.user).slice(2), 16);
      if (b.type === "clearinghouseState") {
        chs.push(clock.now() - t0);
        return new Response(JSON.stringify({ assetPositions: [{ position: { coin: "ETH", szi: "-110", entryPx: "1800", liquidationPx: String(1950 + (idx % 300) * 0.05), positionValue: "200000" } }] }));
      }
      return new Response(JSON.stringify([{ coin: "ETH", side: "B", limitPx: "1800", sz: "10", orderType: "Limit", isTrigger: false, reduceOnly: false }]));
    };
    const src = new HyperliquidLevelSource({ fetch: f, now: clock.now, sleep: clock.sleep, log: () => undefined, minAccountValueUsd: 100_000, fuelMap: { topN: 600, refreshMinutes: 5, quickN: 200, waitMs: 8000, ttlMinutes: 5, idleMinutes: 10 } });
    const planner = createPlanner({ aster: asterFake, levels: src, bracketsFor: async () => null, random: () => 0.5, log: () => undefined, warn: () => undefined, now: clock.now, sleep: clock.sleep });
    const out = await planner.planFromBody({ symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "nearby" }, false);
    expect(out.refusal).toBeNull();
    expect(chs.filter((t) => t < 8_000).length).toBeGreaterThanOrEqual(190);
    expect(out.sources.fuelMap!.fresh).toBeGreaterThanOrEqual(190);
    expect(out.sources.fuelMap).toMatchObject({ status: "ok", stage: "quick" });
    expect(out.plan.entry.usedMode).toBe("nearby"); // the trader read still found the bids
    expect(out.plan.takeProfit.source).toBe("liquidation-cluster");
    expect(out.plan.takeProfit.reason).toMatch(/^Long from [\d,.]+; take profit \(sell\) at .* a cluster where \$[\d.]+M of \d+ accounts' shorts get liquidated/);
  });
});
