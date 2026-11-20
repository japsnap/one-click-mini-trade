/**
 * Sets on one account (2026-11-16; one Set per coin since the never-merge ruling of
 * 2026-11-20): the Set ledger (src/core/ledger.ts), the per-Set stop (src/core/stop.ts),
 * the pre-trade checks (src/core/risk.ts) and the executor (server/execute.ts). Tests that
 * hold two Sets on one coin start from a ledger saved before the ruling, which the code
 * must still read.
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
  type LedgerLog,
  type OrderUpdate,
  type SetLedger,
} from "../src/core/ledger";
import { setStopPrice, stopFromTicketLoss } from "../src/core/stop";
import { checkCoinIsFree, checkNewSetRisk, parseAccountRisk } from "../src/core/risk";
import { buildSetPlan, withSymbolLeverage, type SetPlan } from "../src/core/plan";
import { seededRandom, type SymbolRules } from "../src/core/types";
import { AsterClient, parseOrderTradeUpdate, privateKeySigner } from "../src/exchange/aster";
import { describeTarget, executeLive, handleOrderUpdate, memoryLedgerStore, reconcileSymbol, remeasureTargets } from "../server/execute";

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
/** A position on another coin, seen only in the account answer (cross margin links coins). */
interface OtherCoin {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
}

function fakeAster(init: { dual: boolean; leverage: number; rows: Row[]; wallet?: number; available?: number; others?: OtherCoin[]; symbol?: string; failTakeProfitUpdate?: boolean }) {
  const state = { ...init, wallet: init.wallet ?? 1000, available: init.available ?? 1000, others: init.others ?? [], symbol: init.symbol ?? "BTCUSDT" };
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
            symbol: state.symbol,
            positionSide: r.positionSide,
            positionAmt: String(r.positionAmt),
            entryPrice: String(r.entryPrice ?? 0),
            liquidationPrice: String(r.liquidationPrice ?? 0),
            markPrice: "64000",
            leverage: String(state.leverage),
            marginType: "isolated",
          })),
        );
      case "GET /fapi/v3/account":
        return json({
          availableBalance: String(state.available),
          totalPositionInitialMargin: String(Math.max(0, state.wallet - state.available)),
          totalOpenOrderInitialMargin: "0",
          totalMaintMargin: String(
            state.rows.reduce((a, r) => a + Math.abs(r.positionAmt) * 64000 * 0.004, 0) + state.others.reduce((a, o) => a + Math.abs(o.positionAmt) * o.markPrice * 0.004, 0),
          ),
          positions: [
            ...state.rows.map((r) => ({
              symbol: state.symbol,
              positionSide: r.positionSide,
              positionAmt: String(r.positionAmt),
              entryPrice: String(r.entryPrice ?? 0),
              notional: String(r.positionAmt * 64000),
              maintMargin: String(Math.abs(r.positionAmt) * 64000 * 0.004),
              isolated: false,
            })),
            ...state.others.map((o) => ({
              symbol: o.symbol,
              positionSide: "BOTH",
              positionAmt: String(o.positionAmt),
              entryPrice: String(o.entryPrice),
              notional: String(o.positionAmt * o.markPrice),
              maintMargin: String(Math.abs(o.positionAmt) * o.markPrice * 0.004),
              isolated: false,
            })),
          ],
        });
      case "GET /fapi/v3/balance":
        return json([{ asset: "USDT", balance: String(state.wallet), availableBalance: String(state.available) }]);
      case "POST /fapi/v3/leverage":
        state.leverage = Number(params.get("leverage"));
        return json({ leverage: state.leverage, symbol: "BTCUSDT" });
      case "POST /fapi/v3/placeStrategyOrder":
        return json({ strategyId: nextStrategy++, clientStrategyId: params.get("clientStrategyId"), strategyType: "OTOCO", strategyStatus: "WORKING", failureCode: 0 });
      case "POST /fapi/v3/updateStrategyOrder": {
        // failTakeProfitUpdate: refuse a change of the take-profit's price (sub-order 2 with a stopPrice).
        const subs = JSON.parse(params.get("subOrderList") ?? "[]") as Array<Record<string, string>>;
        if (state.failTakeProfitUpdate && subs.some((x) => x.strategySubId === "2" && x.stopPrice !== undefined)) {
          return json([{ strategyId: Number(params.get("strategyId")), updateStatus: "FAILED", failureCode: -4000, failureReason: "fake refusal" }]);
        }
        return json([{ strategyId: Number(params.get("strategyId")), updateStatus: "SUCCESS", failureCode: 0 }]);
      }
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

