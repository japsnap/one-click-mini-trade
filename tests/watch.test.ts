/**
 * The Set watcher (server/watch.ts), HYBRID: the real watcher, ledger and AsterClient (real
 * EIP-712 signatures) against a stateful FAKE Aster (no network) and a fake socket. The
 * assertions read the requests the fake received (cancels by client order id) and the
 * ledger saved afterwards. Not proven here: that Aster's GET /fapi/v3/order answers for
 * OTOCO sub-orders by client order id, and that the real stream behaves as the fake one;
 * the first live run of scripts/watch.ts --dry shows both.
 *
 * The seeded ledger mirrors the real one of 2026-11-19: a $10 ETH Set at 30x, sent, whose
 * fill the ledger never saw (the demo server had no stream).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetRecord, emptyLedger, filledQty, setPnl, type SetLedger } from "../src/core/ledger";
import type { SymbolRules } from "../src/core/types";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";
import { memoryLedgerStore } from "../server/execute";
import { SetWatcher, type SocketLike, type WatchLogEntry } from "../server/watch";

const ETH: SymbolRules = { symbol: "ETHUSDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
const DEMO_KEY = "0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1" as const;
const ID = "set_mwnguh2nkg6d0";

interface FakeOrder {
  status: string;
  executedQty: number;
  avgPrice: number;
  orderId: number;
}

function fakeAster(positionAmt: number) {
  const state = {
    positionAmt,
    orders: new Map<string, FakeOrder>([
      [`${ID}-1E`, { status: "FILLED", executedQty: 0.166, avgPrice: 1805.73, orderId: 1 }],
      [`${ID}-1T`, { status: "NEW", executedQty: 0, avgPrice: 0, orderId: 2 }],
      [`${ID}-1S`, { status: "NEW", executedQty: 0, avgPrice: 0, orderId: 3 }],
    ]),
    keys: 0,
  };
  const calls: Array<{ method: string; path: string; params: URLSearchParams }> = [];
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
  const fetch = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const params = new URLSearchParams(method === "GET" ? u.search.slice(1) : String(init?.body ?? ""));
    calls.push({ method, path: u.pathname, params });
    const cid = params.get("origClientOrderId") ?? "";
    switch (`${method} ${u.pathname}`) {
      case "GET /fapi/v3/positionRisk":
        return json([{ symbol: "ETHUSDT", positionSide: "BOTH", positionAmt: String(state.positionAmt), entryPrice: "1805.73", liquidationPrice: "1759", markPrice: "1800", leverage: "30" }]);
      case "GET /fapi/v3/order": {
        const o = state.orders.get(cid);
        if (!o) return json({ code: -2013, msg: "Order does not exist." }, 400);
        return json({ symbol: "ETHUSDT", clientOrderId: cid, orderId: o.orderId, status: o.status, executedQty: String(o.executedQty), avgPrice: String(o.avgPrice), updateTime: 1 });
      }
      case "DELETE /fapi/v3/order": {
        const o = state.orders.get(cid);
        if (!o || o.status !== "NEW") return json({ code: -2011, msg: "Unknown order sent." }, 400);
        o.status = "CANCELED";
        return json({ status: "CANCELED", clientOrderId: cid });
      }
      case "POST /fapi/v3/listenKey":
        return json({ listenKey: `key${++state.keys}` });
      case "PUT /fapi/v3/listenKey":
        return json({});
      default:
        return json({ code: -1, msg: `fake has no ${method} ${u.pathname}` }, 404);
    }
  };
  const s = privateKeySigner(DEMO_KEY);
  const client = new AsterClient({ fetch, auth: { user: ("0x" + "a".repeat(40)) as `0x${string}`, signer: s.address, sign: s.sign } });
  const of = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
  const cancelled = () => of("DELETE", "/fapi/v3/order").map((c) => c.params.get("origClientOrderId"));
  return { client, state, of, cancelled };
}

/** The live ETH Set as the ledger knew it: sent, entry working, no fill recorded. */
function liveLedger(): SetLedger {
  const l = emptyLedger();
  const r = createSetRecord({ id: ID, symbol: "ETHUSDT", side: "buy", leverage: 30, ticketUsd: 10, positionMode: "one-way", now: 0, legs: [{ entryType: "MARKET", qty: 0.166, price: null, takeProfitPrice: 1900.12, stopPrice: 1758.19 }] });
  r.legs[0]!.sent = "sent";
  r.legs[0]!.strategyId = "39956667";
  r.legs[0]!.entry.state = "working";
  l.sets.push(r);
  return l;
}

