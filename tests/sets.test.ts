/**
 * Many Sets at once (2026-11-16): the Set ledger (src/core/ledger.ts), the per-Set stop
 * (src/core/stop.ts) and the executor (server/execute.ts).
 *
 * Categories (rules/testing.md):
 *  - REAL: pure ledger, stop and parse functions; assertions on returned ledger state,
 *    actions and prices.
 *  - HYBRID: executor tests run the real AsterClient (real EIP-712 signatures) against a
 *    stateful FAKE Aster (fakeAster below: no network). They verify the exact requests the
 *    executor sends (subOrderList legs, updateStrategyOrder bodies, cancels, leverage) and
 *    the ledger saved afterwards. They do NOT prove Aster accepts these requests: that
 *    needs the first live $10 Set (README "Open items").
 */
import { describe, expect, it } from "vitest";
import {
  applyOrderUpdate,
  ASTER_CLIENT_ORDER_ID,
  ASTER_CLIENT_STRATEGY_ID,
  createSetRecord,
  emptyLedger,
  filledQty,
  newSetId,
  parseSetClientOrderId,
  reconcile,
  setClientOrderId,
  setPnl,
  setStrategyClientId,
  stopCapFor,
  symbolLeverageTarget,
  checkMarginForSet,
  type OrderUpdate,
  type SetLedger,
} from "../src/core/ledger";
import { setStopPrice, stopFromTicketLoss } from "../src/core/stop";
import { buildSetPlan, withSymbolLeverage, type SetPlan } from "../src/core/plan";
import { seededRandom, type SymbolRules } from "../src/core/types";
import { AsterClient, parseOrderTradeUpdate, privateKeySigner } from "../src/exchange/aster";
import { executeLive, handleOrderUpdate, memoryLedgerStore, reconcileSymbol } from "../server/execute";

const BTC: SymbolRules = { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
const NO_LEVELS = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };
// Public demo key from the Aster V3 doc (signs real EIP-712 messages; never a real account).
const DEMO_KEY = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1" as const;

function nowPlan(side: "buy" | "sell", leverage: 30 | 50, price = 64000): SetPlan {
  return buildSetPlan({
    input: { symbol: "BTCUSDT", side, ticketUsd: 10, leverage, tpMode: "deserved", entryMode: "now" },
    currentPrice: price,
    rules: BTC,
    levels: NO_LEVELS,
    random: () => 0.5,
  });
}

/** One fill or status event, shaped like parseOrderTradeUpdate's output. */
function ev(clientOrderId: string, status: string, qty = 0, price = 0, tradeId: string | null = null, commission = 0): OrderUpdate {
  return {
    symbol: "BTCUSDT",
    clientOrderId,
    orderId: null,
    status,
    executionType: qty > 0 ? "TRADE" : status === "CANCELED" ? "CANCELED" : "NEW",
    lastFilledQty: qty,
    lastFilledPrice: price,
    commission,
    commissionAsset: commission ? "USDT" : null,
    tradeId: tradeId ?? (qty > 0 ? `${clientOrderId}:${qty}:${price}` : null),
    time: 1,
  };
}

interface Row {
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: number;
  entryPrice?: number;
  liquidationPrice?: number;
}

/**
 * A stateful fake of the Aster endpoints the executor uses. Records every request with its
 * decoded parameters. positionRisk answers state.rows (with the symbol leverage on each
 * row, as the doc shows); POST /fapi/v3/leverage changes state.leverage.
 */
