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
  selectTraders,
  toNum,
  type LeaderboardTrader,
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
    // Month volume read from the same window ("vlm": "44831001610.1899795532").
    expect(Math.round(t.find((x) => x.address === "0xf5d81a135f756ca16544e53c20fc20643ec3ad53")!.monthVolumeUsd)).toBe(44831001610);
  });
  it("leaderboard can rank by 30-day volume", () => {
    const t = parseLeaderboard(LB, { topN: 10, minAccountValueUsd: 1, rankBy: "monthVolume" });
    for (let i = 1; i < t.length; i++) expect(t[i - 1]!.monthVolumeUsd).toBeGreaterThanOrEqual(t[i]!.monthVolumeUsd);
  });
  it("selectTraders: orders from the top by profit; positions = top by profit + top by volume, no duplicates", () => {
    const mk = (i: number, pnl: number, vol: number, acct: number): LeaderboardTrader => ({
      address: "0x" + i.toString(16).padStart(40, "0"),
      accountValueUsd: acct,
      monthPnlUsd: pnl,
      monthRoi: 0.1,
      monthVolumeUsd: vol,
    });
    const all = [mk(1, 900, 10, 200_000), mk(2, 800, 5_000, 200_000), mk(3, 50, 9_000, 20_000), mk(4, 40, 1, 5_000), mk(5, 30, 8_000, 200_000)];
    const sel = selectTraders(all, { ordersTopN: 2, positionsByPnlTopN: 2, positionsByVolumeTopN: 2, minAccountValueUsd: 100_000, minAccountValueForVolumeUsd: 10_000 });
    expect(sel.orders.map((t) => t.monthPnlUsd)).toEqual([900, 800]);
    // pnl ranks: 1, 2; volume ranks (>= $10k accounts): 3 (9,000), 5 (8,000). Account 4 is under every floor.
    expect(sel.positions.map((t) => t.monthPnlUsd)).toEqual([900, 800, 50, 30]);
    const dup = selectTraders(all, { ordersTopN: 1, positionsByPnlTopN: 2, positionsByVolumeTopN: 3, minAccountValueUsd: 100_000, minAccountValueForVolumeUsd: 10_000 });
    expect(new Set(dup.positions.map((t) => t.address)).size).toBe(dup.positions.length); // trader 2 is in both ranks, listed once
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

  it("merges levels across traders, caches per coin and per address, and logs structural counts", async () => {
    const { f, stats } = fakeFetch();
    const lines: string[] = [];
    let now = 1_000;
    const src = new HyperliquidLevelSource({ fetch: f, now: () => now, log: (l) => lines.push(l), minAccountValueUsd: 1, minAccountValueForVolumeUsd: 1 });
    const a = await src.getLevels("BTC");
    expect(a.report.addressesRead).toBeGreaterThan(0);
    expect(a.report.positionAddresses).toBe(a.report.addressesRead); // 3 fixture rows: every one is in the positions set
    expect(a.levels.liquidationLevels).toHaveLength(a.report.positionAddressesOk); // one BTC position per trader fixture
    expect(a.report.positionsWithLiquidationPx).toBe(a.levels.liquidationLevels.length);
    expect(a.levels.limitLevels).toHaveLength(4 * a.report.orderAddressesOk);
    expect(a.report.weightSpent).toBe(a.report.positionAddresses * 2 + a.report.orderAddresses * 20);
    expect(lines.some((l) => l.includes("leaderboard read: 3 rows"))).toBe(true);
    expect(lines.some((l) => /positions with liquidationPx \d+/.test(l))).toBe(true);
    const callsAfterFirst = stats().infoCalls;
    // ETH right after: the per-address answers are shared, so no new requests.
    await src.getLevels("ETH");
    expect(stats().infoCalls).toBe(callsAfterFirst);
    now += 10_000; // inside the 60 s coin cache
    const b = await src.getLevels("BTC");
    expect(b.report.fromCache).toBe(true);
    expect(stats().infoCalls).toBe(callsAfterFirst);
    now += 120_000; // caches expired; leaderboard (6 h) still cached
    await src.getLevels("BTC");
    expect(stats().lbCalls).toBe(1);
    expect(stats().infoCalls).toBe(callsAfterFirst * 2);
  });

  it("asks positions with clearinghouseState and orders with frontendOpenOrders only for their own sets", async () => {
    const bodies: string[] = [];
    const f = async (url: string, init?: RequestInit) => {
      if (url.includes("leaderboard")) return new Response(JSON.stringify(LB));
      const body = JSON.parse(String(init?.body));
      bodies.push(body.type);
      return new Response(JSON.stringify(body.type === "clearinghouseState" ? CS : OO));
    };
    const src = new HyperliquidLevelSource({ fetch: f, log: () => undefined, minAccountValueUsd: 1, minAccountValueForVolumeUsd: 1, ordersTopN: 1 });
    const r = await src.getLevels("BTC");
    expect(bodies.filter((b) => b === "frontendOpenOrders")).toHaveLength(1);
    expect(bodies.filter((b) => b === "clearinghouseState")).toHaveLength(r.report.positionAddresses);
  });

  it("a weight budget too small skips requests, counts them, and fails loudly when nothing was sent (negative)", async () => {
    const { f, stats } = fakeFetch();
    const src = new HyperliquidLevelSource({ fetch: f, log: () => undefined, minAccountValueUsd: 1, minAccountValueForVolumeUsd: 1, weightBudgetPerMinute: 4 });
    const r = await src.getLevels("BTC");
    expect(r.report.positionAddressesOk).toBe(2); // 2 x weight 2 = 4 fits, the third does not
    expect(r.report.skippedByRateBudget).toBe(r.report.positionAddresses - 2 + r.report.orderAddresses);
    expect(stats().infoCalls).toBe(2);
    const none = new HyperliquidLevelSource({ fetch: f, log: () => undefined, minAccountValueUsd: 1, minAccountValueForVolumeUsd: 1, weightBudgetPerMinute: 1 });
    await expect(none.getLevels("BTC")).rejects.toThrow(/rate budget used up/);
  });

  it("ignores a disk cache written for another trader selection (the old 30-trader file)", async () => {
    const { f, stats } = fakeFetch();
    const old = JSON.stringify({ at: 1_000, traders: [{ address: "0x" + "1".repeat(40), accountValueUsd: 1, monthPnlUsd: 1, monthRoi: 0 }] });
    let written = "";
    const src = new HyperliquidLevelSource({
      fetch: f,
      now: () => 2_000,
      log: () => undefined,
      minAccountValueUsd: 1,
      diskCache: { read: async () => old, write: async (t) => void (written = t) },
    });
    await src.getTopTraders();
    expect(stats().lbCalls).toBe(1); // downloaded again instead of trusting the old file
    expect(JSON.parse(written).key).toMatch(/^v2:/);
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