/** A socket the test drives by hand. */
function fakeSockets() {
  const made: Array<SocketLike & { url: string; closed: boolean }> = [];
  const open = (url: string) => {
    const s = { url, closed: false, onopen: null, onmessage: null, onclose: null, onerror: null, close() { s.closed = true; s.onclose?.({}); } } as SocketLike & { url: string; closed: boolean };
    made.push(s);
    return s;
  };
  return { made, open };
}

function watcher(fake: ReturnType<typeof fakeAster>, store = memoryLedgerStore(liveLedger()), extra: Partial<ConstructorParameters<typeof SetWatcher>[0]> = {}) {
  const logs: WatchLogEntry[] = [];
  let t = 0;
  const clock = { set: (x: number) => (t = x) };
  const w = new SetWatcher({ client: fake.client, store, rulesFor: async () => ETH, log: (e) => logs.push(e), openSocket: fakeSockets().open, now: () => t, ...extra });
  return { w, store, logs, clock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Watcher: the position was closed by hand", () => {
  it("both exits are cancelled by client order id and the Set is closed outside the Set, on the second sight; the missed entry fill is caught up first", async () => {
    const fake = fakeAster(0);
    const { w, store, logs, clock } = watcher(fake);
    const first = await w.checkSymbol("ETHUSDT", "poll");
    expect(first.cancelled).toEqual([]); // first sight: wait (a fill event may be on its way)
    expect(fake.cancelled()).toEqual([]);
    expect(filledQty(store.current().sets[0]!.legs[0]!.entry)).toBe(0.166); // caught up from GET /fapi/v3/order

    clock.set(6_000);
    const second = await w.checkSymbol("ETHUSDT", "poll");
    expect(fake.cancelled().sort()).toEqual([`${ID}-1S`, `${ID}-1T`]);
    expect(second.closedOutside).toEqual([ID]);
    const set = store.current().sets[0]!;
    expect(set.status).toBe("closed-outside");
    expect(set.closeReason).toBe("closed outside the Set");
    expect(setPnl(set).profitShare.blackboardUsd).toBe(0);
    expect(fake.of("POST", "/fapi/v3/order")).toHaveLength(0); // never places anything
    expect(logs.filter((l) => l.event === "cancel").map((l) => l.message).join(" ")).toMatch(new RegExp(`cancelled ${ID}-1T.*cancelled ${ID}-1S`));
    expect(logs.some((l) => l.event === "check" && /\[counts\] poll: live Sets 1, position BOTH 0, uncovered 1, acted on 1, cancelled 2/.test(l.message))).toBe(true);

    // Nothing left to watch: a third check does nothing.
    clock.set(30_000);
    expect((await w.checkSymbol("ETHUSDT", "poll")).cancelled).toEqual([]);
    expect(fake.cancelled()).toHaveLength(2);
  });

  it("position still there: nothing is cancelled, however often it checks (negative)", async () => {
    const fake = fakeAster(0.166);
    const { w, store, clock } = watcher(fake);
    for (const t of [0, 6_000, 20_000]) {
      clock.set(t);
      await w.checkSymbol("ETHUSDT", "poll");
    }
    expect(fake.cancelled()).toEqual([]);
    expect(store.current().sets[0]!.status).toBe("open");
    // A smaller position no longer covers the Set: that counts as closed elsewhere.
    fake.state.positionAmt = 0.1;
    clock.set(30_000);
    await w.checkSymbol("ETHUSDT", "poll");
    clock.set(36_000);
    await w.checkSymbol("ETHUSDT", "poll");
    expect(fake.cancelled().sort()).toEqual([`${ID}-1S`, `${ID}-1T`]);
  });

  it("the position is gone because the take-profit filled: the Set is closed by its own exit and only the stop is cancelled", async () => {
    const fake = fakeAster(0);
    fake.state.orders.set(`${ID}-1T`, { status: "FILLED", executedQty: 0.166, avgPrice: 1900.12, orderId: 2 });
    const { w, store, logs, clock } = watcher(fake);
    await w.checkSymbol("ETHUSDT", "poll");
    clock.set(6_000);
    const r = await w.checkSymbol("ETHUSDT", "poll");
    expect(r.closedOutside).toEqual([]);
    expect(fake.cancelled()).toEqual([`${ID}-1S`]);
    const set = store.current().sets[0]!;
    expect(set.status).toBe("closed");
    expect(setPnl(set).grossPnlUsd).toBeCloseTo(0.166 * (1900.12 - 1805.73), 2);
    expect(logs.some((l) => l.event === "closed-by-exit")).toBe(true);
  });

  it("--dry reports what it would cancel and changes nothing: no cancel sent, the real ledger untouched", async () => {
    const fake = fakeAster(0);
    const real = memoryLedgerStore(liveLedger());
    const before = real.current();
    const { w, logs, clock } = watcher(fake, real, { dry: true });
    await w.checkSymbol("ETHUSDT", "poll");
    clock.set(6_000);
    await w.checkSymbol("ETHUSDT", "poll");
    expect(fake.of("DELETE", "/fapi/v3/order")).toHaveLength(0);
    expect(real.current()).toEqual(before);
    expect(logs.filter((l) => l.event === "would-cancel").map((l) => l.message).sort()).toEqual([
      `would cancel ${ID}-1S (closed outside the Set)`,
      `would cancel ${ID}-1T (closed outside the Set)`,
    ]);
    expect(logs.every((l) => l.dry === true)).toBe(true);
  });
});