function fakeAster(init: { dual: boolean; leverage: number; rows: Row[]; wallet?: number; available?: number }) {
  const state = { ...init, wallet: init.wallet ?? 1000, available: init.available ?? 1000 };
  const calls: Array<{ method: string; path: string; params: URLSearchParams }> = [];
  let nextStrategy = 100;
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
  const fetch = async (url: string, reqInit?: RequestInit) => {
    const u = new URL(url);
    const method = reqInit?.method ?? "GET";
    const params = new URLSearchParams(method === "GET" ? u.search.slice(1) : String(reqInit?.body ?? ""));
    calls.push({ method, path: u.pathname, params });
    switch (`${method} ${u.pathname}`) {
      case "GET /fapi/v3/positionSide/dual":
        return json({ dualSidePosition: state.dual });
      case "GET /fapi/v3/positionRisk":
        return json(
          state.rows.map((r) => ({
            symbol: "BTCUSDT",
            positionSide: r.positionSide,
            positionAmt: String(r.positionAmt),
            entryPrice: String(r.entryPrice ?? 0),
            liquidationPrice: String(r.liquidationPrice ?? 0),
            markPrice: "64000",
            leverage: String(state.leverage),
            marginType: "isolated",
          })),
        );
      case "GET /fapi/v3/balance":
        return json([{ asset: "USDT", balance: String(state.wallet), availableBalance: String(state.available) }]);
      case "POST /fapi/v3/leverage":
        state.leverage = Number(params.get("leverage"));
        return json({ leverage: state.leverage, symbol: "BTCUSDT" });
      case "POST /fapi/v3/placeStrategyOrder":
        return json({ strategyId: nextStrategy++, clientStrategyId: params.get("clientStrategyId"), strategyType: "OTOCO", strategyStatus: "WORKING", failureCode: 0 });
      case "POST /fapi/v3/updateStrategyOrder":
        return json([{ strategyId: Number(params.get("strategyId")), updateStatus: "SUCCESS", failureCode: 0 }]);
      case "DELETE /fapi/v3/order":
        return json({ status: "CANCELED", clientOrderId: params.get("origClientOrderId") });
      default:
        return json({ code: -1, msg: `fake has no ${method} ${u.pathname}` }, 404);
    }
  };
  const s = privateKeySigner(DEMO_KEY);
  const client = new AsterClient({ fetch, auth: { user: ("0x" + "a".repeat(40)) as `0x${string}`, signer: s.address, sign: s.sign } });
  const of = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  return { client, state, calls, of };
}

/** The three legs of the n-th placeStrategyOrder request. */
function legsOf(fake: ReturnType<typeof fakeAster>, n: number) {
  const c = fake.of("POST", "/fapi/v3/placeStrategyOrder")[n]!;
  return { clientStrategyId: c.params.get("clientStrategyId"), legs: JSON.parse(c.params.get("subOrderList")!) as Array<Record<string, string>> };
}

// ---------------------------------------------------------------------------

