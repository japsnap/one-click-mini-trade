/**
 * Skilled traders' levels from Hyperliquid's free public data.
 *
 * Why Hyperliquid when orders go to Aster: Aster does not publish other users'
 * positions or orders (its builder endpoints only show users who approved YOUR
 * builder). Hyperliquid's ledger is public: anyone can read any address's open
 * positions (with liquidation prices) and resting orders. BTC and ETH trade at
 * nearly the same price on both venues, so a level that matters on Hyperliquid is
 * a good guide for an order on Aster.
 *
 * Flow:
 *  1. Leaderboard (stats-data.hyperliquid.xyz, about 39 MB, 47,728 rows on 2026-11-16):
 *     keep profitable traders and split them into two sets (selectTraders):
 *       orders set:    top 30 by 30-day profit (accounts >= $100k)
 *       positions set: top 50 by 30-day profit + top 150 by 30-day volume (>= $10k)
 *     Cached in memory and optionally on disk, because it is big and changes slowly.
 *  2. POST api.hyperliquid.xyz/info:
 *       {"type":"clearinghouseState","user":addr}  -> open positions (entryPx, liquidationPx, szi, positionValue)
 *                                                     for the positions set (weight 2 each)
 *       {"type":"frontendOpenOrders","user":addr}  -> resting limits and take-profit orders
 *                                                     for the orders set (weight 20 each)
 *     with a concurrency limit, a timeout per request, a per-address and per-coin cache
 *     (60 s), and a per-minute weight budget under Hyperliquid's 1,200 per IP.
 *  3. Return { limitLevels, takeProfitLevels, liquidationLevels } for one coin.
 *  4. The liquidation map ("fuel map", 2026-11-20, Sets_Rules.md A1): a second, wider sample
 *     for the take-profit only: the top 600 accounts by 30-day volume with at least $10,000,
 *     profitable or not (skill does not matter for fuel; money that gets force-closed does).
 *     Read in the BACKGROUND every 5 minutes (startFuelMap), never per request, one address
 *     at a time spread over the 5 minutes: 600 x weight 2 = 1,200 weight per 5 minutes, a
 *     fifth of Hyperliquid's 1,200 per minute, so the Nearby and Patient reads keep their
 *     share. Requests the per-minute budget refuses are counted, never hidden.
 *
 * Every field is coerced at this boundary: Hyperliquid sends numbers as strings,
 * and arrays can be missing. Anything malformed is skipped and counted, never trusted.
 */
import type { LiquidationLevel, Level, SidedLevel, TraderLevels } from "../core/types";

export const HL_LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

// ---------- boundary coercion helpers ----------

/** Number from a string or number; NaN for anything else. Hyperliquid sends "64412.0". */
export function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return Number.NaN;
}

/** An array, or [] when the field is missing or not an array. */
function toArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A plain object, or {} when not an object. */
function toObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ---------- leaderboard ----------

/** One kept trader. Units: USD. */
export interface LeaderboardTrader {
  address: string;
  accountValueUsd: number;
  monthPnlUsd: number;
  monthRoi: number;
  /** 30-day traded volume. Missing in caches written before 2026-11-16 (then NaN). */
  monthVolumeUsd: number;
}

/**
 * Read the leaderboard JSON into traders.
 * Keeps only accounts with a positive 30-day profit ("skilled": losing traders are not
 * copied) and at least minAccountValueUsd. Sorted by 30-day profit, or by 30-day volume
 * with rankBy "monthVolume". topN cuts the list (default 30; Infinity keeps all).
 * Units: minAccountValueUsd in USD.
 */
