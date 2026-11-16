/**
 * Server-side pure parts: config validation (REAL, plain objects, never the real environment)
 * and plan-to-Aster-order conversion (REAL).
 */
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../server/config";
import { planToOtoPairs } from "../server/execute";
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

describe("plan -> Aster OTO legs", () => {
  const plan = buildSetPlan({
    input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, tpMode: "deserved", entryMode: "nearby" },
    currentPrice: 64000,
    rules: BTC,
    levels: { limitLevels: [{ price: 63900, weightUsd: 1e6, side: "buy" }], takeProfitLevels: [], liquidationLevels: [] },
    random: () => 0.5,
  });
  it("one-way mode: LIMIT GTC entry, reduce-only TAKE_PROFIT_MARKET on mark price, driven by the entry", () => {
    const [p] = planToOtoPairs(plan, BTC, false);
    expect(p!.entry).toMatchObject({ strategySubId: "1", type: "LIMIT", side: "BUY", timeInForce: "GTC", price: "63900.0", quantity: "0.023" });
    expect(p!.takeProfit).toMatchObject({
      strategySubId: "2",
      type: "TAKE_PROFIT_MARKET",
      side: "SELL",
      reduceOnly: "true",
      workingType: "MARK_PRICE",
      firstDrivenId: "1",
      firstDrivenOn: "PARTIALLY_FILLED_OR_FILLED",
      firstTrigger: "PLACE_ORDER",
      quantity: "0.023",
    });
    expect(p!.takeProfit.price).toBeUndefined(); // TAKE_PROFIT_MARKET must not carry price
  });
  it("hedge mode: positionSide LONG and no reduceOnly", () => {
    const [p] = planToOtoPairs(plan, BTC, true);
    expect(p!.entry.positionSide).toBe("LONG");
    expect(p!.takeProfit.positionSide).toBe("LONG");
    expect(p!.takeProfit.reduceOnly).toBeUndefined();
  });
  it("refuses a price off the tick before signing (negative)", () => {
    const broken = { ...plan, orders: { ...plan.orders, entries: [{ type: "LIMIT" as const, price: 63900.05, qty: 0.023 }] } };
    expect(() => planToOtoPairs(broken, BTC, false)).toThrow(/off the tick/);
  });
});