describe("Set ids (REAL)", () => {
  it("fit Aster's client id rules and read back; foreign and liquidation ids are not Sets (negative)", () => {
    const id = newSetId(Date.UTC(2026, 10, 16), seededRandom(7));
    expect(id).toMatch(/^set_[a-z0-9]{13}$/);
    for (const role of ["entry", "takeProfit", "stop"] as const) {
      const c = setClientOrderId(id, 5, role);
      expect(c.length).toBeLessThanOrEqual(36);
      expect(ASTER_CLIENT_ORDER_ID.test(c)).toBe(true);
      expect(parseSetClientOrderId(c)).toEqual({ setId: id, legIndex: 5, role });
    }
    expect(ASTER_CLIENT_STRATEGY_ID.test(setStrategyClientId(id, 5))).toBe(true);
    expect(parseSetClientOrderId("web_8f2kx")).toBeNull();
    expect(parseSetClientOrderId("autoclose-1596107620040000020")).toBeNull();
    expect(parseSetClientOrderId(`${id}-1X`)).toBeNull();
    expect(() => setClientOrderId("set_" + "a".repeat(40), 1, "entry")).toThrow(/Aster's rule/);
  });
});

describe("Buy and Sell Set on BTC at the same time", () => {
  it("one-way mode: plain opposite exits, the net equals the sum of Sets, one Set's take-profit cancels only its own stop (HYBRID)", async () => {
    const fake = fakeAster({ dual: false, leverage: 20, rows: [{ positionSide: "BOTH", positionAmt: 0 }] });
    const store = memoryLedgerStore();
    const buy = await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_buy01" });
    expect(buy.ok).toBe(true);
    const b = legsOf(fake, 0);
    expect(b.clientStrategyId).toBe("set_buy01-1");
    expect(b.legs.map((l) => [l.side, l.type, l.clientOrderId])).toEqual([
      ["BUY", "MARKET", "set_buy01-1E"],
      ["SELL", "TAKE_PROFIT_MARKET", "set_buy01-1T"],
      ["SELL", "STOP_MARKET", "set_buy01-1S"],
    ]);
    for (const l of b.legs) {
      expect(l.reduceOnly).toBeUndefined(); // decision 2: never reduce-only in one-way mode
      expect(l.positionSide).toBeUndefined();
      expect(l.quantity).toBe("0.004"); // $10 x 30 / 64,000 = 0.00468 -> 0.004
    }

    // Buy entry fills; the exchange now shows the long.
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62200 }];
    await handleOrderUpdate(fake.client, ev("set_buy01-1E", "FILLED", 0.004, 64000), BTC, { store });

    const sell = await executeLive(fake.client, nowPlan("sell", 30, 64010), BTC, { store, setId: "set_sel01" });
    expect(sell.ok).toBe(true);
    const s = legsOf(fake, 1);
    expect(s.legs.map((l) => [l.side, l.type])).toEqual([
      ["SELL", "MARKET"],
      ["BUY", "TAKE_PROFIT_MARKET"],
      ["BUY", "STOP_MARKET"],
    ]);
    expect(s.legs.every((l) => l.reduceOnly === undefined)).toBe(true);
    expect(fake.of("POST", "/fapi/v3/leverage").map((c) => c.params.get("leverage"))).toEqual(["30"]); // set once, kept for the Sell

    // Sell entry fills: one-way nets to zero, and that is exactly the Sets' sum.
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0 }];
    await handleOrderUpdate(fake.client, ev("set_sel01-1E", "FILLED", 0.004, 64010), BTC, { store });
    const r1 = await reconcileSymbol(fake.client, BTC, { store, now: () => 10_000 });
    expect(r1.mismatches).toEqual([]);
    expect(r1.cancelled).toBe(0);

    // The Buy Set's take-profit fills: only ITS stop is cancelled; the Sell Set keeps both exits.
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: -0.004, entryPrice: 64010, liquidationPrice: 65800 }];
    const deletesBefore = fake.of("DELETE", "/fapi/v3/order").length;
    await handleOrderUpdate(fake.client, ev("set_buy01-1T", "FILLED", 0.004, 66000), BTC, { store });
    const cancels = fake.of("DELETE", "/fapi/v3/order").slice(deletesBefore).map((c) => c.params.get("origClientOrderId"));
    expect(cancels).toEqual(["set_buy01-1S"]);
    const l = store.current();
    expect(l.sets.find((x) => x.id === "set_buy01")!.status).toBe("closed");
    const sellSet = l.sets.find((x) => x.id === "set_sel01")!;
    expect(sellSet.status).toBe("open");
    expect(sellSet.legs[0]!.takeProfit.qty).toBe(0.004);
    expect(sellSet.legs[0]!.stop.qty).toBe(0.004);
    expect((await reconcileSymbol(fake.client, BTC, { store, now: () => 20_000 })).mismatches).toEqual([]);
    expect(fake.of("POST", "/fapi/v3/order")).toHaveLength(0); // never a plain order placed
  });

  it("hedge mode: LONG and SHORT legs, no reduceOnly; a hand-close of the short only closes the Sell Set (HYBRID)", async () => {
    const fake = fakeAster({ dual: true, leverage: 30, rows: [{ positionSide: "LONG", positionAmt: 0 }, { positionSide: "SHORT", positionAmt: 0 }] });
    const store = memoryLedgerStore();
    expect((await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_hbuy1" })).ok).toBe(true);
    expect((await executeLive(fake.client, nowPlan("sell", 30), BTC, { store, setId: "set_hsel1" })).ok).toBe(true);
    expect(legsOf(fake, 0).legs.map((l) => l.positionSide)).toEqual(["LONG", "LONG", "LONG"]);
    expect(legsOf(fake, 1).legs.map((l) => l.positionSide)).toEqual(["SHORT", "SHORT", "SHORT"]);
    for (const n of [0, 1]) expect(legsOf(fake, n).legs.every((l) => l.reduceOnly === undefined)).toBe(true);
    expect(fake.of("POST", "/fapi/v3/leverage")).toHaveLength(0); // the symbol already stood at 30x

    fake.state.rows = [
      { positionSide: "LONG", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62200 },
      { positionSide: "SHORT", positionAmt: -0.004, entryPrice: 64000, liquidationPrice: 65800 },
    ];
    await handleOrderUpdate(fake.client, ev("set_hbuy1-1E", "FILLED", 0.004, 64000), BTC, { store });
    await handleOrderUpdate(fake.client, ev("set_hsel1-1E", "FILLED", 0.004, 64000), BTC, { store });
    expect((await reconcileSymbol(fake.client, BTC, { store, now: () => 1_000 })).mismatches).toEqual([]);

    // The user closes the short by hand in Blackboard's app.
    fake.state.rows = [{ positionSide: "LONG", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62200 }, { positionSide: "SHORT", positionAmt: 0 }];
    await reconcileSymbol(fake.client, BTC, { store, now: () => 2_000 });
    const r = await reconcileSymbol(fake.client, BTC, { store, now: () => 8_000 });
    expect(r.mismatches).toEqual([{ key: "SHORT", expected: 0.004, actual: 0 }]);
    expect(fake.of("DELETE", "/fapi/v3/order").map((c) => c.params.get("origClientOrderId")).sort()).toEqual(["set_hsel1-1S", "set_hsel1-1T"]);
    const l = store.current();
    expect(l.sets.find((x) => x.id === "set_hsel1")!.status).toBe("closed-outside");
    expect(l.sets.find((x) => x.id === "set_hbuy1")!.status).toBe("open");
  });
});