const NEVER = "A Set never shares a coin with another position, so nothing was sent.";

describe("One Set per coin: a Set's position never merges (2026-11-20)", () => {
  it("one-way mode: a second Set on the coin is refused while the first is live, before and after its fill; its take-profit cancels its stop; then the coin is free again (HYBRID)", async () => {
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
      expect(l.reduceOnly).toBeUndefined(); // off unless ASTER_EXIT_REDUCE_ONLY is true
      expect(l.positionSide).toBeUndefined();
      expect(l.quantity).toBe("0.004"); // $10 x 30 / 64,000 = 0.00468 -> 0.004
    }

    // Before the fill the position is still flat, but the live Set holds the coin.
    const early = await executeLive(fake.client, nowPlan("sell", 30), BTC, { store, setId: "set_sel00" });
    expect(early).toMatchObject({ ok: false, refused: true, message: `BTC already has a live Set (set_buy01). ${NEVER}` });

    // Buy entry fills; the exchange now shows the long. A Sell Set would net against it: refused.
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62200 }];
    await handleOrderUpdate(fake.client, ev("set_buy01-1E", "FILLED", 0.004, 64000), BTC, { store });
    const sell = await executeLive(fake.client, nowPlan("sell", 30, 64010), BTC, { store, setId: "set_sel01" });
    expect(sell).toMatchObject({ ok: false, refused: true, message: `BTC already has an open position. ${NEVER}` });
    expect(fake.of("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(1);
    expect(store.current().sets.map((x) => x.id)).toEqual(["set_buy01"]); // refusals leave no record

    // The Buy Set's take-profit fills: its stop is cancelled and the Set is closed.
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0 }];
    await handleOrderUpdate(fake.client, ev("set_buy01-1T", "FILLED", 0.004, 66000), BTC, { store });
    expect(fake.of("DELETE", "/fapi/v3/order").map((c) => c.params.get("origClientOrderId"))).toEqual(["set_buy01-1S"]);
    expect(store.current().sets[0]!.status).toBe("closed");
    expect((await reconcileSymbol(fake.client, BTC, { store, now: () => 20_000 })).mismatches).toEqual([]);

    // Flat and no live Set: the next Set on BTC goes out.
    expect((await executeLive(fake.client, nowPlan("sell", 30), BTC, { store, setId: "set_sel02" })).ok).toBe(true);
    expect(fake.of("POST", "/fapi/v3/order")).toHaveLength(0); // never a plain order placed
  });

  it("hedge mode: a Sell Set is refused while a Buy Set is live, even with the SHORT side flat; the Buy Set's legs are LONG with no reduceOnly (HYBRID, negative)", async () => {
    const fake = fakeAster({ dual: true, leverage: 30, rows: [{ positionSide: "LONG", positionAmt: 0 }, { positionSide: "SHORT", positionAmt: 0 }] });
    const store = memoryLedgerStore();
    expect((await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_hbuy1" })).ok).toBe(true);
    expect(legsOf(fake, 0).legs.map((l) => l.positionSide)).toEqual(["LONG", "LONG", "LONG"]);
    expect(legsOf(fake, 0).legs.every((l) => l.reduceOnly === undefined)).toBe(true);
    expect(fake.of("POST", "/fapi/v3/leverage")).toHaveLength(0); // the symbol already stood at 30x
    const r = await executeLive(fake.client, nowPlan("sell", 30), BTC, { store, setId: "set_hsel1" });
    expect(r).toMatchObject({ ok: false, refused: true, message: `BTC already has a live Set (set_hbuy1). ${NEVER}` });
    // A position on either side blocks the coin too.
    const other = fakeAster({ dual: true, leverage: 30, rows: [{ positionSide: "LONG", positionAmt: 0 }, { positionSide: "SHORT", positionAmt: -0.01 }] });
    const r2 = await executeLive(other.client, nowPlan("buy", 30), BTC, { store: memoryLedgerStore(), setId: "set_hbuy2" });
    expect(r2).toMatchObject({ ok: false, refused: true, message: `BTC already has an open position. ${NEVER}` });
    expect(other.of("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(0);
  });
});

describe("Leverage with one Set per coin", () => {
  it("the symbol leverage follows each new Set: 30, then 50 after the first Set closed (HYBRID)", async () => {
    const fake = fakeAster({ dual: false, leverage: 20, rows: [{ positionSide: "BOTH", positionAmt: 0 }] });
    const store = memoryLedgerStore();
    await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_l30a" });
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.004, entryPrice: 64000, liquidationPrice: 62200 }];
    await handleOrderUpdate(fake.client, ev("set_l30a-1E", "FILLED", 0.004, 64000), BTC, { store });
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0 }];
    await handleOrderUpdate(fake.client, ev("set_l30a-1T", "FILLED", 0.004, 66000), BTC, { store });
    const fifty = nowPlan("buy", 50);
    await executeLive(fake.client, fifty, BTC, { store, setId: "set_l50a" });
    expect(fake.of("POST", "/fapi/v3/leverage").map((c) => c.params.get("leverage"))).toEqual(["30", "50"]);
    expect(legsOf(fake, 1).legs[0]!.quantity).toBe("0.007"); // $10 x 50 / 64,000 -> 0.007
    expect(Number(legsOf(fake, 1).legs[2]!.stopPrice)).toBe(fifty.orders.stops[0]!.stopPrice); // nothing pulled in: no other Set
  });

  it("withSymbolLeverage (still used for ledgers saved before the ruling): a 30x plan on a coin standing at 50x gets the nearer 50x stop (REAL)", () => {
    const third = nowPlan("buy", 30);
    const at50 = withSymbolLeverage(third, BTC, 50).orders.stops[0]!.stopPrice;
    expect(at50).toBeGreaterThan(third.orders.stops[0]!.stopPrice);
    expect(withSymbolLeverage(third, BTC, 30)).toBe(third);
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

/**
 * Two filled Buy Sets A (30x, 0.004) and B (50x, 0.007) on BTC in one-way mode: a ledger
 * saved before the never-merge ruling (new Sets can no longer get there), which the
 * executor must still handle.
 */
async function twoFilledBuys() {
  const fake = fakeAster({ dual: false, leverage: 50, rows: [{ positionSide: "BOTH", positionAmt: 0.011, entryPrice: 64000, liquidationPrice: 62900 }] });
  let ledger = emptyLedger();
  const mk = (id: string, leverage: number, qty: number, stopPrice: number, strategyId: string) => {
    const r = createSetRecord({ id, symbol: "BTCUSDT", side: "buy", leverage, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "MARKET", qty, price: null, takeProfitPrice: 66000, stopPrice }] });
    r.legs[0]!.sent = "sent";
    r.legs[0]!.strategyId = strategyId;
    return r;
  };
  ledger.sets.push(mk("set_aaa", 30, 0.004, 62400, "100"), mk("set_bbb", 50, 0.007, 63000, "101"));
  ledger = applyOrderUpdate(ledger, ev("set_aaa-1E", "FILLED", 0.004, 64000), 1).ledger;
  ledger = applyOrderUpdate(ledger, ev("set_bbb-1E", "FILLED", 0.007, 64000), 2).ledger;
  const store = memoryLedgerStore(ledger);
  return { fake, store };
}

