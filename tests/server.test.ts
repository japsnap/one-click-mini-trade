/**
 * Server-side pure parts: config validation (REAL, plain objects, never the real environment)
 * and plan-to-Aster-order conversion (REAL).
 */
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../server/config";
import { planToSetLegs, reconcileStop } from "../server/execute";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";
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
  it("one-way mode: LIMIT GTC entry; reduce-only TP and STOP_MARKET on mark price, both driven by the entry, each cancelling the other", () => {
    const [l] = planToSetLegs(plan, BTC, false);
    // Nearby with r = 0.5: middle of bucket 3 (0.15%-0.2%) = 63,888, nudge 0 -> 63,888.0
    expect(l!.entry).toMatchObject({ strategySubId: "1", type: "LIMIT", side: "BUY", timeInForce: "GTC", price: "63888.0", quantity: "0.023" });
    expect(l!.takeProfit).toMatchObject({
      strategySubId: "2",
      type: "TAKE_PROFIT_MARKET",
      side: "SELL",
      reduceOnly: "true",
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
      reduceOnly: "true",
      workingType: "MARK_PRICE",
      firstDrivenId: "1",
      secondDrivenId: "2",
      secondTrigger: "CANCEL_ORDER",
      quantity: "0.023",
      stopPrice: plan.stop.price.toFixed(1),
    });
    expect(Number(l!.stop.stopPrice)).toBeLessThan(63888);
    expect(Number(l!.stop.stopPrice)).toBeGreaterThan(plan.liquidationPrice);
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

describe("reconcileStop after a fill (HYBRID: fake fetch records requests; no network)", () => {
  // Public demo key from the Aster V3 doc.
  const key = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1" as const;
  const s = privateKeySigner(key);
  const plan = buildSetPlan({
    input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" },
    currentPrice: 64000,
    rules: BTC,
    levels: { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] },
    random: () => 0.5,
  });
  function client(positionRisk: unknown) {
    const calls: Array<{ url: string; body: string }> = [];
    const c = new AsterClient({
      fetch: async (url, init) => {
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.includes("/fapi/v3/positionRisk")) return new Response(JSON.stringify(positionRisk));
        return new Response(JSON.stringify({ orderId: 1 }));
      },
      auth: { user: ("0x" + "a".repeat(40)) as `0x${string}`, signer: s.address, sign: s.sign },
      builder: { address: ("0x" + "b".repeat(40)) as `0x${string}`, feeRate: "0.0001" },
    });
    return { c, calls };
  }
  const row = (liq: string) => [{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: "0.004", entryPrice: "64000", liquidationPrice: liq, markPrice: "64000" }];

  it("moves the stop to 85% of the venue's real liquidation distance, reduce-only, with builder fields", async () => {
    const { c, calls } = client(row("62100")); // venue says 1,900 away
    const r = await reconcileStop(c, plan, BTC, { currentStopPrice: plan.stop.price, currentStopOrderId: "77", hedgeMode: false, apply: true });
    expect(r.changed).toBe(true);
    expect(r.target).toBe(62385); // 64,000 - 0.85 x 1,900
    const placed = calls.find((x) => x.url.endsWith("/fapi/v3/order") && x.body.includes("STOP_MARKET"))!;
    expect(placed.body).toContain("type=STOP_MARKET");
    expect(placed.body).toContain("stopPrice=62385.0");
    expect(placed.body).toContain("reduceOnly=true");
    expect(placed.body).toContain("builder=0x" + "b".repeat(40));
    expect(placed.body).toContain("feeRate=0.0001");
    expect(calls.some((x) => x.body.includes("orderId=77"))).toBe(true); // the old stop is cancelled
  });
  it("keeps the stop and says why when the venue reports no liquidation price, or the planned one is within a tick (negative)", async () => {
    const none = await reconcileStop(client(row("0")).c, plan, BTC, { currentStopPrice: plan.stop.price, hedgeMode: false, apply: true });
    expect(none.changed).toBe(false);
    expect(none.reason).toMatch(/no liquidation price/);
    const same = client(row(String(plan.liquidationPrice)));
    const r = await reconcileStop(same.c, plan, BTC, { currentStopPrice: plan.stop.price, hedgeMode: false, apply: true });
    expect(r.changed).toBe(false);
    expect(same.calls.filter((x) => x.url.endsWith("/fapi/v3/order"))).toHaveLength(0);
    const flat = await reconcileStop(client([{ symbol: "BTCUSDT", positionAmt: "0" }]).c, plan, BTC, { currentStopPrice: 1, hedgeMode: false, apply: true });
    expect(flat.reason).toMatch(/no open position/);
  });
});