describe("Two Buy Sets at 30x and 50x on BTC", () => {
  it("leverage is raised to 50, never lowered while Sets are open, and a later 30x Set's stop sits in front of the 50x liquidation (HYBRID)", async () => {
    const fake = fakeAster({ dual: false, leverage: 20, rows: [{ positionSide: "BOTH", positionAmt: 0 }] });
    const store = memoryLedgerStore();
    await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_l30a" });
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62200 }];
    await handleOrderUpdate(fake.client, ev("set_l30a-1E", "FILLED", 0.004, 64000), BTC, { store });
    await executeLive(fake.client, nowPlan("buy", 50), BTC, { store, setId: "set_l50a" });
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.011, entryPrice: 64000, liquidationPrice: 62900 }];
    await handleOrderUpdate(fake.client, ev("set_l50a-1E", "FILLED", 0.007, 64000), BTC, { store });
    const third = nowPlan("buy", 30);
    await executeLive(fake.client, third, BTC, { store, setId: "set_l30b" });

    expect(fake.of("POST", "/fapi/v3/leverage").map((c) => c.params.get("leverage"))).toEqual(["30", "50"]); // the third Set changed nothing
    expect(fake.state.leverage).toBe(50);
    // Sizing stays the Set's own: $10 x 50 = $500 -> 0.007 BTC; $10 x 30 -> 0.004.
    expect(legsOf(fake, 1).legs[0]!.quantity).toBe("0.007");
    expect(legsOf(fake, 2).legs[0]!.quantity).toBe("0.004");
    // The third (30x) Set's stop = 85% of the liquidation estimated at the symbol's 50x.
    const at50 = withSymbolLeverage(third, BTC, 50).orders.stops[0]!.stopPrice;
    expect(Number(legsOf(fake, 2).legs[2]!.stopPrice)).toBe(at50);
    expect(at50).toBeGreaterThan(third.orders.stops[0]!.stopPrice); // nearer the entry than the 30x stop
  });

  it("symbolLeverageTarget: max of open Sets, never lower while open, follows the Set when none are open (REAL)", () => {
    let ledger: SetLedger = emptyLedger();
    expect(symbolLeverageTarget({ ledger, symbol: "BTCUSDT", newLeverage: 30, currentLeverage: 75 })).toMatchObject({ target: 30, change: true });
    ledger = { ...ledger, sets: [{ ...createSetRecord({ id: "set_x1", symbol: "BTCUSDT", side: "buy", leverage: 30, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "MARKET", qty: 0.004, price: null, takeProfitPrice: 66000, stopPrice: 62400 }] }) }] };
    expect(symbolLeverageTarget({ ledger, symbol: "BTCUSDT", newLeverage: 50, currentLeverage: 30 })).toMatchObject({ target: 50, change: true });
    expect(symbolLeverageTarget({ ledger, symbol: "BTCUSDT", newLeverage: 30, currentLeverage: 50 })).toMatchObject({ target: 50, change: false });
    expect(symbolLeverageTarget({ ledger, symbol: "ETHUSDT", newLeverage: 30, currentLeverage: 50 })).toMatchObject({ target: 30, change: true }); // other symbol, no Sets
  });
});

/** Two filled Buy Sets A (30x, 0.004) and B (50x, 0.007) in one-way mode. */
async function twoFilledBuys() {
  const fake = fakeAster({ dual: false, leverage: 30, rows: [{ positionSide: "BOTH", positionAmt: 0 }] });
  const store = memoryLedgerStore();
  await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_aaa" });
  fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62200 }];
  await handleOrderUpdate(fake.client, ev("set_aaa-1E", "FILLED", 0.004, 64000), BTC, { store });
  await executeLive(fake.client, nowPlan("buy", 50), BTC, { store, setId: "set_bbb" });
  fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.011, entryPrice: 64000, liquidationPrice: 62900 }];
  await handleOrderUpdate(fake.client, ev("set_bbb-1E", "FILLED", 0.007, 64000), BTC, { store });
  return { fake, store };
}