describe("One Set's stop fills while the other stays open (ledger from before the ruling)", () => {
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

  it("a large Set on BTC that pulls the user's ETH liquidation more than 30% closer is refused, nothing sent (cross margin links coins)", async () => {
    // Own ETH long 1 at 3,000 on cross margin; BTC is flat. Cushion 168 before, about 108 after the $100 x 100 BTC Set.
    const fake = fakeAster({ dual: false, leverage: 30, rows: [{ positionSide: "BOTH", positionAmt: 0 }], wallet: 180, available: 140, others: [{ symbol: "ETHUSDT", positionAmt: 1, entryPrice: 3000, markPrice: 3000 }] });
    const plan = buildSetPlan({ input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 100, leverage: 100, tpMode: "deserved", entryMode: "now" }, currentPrice: 64000, rules: BTC, levels: NO_LEVELS, random: () => 0.5 });
    const r = await executeLive(fake.client, plan, BTC, { store: memoryLedgerStore(), setId: "set_big" });
    expect(r.ok === false && r.refused && r.message).toMatch(/your ETH long's liquidation from [\d.]+ to [\d.]+: 3\d% closer to the price \(the limit is 30%\)/);
    expect(fake.of("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(0);
    // A $10 Set leaves the ETH cushion almost untouched and goes out.
    expect((await executeLive(fake.client, nowPlan("buy", 30), BTC, { store: memoryLedgerStore(), setId: "set_small" })).ok).toBe(true);
  });
});

describe("Never merge: refused before anything is sent (2026-11-20)", () => {
  it("the user's own position on the coin refuses the Set with a plain message: no order, no leverage change, no account read, no outside baseline (HYBRID, negative)", async () => {
    const fake = fakeAster({ dual: false, leverage: 30, rows: [{ positionSide: "BOTH", positionAmt: 0.067, entryPrice: 63530, liquidationPrice: 59286 }], wallet: 300, available: 170 });
    const store = memoryLedgerStore();
    const r = await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_next" });
    expect(r).toMatchObject({ ok: false, refused: true, message: `BTC already has an open position. ${NEVER}` });
    expect(fake.of("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(0);
    expect(fake.of("POST", "/fapi/v3/leverage")).toHaveLength(0);
    expect(fake.of("GET", "/fapi/v3/account")).toHaveLength(0);
    expect(store.current()).toEqual(emptyLedger());
    // A short of his own blocks a Buy Set the same way (one-way: it would net against it).
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: -0.01, entryPrice: 64000, liquidationPrice: 66000 }];
    expect(await executeLive(fake.client, nowPlan("buy", 30), BTC, { store, setId: "set_next2" })).toMatchObject({ ok: false, refused: true });
  });

  it("a position on another coin does not block; the entry leg carries the root trigger ids Aster requires (HYBRID)", async () => {
    const fake = fakeAster({ dual: false, leverage: 30, rows: [{ positionSide: "BOTH", positionAmt: 0 }], wallet: 300, available: 170, others: [{ symbol: "ETHUSDT", positionAmt: 0.166, entryPrice: 1805.73, markPrice: 1805 }] });
    const r = await executeLive(fake.client, nowPlan("buy", 30), BTC, { store: memoryLedgerStore(), setId: "set_free" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.join(" ")).not.toMatch(/merges/);
    expect(legsOf(fake, 0).legs[0]).toMatchObject({ strategySubId: "1", firstDrivenId: "0", secondDrivenId: "0" });
  });

  it("checkCoinIsFree: flat and no live Set passes; any position or a live Set refuses, naming the coin (REAL, negative)", () => {
    expect(checkCoinIsFree({ symbol: "ETHUSDT", positionAmts: [0], liveSetIds: [] })).toEqual({ ok: true });
    expect(checkCoinIsFree({ symbol: "ETHUSDT", positionAmts: [], liveSetIds: [] })).toEqual({ ok: true });
    expect(checkCoinIsFree({ symbol: "ETHUSDT", positionAmts: [0.166], liveSetIds: [] })).toEqual({ ok: false, message: `ETH already has an open position. ${NEVER}` });
    expect(checkCoinIsFree({ symbol: "ETHUSDT", positionAmts: [0, -0.1], liveSetIds: [] }).ok).toBe(false);
    expect(checkCoinIsFree({ symbol: "ETHUSDT", positionAmts: [0], liveSetIds: ["set_a"] })).toEqual({ ok: false, message: `ETH already has a live Set (set_a). ${NEVER}` });
  });

  it("a ledger saved with the user's own part (2026-11-19 to 20) still reconciles: cutting his part keeps the Sets; closing everything cancels them (REAL, negative)", () => {
    let ledger = emptyLedger();
    ledger.outside = { BTCUSDT: { BOTH: 0.067 } };
    const set = createSetRecord({ id: "set_r1", symbol: "BTCUSDT", side: "buy", leverage: 30, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "MARKET", qty: 0.004, price: null, takeProfitPrice: 67000, stopPrice: 62000 }] });
    ledger.sets.push(set);
    ledger = applyOrderUpdate(ledger, ev("set_r1-1E", "FILLED", 0.004, 64000), 1).ledger;
    const args = { symbol: "BTCUSDT", mode: "one-way" as const, stepSize: 0.001, graceMs: 0 };
    const cut = reconcile(ledger, { ...args, positions: [{ positionSide: "BOTH", positionAmt: 0.034 }], now: 10 });
    expect(cut.actions).toHaveLength(0);
    expect(cut.ledger.outside?.BTCUSDT?.BOTH).toBeCloseTo(0.03, 9);
    expect(cut.ledger.sets[0]!.status).toBe("open");
    const gone = reconcile(cut.ledger, { ...args, positions: [{ positionSide: "BOTH", positionAmt: 0 }], now: 20 });
    expect(gone.ledger.sets[0]!.status).toBe("closed-outside");
    expect(gone.actions.map((a) => (a.kind === "cancel" ? a.role : a.kind)).sort()).toEqual(["stop", "takeProfit"]);
  });
});

describe("Liquidation and stop rules before a Set (REAL)", () => {
  // Shota's account, read live 2026-11-19 11:30 UTC (GET /fapi/v3/account).
  const live = parseAccountRisk({
    availableBalance: "167.35580547",
    totalPositionInitialMargin: "152.65678708",
    totalOpenOrderInitialMargin: "0",
    totalMaintMargin: "13.87299485",
    positions: [
      { symbol: "ETHUSDT", maintMargin: "0.75007515", positionSide: "BOTH", positionAmt: "0.166", notional: "300.03006000", entryPrice: "1805.73", isolated: false },
      { symbol: "BTCUSDT", maintMargin: "13.12291970", positionSide: "BOTH", positionAmt: "0.067", notional: "4279.67263659", entryPrice: "63530.07761194", isolated: false },
    ],
  });
  const mark = 4279.67263659 / 0.067;
  const newBtc = (qty: number, side: "buy" | "sell", stopPrice: number) => ({ symbol: "BTCUSDT", side, qty, price: mark, stopPrice, maintenanceMarginRate: 0.003, positionMode: "one-way" as const });

  it("the model reproduces Aster's BTC liquidation (59,286) within 0.05%", () => {
    const v = checkNewSetRisk(live, newBtc(0.004, "buy", mark * 0.97), []);
    const btc = v.rows.find((r) => r.symbol === "BTCUSDT")!;
    expect(Math.abs((btc.liqBefore as number) - 59286.1) / 59286.1).toBeLessThan(0.0005);
  });

  it("$10 and $30 at 30x pass; $100 at 30x (43% closer) is refused; a stop past 85% of the way to the new liquidation is refused (negative)", () => {
    expect(checkNewSetRisk(live, newBtc(0.004, "buy", mark * (1 - 0.85 / 30)), []).ok).toBe(true);
    const mid = checkNewSetRisk(live, newBtc(0.014, "buy", mark * (1 - 0.85 / 30)), []);
    expect(mid.ok).toBe(true);
    expect(mid.warnings.join(" ")).toMatch(/liquidation moves 18% closer/);
    const big = checkNewSetRisk(live, newBtc(0.046, "buy", mark * (1 - 0.85 / 30)), []);
    expect(big.ok).toBe(false);
    expect(big.reasons[0]).toMatch(/43% closer to the price/);
    // An open Set's stop at 59,700 sits past 85% of the way from 64,000 to the new liquidation (about 59,565).
    const stops = checkNewSetRisk(live, newBtc(0.004, "buy", mark * (1 - 0.85 / 30)), [{ setId: "set_old", side: "buy", entryPrice: 64000, stopPrice: 59700 }]);
    expect(stops.ok).toBe(false);
    expect(stops.reasons[0]).toMatch(/Set set_old's stop at 59700\.0 would sit 9\d% of the way/);
  });

  it("margin uses account equity: a multi-asset account with a small USDT wallet is not refused; a broken account answer fails loudly (negative)", () => {
    expect(live.equityUsd).toBeCloseTo(320.01, 1);
    expect(checkMarginForSet({ ledger: emptyLedger(), ticketUsd: 10, availableBalanceUsd: live.availableBalanceUsd, walletBalanceUsd: live.equityUsd })).toEqual({ ok: true });
    expect(() => parseAccountRisk({ availableBalance: "1" })).toThrow(/totalPositionInitialMargin missing/);
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
      cumulativeFilledQty: 0.004,
    });
    expect(parseOrderTradeUpdate({ e: "ACCOUNT_UPDATE" })).toBeNull();
    expect(() => parseOrderTradeUpdate({ e: "ORDER_TRADE_UPDATE", o: {} })).toThrow(/without symbol or status/);
  });

  it("a fill caught up from a query and then delivered by the stream under another id counts once (cumulative filled quantity) (REAL, negative)", () => {
    let ledger = emptyLedger();
    ledger.sets.push(createSetRecord({ id: "set_cum", symbol: "BTCUSDT", side: "buy", leverage: 30, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "LIMIT", qty: 0.004, price: 63900, takeProfitPrice: 66000, stopPrice: 62400 }] }));
    ledger = applyOrderUpdate(ledger, { ...ev("set_cum-1E", "FILLED", 0.004, 63900, "catchup:set_cum-1E:0.004"), cumulativeFilledQty: 0.004 }, 1).ledger;
    const again = applyOrderUpdate(ledger, { ...ev("set_cum-1E", "FILLED", 0.004, 63900, "77"), cumulativeFilledQty: 0.004 }, 2);
    expect(again.actions).toEqual([]);
    expect(filledQty(again.ledger.sets[0]!.legs[0]!.entry)).toBe(0.004);
    // A missed partial: the cumulative says 0.003 in all, so 0.003 is recorded, not the event's 0.001.
    let l2 = emptyLedger();
    l2.sets.push(createSetRecord({ id: "set_cu2", symbol: "BTCUSDT", side: "buy", leverage: 30, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "LIMIT", qty: 0.004, price: 63900, takeProfitPrice: 66000, stopPrice: 62400 }] }));
    l2 = applyOrderUpdate(l2, { ...ev("set_cu2-1E", "PARTIALLY_FILLED", 0.001, 63900, "80"), cumulativeFilledQty: 0.003 }, 1).ledger;
    expect(filledQty(l2.sets[0]!.legs[0]!.entry)).toBe(0.003);
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

