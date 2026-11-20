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
  /** How old the trader sample is, in ms (0 for a fresh read). */
  ageMs: number;
  /** How long this sample is reused: 5 minutes, or 60 s when more than 10% of its requests were lost. */
  cachedForMs?: number;
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
  /** How long one address's answer stays in the per-address cache in ms. Default 60 s. */
  levelsTtlMs?: number;
  /**
   * How long one coin's trader sample (positions and resting orders of the kept traders) is
   * reused in ms. Default 5 minutes (decision of 2026-11-21: a fresh read costs about 944 weight,
   * most of the per-minute budget, and starved the liquidation map when re-read every minute).
   */
  traderSampleTtlMs?: number;
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
  fuelMap?: {
    topN: number;
    refreshMinutes: number;
    minAccountValueUsd?: number;
    /** Quick map size (stage 1), the longest a plan waits for it, answer freshness, idle stop (A10). */
    quickN?: number;
    waitMs?: number;
    ttlMinutes?: number;
    idleMinutes?: number;
  };
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

/** How far the map got: see getFuelLevels. */
export type FuelMapStage = "none" | "reading" | "quick" | "full" | "stale";

/** Stage 2 of the quick start reads at most this much weight a minute (A10: 250 accounts a minute). */
export const FUEL_STAGE2_WEIGHT_PER_MINUTE = 500;