describe("One Set's stop fills while the other stays open", () => {
  it("cancels only that Set's take-profit; the other Set keeps its exits at its own quantity (HYBRID)", async () => {
    const { fake, store } = await twoFilledBuys();
    const before = store.current().sets.find((s) => s.id === "set_bbb")!.legs[0]!;
    const deletes = fake.of("DELETE", "/fapi/v3/order").length;
    const aStop = store.current().sets.find((s) => s.id === "set_aaa")!.legs[0]!.stop.stopPrice;
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.007, entryPrice: 64000, liquidationPrice: 62900 }];
    const out = await handleOrderUpdate(fake.client, ev("set_aaa-1S", "FILLED", 0.004, aStop), BTC, { store });
    expect(out.actions.filter((a) => a.kind === "cancel").map((a) => a.kind === "cancel" && a.clientOrderId)).toEqual(["set_aaa-1T"]);
    expect(fake.of("DELETE", "/fapi/v3/order").slice(deletes).map((c) => c.params.get("origClientOrderId"))).toEqual(["set_aaa-1T"]);
    const l = store.current();
    const a = l.sets.find((s) => s.id === "set_aaa")!;
    const b = l.sets.find((s) => s.id === "set_bbb")!;
    expect(a.status).toBe("closed");
    expect(setPnl(a).grossPnlUsd).toBeCloseTo(-0.004 * (64000 - aStop), 2);
    expect(b.status).toBe("open");
    expect(b.legs[0]!.takeProfit.qty).toBe(0.007);
    expect(b.legs[0]!.stop.qty).toBe(0.007);
    expect(b.legs[0]!.takeProfit.stopPrice).toBe(before.takeProfit.stopPrice);
    expect((await reconcileSymbol(fake.client, BTC, { store, now: () => 5_000 })).mismatches).toEqual([]);
  });
});

describe("The user closes the position by hand in Blackboard's app", () => {
  it("a confirmed mismatch cancels every Set exit on the symbol, marks them closed outside the Set, and places nothing (HYBRID)", async () => {
    const { fake, store } = await twoFilledBuys();
    const placesBefore = fake.of("POST", "/fapi/v3/placeStrategyOrder").length;
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0 }];
    const first = await reconcileSymbol(fake.client, BTC, { store, now: () => 1_000 });
    expect(first.cancelled).toBe(0); // seen once: wait (a fill event may still be on its way)
    expect(first.log.some((x) => x.level === "warn")).toBe(true);
    const second = await reconcileSymbol(fake.client, BTC, { store, now: () => 7_000 });
    expect(second.mismatches).toEqual([{ key: "BOTH", expected: 0.011, actual: 0 }]);
    expect(second.log.some((x) => x.level === "error" && /MISMATCH confirmed/.test(x.message))).toBe(true);
    expect(fake.of("DELETE", "/fapi/v3/order").map((c) => c.params.get("origClientOrderId")).sort()).toEqual(["set_aaa-1S", "set_aaa-1T", "set_bbb-1S", "set_bbb-1T"]);
    expect(store.current().sets.map((s) => s.status)).toEqual(["closed-outside", "closed-outside"]);
    expect(fake.of("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(placesBefore);
    expect(fake.of("POST", "/fapi/v3/order")).toHaveLength(0);
    expect(setPnl(store.current().sets[0]!).profitShare.blackboardUsd).toBe(0); // no share on an outside close
  });

  it("a mismatch that clears before its second sight cancels nothing (negative)", async () => {
    const { fake, store } = await twoFilledBuys();
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.004 }];
    await reconcileSymbol(fake.client, BTC, { store, now: () => 1_000 });
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.011, entryPrice: 64000, liquidationPrice: 62900 }];
    const r = await reconcileSymbol(fake.client, BTC, { store, now: () => 9_000 });
    expect(r.cancelled).toBe(0);
    expect(fake.of("DELETE", "/fapi/v3/order")).toHaveLength(0);
    expect(store.current().suspects).toEqual({});
    expect(store.current().sets.every((s) => s.status === "open")).toBe(true);
  });
});