export function parseLeaderboard(
  json: unknown,
  opts: { topN?: number; minAccountValueUsd?: number; rankBy?: "monthPnl" | "monthVolume"; profitableOnly?: boolean } = {},
): LeaderboardTrader[] {
  const profitableOnly = opts.profitableOnly ?? true;
  const topN = opts.topN ?? 30;
  const minValue = opts.minAccountValueUsd ?? 100_000;
  const rows = toArr(toObj(json).leaderboardRows);
  const out: LeaderboardTrader[] = [];
  for (const r of rows) {
    const row = toObj(r);
    const address = typeof row.ethAddress === "string" ? row.ethAddress : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) continue;
    const accountValueUsd = toNum(row.accountValue);
    if (!(accountValueUsd >= minValue)) continue;
    // windowPerformances is a list of [name, {pnl, roi, vlm}] pairs; find "month".
    let monthPnlUsd = Number.NaN;
    let monthRoi = Number.NaN;
    let monthVolumeUsd = Number.NaN;
    for (const w of toArr(row.windowPerformances)) {
      const pair = toArr(w);
      if (pair[0] === "month") {
        const perf = toObj(pair[1]);
        monthPnlUsd = toNum(perf.pnl);
        monthRoi = toNum(perf.roi);
        monthVolumeUsd = toNum(perf.vlm);
      }
    }
    // Losing traders are not copied; the liquidation map reads them too (profitableOnly false).
    if (profitableOnly && (!Number.isFinite(monthPnlUsd) || monthPnlUsd <= 0)) continue;
    out.push({ address, accountValueUsd, monthPnlUsd, monthRoi, monthVolumeUsd });
  }
  if (opts.rankBy === "monthVolume") out.sort((a, b) => (b.monthVolumeUsd || 0) - (a.monthVolumeUsd || 0));
  else out.sort((a, b) => b.monthPnlUsd - a.monthPnlUsd);
  return out.slice(0, topN);
}

/** How many traders feed each kind of level. See HyperliquidSourceOptions for the why. */
export interface TraderSelectionOptions {
  /** Resting orders (Nearby, take-profit zone) from the top N by 30-day profit. Default 30. */
  ordersTopN: number;
  /** Positions (Patient) from the top N by 30-day profit... Default 50. */
  positionsByPnlTopN: number;
  /** ...plus the top N by 30-day volume (profitable only). Default 150. */
  positionsByVolumeTopN: number;
  /** Account floor for the profit ranks. Default $100,000. */
  minAccountValueUsd: number;
  /** Account floor for the volume rank. Default $10,000. */
  minAccountValueForVolumeUsd: number;
}

export const DEFAULT_TRADER_SELECTION: TraderSelectionOptions = {
  ordersTopN: 30,
  positionsByPnlTopN: 50,
  positionsByVolumeTopN: 150,
  minAccountValueUsd: 100_000,
  minAccountValueForVolumeUsd: 10_000,
};

/**
 * Split traders into the two sets the source queries.
 *  - orders:    top ordersTopN by 30-day profit (accounts >= $100k): the "skilled" set whose
 *               resting limits Nearby and the take-profit zone follow.
 *  - positions: top positionsByPnlTopN by profit, plus top positionsByVolumeTopN by volume
 *               (accounts >= $10k), without duplicates. Why the volume rank: on 2026-11-16
 *               the top 30 by profit were large, low-leverage accounts whose nearest BTC
 *               liquidation was 16.7% away; the most active profitable traders run higher
 *               leverage, and a probe of the top 167 by profit + volume found BTC short
 *               liquidations 1.03% and 4.08% above the price.
 * Input may be any traders list; floors and ranks are applied here.
 */
export function selectTraders(all: LeaderboardTrader[], o: TraderSelectionOptions = DEFAULT_TRADER_SELECTION) {
  const byPnl = all.filter((t) => t.accountValueUsd >= o.minAccountValueUsd).sort((a, b) => b.monthPnlUsd - a.monthPnlUsd);
  const byVolume = all
    .filter((t) => t.accountValueUsd >= o.minAccountValueForVolumeUsd && Number.isFinite(t.monthVolumeUsd))
    .sort((a, b) => b.monthVolumeUsd - a.monthVolumeUsd);
  const orders = byPnl.slice(0, o.ordersTopN);
  const seen = new Set<string>();
  const positions: LeaderboardTrader[] = [];
  for (const t of [...byPnl.slice(0, o.positionsByPnlTopN), ...byVolume.slice(0, o.positionsByVolumeTopN)]) {
    const k = t.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    positions.push(t);
  }
  return { orders, positions };
}

// ---------- clearinghouseState (positions) ----------

/**
 * Liquidation levels of one trader's positions on one coin.
 * szi > 0 is a long, szi < 0 a short. Weight = positionValue (USD notional);
 * if missing, |szi| x entryPx. A null or zero liquidationPx (fully collateralised) is skipped.
 * Units: prices quote per base; weights USD.
 */
