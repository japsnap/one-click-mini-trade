/**
 * Wick Catcher's routes (server/intents.ts, 2026-11-25).
 *
 * Categories (rules/testing.md):
 *  - HYBRID: the real routes and the real AsterClient (real EIP-712 signatures) against a stateful
 *    FAKE Aster (fakeVenue below, no network). They verify the requests sent (or that none was sent)
 *    and the counter file read back from a temp folder. They do NOT prove Aster accepts the requests.
 *  - REAL: checkCoinIsFree is pure; the card's preTradeCheck runs against the same fake.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";
import { createWcRoutes, loadCounter, readTokenFile } from "../server/intents";
import { checkCoinIsFree } from "../src/core/risk";
import { emptyLedger, type SetLedger } from "../src/core/ledger";
import { preTradeCheck } from "../server/execute";
import type { SetPlan } from "../src/core/plan";

const DEMO_KEY = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1" as const;
const TOKEN = "t".repeat(40);
const exchangeInfo = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "aster-exchangeInfo.json"), "utf8"));

interface FakeOrder { orderId: number; clientOrderId: string; type: string; side: string; price: string; stopPrice: string; origQty: string; reduceOnly: string; status: string; executedQty: string; avgPrice: string }

function fakeVenue(init: { positionAmt?: number; leverage?: number; foreign?: boolean; failNewStop?: boolean; readBackMissing?: boolean; marginType?: string } = {}) {
  const st = { positionAmt: init.positionAmt ?? 0, leverage: init.leverage ?? 30, marginType: init.marginType ?? "cross", orders: [] as FakeOrder[], done: [] as FakeOrder[] };
  let nextId = 1000;
  if (init.foreign) st.orders.push({ orderId: nextId++, clientOrderId: "web_abc", type: "LIMIT", side: "BUY", price: "50000", stopPrice: "0", origQty: "0.001", reduceOnly: "false", status: "NEW", executedQty: "0", avgPrice: "0" });
  const calls: Array<{ method: string; path: string; params: URLSearchParams }> = [];
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
  const fetch = async (url: string, reqInit?: RequestInit) => {
    const u = new URL(url);
    const method = reqInit?.method ?? "GET";
    const params = new URLSearchParams(method === "GET" ? u.search.slice(1) : String(reqInit?.body ?? ""));
    calls.push({ method, path: u.pathname, params });
    switch (`${method} ${u.pathname}`) {
      case "GET /fapi/v3/exchangeInfo":
        return json(exchangeInfo);
      case "GET /fapi/v3/positionRisk":
        return json([{ symbol: "BTCUSDT", positionSide: "BOTH", positionAmt: String(st.positionAmt), entryPrice: "59000", liquidationPrice: "56300", markPrice: "59100", leverage: String(st.leverage), marginType: st.marginType }]);
      case "GET /fapi/v3/openOrders":
        return json(st.orders);
      case "GET /fapi/v3/account":
        return json({ availableBalance: "12", totalPositionInitialMargin: "0", totalOpenOrderInitialMargin: "0", totalMaintMargin: "0", positions: [] });
      case "GET /fapi/v3/leverageBrackets":
        return json([{ symbol: "BTCUSDT", brackets: [{ notionalFloor: "0", notionalCap: "50000", initialLeverage: "125", maintMarginRatio: "0.004" }] }]);
      case "POST /fapi/v3/leverage":
        st.leverage = Number(params.get("leverage"));
        return json({ leverage: st.leverage });
      case "POST /fapi/v3/marginType":
        st.marginType = String(params.get("marginType")).toLowerCase();
        return json({ code: 200, msg: "success" });
      case "POST /fapi/v3/placeStrategyOrder": {
        const legs = JSON.parse(params.get("subOrderList") ?? "[]") as Array<Record<string, string>>;
        const e = legs[0]!;
        st.orders.push({ orderId: nextId++, clientOrderId: e.clientOrderId!, type: "LIMIT", side: "BUY", price: e.price!, stopPrice: "0", origQty: e.quantity!, reduceOnly: "false", status: "NEW", executedQty: "0", avgPrice: "0" });
        return json({ strategyId: nextId++, strategyStatus: "WORKING", failureCode: 0 });
      }
      case "POST /fapi/v3/order": {
        if (init.failNewStop && params.get("type") === "STOP_MARKET") return json({ code: -2010, msg: "fake refusal" }, 400);
        const o: FakeOrder = { orderId: nextId++, clientOrderId: params.get("newClientOrderId")!, type: params.get("type")!, side: params.get("side")!, price: "0", stopPrice: params.get("stopPrice") ?? "0", origQty: params.get("quantity")!, reduceOnly: params.get("reduceOnly") ?? "false", status: "NEW", executedQty: "0", avgPrice: "0" };
        if (o.type === "MARKET") {
          st.positionAmt = Math.max(0, st.positionAmt - Number(o.origQty));
          o.status = "FILLED";
          st.done.push(o);
        } else st.orders.push(o);
        return json(o);
      }
      case "GET /fapi/v3/order": {
        const id = params.get("origClientOrderId");
        const o = [...st.orders, ...st.done].find((x) => x.clientOrderId === id);
        if (!o || (init.readBackMissing && o.type === "STOP_MARKET")) return json({ code: -2013, msg: "Order does not exist." }, 400);
        return json({ symbol: "BTCUSDT", ...o });
      }
      case "DELETE /fapi/v3/order": {
        const id = params.get("origClientOrderId");
        const i = st.orders.findIndex((x) => x.clientOrderId === id);
        if (i < 0) return json({ code: -2011, msg: "Unknown order sent." }, 400);
        const [o] = st.orders.splice(i, 1);
        o!.status = "CANCELED";
        st.done.push(o!);
        return json(o);
      }
      default:
        return json({ code: -1, msg: `fake has no ${method} ${u.pathname}` }, 404);
    }
  };
  const s = privateKeySigner(DEMO_KEY);
  const client = new AsterClient({ fetch, auth: { user: ("0x" + "a".repeat(40)) as `0x${string}`, signer: s.address, sign: s.sign } });
  const sent = (method: string, p: string) => calls.filter((c) => c.method === method && c.path === p);
  /** The fake's matching engine: the entry fills. */
  const fillEntry = (clientId: string) => {
    const i = st.orders.findIndex((x) => x.clientOrderId === `${clientId}-E`);
    const [o] = st.orders.splice(i, 1);
    o!.status = "FILLED";
    o!.executedQty = o!.origQty;
    o!.avgPrice = o!.price;
    st.done.push(o!);
    st.positionAmt += Number(o!.origQty);
  };
  return { client, st, calls, sent, fillEntry };
}