describe("Per-Set profit with merged positions (REAL)", () => {
  it("each Set's profit comes from its own fills, not the merged average; the share is 5% + 5% of the net win only", () => {
    let ledger = emptyLedger();
    const mk = (id: string, qty: number) =>
      createSetRecord({ id, symbol: "BTCUSDT", side: "buy", leverage: 30, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "MARKET", qty, price: null, takeProfitPrice: 66000, stopPrice: 63000 }] });
    ledger.sets.push(mk("set_pa", 0.004), mk("set_pb", 0.002));
    const steps: OrderUpdate[] = [
      ev("set_pa-1E", "FILLED", 0.004, 64000, "t1", 0.1),
      ev("set_pb-1E", "FILLED", 0.002, 65000, "t2", 0.05),
      ev("set_pa-1T", "FILLED", 0.004, 66000, "t3", 0.1),
      ev("set_pb-1S", "FILLED", 0.002, 63500, "t4", 0.05),
    ];
    for (const u of steps) ledger = applyOrderUpdate(ledger, u, 100).ledger;
    const a = setPnl(ledger.sets[0]!);
    const b = setPnl(ledger.sets[1]!);
    expect(a).toMatchObject({ status: "closed", final: true, grossPnlUsd: 8, commissionUsd: 0.2, netPnlUsd: 7.8 }); // 0.004 x (66,000 - 64,000)
    expect(b).toMatchObject({ status: "closed", final: true, grossPnlUsd: -3, netPnlUsd: -3.1 }); // 0.002 x (63,500 - 65,000)
    // Aster's merged average entry is 64,333.33; realizedPnl on A's close would say 6.67, the wrong figure for A.
    const mergedAvg = (0.004 * 64000 + 0.002 * 65000) / 0.006;
    expect(Math.round(0.004 * (66000 - mergedAvg) * 100) / 100).toBe(6.67);
    expect(a.profitShare).toEqual({ grossPnlUsd: 7.8, blackboardUsd: 0.39, traderUsd: 0.39, userNetUsd: 7.02 });
    expect(b.profitShare.blackboardUsd).toBe(0);
  });

  it("a fill delivered twice counts once; a winner smaller than its fees pays no share (negative)", () => {
    let ledger = emptyLedger();
    ledger.sets.push(
      createSetRecord({ id: "set_dup", symbol: "BTCUSDT", side: "sell", leverage: 30, ticketUsd: 10, positionMode: "hedge", now: 0, legs: [{ entryType: "MARKET", qty: 0.004, price: null, takeProfitPrice: 63000, stopPrice: 66000 }] }),
    );
    ledger = applyOrderUpdate(ledger, ev("set_dup-1E", "FILLED", 0.004, 64000, "t9", 0.1), 1).ledger;
    const again = applyOrderUpdate(ledger, ev("set_dup-1E", "FILLED", 0.004, 64000, "t9", 0.1), 2);
    expect(again.actions).toEqual([]);
    expect(filledQty(again.ledger.sets[0]!.legs[0]!.entry)).toBe(0.004);
    ledger = applyOrderUpdate(again.ledger, ev("set_dup-1T", "FILLED", 0.004, 63990, "t10", 0.1), 3).ledger;
    const p = setPnl(ledger.sets[0]!);
    expect(p.grossPnlUsd).toBe(0.04); // short: 0.004 x (64,000 - 63,990)
    expect(p.netPnlUsd).toBe(-0.16);
    expect(p.profitShare.blackboardUsd).toBe(0);
  });
});

describe("The per-Set stop and its cap (REAL)", () => {
  it("picks the price that fires first: the real liquidation cap when it is nearer, the 85%-of-ticket price when the venue's liquidation is far", () => {
    // Ticket rule: 64,000 - 0.85 x $10 / 0.004 = 61,875.
    expect(stopFromTicketLoss({ entry: 64000, qty: 0.004, ticketUsd: 10, side: "buy", tickSize: 0.1 })).toBe(61875);
    const near = setStopPrice({ side: "buy", entry: 64000, qty: 0.004, ticketUsd: 10, tickSize: 0.1, cap: { source: "position", entryPrice: 64000, liquidationPrice: 62080 } });
    expect(near).toMatchObject({ stopPrice: 62368, boundBy: "liquidation", ticketStopPrice: 61875 }); // 64,000 - 0.85 x 1,920
    const far = setStopPrice({ side: "buy", entry: 64000, qty: 0.004, ticketUsd: 10, tickSize: 0.1, cap: { source: "position", entryPrice: 64000, liquidationPrice: 50000 } }); // cross margin, big balance
    expect(far).toMatchObject({ stopPrice: 61875, boundBy: "ticket" });
    const sell = setStopPrice({ side: "sell", entry: 64000, qty: 0.004, ticketUsd: 10, tickSize: 0.1, cap: { source: "position", entryPrice: 64000, liquidationPrice: 65920 } });
    expect(sell).toMatchObject({ stopPrice: 65632, boundBy: "liquidation", ticketStopPrice: 66125 });
    // Estimate cap at 50x for a 30x Set: nearer than the Set's own 30x numbers.
    const est = setStopPrice({ side: "buy", entry: 64000, qty: 0.004, ticketUsd: 10, tickSize: 0.1, cap: { source: "estimate", leverage: 50, maintenanceMarginRate: 0.005 } });
    expect(est.boundBy).toBe("liquidation");
    expect(est.stopPrice).toBeCloseTo(64000 - 0.85 * 64000 * (1 / 50 - 0.005), 0);
  });

  it("stopCapFor uses the position on the Set's side only; an opposite net (one-way) or no liquidation price falls back to the estimate at the higher leverage (negative)", () => {
    const set = { side: "buy" as const, leverage: 30, positionMode: "one-way" as const };
    expect(stopCapFor(set, [{ positionSide: "BOTH", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62080 }], { symbolLeverage: 50, maintenanceMarginRate: 0.005 })).toEqual({
      source: "position",
      entryPrice: 64000,
      liquidationPrice: 62080,
    });
    expect(stopCapFor(set, [{ positionSide: "BOTH", positionAmt: -0.004, entryPrice: 64000, liquidationPrice: 65900 }], { symbolLeverage: 50, maintenanceMarginRate: 0.005 })).toEqual({
      source: "estimate",
      leverage: 50,
      maintenanceMarginRate: 0.005,
    });
    expect(stopCapFor(set, [{ positionSide: "BOTH", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 0 }], { symbolLeverage: 20, maintenanceMarginRate: 0.005 }).source).toBe("estimate");
    expect(stopCapFor({ ...set, positionMode: "hedge" }, [{ positionSide: "SHORT", positionAmt: -0.004, entryPrice: 64000, liquidationPrice: 65900 }], { symbolLeverage: 30, maintenanceMarginRate: 0.005 })).toMatchObject({ source: "estimate", leverage: 30 });
  });
});

