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
 *  1. Leaderboard (stats-data.hyperliquid.xyz, about 39 MB): keep only the top N
 *     traders by 30-day ("month") profit with at least a minimum account value.
 *     Cached in memory and optionally on disk, because it is big and changes slowly.
 *  2. For each kept trader, POST api.hyperliquid.xyz/info:
 *       {"type":"clearinghouseState","user":addr}  -> open positions (entryPx, liquidationPx, szi, positionValue)
 *       {"type":"frontendOpenOrders","user":addr}  -> resting limits and take-profit orders
 *     with a concurrency limit, a timeout per request, and a short per-coin cache.
 *  3. Return { limitLevels, takeProfitLevels, liquidationLevels } for one coin.
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
}

/**
 * Pick the top traders from the leaderboard JSON.
 * Why: "skilled" = most 30-day profit among accounts large enough to matter.
 * Units: minAccountValueUsd in USD.
 */
export function parseLeaderboard(
  json: unknown,
  opts: { topN?: number; minAccountValueUsd?: number } = {},
): LeaderboardTrader[] {
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
    for (const w of toArr(row.windowPerformances)) {
      const pair = toArr(w);
      if (pair[0] === "month") {
        const perf = toObj(pair[1]);
        monthPnlUsd = toNum(perf.pnl);
        monthRoi = toNum(perf.roi);
      }
    }
    if (!Number.isFinite(monthPnlUsd) || monthPnlUsd <= 0) continue; // losing traders are not copied
    out.push({ address, accountValueUsd, monthPnlUsd, monthRoi });
  }
  out.sort((a, b) => b.monthPnlUsd - a.monthPnlUsd);
  return out.slice(0, topN);
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
  tradersKept: number;
  tradersQueried: number;
  requestsFailed: number;
  positionsOnCoin: number;
  ordersOnCoin: number;
  fromCache: boolean;
}