export function parseClearinghouseState(json: unknown, coin: string): LiquidationLevel[] {
  const out: LiquidationLevel[] = [];
  for (const ap of toArr(toObj(json).assetPositions)) {
    const p = toObj(toObj(ap).position);
    if (p.coin !== coin) continue;
    const szi = toNum(p.szi); // signed size in coins
    const liq = toNum(p.liquidationPx);
    if (!Number.isFinite(szi) || szi === 0 || !(liq > 0)) continue;
    let weight = toNum(p.positionValue);
    if (!(weight > 0)) weight = Math.abs(szi) * toNum(p.entryPx);
    if (!(weight > 0)) continue;
    out.push({ price: liq, weightUsd: weight, positionSide: szi > 0 ? "long" : "short" });
  }
  return out;
}

// ---------- frontendOpenOrders (resting orders) ----------

/**
 * Split one trader's open orders on one coin into plain limits and take-profits.
 *  - A trigger order whose orderType mentions "Take Profit" -> take-profit at triggerPx.
 *  - A reduce-only plain limit -> take-profit at limitPx (it closes a position at a gain or loss).
 *  - Any other plain limit -> limit level; side "B" (bid) = buy, "A" (ask) = sell.
 *  - Stop losses and other triggers are ignored.
 * Weight = price x remaining size. Units: prices quote per base; weights USD.
 */
export function parseFrontendOpenOrders(json: unknown, coin: string): { limits: SidedLevel[]; takeProfits: Level[] } {
  const limits: SidedLevel[] = [];
  const takeProfits: Level[] = [];
  for (const raw of toArr(json)) {
    const o = toObj(raw);
    if (o.coin !== coin) continue;
    const sz = toNum(o.sz);
    const orderType = typeof o.orderType === "string" ? o.orderType : "";
    const isTrigger = o.isTrigger === true;
    const reduceOnly = o.reduceOnly === true;
    if (isTrigger) {
      if (!/take profit/i.test(orderType)) continue; // stop-losses are not targets
      const px = toNum(o.triggerPx);
      // Position TP/SL orders often carry sz "0.0" (they close the whole position): weight by price only then.
      if (px > 0) takeProfits.push({ price: px, weightUsd: sz > 0 ? sz * px : 0 });
      continue;
    }
    const px = toNum(o.limitPx);
    if (!(px > 0) || !(sz > 0)) continue;
    if (reduceOnly) {
      takeProfits.push({ price: px, weightUsd: sz * px });
      continue;
    }
    if (o.side === "B") limits.push({ price: px, weightUsd: sz * px, side: "buy" });
    else if (o.side === "A") limits.push({ price: px, weightUsd: sz * px, side: "sell" });
  }
  return { limits, takeProfits };
}

// ---------- fetching with cache, timeout and concurrency ----------

/** The fetch function shape we need (global fetch fits). Injected for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Structural counts from one fetch, printed at the phase boundary so a zero is loud. */
export interface LevelsReport {
  /** Traders read from the leaderboard after floors and ranks (union of both sets). */
  addressesRead: number;
  /** Addresses whose positions were requested, and how many answered / failed. */
  positionAddresses: number;
  positionAddressesOk: number;
  positionAddressesFailed: number;
  /** Addresses whose open orders were requested, and how many answered / failed. */
  orderAddresses: number;
  orderAddressesOk: number;
  orderAddressesFailed: number;
  /** Requests not sent because the per-minute weight budget was used up (counted, not hidden). */
  skippedByRateBudget: number;
  /** Positions on this coin that carry a liquidation price (the Patient input). */
  positionsWithLiquidationPx: number;
  /** Resting limits and take-profits on this coin. */
  ordersOnCoin: number;
  takeProfitsOnCoin: number;
  /** Request weight spent by this fetch (Hyperliquid counts 1,200 per minute per IP). */
  weightSpent: number;
  fromCache: boolean;
}