describe("Partial entry fills (HYBRID)", () => {
  it("exits are resized to the filled quantity; the take-profit closing the leg cancels the stop and the unfilled entry", async () => {
    const plan = buildSetPlan({
      input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 30, leverage: 50, tpMode: "deserved", entryMode: "nearby" },
      currentPrice: 64000,
      rules: BTC,
      levels: { limitLevels: [{ price: 63900, weightUsd: 1e6, side: "buy" }], takeProfitLevels: [], liquidationLevels: [] },
      random: () => 0.5,
    });
    expect(plan.orders.entries[0]).toMatchObject({ type: "LIMIT", qty: 0.023 });
    const fake = fakeAster({ dual: false, leverage: 50, rows: [{ positionSide: "BOTH", positionAmt: 0 }] });
    const store = memoryLedgerStore();
    await executeLive(fake.client, plan, BTC, { store, setId: "set_part" });
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.01, entryPrice: 63888, liquidationPrice: 62930 }];
    await handleOrderUpdate(fake.client, ev("set_part-1E", "PARTIALLY_FILLED", 0.01, 63888), BTC, { store });
    const upd = fake.of("POST", "/fapi/v3/updateStrategyOrder").at(-1)!;
    expect(upd.params.get("strategyId")).toBe("100");
    expect(upd.params.get("strategyType")).toBe("OTOCO");
    const subs = JSON.parse(upd.params.get("subOrderList")!) as Array<Record<string, string>>;
    expect(subs.map((x) => [x.strategySubId, x.type, x.side, x.quantity])).toEqual([
      ["2", "TAKE_PROFIT_MARKET", "SELL", "0.010"],
      ["3", "STOP_MARKET", "SELL", "0.010"],
    ]);
    // Stop: 85% of the real liquidation distance (63,888 - 0.85 x 958 = 63,073.7) beats the ticket rule.
    expect(subs[1]!.stopPrice).toBe("63073.7");
    const leg = store.current().sets[0]!.legs[0]!;
    expect([leg.takeProfit.qty, leg.stop.qty, leg.stop.boundBy]).toEqual([0.01, 0.01, "liquidation"]);

    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0 }];
    await handleOrderUpdate(fake.client, ev("set_part-1T", "FILLED", 0.01, plan.takeProfit.price), BTC, { store });
    expect(fake.of("DELETE", "/fapi/v3/order").map((c) => c.params.get("origClientOrderId"))).toEqual(["set_part-1S", "set_part-1E"]);
  });
});

