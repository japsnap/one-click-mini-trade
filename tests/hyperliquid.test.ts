/**
 * Hyperliquid level source tests.
 *  - Parsers: REAL against fixtures captured from live public responses (tests/fixtures/SOURCES.txt).
 *  - Source with cache and concurrency: HYBRID. A fake fetch serves the same fixtures by request
 *    body; it proves routing, caching and failure handling, not the network (the live smoke does that).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  coinFromSymbol,
  HyperliquidLevelSource,
  mapLimited,
  parseClearinghouseState,
  parseFrontendOpenOrders,
  parseLeaderboard,
  toNum,
} from "../src/levels/hyperliquid";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const LB = fx("hl-leaderboard.json");
const CS = fx("hl-clearinghouseState.json");
const OO = fx("hl-frontendOpenOrders.json");

describe("parsers on real captured responses", () => {
  it("leaderboard: keeps profitable traders above the account floor, sorted by 30-day profit", () => {
    const t = parseLeaderboard(LB, { topN: 10, minAccountValueUsd: 100_000 });
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThanOrEqual(3);
    for (const x of t) {
      expect(x.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(x.monthPnlUsd).toBeGreaterThan(0);
      expect(x.accountValueUsd).toBeGreaterThanOrEqual(100_000);
    }
    for (let i = 1; i < t.length; i++) expect(t[i - 1]!.monthPnlUsd).toBeGreaterThanOrEqual(t[i]!.monthPnlUsd);
    // First fixture row: month pnl "23567077.9121000059" read from a string.
    expect(t.some((x) => x.address === "0xf5d81a135f756ca16544e53c20fc20643ec3ad53" && Math.round(x.monthPnlUsd) === 23567078)).toBe(true);
  });
  it("clearinghouseState: BTC short position becomes a SHORT liquidation level weighted by positionValue", () => {
    expect(parseClearinghouseState(CS, "BTC")).toEqual([{ price: 117068.4468533758, weightUsd: 56209834.1336999983, positionSide: "short" }]);
    expect(parseClearinghouseState(CS, "DOGE")).toEqual([]);
  });
  it("frontendOpenOrders: bids and asks on the coin only, weight = price x size", () => {
    const { limits, takeProfits } = parseFrontendOpenOrders(OO, "BTC");
    expect(limits).toHaveLength(4); // the ZEC order is dropped
    expect(limits[0]).toEqual({ price: 64418, weightUsd: 64418 * 0.9, side: "buy" });
    expect(limits.filter((l) => l.side === "sell")).toHaveLength(2);
    expect(takeProfits).toEqual([]);
  });
  it("classifies take-profit triggers and reduce-only limits as TPs, ignores stop-losses", () => {
    const orders = [
      { coin: "BTC", side: "A", limitPx: "70000.0", sz: "0.0", isTrigger: true, triggerPx: "70000.0", orderType: "Take Profit Market", reduceOnly: true },
      { coin: "BTC", side: "A", limitPx: "60000.0", sz: "1.0", isTrigger: true, triggerPx: "60000.0", orderType: "Stop Market", reduceOnly: true },
      { coin: "BTC", side: "B", limitPx: "62000.0", sz: "2.0", isTrigger: false, triggerPx: "0.0", orderType: "Limit", reduceOnly: true },
    ];
    const r = parseFrontendOpenOrders(orders, "BTC");
    expect(r.takeProfits).toEqual([
      { price: 70000, weightUsd: 0 },
      { price: 62000, weightUsd: 124000 },
    ]);
    expect(r.limits).toEqual([]);
  });
  it("coerces junk at the boundary instead of trusting it (negative)", () => {
    expect(parseLeaderboard(null)).toEqual([]);
    expect(parseLeaderboard({ leaderboardRows: "oops" })).toEqual([]);
    expect(parseClearinghouseState({ assetPositions: [{ position: { coin: "BTC", szi: "x", liquidationPx: null } }] }, "BTC")).toEqual([]);
    expect(parseClearinghouseState({}, "BTC")).toEqual([]);
    expect(parseFrontendOpenOrders({ not: "an array" }, "BTC")).toEqual({ limits: [], takeProfits: [] });
    expect(toNum("12.5")).toBe(12.5);
    expect(Number.isNaN(toNum(undefined))).toBe(true);
    expect(coinFromSymbol("BTCUSDT")).toBe("BTC");
  });
});

describe("HyperliquidLevelSource", () => {
  function fakeFetch(opts: { failInfo?: boolean } = {}) {
    let infoCalls = 0;
    let lbCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes("leaderboard")) {
        lbCalls++;
        return new Response(JSON.stringify(LB));
      }
      infoCalls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      if (opts.failInfo) return new Response("busy", { status: 429 });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(body.type === "clearinghouseState" ? CS : OO));
    };
    return { f, stats: () => ({ infoCalls, lbCalls, maxInFlight }) };
  }

  it("merges levels across traders, caches per coin, and logs structural counts", async () => {
    const { f, stats } = fakeFetch();
    const lines: string[] = [];
    let now = 1_000;
    const src = new HyperliquidLevelSource({ fetch: f, now: () => now, log: (l) => lines.push(l), minAccountValueUsd: 1 });
    const a = await src.getLevels("BTC");
    expect(a.report.tradersKept).toBeGreaterThan(0);
    expect(a.levels.liquidationLevels).toHaveLength(a.report.tradersKept); // one BTC position per trader fixture
    expect(a.levels.limitLevels).toHaveLength(4 * a.report.tradersKept);
    expect(lines.some((l) => l.includes("leaderboard read: 3 rows"))).toBe(true);
    const callsAfterFirst = stats().infoCalls;
    now += 10_000; // inside the 30 s coin cache
    const b = await src.getLevels("BTC");
    expect(b.report.fromCache).toBe(true);
    expect(stats().infoCalls).toBe(callsAfterFirst);
    now += 60_000; // coin cache expired; leaderboard (6 h) still cached
    await src.getLevels("BTC");
    expect(stats().lbCalls).toBe(1);
    expect(stats().infoCalls).toBe(callsAfterFirst * 2);
  });

  it("all trader requests failing is a loud error, not empty levels (negative)", async () => {
    const { f } = fakeFetch({ failInfo: true });
    const src = new HyperliquidLevelSource({ fetch: f, log: () => undefined, minAccountValueUsd: 1 });
    await expect(src.getLevels("BTC")).rejects.toThrow(/all \d+ Hyperliquid trader requests failed/);
  });

  it("mapLimited never exceeds its limit and keeps errors per item", async () => {
    let inFlight = 0;
    let max = 0;
    const r = await mapLimited([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((res) => setTimeout(res, 3));
      inFlight--;
      if (x === 4) throw new Error("boom");
      return x * 2;
    });
    expect(max).toBeLessThanOrEqual(3);
    expect(r[3]).toBeInstanceOf(Error);
    expect(r[6]).toBe(14);
  });
});