/** The liquidation map for one coin, with counts around a price. */
export interface FuelLevels {
  levels: LiquidationLevel[];
  status: "ok" | "unavailable";
  /** Why it is unavailable, when it is. */
  note: string | null;
  /** While the quick map is still being read: "liquidation map: 143 of 600 accounts, still reading". */
  reading: string | null;
  report: FuelMapReport & {
    stage: FuelMapStage;
    /** Accounts answered within fuelMapTtlMinutes (5). addressesWithFreshAnswer counts those usable (15 minutes). */
    fresh: number;
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
    traderSampleTtlMs: number;
    weightBudgetPerMinute: number;
    now: () => number;
    log: (line: string) => void;
    diskCache?: HyperliquidSourceOptions["diskCache"];
  };
  private leaderboard: { at: number; traders: LeaderboardTrader[]; fuelTraders: LeaderboardTrader[] } | null = null;
  private readonly fuel: { topN: number; refreshMs: number; minAccountValueUsd: number; quickN: number; waitMs: number; ttlMs: number; idleMs: number };
  private readonly sleep: (ms: number) => Promise<void>;
  /** The latest answer of every fuel-map account: its liquidation levels per coin. */
  private readonly fuelAnswers = new Map<string, { at: number; byCoin: Map<string, LiquidationLevel[]> }>();
  private fuelReport: FuelMapReport;
  private fuelRun: Promise<FuelMapReport> | null = null;
  private fuelStopRequested = false;
  /** The quick map (stage 1) while it runs, and when it started. */
  private stage1Run: Promise<void> | null = null;
  private stage1StartedAt: number | null = null;
  /** The open-card loop is running. */
  private looping = false;
  /** Last time a preview, level read or place asked for the map (null: never). */
  private lastTouchAt: number | null = null;
  /** Requests sent to Hyperliquid, counted for the health check ("nothing before the first preview"). */
  private readonly sent = { leaderboard: 0, info: 0 };
  private leaderboardInFlight: Promise<LeaderboardTrader[]> | null = null;
  private readonly coinCache = new Map<string, { at: number; ttlMs: number; levels: TraderLevels; report: LevelsReport }>();
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
      traderSampleTtlMs: opts.traderSampleTtlMs ?? 5 * 60_000,
      weightBudgetPerMinute: opts.weightBudgetPerMinute ?? 1_100,
      now: opts.now ?? Date.now,
      log: opts.log ?? ((l) => console.log(l)),
      diskCache: opts.diskCache,
    };
    const topN = Math.max(0, Math.floor(opts.fuelMap?.topN ?? 0));
    this.fuel = {
      topN,
      refreshMs: Math.max(1, opts.fuelMap?.refreshMinutes ?? 5) * 60_000,
      minAccountValueUsd: opts.fuelMap?.minAccountValueUsd ?? 10_000,
      quickN: Math.min(topN, Math.max(0, Math.floor(opts.fuelMap?.quickN ?? 200))),
      waitMs: opts.fuelMap?.waitMs ?? 8_000,
      ttlMs: (opts.fuelMap?.ttlMinutes ?? 5) * 60_000,
      idleMs: (opts.fuelMap?.idleMinutes ?? 10) * 60_000,
    };
    // The default wait never keeps the process alive on its own (unref).
    this.sleep = opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms).unref?.()));
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
   * download. Concurrent callers share one download. An expired copy (memory or disk) is
   * still returned at once while a fresh download runs in the background (2026-11-21: the
   * 39 MB download held the first preview for 49 s); only with no copy at all does a caller wait.
   */
  async getTopTraders(): Promise<LeaderboardTrader[]> {
    const now = this.o.now();
    if (this.leaderboard && now - this.leaderboard.at < this.o.leaderboardTtlMs) return this.leaderboard.traders;
    if (!this.leaderboard && !this.leaderboardInFlight) await this.loadStaleDiskCopy();
    if (this.leaderboard) {
      if (now - this.leaderboard.at >= this.o.leaderboardTtlMs && !this.leaderboardInFlight) {
        this.o.log(`[levels] leaderboard copy is ${Math.round((now - this.leaderboard.at) / 60_000)} min old: using it while a fresh one downloads`);
        void this.downloadLeaderboard().catch((e) => this.o.log(`[levels] leaderboard refresh failed, keeping the old copy: ${(e as Error).message}`));
      }
      return this.leaderboard.traders;
    }
    return this.downloadLeaderboard();
  }

  /** True while there is no copy of the account list at all (the first download is running). */
  hasLeaderboard(): boolean {
    return this.leaderboard !== null;
  }

  /** An expired but matching disk copy, kept in memory so a caller does not wait for the download. */
  private async loadStaleDiskCopy(): Promise<void> {
    if (!this.o.diskCache) return;
    const text = await this.o.diskCache.read().catch(() => null);
    if (!text) return;
    try {
      const cached = toObj(JSON.parse(text));
      const traders = toArr(cached.traders) as LeaderboardTrader[];
      if (cached.key === this.selectionKey() && traders.length > 0 && !this.leaderboard) {
        this.leaderboard = { at: toNum(cached.at), traders, fuelTraders: toArr(cached.fuelTraders) as LeaderboardTrader[] };
        this.o.log(`[levels] leaderboard from disk cache: kept ${traders.length}`);
      }
    } catch {
      this.o.log("[levels] leaderboard disk cache unreadable, downloading again");
    }
  }

  /** Download and trim the leaderboard (shared by concurrent callers). */
  private downloadLeaderboard(): Promise<LeaderboardTrader[]> {
    const now = this.o.now();
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
      this.sent.leaderboard++;
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
  private async info(type: "clearinghouseState" | "frontendOpenOrders", user: string, opts: { waitForBudget?: boolean } = {}): Promise<{ json: unknown; cached: boolean; at: number }> {
    const key = `${type}:${user.toLowerCase()}`;
    let now = this.o.now();
    const hit = this.answerCache.get(key);
    if (hit && now - hit.at < this.o.levelsTtlMs) return { json: hit.json, cached: true, at: hit.at };
    const w = HL_WEIGHT[type];
    // Background reads (stage 2 of the map) wait for the budget to free up instead of losing the
    // request; foreground reads skip at once (a preview never waits on the budget).
    for (let tries = 0; opts.waitForBudget && this.weightInLastMinute(now) + w > this.o.weightBudgetPerMinute && tries < 20; tries++) {
      if (this.fuelStopRequested || this.idle()) break;
      const oldest = this.spent[0];
      await this.sleep(Math.max(250, oldest ? oldest.at + 60_000 - now : 1_000));
      now = this.o.now();
    }
    if (this.weightInLastMinute(now) + w > this.o.weightBudgetPerMinute) throw new RateBudgetSkip(key);
    this.spent.push({ at: now, w });
    this.sent.info++;
    const json = await fetchJson(
      this.o.fetch,
      HL_INFO_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, user }) },
      this.o.requestTimeoutMs,
    );
    this.answerCache.set(key, { at: now, json });
    return { json, cached: false, at: now };
  }

  /**
   * Levels for one coin ("BTC", "ETH"), from the kept traders.
   * Units: prices quote per base; weights USD.
   */
  async getLevels(coin: string): Promise<{ levels: TraderLevels; report: LevelsReport }> {
    const now = this.o.now();
    const hit = this.coinCache.get(coin);
    if (hit && now - hit.at < hit.ttlMs) return { levels: hit.levels, report: { ...hit.report, fromCache: true, ageMs: now - hit.at } };

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
      ageMs: 0,
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
    // A sample that lost more than 10% of its requests (failed or skipped by the budget) is
    // reused for 60 s only, so the missing traders are read again soon (architect's review 2026-11-21).
    const lost = posFailed + ordFailed + skipped;
    report.cachedForMs = asked > 0 && lost > 0.1 * asked ? 60_000 : this.o.traderSampleTtlMs;
    this.coinCache.set(coin, { at: now, ttlMs: report.cachedForMs, levels, report });
    return { levels, report };
  }

  /** The liquidation map's sample (top N by 30-day volume), from the cached leaderboard. */
  async getFuelTraders(): Promise<LeaderboardTrader[]> {
    await this.getTopTraders();
    return this.leaderboard?.fuelTraders ?? [];
  }

  /** Answer one account's clearinghouseState and keep it in the map; the outcome for the counts. */
  private async readFuelAccount(address: string, opts: { waitForBudget?: boolean } = {}): Promise<"answered" | "failed" | "skipped" | { weight: number }> {
    try {
      const { json, cached, at } = await this.info("clearinghouseState", address, opts);
      // The answer's own time: a cached answer keeps its age (never re-stamped as fresh).
      this.fuelAnswers.set(address.toLowerCase(), { at, byCoin: parseClearinghouseStateAllCoins(json) });
      return { weight: cached ? 0 : HL_WEIGHT.clearinghouseState };
    } catch (e) {
      return e instanceof RateBudgetSkip ? "skipped" : "failed";
    }
  }

  /** True once no preview, level read or place has asked for the map for fuelMapIdleMinutes. */
  private idle(): boolean {
    return this.lastTouchAt !== null && this.o.now() - this.lastTouchAt > this.fuel.idleMs;
  }

  /**
   * One pass over the liquidation map's accounts, one request at a time spread evenly over
   * the refresh window (a pass of 600 accounts costs 1,200 weight per 5 minutes). Run by the
   * open-card loop (A10); stops early when the map goes idle or stopFuelMap is called.
   * Concurrent callers share a pass.
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
          if (this.fuelStopRequested || this.idle()) break;
          if (i > 0 && gap > 0) await this.sleep(gap);
          if (this.fuelStopRequested || this.idle()) break;
          asked++;
          const out = await this.readFuelAccount(t.address);
          if (out === "skipped") skipped++;
          else if (out === "failed") failed++;
          else if (out !== "answered") {
            answered++;
            weight += out.weight;
          }
        }
        r.lastError = asked > 0 && answered === 0 ? `none of ${asked} liquidation-map requests answered (failed ${failed}, skipped by budget ${skipped})` : null;
      } catch (e) {
        r.lastError = (e as Error).message;
      }
      Object.assign(r, { addressesAsked: asked, answered, failed, skippedByBudget: skipped, weightSpent: weight, inProgress: false, lastFinishedAt: this.o.now() });
      r.refreshes++;
      r.addressesWithFreshAnswer = this.usableFuelAnswers().length;
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

  /**
   * Stage 1, the quick map (A10): the first fuelMapQuickN accounts of the sample (the biggest
   * by 30-day volume), 6 requests in flight, about 400 weight in a few seconds.
   */
  private runStage1(): Promise<void> {
    if (this.stage1Run) return this.stage1Run;
    this.stage1Run = (async () => {
      this.stage1StartedAt = this.o.now();
      let answered = 0;
      let failed = 0;
      let skipped = 0;
      try {
        const traders = await this.getFuelTraders();
        this.fuelReport.addressesInSample = traders.length;
        const quick = traders.slice(0, this.fuel.quickN);
        const outs = await mapLimited(quick, this.o.concurrency, (t) => this.readFuelAccount(t.address));
        for (const o of outs) {
          if (o === "skipped") skipped++;
          else if (o === "failed" || o instanceof Error) failed++;
          else answered++;
        }
        this.fuelReport.lastError = quick.length > 0 && answered === 0 ? `none of ${quick.length} quick-map requests answered (failed ${failed}, skipped by budget ${skipped})` : null;
        this.o.log(`[levels] liquidation map stage 1 (quick): asked ${quick.length}, answered ${answered}, failed ${failed}, skipped by budget ${skipped}`);
      } catch (e) {
        this.fuelReport.lastError = (e as Error).message;
        this.o.log(`[levels] liquidation map stage 1 failed: ${(e as Error).message}`);
      }
    })().finally(() => {
      this.stage1Run = null;
    });
    return this.stage1Run;
  }

  /**
   * Stage 2 (A10): every account of the sample still without a fresh answer (the rest of the
   * 600, and any quick-map account the budget skipped), starting once the triggering preview's
   * wait is over, one request every 240 ms (at most 500 weight a minute). It waits for the
   * per-minute budget instead of losing a request (2026-11-21 smoke: 248 of 400 were lost).
   */
  private async runStage2(): Promise<void> {
    const traders = await this.getFuelTraders().catch(() => [] as LeaderboardTrader[]);
    const start = (this.stage1StartedAt ?? this.o.now()) + this.fuel.waitMs;
    if (this.o.now() < start) await this.sleep(start - this.o.now());
    const gap = (60_000 * HL_WEIGHT.clearinghouseState) / FUEL_STAGE2_WEIGHT_PER_MINUTE;
    let asked = 0;
    let answered = 0;
    let skipped = 0;
    let failed = 0;
    for (const t of traders) {
      if (this.fuelStopRequested || this.idle()) break;
      const a = this.fuelAnswers.get(t.address.toLowerCase());
      if (a && this.o.now() - a.at <= this.fuel.ttlMs) continue; // still fresh
      if (asked > 0) await this.sleep(gap);
      if (this.fuelStopRequested || this.idle()) break;
      asked++;
      const out = await this.readFuelAccount(t.address, { waitForBudget: true });
      if (typeof out === "object") answered++;
      else if (out === "skipped") skipped++;
      else failed++;
    }
    // Skipped accounts are read by the next whole pass (it starts as soon as stage 2 ends).
    this.o.log(`[levels] liquidation map stage 2: asked ${asked}, answered ${answered}, failed ${failed}, skipped by budget ${skipped}`);
  }

  /**
   * The open-card loop (A10): stage 2 after the quick map, then whole passes spread over
   * fuelMapRefreshMinutes, for as long as something asked for the map in the last
   * fuelMapIdleMinutes. Started by ensureFuelMap; never runs on its own at server start.
   */
  startFuelMap(): void {
    if (this.fuel.topN === 0) return;
    this.lastTouchAt ??= this.o.now();
    if (this.looping) return;
    this.looping = true;
    this.fuelStopRequested = false;
    void (async () => {
      try {
        if (this.stage1Run) await this.stage1Run;
        if (!this.idle() && !this.fuelStopRequested) await this.runStage2();
        while (!this.idle() && !this.fuelStopRequested) {
          const r = await this.refreshFuelMap().catch(() => null);
          // Nothing could be asked (leaderboard down): wait a window before trying again, never spin.
          if (!r || r.addressesAsked === 0) await this.sleep(this.fuel.refreshMs);
        }
        if (this.idle()) this.o.log(`[levels] liquidation map idle for ${this.fuel.idleMs / 60_000} min: reading stopped`);
      } finally {
        this.looping = false;
      }
    })();
  }

  /** Stop the open-card loop (a running pass stops at its next request). */
  stopFuelMap(): void {
    this.fuelStopRequested = true;
  }

  /**
   * Make sure the liquidation map can serve a plan (A10). Marks the map as wanted (the
   * open-card loop runs until 10 minutes pass without such a call). With at least half the
   * sample fresh it sends nothing; otherwise it runs the quick map (stage 1) and waits for it
   * at most fuelMapWaitMs (opts.wait false: does not wait, e.g. GET /api/levels).
   */
  async ensureFuelMap(opts: { wait?: boolean } = {}): Promise<FuelMapReport> {
    if (this.fuel.topN === 0) return { ...this.fuelReport };
    this.lastTouchAt = this.o.now();
    const fresh = this.fuelAnswersWithin(this.fuel.ttlMs).length;
    const sample = this.fuelReport.addressesInSample || this.fuel.topN;
    // Stage 1 runs again only when the quick map itself is not fresh, or when the map is under
    // half fresh and nothing is filling it in. A stage 2 or a pass already running fills the rest:
    // re-reading the quick map then would only take budget from it (seen live 2026-11-21).
    const quickFresh = await this.quickMapFresh();
    const quickSize = Math.min(this.fuel.quickN, this.leaderboard?.fuelTraders.length ?? this.fuel.quickN);
    if (quickFresh < quickSize / 2 || (!this.looping && fresh < sample / 2)) {
      const run = this.runStage1();
      this.startFuelMap();
      if (opts.wait !== false) {
        let timer = false;
        await Promise.race([run, this.sleep(this.fuel.waitMs).then(() => void (timer = true))]);
        if (timer) this.o.log(`[levels] liquidation map: built after ${this.fuel.waitMs} ms with ${this.usableFuelAnswers().length} accounts, still reading`);
      }
    } else {
      this.startFuelMap();
    }
    return { ...this.fuelReport, addressesWithFreshAnswer: this.usableFuelAnswers().length };
  }

  /** How many of the quick-map accounts (the first fuelMapQuickN of the sample) hold a fresh answer. */
  private async quickMapFresh(): Promise<number> {
    if (!this.leaderboard) return 0; // nothing read yet (the sample comes with the first read)
    const now = this.o.now();
    return this.leaderboard.fuelTraders.slice(0, this.fuel.quickN).filter((t) => {
      const a = this.fuelAnswers.get(t.address.toLowerCase());
      return a !== undefined && now - a.at <= this.fuel.ttlMs;
    }).length;
  }

  /** Answers at most `ms` old. */
  private fuelAnswersWithin(ms: number): Array<{ at: number; byCoin: Map<string, LiquidationLevel[]> }> {
    const now = this.o.now();
    return [...this.fuelAnswers.values()].filter((a) => now - a.at <= ms);
  }

  /** Answers young enough to use: at most 3 refresh windows (15 minutes) old, never past that. */
  private usableFuelAnswers(): Array<{ at: number; byCoin: Map<string, LiquidationLevel[]> }> {
    return this.fuelAnswersWithin(3 * this.fuel.refreshMs);
  }

  /** Requests this source has sent to Hyperliquid (leaderboard and info), for the health check. */
  requestsSent(): { leaderboard: number; info: number } {
    return { ...this.sent };
  }

  /**
   * The liquidation map for one coin, from the answers already in memory (never a request).
   * stage: "reading" (the quick map is still being read), "quick" (some of the sample),
   * "full" (the whole sample), "stale" (answers exist but all older than 15 minutes), "none".
   * "unavailable" when the map is off, no usable answer exists, or fewer than half of the
   * quick map answered once reading stopped ("thin: N of 600 accounts"). While the quick map
   * is still being read the plan uses what answered and `reading` says how much.
   * With a price, the report also counts shorts above, longs below and bands within 20%.
   */
  getFuelLevels(coin: string, price?: number): FuelLevels {
    const usable = this.usableFuelAnswers();
    const fresh = this.fuelAnswersWithin(this.fuel.ttlMs).length;
    const levels = usable.flatMap((a) => a.byCoin.get(coin) ?? []);
    const sample = this.fuelReport.addressesInSample || this.fuel.topN;
    const isReading = this.stage1Run !== null;
    const stage: FuelMapStage = isReading ? "reading" : usable.length === 0 ? (this.fuelAnswers.size > 0 ? "stale" : "none") : usable.length >= sample ? "full" : "quick";
    const reading = !isReading
      ? null
      : this.leaderboard === null
        ? `liquidation map: the account list is still downloading (no cached copy yet), 0 of ${sample} accounts read`
        : `liquidation map: ${usable.length} of ${sample} accounts, still reading`;
    let note: string | null = null;
    if (this.fuel.topN === 0) note = "liquidation map is off (target.fuelMapTopN is 0)";
    else if (usable.length === 0)
      note = isReading
        ? "liquidation map not read yet"
        : this.fuelAnswers.size > 0
          ? "liquidation map stale: every answer is older than 15 minutes"
          : `liquidation map has no fresh answer (${this.fuelReport.lastError ?? "nothing read yet"})`;
    // Fewer than half of the quick map answered and nothing more is coming: too thin to call "no cluster" a fact.
    else if (!isReading && usable.length < Math.max(1, Math.min(this.fuel.quickN, sample)) / 2) note = `thin: ${usable.length} of ${sample} accounts`;
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
      reading,
      report: {
        ...this.fuelReport,
        addressesWithFreshAnswer: usable.length,
        stage,
        fresh,
        coin,
        liquidationLevels: levels.length,
        shortLevelsAbove: shortAbove,
        longLevelsBelow: longBelow,
        bandsWithin20pct: bands,
      },
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