describe("Refusals before anything is sent (HYBRID, negative)", () => {
  it("free balance below the ticket, or wallet below all open tickets plus this one: refused with a plain message, no order, no leverage change", async () => {
    const poor = fakeAster({ dual: false, leverage: 20, rows: [{ positionSide: "BOTH", positionAmt: 0 }], wallet: 50, available: 5 });
    const r = await executeLive(poor.client, nowPlan("buy", 30), BTC, { store: memoryLedgerStore(), setId: "set_poor" });
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(r.ok === false && r.refused && r.message).toMatch(/needs \$10, and \$5 is free/);
    expect(poor.of("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(0);
    expect(poor.of("POST", "/fapi/v3/leverage")).toHaveLength(0);

    let ledger = emptyLedger();
    ledger.sets.push(createSetRecord({ id: "set_o1", symbol: "ETHUSDT", side: "buy", leverage: 30, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "MARKET", qty: 0.1, price: null, takeProfitPrice: 4000, stopPrice: 3000 }] }));
    expect(checkMarginForSet({ ledger, ticketUsd: 10, availableBalanceUsd: 12, walletBalanceUsd: 15 })).toMatchObject({ ok: false, message: expect.stringMatching(/does not cover your open Sets \(\$10\) plus this one/) });
    expect(checkMarginForSet({ ledger, ticketUsd: 10, availableBalanceUsd: 12, walletBalanceUsd: 20 })).toEqual({ ok: true });
  });

  it("a position on the coin that the Sets do not explain (the user's own trade) refuses the Set", async () => {
    const fake = fakeAster({ dual: false, leverage: 20, rows: [{ positionSide: "BOTH", positionAmt: 0.01, entryPrice: 64000, liquidationPrice: 60000 }] });
    const r = await executeLive(fake.client, nowPlan("buy", 30), BTC, { store: memoryLedgerStore(), setId: "set_foreign" });
    expect(r.ok === false && r.refused && r.message).toMatch(/does not match your open Sets/);
    expect(fake.of("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(0);
  });
});

describe("Order events from Aster's user data stream (REAL)", () => {
  it("parses the doc's ORDER_TRADE_UPDATE; other messages are not order events; a broken one fails loudly (negative)", () => {
    const u = parseOrderTradeUpdate({
      e: "ORDER_TRADE_UPDATE",
      E: 1568879465651,
      T: 1568879465650,
      o: { s: "BTCUSDT", c: "set_abc-1E", S: "BUY", o: "MARKET", q: "0.004", ap: "64000", x: "TRADE", X: "FILLED", i: 8886774, l: "0.004", z: "0.004", L: "64000.1", N: "USDT", n: "0.1024", T: 1568879465651, t: 42, R: false, ps: "BOTH", rp: "0" },
    })!;
    expect(u).toEqual({
      symbol: "BTCUSDT",
      clientOrderId: "set_abc-1E",
      orderId: "8886774",
      status: "FILLED",
      executionType: "TRADE",
      lastFilledQty: 0.004,
      lastFilledPrice: 64000.1,
      commission: 0.1024,
      commissionAsset: "USDT",
      tradeId: "42",
      time: 1568879465651,
    });
    expect(parseOrderTradeUpdate({ e: "ACCOUNT_UPDATE" })).toBeNull();
    expect(() => parseOrderTradeUpdate({ e: "ORDER_TRADE_UPDATE", o: {} })).toThrow(/without symbol or status/);
  });

  it("a venue liquidation on a coin with open Sets asks for a reconcile; an exit vanishing while the Set is open is flagged loudly", () => {
    let ledger = emptyLedger();
    ledger.sets.push(createSetRecord({ id: "set_liq", symbol: "BTCUSDT", side: "buy", leverage: 50, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "MARKET", qty: 0.007, price: null, takeProfitPrice: 66000, stopPrice: 63200 }] }));
    ledger = applyOrderUpdate(ledger, ev("set_liq-1E", "FILLED", 0.007, 64000), 1).ledger;
    const liq = applyOrderUpdate(ledger, { ...ev("autoclose-1596107620040000020", "FILLED", 0.007, 62800), executionType: "CALCULATED" }, 2);
    expect(liq.matched).toBe(false);
    expect(liq.needsReconcile).toBe(true);
    expect(liq.log[0]!.level).toBe("error");
    const lost = applyOrderUpdate(ledger, ev("set_liq-1S", "EXPIRED"), 3);
    expect(lost.ledger.sets[0]!.needsAttention).toMatch(/lost an exit/);
    expect(lost.log.some((l) => l.level === "error")).toBe(true);
    expect(lost.needsReconcile).toBe(true);
    // reconcile with graceMs 0 acts at once and never asks to place anything.
    const r = reconcile(ledger, { symbol: "BTCUSDT", mode: "one-way", positions: [{ positionSide: "BOTH", positionAmt: 0 }], stepSize: 0.001, now: 5, graceMs: 0 });
    expect(r.actions.every((a) => a.kind === "cancel")).toBe(true);
    expect(r.ledger.sets[0]!.status).toBe("closed-outside");
  });
});