function routes(v: ReturnType<typeof fakeVenue>, opts: { ledger?: SetLedger; token?: string | null; live?: boolean; cap?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wc-"));
  const counterFile = path.join(dir, "wc-entries.json");
  const r = createWcRoutes({
    client: v.client,
    loadLedger: async () => opts.ledger ?? emptyLedger(),
    counterFile,
    token: opts.token === undefined ? TOKEN : opts.token,
    maxTicketUsd: opts.cap ?? 5,
    liveTrading: opts.live ?? true,
    now: () => 1_795_600_000_000,
  });
  return { r, counterFile };
}

/** Call handle() like the server does and return status and body. */
async function call(r: ReturnType<typeof createWcRoutes>, method: string, p: string, body: unknown = {}, token: string | null = TOKEN) {
  let status = 0;
  let text = "";
  const res = { writeHead: (s: number) => { status = s; }, end: (t: string) => { text = t; } } as never;
  const req = { method, headers: token === null ? {} : { "x-wc-token": token } } as never;
  await r.handle(req, res, new URL(`http://x${p}`), async () => body);
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

const ORDER = { clientId: "wc_t1", quantity: "0.001", price: "57000", takeProfit: "62600", stop: "54700", leverage: 20, symbol: "BTCUSDT" };

describe("Wick Catcher routes: guards refuse and send nothing (HYBRID, negative)", () => {
  const cases: Array<[string, () => ReturnType<typeof fakeVenue>, Partial<Parameters<typeof routes>[1]>, Record<string, unknown>, string | null, RegExp]> = [
    ["no token file on the server", () => fakeVenue(), { token: null }, ORDER, TOKEN, /no Wick Catcher token file/],
    ["wrong token", () => fakeVenue(), {}, ORDER, "x".repeat(40), /Wrong or missing/],
    ["missing token", () => fakeVenue(), {}, ORDER, null, /Wrong or missing/],
    ["a symbol other than BTCUSDT", () => fakeVenue(), {}, { ...ORDER, symbol: "ETHUSDT" }, TOKEN, /BTCUSDT only/],
    ["leverage other than 20", () => fakeVenue(), {}, { ...ORDER, leverage: 50 }, TOKEN, /20x only/],
    ["margin above the cap", () => fakeVenue(), {}, { ...ORDER, quantity: "0.002" }, TOKEN, /above Wick Catcher's cap of \$5/],
    ["a foreign order on BTC", () => fakeVenue({ foreign: true }), {}, ORDER, TOKEN, /not Wick Catcher's/],
    ["a live Set on BTC", () => fakeVenue(), { ledger: { version: 1, sets: [{ id: "set_live", symbol: "BTCUSDT", status: "open" }] } as unknown as SetLedger }, ORDER, TOKEN, /live Set \(set_live\)/],
    ["a position on BTC", () => fakeVenue({ positionAmt: 0.001 }), {}, ORDER, TOKEN, /already has an open position/],
    ["LIVE_TRADING off", () => fakeVenue(), { live: false }, ORDER, TOKEN, /LIVE_TRADING is not true/],
    ["a stop under the liquidation estimate", () => fakeVenue(), {}, { ...ORDER, stop: "54200" }, TOKEN, /liquidation estimate/],
    ["a client id without wc_", () => fakeVenue(), {}, { ...ORDER, clientId: "set_x1" }, TOKEN, /start with wc_/],
  ];
  for (const [name, mk, opts, body, token, msg] of cases) {
    it(`refuses: ${name}`, async () => {
      const v = mk();
      const { r, counterFile } = routes(v, opts);
      const out = await call(r, "POST", "/api/wc/place", body, token);
      expect(out.status).toBe(409);
      expect(String(out.body.message)).toMatch(msg);
      expect(v.sent("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(0);
      expect(v.sent("POST", "/fapi/v3/leverage")).toHaveLength(0);
      expect(existsSync(counterFile) ? (await loadCounter(counterFile)).entries : []).toHaveLength(0);
    });
  }
});

describe("Wick Catcher routes: place, one trade, cancel, close (HYBRID)", () => {
  it("place sends one OTOCO with reduce-only exits on the mark price, sets 20x first, and saves the counter before sending", async () => {
    const v = fakeVenue({ leverage: 30 });
    const { r, counterFile } = routes(v);
    const out = await call(r, "POST", "/api/wc/place", ORDER);
    expect(out.status).toBe(200);
    expect(v.sent("POST", "/fapi/v3/leverage")[0]!.params.get("leverage")).toBe("20");
    const p = v.sent("POST", "/fapi/v3/placeStrategyOrder")[0]!.params;
    expect(p.get("strategyType")).toBe("OTOCO");
    expect(p.get("clientStrategyId")).toBe("wc_t1");
    const legs = JSON.parse(p.get("subOrderList")!) as Array<Record<string, string>>;
    expect(legs.map((l) => [l.type, l.clientOrderId])).toEqual([["LIMIT", "wc_t1-E"], ["TAKE_PROFIT_MARKET", "wc_t1-T"], ["STOP_MARKET", "wc_t1-S"]]);
    expect(legs[0]).toMatchObject({ side: "BUY", price: "57000.0", quantity: "0.001", timeInForce: "GTC" });
    expect(legs[1]).toMatchObject({ side: "SELL", stopPrice: "62600.0", reduceOnly: "true", workingType: "MARK_PRICE" });
    expect(legs[2]).toMatchObject({ side: "SELL", stopPrice: "54700.0", reduceOnly: "true", workingType: "MARK_PRICE" });
    const c = await loadCounter(counterFile);
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]).toMatchObject({ clientId: "wc_t1", status: "working" });
  });

  it("after one filled entry a second place is refused by the server's counter (the venue would accept it)", async () => {
    const v = fakeVenue();
    const { r, counterFile } = routes(v);
    expect((await call(r, "POST", "/api/wc/place", ORDER)).status).toBe(200);
    v.fillEntry("wc_t1");
    v.st.positionAmt = 0; // the position already closed by its exits: only the counter can refuse now
    const out = await call(r, "POST", "/api/wc/place", { ...ORDER, clientId: "wc_t2" });
    expect(out.status).toBe(409);
    expect(String(out.body.message)).toMatch(/One trade means one filled entry, and wc_t1 has filled/);
    expect(v.sent("POST", "/fapi/v3/placeStrategyOrder")).toHaveLength(1);
    expect((await loadCounter(counterFile)).entries[0]!.status).toBe("filled");
  });

  it("an expired, unfilled bid does not use up the one trade", async () => {
    const v = fakeVenue();
    const { r } = routes(v);
    await call(r, "POST", "/api/wc/place", ORDER);
    const c = await call(r, "POST", "/api/wc/cancel", { clientId: "wc_t1" });
    expect(c.status).toBe(200);
    expect((c.body.entry as Record<string, unknown>).status).toBe("closed-unfilled");
    expect((await call(r, "POST", "/api/wc/place", { ...ORDER, clientId: "wc_t2" })).status).toBe(200);
  });

  it("state lists own and foreign orders, the maintenance rate, the counter", async () => {
    const v = fakeVenue();
    const { r } = routes(v);
    await call(r, "POST", "/api/wc/place", ORDER);
    const s = await call(r, "GET", "/api/wc/state");
    expect(s.status).toBe(200);
    expect((s.body.wcOrders as unknown[]).length).toBe(1);
    expect(s.body.maintenanceRate).toBe(0.004);
    expect(s.body.busyByOther).toBe(false);
    expect(s.body.maxTicketUsd).toBe(5);
  });

  it("close sends a reduce-only market sell, and refuses more than the position", async () => {
    const v = fakeVenue({ positionAmt: 0.001 });
    const { r } = routes(v);
    expect((await call(r, "POST", "/api/wc/close", { quantity: "0.002" })).status).toBe(409);
    const out = await call(r, "POST", "/api/wc/close", { quantity: "0.001" });
    expect(out.status).toBe(200);
    const p = v.sent("POST", "/fapi/v3/order")[0]!.params;
    expect([p.get("type"), p.get("side"), p.get("reduceOnly")]).toEqual(["MARKET", "SELL", "true"]);
    expect(v.st.positionAmt).toBe(0);
  });
});

describe("Wick Catcher routes: move-stop keeps a stop at every moment (HYBRID)", () => {
  const body = { oldClientOrderId: "wc_t1-S", newClientOrderId: "wc_t1m1-S", stopPrice: "57200", quantity: "0.001" };
  function withOldStop(v: ReturnType<typeof fakeVenue>) {
    v.st.orders.push({ orderId: 1, clientOrderId: "wc_t1-S", type: "STOP_MARKET", side: "SELL", price: "0", stopPrice: "54700", origQty: "0.001", reduceOnly: "true", status: "NEW", executedQty: "0", avgPrice: "0" });
  }
  it("places the new stop, reads it back, then cancels the old one, in that order", async () => {
    const v = fakeVenue({ positionAmt: 0.001 });
    withOldStop(v);
    const { r } = routes(v);
    const out = await call(r, "POST", "/api/wc/move-stop", body);
    expect(out.status).toBe(200);
    const seq = v.calls.filter((c) => c.path === "/fapi/v3/order").map((c) => `${c.method} ${c.params.get("newClientOrderId") ?? c.params.get("origClientOrderId")}`);
    expect(seq).toEqual(["POST wc_t1m1-S", "GET wc_t1m1-S", "DELETE wc_t1-S"]);
    expect(v.st.orders.map((o) => o.clientOrderId)).toEqual(["wc_t1m1-S"]);
  });
  it("when the new stop is refused, the old one stays", async () => {
    const v = fakeVenue({ positionAmt: 0.001, failNewStop: true });
    withOldStop(v);
    const { r } = routes(v);
    const out = await call(r, "POST", "/api/wc/move-stop", body);
    expect(out.status).toBe(502);
    expect(v.sent("DELETE", "/fapi/v3/order")).toHaveLength(0);
    expect(v.st.orders.map((o) => o.clientOrderId)).toEqual(["wc_t1-S"]);
  });
  it("when the new stop cannot be read back, the old one stays", async () => {
    const v = fakeVenue({ positionAmt: 0.001, readBackMissing: true });
    withOldStop(v);
    const { r } = routes(v);
    const out = await call(r, "POST", "/api/wc/move-stop", body);
    expect(out.status).toBe(409);
    expect(String(out.body.message)).toMatch(/old stop wc_t1-S was kept/);
    expect(v.sent("DELETE", "/fapi/v3/order")).toHaveLength(0);
  });
});

describe("the card never shares BTC with a resting Wick Catcher order", () => {
  it("checkCoinIsFree counts an open wc_ order as busy (REAL, negative)", () => {
    expect(checkCoinIsFree({ symbol: "BTCUSDT", positionAmts: [0], liveSetIds: [], openOrderClientIds: ["wc_t1-E"] })).toMatchObject({ ok: false, message: expect.stringMatching(/resting Wick Catcher order \(wc_t1-E\)/) });
    expect(checkCoinIsFree({ symbol: "BTCUSDT", positionAmts: [0], liveSetIds: [], openOrderClientIds: ["web_x"] })).toEqual({ ok: true });
  });
  it("the card's preTradeCheck refuses BTC while a wc_ bid rests (HYBRID)", async () => {
    const v = fakeVenue();
    const { r } = routes(v);
    await call(r, "POST", "/api/wc/place", ORDER);
    const rules = await v.client.getSymbolRules("BTCUSDT");
    const plan = { input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 3 } } as unknown as SetPlan;
    const res = await preTradeCheck(v.client, plan, rules, { ledger: emptyLedger(), mode: "one-way", rows: [] });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toMatch(/resting Wick Catcher order \(wc_t1-E\)/);
  });
});

describe("token file", () => {
  it("a short or missing token file closes the routes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wct-"));
    expect(readTokenFile(path.join(dir, "none"))).toBeNull();
    writeFileSync(path.join(dir, "short"), "abc");
    expect(readTokenFile(path.join(dir, "short"))).toBeNull();
    writeFileSync(path.join(dir, "ok"), TOKEN + "\n");
    expect(readTokenFile(path.join(dir, "ok"))).toBe(TOKEN);
  });
});