/** Options for HyperliquidLevelSource. */
export interface HyperliquidSourceOptions {
  fetch?: FetchLike;
  /** Top traders kept from the leaderboard. Default 30. */
  topN?: number;
  /** Minimum account value in USD. Default 100,000. */
  minAccountValueUsd?: number;
  /** Parallel requests to api.hyperliquid.xyz. Default 6. */
  concurrency?: number;
  /** Per-request timeout for /info in ms. Default 8,000. */
  requestTimeoutMs?: number;
  /** Timeout for the 39 MB leaderboard download in ms. Default 90,000. */
  leaderboardTimeoutMs?: number;
  /** How long the leaderboard stays fresh in ms. Default 6 hours. */
  leaderboardTtlMs?: number;
  /** How long one coin's levels stay fresh in ms. Default 30 s. */
  levelsTtlMs?: number;
  /** Optional disk cache for the trimmed leaderboard (server only). */
  diskCache?: { read(): Promise<string | null>; write(text: string): Promise<void> };
  /** Clock, injected for tests. */
  now?: () => number;
  /** Logger for structural counts. Default console.log. */
  log?: (line: string) => void;
}

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
 * Why: Hyperliquid rate-limits by IP; 30 traders x 2 calls at once would trip it.
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
  private readonly o: Required<Omit<HyperliquidSourceOptions, "diskCache">> & { diskCache?: HyperliquidSourceOptions["diskCache"] };
  private leaderboard: { at: number; traders: LeaderboardTrader[] } | null = null;
  private leaderboardInFlight: Promise<LeaderboardTrader[]> | null = null;
  private readonly coinCache = new Map<string, { at: number; levels: TraderLevels; report: LevelsReport }>();

  constructor(opts: HyperliquidSourceOptions = {}) {
    this.o = {
      fetch: opts.fetch ?? ((u, i) => fetch(u, i)),
      topN: opts.topN ?? 30,
      minAccountValueUsd: opts.minAccountValueUsd ?? 100_000,
      concurrency: opts.concurrency ?? 6,
      requestTimeoutMs: opts.requestTimeoutMs ?? 8_000,
      leaderboardTimeoutMs: opts.leaderboardTimeoutMs ?? 90_000,
      leaderboardTtlMs: opts.leaderboardTtlMs ?? 6 * 60 * 60 * 1000,
      levelsTtlMs: opts.levelsTtlMs ?? 30_000,
      now: opts.now ?? Date.now,
      log: opts.log ?? ((l) => console.log(l)),
      diskCache: opts.diskCache,
    };
  }

  /**
   * The kept traders. Order of preference: memory cache, disk cache, download.
   * Concurrent callers share one download.
   */
  async getTopTraders(): Promise<LeaderboardTrader[]> {
    const now = this.o.now();
    if (this.leaderboard && now - this.leaderboard.at < this.o.leaderboardTtlMs) return this.leaderboard.traders;
    if (this.leaderboardInFlight) return this.leaderboardInFlight;
    this.leaderboardInFlight = (async () => {
      // Disk cache holds the TRIMMED list ({at, traders}), a few KB instead of 39 MB.
      if (this.o.diskCache) {
        const text = await this.o.diskCache.read().catch(() => null);
        if (text) {
          const cached = toObj(JSON.parse(text));
          const at = toNum(cached.at);
          const traders = toArr(cached.traders) as LeaderboardTrader[];
          if (now - at < this.o.leaderboardTtlMs && traders.length > 0) {
            this.leaderboard = { at, traders };
            this.o.log(`[levels] leaderboard from disk cache: kept ${traders.length}`);
            return traders;
          }
        }
      }
      const json = await fetchJson(this.o.fetch, HL_LEADERBOARD_URL, { method: "GET" }, this.o.leaderboardTimeoutMs);
      const rowsRead = toArr(toObj(json).leaderboardRows).length;
      const traders = parseLeaderboard(json, { topN: this.o.topN, minAccountValueUsd: this.o.minAccountValueUsd });
      this.o.log(`[levels] leaderboard read: ${rowsRead} rows, kept: ${traders.length}`);
      if (traders.length === 0) throw new Error("Hyperliquid leaderboard gave zero usable traders");
      this.leaderboard = { at: now, traders };
      if (this.o.diskCache) await this.o.diskCache.write(JSON.stringify(this.leaderboard)).catch(() => undefined);
      return traders;
    })().finally(() => {
      this.leaderboardInFlight = null;
    });
    return this.leaderboardInFlight;
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
    const post = (body: object) =>
      fetchJson(
        this.o.fetch,
        HL_INFO_URL,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        this.o.requestTimeoutMs,
      );
    const results = await mapLimited(traders, this.o.concurrency, async (t) => {
      const [state, orders] = await Promise.all([
        post({ type: "clearinghouseState", user: t.address }),
        post({ type: "frontendOpenOrders", user: t.address }),
      ]);
      return { liq: parseClearinghouseState(state, coin), ...parseFrontendOpenOrders(orders, coin) };
    });

    const levels: TraderLevels = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };
    let failed = 0;
    for (const r of results) {
      if (r instanceof Error) {
        failed++;
        continue;
      }
      levels.liquidationLevels.push(...r.liq);
      levels.limitLevels.push(...r.limits);
      levels.takeProfitLevels.push(...r.takeProfits);
    }
    const report: LevelsReport = {
      tradersKept: traders.length,
      tradersQueried: traders.length - failed,
      requestsFailed: failed,
      positionsOnCoin: levels.liquidationLevels.length,
      ordersOnCoin: levels.limitLevels.length + levels.takeProfitLevels.length,
      fromCache: false,
    };
    this.o.log(
      `[levels] ${coin}: traders kept ${report.tradersKept}, queried ok ${report.tradersQueried}, failed ${failed}, positions ${report.positionsOnCoin}, orders ${report.ordersOnCoin}`,
    );
    // Every request failing is an outage, not "no levels": say so loudly instead of returning empties.
    if (traders.length > 0 && failed === traders.length) throw new Error(`all ${failed} Hyperliquid trader requests failed`);
    this.coinCache.set(coin, { at: now, levels, report });
    return { levels, report };
  }
}

/** "BTCUSDT" -> "BTC". Hyperliquid names perps by coin only. */
export function coinFromSymbol(symbol: string): string {
  return symbol.replace(/USDT$|USD$|USDC$/, "");
}