/**
 * The target against the real fill (Sets_Rules.md A7, build step E3). HYBRID: the real
 * executor, ledger, stop re-set and target re-measure, the real AsterClient with real
 * signatures, against the stateful FAKE Aster above (symbol ETHUSDT). The fake's
 * positionRisk carries the liquidation price 1,749.83 of 2026-11-19, so the stop the resync
 * computes is 85% of the real liquidation distance from the fill. Every check reads the
 * ledger copy before and after, and the exact updateStrategyOrder bodies sent.
 */
describe("Target against the real fill (A7, HYBRID)", () => {
  const ETH: SymbolRules = { symbol: "ETHUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
  const ethPlan = () =>
    buildSetPlan({ input: { symbol: "ETHUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, currentPrice: 1805.73, rules: ETH, levels: NO_LEVELS, random: () => 0.5, market: { sigma1h: 0.007 } });
  const evEth = (id: string, status: string, qty: number, price: number): OrderUpdate => ({ ...ev(id, status, qty, price), symbol: "ETHUSDT" });
  const tpBodies = (fake: ReturnType<typeof fakeAster>) =>
    fake.of("POST", "/fapi/v3/updateStrategyOrder").flatMap((c) => (JSON.parse(c.params.get("subOrderList")!) as Array<Record<string, string>>).filter((x) => x.strategySubId === "2" && x.stopPrice !== undefined));

  async function placedSet(id: string, opts: { failTakeProfitUpdate?: boolean } = {}) {
    const plan = ethPlan();
    const fake = fakeAster({ dual: false, leverage: 30, rows: [{ positionSide: "BOTH", positionAmt: 0 }], symbol: "ETHUSDT", ...opts });
    const store = memoryLedgerStore();
    const r = await executeLive(fake.client, plan, ETH, { store, setId: id, reduceOnlyExits: true });
    expect(r.ok).toBe(true);
    return { plan, fake, store };
  }

  it("the ledger keeps the plan's reason and stored candidates", async () => {
    const { plan, store } = await placedSet("set_fill0");
    expect(plan.takeProfit.price).toBe(1899.43);
    const t = store.current().sets[0]!.target!;
    expect(t.reason).toBe(plan.takeProfit.reason);
    expect(t.planRatio).toBe(plan.takeProfit.ratio);
    expect(t.basis.candidates.map((c) => c.price)).toEqual([1899.43, 1949.41]);
    expect(t).toMatchObject({ realRatio: null, measuredAtFill: null, pendingPrice: null });
  });

  it("filled 23 cents above the plan: about 1.96x against the real fill, at or above 1.9x, nothing moves", async () => {
    const { fake, store } = await placedSet("set_fill1");
    const before = structuredClone(store.current().sets[0]!);
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.166, entryPrice: 1805.96, liquidationPrice: 1749.83 }];
    const out = await handleOrderUpdate(fake.client, evEth("set_fill1-1E", "FILLED", 0.166, 1805.96), ETH, { store });
    const after = store.current().sets[0]!;
    const leg = after.legs[0]!;
    // The stop was re-set from the fill: 1,805.96 - 0.85 x 56.13 = 1,758.25.
    expect(leg.stop.stopPrice).toBe(1758.25);
    expect(leg.takeProfit.stopPrice).toBe(before.legs[0]!.takeProfit.stopPrice); // 1,899.43, unchanged
    expect(after.target!.realRatio).toBeCloseTo((1899.43 - 1805.96) / (1805.96 - 1758.25), 6);
    expect(after.target!.realRatio).toBeGreaterThanOrEqual(1.9);
    expect(after.target!.lastCheck).toMatch(/1\.96x against the real fill, at or above 1\.9x: kept/);
    expect(tpBodies(fake)).toHaveLength(0); // the take-profit price was never sent again
    expect(out.log.some((l) => l.message.includes("[counts] remeasureTargets ETHUSDT: measured 1, re-placed 0"))).toBe(true);
    // A repeated event does not measure twice.
    const again = await handleOrderUpdate(fake.client, evEth("set_fill1-1E", "FILLED", 0, 0), ETH, { store });
    expect(again.log.some((l) => l.message.includes("measured 1"))).toBe(false);
  });

  it("filled 3 dollars above the plan: 1.81x, re-chosen 1,949.41; kept and logged until updateStrategyOrder is proven", async () => {
    const { fake, store } = await placedSet("set_fill2");
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.166, entryPrice: 1808.73, liquidationPrice: 1749.83 }];
    const out = await handleOrderUpdate(fake.client, evEth("set_fill2-1E", "FILLED", 0.166, 1808.73), ETH, { store });
    const after = store.current().sets[0]!;
    expect(after.legs[0]!.stop.stopPrice).toBe(1758.67);
    expect(after.legs[0]!.takeProfit.stopPrice).toBe(1899.43); // kept
    expect(after.target!.realRatio).toBeCloseTo((1899.43 - 1808.73) / (1808.73 - 1758.67), 6); // 1.812
    expect(after.target!.pendingPrice).toBe(1949.41);
    expect(after.target!.lastCheck).toBe(
      "kept, update unproven: take profit (sell) at 1,899.43 is 1.81x against the real fill, below 1.9x; re-chosen: Long from 1,808.73; take profit (sell) at 1,949.41, 2.81x the stop (sell at 1,758.67): no liquidation cluster between 1.9x and 4x, so the sale sits just in front of 1,950 (a round number)",
    );
    expect(out.log.some((l) => l.level === "warn" && l.message.includes("kept, update unproven") && l.message.includes("would re-place at 1949.41"))).toBe(true);
    expect(tpBodies(fake)).toHaveLength(0);
    expect(describeTarget(after)).toMatchObject({ realRatioText: "1.81x against the real fill", pendingPrice: 1949.41 });
  });

  it("with re-placing switched on and the client reporting success: the take-profit moves to 1,949.41, logged re-placed", async () => {
    const { fake, store } = await placedSet("set_fill3");
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.166, entryPrice: 1808.73, liquidationPrice: 1749.83 }];
    const out = await handleOrderUpdate(fake.client, evEth("set_fill3-1E", "FILLED", 0.166, 1808.73), ETH, { store, replaceTakeProfitAfterFill: true });
    const sent = tpBodies(fake);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ strategySubId: "2", type: "TAKE_PROFIT_MARKET", side: "SELL", symbol: "ETHUSDT", stopPrice: "1949.41", quantity: "0.166", workingType: "MARK_PRICE" });
    const after = store.current().sets[0]!;
    expect(after.legs[0]!.takeProfit.stopPrice).toBe(1949.41);
    expect(after.legs[0]!.entry.fills[0]!.price).toBe(1808.73); // the entry is never touched
    expect(after.legs[0]!.stop.stopPrice).toBe(1758.67); // nor the stop
    expect(after.target!.realRatio).toBeCloseTo((1949.41 - 1808.73) / (1808.73 - 1758.67), 6);
    expect(after.target!.pendingPrice).toBeNull();
    expect(out.log.some((l) => l.message.startsWith("re-placed take-profit at 1949.41"))).toBe(true);
  });

  it("a log-only pass (reconcile) stamps the fill first; a later re-place-on pass still re-places the pending level, exactly once", async () => {
    const { fake, store } = await placedSet("set_fill5");
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.166, entryPrice: 1808.73, liquidationPrice: 1749.83 }];
    await handleOrderUpdate(fake.client, evEth("set_fill5-1E", "FILLED", 0.166, 1808.73), ETH, { store }); // re-place off: pending
    await reconcileSymbol(fake.client, ETH, { store, now: () => 10_000 }); // log-only remeasure on the same (fill, stop)
    const stamped = store.current();
    expect(stamped.sets[0]!.target).toMatchObject({ pendingPrice: 1949.41, measuredAtFill: 1808.73, measuredAtStop: 1758.67 });
    expect(tpBodies(fake)).toHaveLength(0);
    const log: LedgerLog[] = [];
    const after = await remeasureTargets(fake.client, stamped, ETH, log, { replaceTakeProfit: true });
    expect(tpBodies(fake).map((x) => x.stopPrice)).toEqual(["1949.41"]);
    expect(after.sets[0]!.legs[0]!.takeProfit.stopPrice).toBe(1949.41);
    expect(after.sets[0]!.target!.pendingPrice).toBeNull();
    expect(log.some((l) => l.message.startsWith("re-placed take-profit at 1949.41"))).toBe(true);
    // Nothing pending any more: the same pair is skipped, no second order change.
    await remeasureTargets(fake.client, after, ETH, [], { replaceTakeProfit: true });
    expect(tpBodies(fake)).toHaveLength(1);
    // Re-place off: a stamped pair with a pending level is still skipped (no repeated log line).
    const offLog: LedgerLog[] = [];
    await remeasureTargets(fake.client, stamped, ETH, offLog);
    expect(offLog.some((l) => l.message.includes("kept, update unproven"))).toBe(false);
  });

  it("re-placing switched on but the client refusing: the target stays, the Set is flagged, the failure is loud (negative)", async () => {
    const { fake, store } = await placedSet("set_fill4", { failTakeProfitUpdate: true });
    fake.state.rows = [{ positionSide: "BOTH", positionAmt: 0.166, entryPrice: 1808.73, liquidationPrice: 1749.83 }];
    const out = await handleOrderUpdate(fake.client, evEth("set_fill4-1E", "FILLED", 0.166, 1808.73), ETH, { store, replaceTakeProfitAfterFill: true });
    const after = store.current().sets[0]!;
    expect(after.legs[0]!.takeProfit.stopPrice).toBe(1899.43);
    expect(after.needsAttention).toMatch(/take-profit re-place failed/);
    expect(after.target!.pendingPrice).toBe(1949.41);
    expect(out.log.some((l) => l.level === "error" && l.message.startsWith("TAKE-PROFIT RE-PLACE FAILED, kept at 1899.43"))).toBe(true);
  });
});