describe("Watcher: stream and poll", () => {
  it("a dropped stream is reconnected with backoff and a fresh listenKey; the key is kept alive every 30 minutes", async () => {
    vi.useFakeTimers();
    const fake = fakeAster(0.166);
    const sockets = fakeSockets();
    const { w } = watcher(fake, memoryLedgerStore(liveLedger()), { openSocket: sockets.open, now: () => Date.now(), pollMs: 10 * 60 * 60_000 });
    await w.start();
    expect(sockets.made).toHaveLength(1);
    expect(sockets.made[0]!.url).toBe("wss://fstream.asterdex.com/ws/key1");
    sockets.made[0]!.onopen?.({});
    sockets.made[0]!.onclose?.({}); // the stream closes itself, as in the live test
    expect(w.stats.reconnectsScheduled).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets.made).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.made).toHaveLength(2);
    expect(fake.of("POST", "/fapi/v3/listenKey")).toHaveLength(2);
    // A socket that closes before it ever opened is a failed try: the wait doubles, 2 s then 4 s.
    sockets.made[1]!.onclose?.({});
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets.made).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.made).toHaveLength(3);
    sockets.made[2]!.onclose?.({});
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sockets.made).toHaveLength(4);
    // An open stream resets the wait to 1 s.
    sockets.made[3]!.onopen?.({});
    sockets.made[3]!.onclose?.({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.made).toHaveLength(5);
    sockets.made[4]!.onopen?.({});
    expect(fake.of("PUT", "/fapi/v3/listenKey")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fake.of("PUT", "/fapi/v3/listenKey")).toHaveLength(1);
    w.stop();
  });

  it("the poll catches a hand close while the stream stays silent", async () => {
    vi.useFakeTimers();
    const fake = fakeAster(0.166);
    const sockets = fakeSockets();
    const store = memoryLedgerStore(liveLedger());
    const { w } = watcher(fake, store, { openSocket: sockets.open, now: () => Date.now() });
    await w.start();
    sockets.made[0]!.onopen?.({});
    await vi.advanceTimersByTimeAsync(0);
    fake.state.positionAmt = 0; // closed by hand; no stream message arrives
    await vi.advanceTimersByTimeAsync(15_000); // first sight
    expect(fake.cancelled()).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000); // second sight, 15 s later
    expect(fake.cancelled().sort()).toEqual([`${ID}-1S`, `${ID}-1T`]);
    expect(store.current().sets[0]!.status).toBe("closed-outside");
    w.stop();
  });

  it("stream events: an exit fill is recorded and its sibling cancelled; ACCOUNT_UPDATE on the coin triggers a check; a broken message is logged, not thrown", async () => {
    const fake = fakeAster(0.166);
    const { w, store, logs } = watcher(fake);
    await w.checkSymbol("ETHUSDT", "poll"); // catches up the entry fill
    const checks = w.stats.checks;
    await w.handleStreamMessage(JSON.stringify({ e: "ACCOUNT_UPDATE", E: 2, a: { P: [{ s: "ETHUSDT", pa: "0.166", ps: "BOTH" }] } }));
    expect(w.stats.checks).toBe(checks + 1);
    fake.state.orders.set(`${ID}-1S`, { status: "FILLED", executedQty: 0.166, avgPrice: 1758, orderId: 3 });
    fake.state.positionAmt = 0;
    await w.handleStreamMessage(JSON.stringify({ e: "ORDER_TRADE_UPDATE", E: 3, o: { s: "ETHUSDT", c: `${ID}-1S`, i: 3, x: "TRADE", X: "FILLED", l: "0.166", z: "0.166", L: "1758", n: "0.05", N: "USDT", t: 9, T: 3 } }));
    expect(fake.cancelled()).toEqual([`${ID}-1T`]);
    expect(store.current().sets[0]!.status).toBe("closed");
    await w.handleStreamMessage("{ not json");
    expect(logs.some((l) => l.level === "error" && /not JSON/.test(l.message))).toBe(true);
  });
});