/** Options for HyperliquidLevelSource. */
export interface HyperliquidSourceOptions extends Partial<TraderSelectionOptions> {
  fetch?: FetchLike;
  /** Old name of ordersTopN, still accepted. */
  topN?: number;
  /** Parallel requests to api.hyperliquid.xyz. Default 6. */
  concurrency?: number;
  /** Per-request timeout for /info in ms. Default 8,000. */
  requestTimeoutMs?: number;
  /** Timeout for the 39 MB leaderboard download in ms. Default 90,000. */
  leaderboardTimeoutMs?: number;
  /** How long the leaderboard stays fresh in ms. Default 6 hours. */
  leaderboardTtlMs?: number;
  /** How long one coin's levels, and one address's answers, stay fresh in ms. Default 60 s. */
  levelsTtlMs?: number;
  /**
   * Request weight allowed per rolling minute. Default 1,100, under Hyperliquid's 1,200
   * per IP. Weights from Hyperliquid's docs: clearinghouseState 2, frontendOpenOrders 20.
   * A full refresh with the defaults costs 200 x 2 + 30 x 20 = 1,000.
   */
  weightBudgetPerMinute?: number;
  /** Optional disk cache for the trimmed leaderboard (server only). */
  diskCache?: { read(): Promise<string | null>; write(text: string): Promise<void> };
  /** Clock, injected for tests. */
  now?: () => number;
  /** Logger for structural counts. Default console.log. */
  log?: (line: string) => void;
  /**
   * The liquidation map (fuel map): topN accounts by 30-day volume with at least
   * minAccountValueUsd (default $10,000), read every refreshMinutes. topN 0 turns it off.
   * Default off here; the server passes the rules (target.fuelMapTopN, fuelMapRefreshMinutes).
   */
  fuelMap?: { topN: number; refreshMinutes: number; minAccountValueUsd?: number };
  /** Wait function used to spread the fuel-map requests; injected for tests. Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Counts of the liquidation map, for GET /api/levels and the plan log. */
export interface FuelMapReport {
  enabled: boolean;
  /** Accounts in the sample (top N by 30-day volume) and how many the last pass asked. */
  addressesInSample: number;
  addressesAsked: number;
  answered: number;
  failed: number;
  /** Requests not sent because the per-minute weight budget was used up (counted, not hidden). */
  skippedByBudget: number;
  weightSpent: number;
  /** Passes finished since start, and whether one is running now. */
  refreshes: number;
  inProgress: boolean;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  /** Accounts whose answer is fresh enough to use (at most 3 refresh windows old). */
  addressesWithFreshAnswer: number;
  lastError: string | null;
}

/** The liquidation map for one coin, with counts around a price. */
export interface FuelLevels {
  levels: LiquidationLevel[];
  status: "ok" | "unavailable";
  /** Why it is unavailable, when it is. */
  note: string | null;
  report: FuelMapReport & {
    coin: string;
    liquidationLevels: number;
    /** Around `price` (when given): shorts liquidated above, longs below, non-empty 0.1% bands within 20%. */
    shortLevelsAbove: number | null;
    longLevelsBelow: number | null;
    bandsWithin20pct: number | null;
  };
}

/** Hyperliquid's documented weights for the two info calls we make. */
export const HL_WEIGHT = { clearinghouseState: 2, frontendOpenOrders: 20 } as const;

/** Raised instead of sending a request that would break the weight budget. */
class RateBudgetSkip extends Error {}

/**
 * Fetch JSON with a timeout. Throws on a non-2xx status or a timeout.
 * Units: timeoutMs in milliseconds.
 */
async function fetchJson(f: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run tasks with at most `limit` in flight. Each result is either a value or an error.
 * Why: Hyperliquid rate-limits by IP; 200 traders at once would trip it.
 */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<R | Error>> {
  const results: Array<R | Error> = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++; // claim an index (single-threaded JS: no race)
      try {
        results[i] = await fn(items[i] as T);
      } catch (e) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Source of trader levels with caching. One instance per server process.
 */
export class HyperliquidLevelSource {
  private readonly o: {
    fetch: FetchLike;
    selection: TraderSelectionOptions;
    concurrency: number;
    requestTimeoutMs: number;
    leaderboardTimeoutMs: number;
    leaderboardTtlMs: number;
    levelsTtlMs: number;
    weightBudgetPerMinute: number;
    now: () => number;
    log: (line: string) => void;
    diskCache?: HyperliquidSourceOptions["diskCache"];
  };
  private leaderboard: { at: number; traders: LeaderboardTrader[]; fuelTraders: LeaderboardTrader[] } | null = null;
  private readonly fuel: { topN: number; refreshMs: number; minAccountValueUsd: number };
  private readonly sleep: (ms: number) => Promise<void>;
  /** The latest answer of every fuel-map account: its liquidation levels per coin. */
  private readonly fuelAnswers = new Map<string, { at: number; byCoin: Map<string, LiquidationLevel[]> }>();
  private fuelReport: FuelMapReport;
  private fuelRun: Promise<FuelMapReport> | null = null;
  private fuelTimer: ReturnType<typeof setTimeout> | null = null;
  private fuelStopped = true;
  private fuelStopRequested = false;
  private leaderboardInFlight: Promise<LeaderboardTrader[]> | null = null;
  private readonly coinCache = new Map<string, { at: number; levels: TraderLevels; report: LevelsReport }>();
  /** Per-address answers ("clearinghouseState:0xabc"), shared by every coin. */
  private readonly answerCache = new Map<string, { at: number; json: unknown }>();
  /** Weight spent in the last minute, as (time, weight) pairs. */
  private spent: Array<{ at: number; w: number }> = [];

  constructor(opts: HyperliquidSourceOptions = {}) {
    this.o = {
      fetch: opts.fetch ?? ((u, i) => fetch(u, i)),
      selection: {
        ordersTopN: opts.ordersTopN ?? opts.topN ?? DEFAULT_TRADER_SELECTION.ordersTopN,
        positionsByPnlTopN: opts.positionsByPnlTopN ?? DEFAULT_TRADER_SELECTION.positionsByPnlTopN,
        positionsByVolumeTopN: opts.positionsByVolumeTopN ?? DEFAULT_TRADER_SELECTION.positionsByVolumeTopN,
        minAccountValueUsd: opts.minAccountValueUsd ?? DEFAULT_TRADER_SELECTION.minAccountValueUsd,
        minAccountValueForVolumeUsd: opts.minAccountValueForVolumeUsd ?? DEFAULT_TRADER_SELECTION.minAccountValueForVolumeUsd,
      },
      concurrency: opts.concurrency ?? 6,
      requestTimeoutMs: opts.requestTimeoutMs ?? 8_000,
      leaderboardTimeoutMs: opts.leaderboardTimeoutMs ?? 90_000,
      leaderboardTtlMs: opts.leaderboardTtlMs ?? 6 * 60 * 60 * 1000,
      levelsTtlMs: opts.levelsTtlMs ?? 60_000,
      weightBudgetPerMinute: opts.weightBudgetPerMinute ?? 1_100,
      now: opts.now ?? Date.now,
      log: opts.log ?? ((l) => console.log(l)),
      diskCache: opts.diskCache,
    };
    this.fuel = {
      topN: Math.max(0, Math.floor(opts.fuelMap?.topN ?? 0)),
      refreshMs: Math.max(1, opts.fuelMap?.refreshMinutes ?? 5) * 60_000,
      minAccountValueUsd: opts.fuelMap?.minAccountValueUsd ?? 10_000,
    };
    this.sleep = opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.fuelReport = {
      enabled: this.fuel.topN > 0,
      addressesInSample: 0,
      addressesAsked: 0,
      answered: 0,
      failed: 0,
      skippedByBudget: 0,
      weightSpent: 0,
      refreshes: 0,
      inProgress: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      addressesWithFreshAnswer: 0,
      lastError: null,
    };
  }

  /** The cache file must match the selection it was trimmed for, or it is ignored. */
  private selectionKey(): string {
    return `v3:${JSON.stringify(this.o.selection)}:fuel${this.fuel.topN}>=${this.fuel.minAccountValueUsd}`;
  }

  /**
   * The kept traders (union of both sets). Order of preference: memory cache, disk cache,
   * download. Concurrent callers share one download.
   */
  async getTopTraders(): Promise<LeaderboardTrader[]> {
    const now = this.o.now();
    if (this.leaderboard && now - this.leaderboard.at < this.o.leaderboardTtlMs) return this.leaderboard.traders;
    if (this.leaderboardInFlight) return this.leaderboardInFlight;
    this.leaderboardInFlight = (async () => {
      // Disk cache holds the TRIMMED list ({at, key, traders}), a few tens of KB instead of 39 MB.
      if (this.o.diskCache) {
        const text = await this.o.diskCache.read().catch(() => null);
        if (text) {
          let cached: Record<string, unknown> = {};
          try {
            cached = toObj(JSON.parse(text));
          } catch {
            this.o.log("[levels] leaderboard disk cache unreadable, downloading again");
          }
          const at = toNum(cached.at);
          const traders = toArr(cached.traders) as LeaderboardTrader[];
          const fuelTraders = toArr(cached.fuelTraders) as LeaderboardTrader[];
          // An older cache (other key, e.g. the 30-trader file from before 2026-11-16) is ignored.
          if (cached.key === this.selectionKey() && now - at < this.o.leaderboardTtlMs && traders.length > 0) {
            this.leaderboard = { at, traders, fuelTraders };
            this.o.log(`[levels] leaderboard from disk cache: kept ${traders.length}`);
            return traders;
          }
        }
      }
      const json = await fetchJson(this.o.fetch, HL_LEADERBOARD_URL, { method: "GET" }, this.o.leaderboardTimeoutMs);
      const rowsRead = toArr(toObj(json).leaderboardRows).length;
      const all = parseLeaderboard(json, { topN: Infinity, minAccountValueUsd: Math.min(this.o.selection.minAccountValueUsd, this.o.selection.minAccountValueForVolumeUsd) });
      const sel = selectTraders(all, this.o.selection);
      const seen = new Set<string>();
      const traders = [...sel.orders, ...sel.positions].filter((t) => !seen.has(t.address) && !!seen.add(t.address));
      this.o.log(
        `[levels] leaderboard read: ${rowsRead} rows, profitable above the floor: ${all.length}, kept: ${traders.length} (orders ${sel.orders.length}, positions ${sel.positions.length})`,
      );
      if (traders.length === 0) throw new Error("Hyperliquid leaderboard gave zero usable traders");
      // The liquidation map's sample: by volume, profitable or not, from the same download.
      const fuelTraders =
        this.fuel.topN > 0
          ? parseLeaderboard(json, { topN: this.fuel.topN, minAccountValueUsd: this.fuel.minAccountValueUsd, rankBy: "monthVolume", profitableOnly: false })
          : [];
      if (this.fuel.topN > 0) this.o.log(`[levels] liquidation map sample: ${fuelTraders.length} accounts by 30-day volume (asked for ${this.fuel.topN}, floor $${this.fuel.minAccountValueUsd})`);
      this.leaderboard = { at: now, traders, fuelTraders };
      if (this.o.diskCache) await this.o.diskCache.write(JSON.stringify({ at: now, key: this.selectionKey(), traders, fuelTraders })).catch(() => undefined);
      return traders;
    })().finally(() => {
      this.leaderboardInFlight = null;
    });
    return this.leaderboardInFlight;
  }

  /** Weight spent in the last 60 s. */
  private weightInLastMinute(now: number): number {
    this.spent = this.spent.filter((x) => now - x.at < 60_000);
    return this.spent.reduce((s, x) => s + x.w, 0);
  }

  /**
   * One /info call for one address, from the per-address cache when fresh, else sent
   * if the weight budget allows (else RateBudgetSkip).
   */
  private async info(type: "clearinghouseState" | "frontendOpenOrders", user: string): Promise<{ json: unknown; cached: boolean }> {
    const key = `${type}:${user.toLowerCase()}`;
    const now = this.o.now();
    const hit = this.answerCache.get(key);
    if (hit && now - hit.at < this.o.levelsTtlMs) return { json: hit.json, cached: true };
    const w = HL_WEIGHT[type];
    if (this.weightInLastMinute(now) + w > this.o.weightBudgetPerMinute) throw new RateBudgetSkip(key);
    this.spent.push({ at: now, w });
    const json = await fetchJson(
      this.o.fetch,
      HL_INFO_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, user }) },
      this.o.requestTimeoutMs,
    );
    this.answerCache.set(key, { at: now, json });
    return { json, cached: false };
  }

  /**
   * Levels for one coin ("BTC", "ETH"), from the kept traders.
   * Units: prices quote per base; weights USD.
   */
  async getLevels(coin: string): Promise<{ levels: TraderLevels; report: LevelsReport }> {
    const now = this.o.now();
    const hit = this.coinCache.get(coin);
    if (hit && now - hit.at < this.o.levelsTtlMs) return { levels: hit.levels, report: { ...hit.report, fromCache: true } };

    const traders = await this.getTopTraders();
    const sel = selectTraders(traders, this.o.selection);
    const before = this.weightInLastMinute(now);
    const posResults = await mapLimited(sel.positions, this.o.concurrency, async (t) => parseClearinghouseState((await this.info("clearinghouseState", t.address)).json, coin));
    const ordResults = await mapLimited(sel.orders, this.o.concurrency, async (t) => parseFrontendOpenOrders((await this.info("frontendOpenOrders", t.address)).json, coin));

    const levels: TraderLevels = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };
    let posFailed = 0;
    let ordFailed = 0;
    let skipped = 0;
    for (const r of posResults) {
      if (r instanceof RateBudgetSkip) skipped++;
      else if (r instanceof Error) posFailed++;
      else levels.liquidationLevels.push(...r);
    }
    for (const r of ordResults) {
      if (r instanceof RateBudgetSkip) skipped++;
      else if (r instanceof Error) ordFailed++;
      else {
        levels.limitLevels.push(...r.limits);
        levels.takeProfitLevels.push(...r.takeProfits);
      }
    }
    const posSkipped = posResults.filter((r) => r instanceof RateBudgetSkip).length;
    const ordSkipped = ordResults.filter((r) => r instanceof RateBudgetSkip).length;
    const report: LevelsReport = {
      addressesRead: traders.length,
      positionAddresses: sel.positions.length,
      positionAddressesOk: sel.positions.length - posFailed - posSkipped,
      positionAddressesFailed: posFailed,
      orderAddresses: sel.orders.length,
      orderAddressesOk: sel.orders.length - ordFailed - ordSkipped,
      orderAddressesFailed: ordFailed,
      skippedByRateBudget: skipped,
      positionsWithLiquidationPx: levels.liquidationLevels.length,
      ordersOnCoin: levels.limitLevels.length,
      takeProfitsOnCoin: levels.takeProfitLevels.length,
      weightSpent: this.weightInLastMinute(this.o.now()) - before,
      fromCache: false,
    };
    this.o.log(
      `[levels] ${coin}: addresses read ${report.addressesRead}; positions asked ${report.positionAddresses}, ok ${report.positionAddressesOk}, failed ${posFailed}; ` +
        `orders asked ${report.orderAddresses}, ok ${report.orderAddressesOk}, failed ${ordFailed}; skipped by rate budget ${skipped}; ` +
        `positions with liquidationPx ${report.positionsWithLiquidationPx}; resting orders ${report.ordersOnCoin}; take-profits ${report.takeProfitsOnCoin}; weight ${report.weightSpent}`,
    );
    // Every request failing is an outage, not "no levels": say so loudly instead of returning empties.
    const asked = sel.positions.length + sel.orders.length;
    if (asked > 0 && posFailed + ordFailed === asked) throw new Error(`all ${asked} Hyperliquid trader requests failed`);
    if (asked > 0 && skipped === asked) throw new Error(`all ${asked} Hyperliquid requests skipped: rate budget used up, try again in a minute`);
    this.coinCache.set(coin, { at: now, levels, report });
    return { levels, report };
  }

  /** The liquidation map's sample (top N by 30-day volume), from the cached leaderboard. */
  async getFuelTraders(): Promise<LeaderboardTrader[]> {
    await this.getTopTraders();
    return this.leaderboard?.fuelTraders ?? [];
  }

  /**
   * One pass over the liquidation map's accounts, one request at a time spread evenly over
   * the refresh window (so a pass of 600 accounts costs 1,200 weight per 5 minutes). Never
   * called per request: startFuelMap runs it in the background. Concurrent callers share a pass.
   */
  refreshFuelMap(): Promise<FuelMapReport> {
    if (this.fuelRun) return this.fuelRun;
    this.fuelRun = (async () => {
      const r = this.fuelReport;
      r.inProgress = true;
      r.lastStartedAt = this.o.now();
      let asked = 0;
      let answered = 0;
      let failed = 0;
      let skipped = 0;
      let weight = 0;
      try {
        const traders = await this.getFuelTraders();
        r.addressesInSample = traders.length;
        const gap = traders.length > 0 ? this.fuel.refreshMs / traders.length : 0;
        for (const [i, t] of traders.entries()) {
          if (this.fuelStopRequested) break; // stopFuelMap was called
          if (i > 0 && gap > 0) await this.sleep(gap);
          asked++;
          try {
            const { json, cached } = await this.info("clearinghouseState", t.address);
            if (!cached) weight += HL_WEIGHT.clearinghouseState;
            this.fuelAnswers.set(t.address.toLowerCase(), { at: this.o.now(), byCoin: parseClearinghouseStateAllCoins(json) });
            answered++;
          } catch (e) {
            if (e instanceof RateBudgetSkip) skipped++;
            else failed++;
          }
        }
        r.lastError = asked > 0 && answered === 0 ? `none of ${asked} liquidation-map requests answered (failed ${failed}, skipped by budget ${skipped})` : null;
      } catch (e) {
        r.lastError = (e as Error).message;
      }
      Object.assign(r, { addressesAsked: asked, answered, failed, skippedByBudget: skipped, weightSpent: weight, inProgress: false, lastFinishedAt: this.o.now() });
      r.refreshes++;
      r.addressesWithFreshAnswer = this.freshFuelAnswers().length;
      this.o.log(
        `[levels] liquidation map pass ${r.refreshes}: sample ${r.addressesInSample}, asked ${asked}, answered ${answered}, failed ${failed}, skipped by budget ${skipped}, weight ${weight}` +
          (r.lastError ? `; PROBLEM: ${r.lastError}` : ""),
      );
      return { ...r };
    })().finally(() => {
      this.fuelRun = null;
    });
    return this.fuelRun;
  }

  /** Start the background refresh: a pass now, then one every refresh window. No-op when the map is off. */
  startFuelMap(): void {
    if (this.fuel.topN === 0 || !this.fuelStopped) return;
    this.fuelStopped = false;
    this.fuelStopRequested = false;
    const loop = async () => {
      const started = this.o.now();
      await this.refreshFuelMap().catch(() => undefined);
      if (this.fuelStopped) return;
      const wait = Math.max(0, started + this.fuel.refreshMs - this.o.now());
      this.fuelTimer = setTimeout(() => void loop(), wait);
      this.fuelTimer.unref?.();
    };
    void loop();
  }

  /** Stop the background refresh (a running pass stops at its next request). */
  stopFuelMap(): void {
    this.fuelStopped = true;
    this.fuelStopRequested = true;
    if (this.fuelTimer) clearTimeout(this.fuelTimer);
    this.fuelTimer = null;
  }

  /** Answers young enough to use: at most 3 refresh windows old. */
  private freshFuelAnswers(): Array<{ at: number; byCoin: Map<string, LiquidationLevel[]> }> {
    const now = this.o.now();
    return [...this.fuelAnswers.values()].filter((a) => now - a.at <= 3 * this.fuel.refreshMs);
  }

  /**
   * The liquidation map for one coin, from the answers already in memory (never a request).
   * "unavailable" when the map is off, no account has a fresh answer yet, or under half the
   * sample has one ("thin: N of 600 accounts"); the note says why.
   * With a price, the report also counts shorts above, longs below and bands within 20%.
   */
  getFuelLevels(coin: string, price?: number): FuelLevels {
    const fresh = this.freshFuelAnswers();
    const levels = fresh.flatMap((a) => a.byCoin.get(coin) ?? []);
    let note: string | null = null;
    if (this.fuel.topN === 0) note = "liquidation map is off (target.fuelMapTopN is 0)";
    else if (fresh.length === 0) note = this.fuelReport.inProgress || this.fuelReport.refreshes === 0 ? "liquidation map not read yet (first pass running)" : `liquidation map has no fresh answer (${this.fuelReport.lastError ?? "no account answered"})`;
    // Under half the sample fresh: too thin to call "no cluster" a fact, so it counts as unavailable.
    else if (this.fuelReport.addressesInSample > 0 && fresh.length < this.fuelReport.addressesInSample / 2) note = `thin: ${fresh.length} of ${this.fuelReport.addressesInSample} accounts`;
    let shortAbove: number | null = null;
    let longBelow: number | null = null;
    let bands: number | null = null;
    if (price && price > 0) {
      shortAbove = levels.filter((l) => l.positionSide === "short" && l.price > price).length;
      longBelow = levels.filter((l) => l.positionSide === "long" && l.price < price).length;
      const set = new Set<number>();
      for (const l of levels) {
        const dist = (l.price - price) / price;
        if (Math.abs(dist) <= 0.2) set.add(Math.floor(dist / 0.001));
      }
      bands = set.size;
    }
    return {
      levels,
      status: note ? "unavailable" : "ok",
      note,
      report: { ...this.fuelReport, addressesWithFreshAnswer: fresh.length, coin, liquidationLevels: levels.length, shortLevelsAbove: shortAbove, longLevelsBelow: longBelow, bandsWithin20pct: bands },
    };
  }
}

// ---------- the liquidation map (fuel map) ----------

/**
 * Liquidation levels of one account's positions on EVERY coin (the fuel map keeps one answer
 * per account for all coins). Same rules as parseClearinghouseState.
 */
export function parseClearinghouseStateAllCoins(json: unknown): Map<string, LiquidationLevel[]> {
  const out = new Map<string, LiquidationLevel[]>();
  for (const ap of toArr(toObj(json).assetPositions)) {
    const coin = toObj(toObj(ap).position).coin;
    if (typeof coin !== "string" || out.has(coin)) continue;
    out.set(coin, parseClearinghouseState(json, coin));
  }
  return out;
}

/** "BTCUSDT" -> "BTC". Hyperliquid names perps by coin only. */
export function coinFromSymbol(symbol: string): string {
  return symbol.replace(/USDT$|USD$|USDC$/, "");
}
