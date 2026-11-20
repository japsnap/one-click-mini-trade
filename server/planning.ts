/**
 * Building a plan from a request body on the server: fetch the price, symbol rules, order
 * book, trader levels, candles and the liquidation map, then run buildSetPlan. Used by the
 * preview and place routes of server/index.ts. Kept apart from index.ts (which starts a
 * server at import) so tests can drive it with fakes.
 *
 * Market data for the target (Sets_Rules.md E2, 2026-11-20):
 *  - Aster klines, two public calls cached 60 s: one-hour (volatility of the last 72 hours,
 *    swing high and low of the last 48) and four-hour (swing high and low of the last 42).
 *  - The liquidation map from HyperliquidLevelSource.getFuelLevels: read from memory, never a
 *    request (the map refreshes itself in the background).
 * Both are best effort: without candles the volatility floor is used and the counts say
 * "not given"; without the map the reason says "liquidation map unavailable".
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildSetPlan, type PlanMarket, type SetPlan } from "../src/core/plan";
import { chaseCheck, type ChaseResult } from "../src/core/chase";
import { planHeadline, positionWords, realizedVol1h, swingLevels } from "../src/core/takeProfit";
import { parseSetInput } from "../src/core/validate";
import { seededRandom, type LeverageBracket, type OrderBookDepth, type RandomSource, type SetInput, type SymbolRules, type TraderLevels } from "../src/core/types";
import type { Kline } from "../src/exchange/aster";
import { coinFromSymbol, type FuelLevels, type FuelMapReport, type LevelsReport } from "../src/levels/hyperliquid";
import { activeRules } from "../src/rules/rules";

/** The parts of the Aster client the planner reads (all public). */
export interface PlannerAster {
  getPrice(symbol: string): Promise<{ symbol: string; price: number; time: number }>;
  getSymbolRules(symbol: string): Promise<SymbolRules>;
  getDepth(symbol: string): Promise<OrderBookDepth & { skipped: number }>;
  getKlines(symbol: string, interval: "1h" | "4h", limit: number): Promise<Kline[]>;
}

/** The parts of the level source the planner reads. */
export interface PlannerLevels {
  getLevels(coin: string): Promise<{ levels: TraderLevels; report: LevelsReport }>;
  getFuelLevels(coin: string, price?: number): FuelLevels;
  /** Ask for the liquidation map (A10): starts it on demand and waits for the quick map, bounded. */
  ensureFuelMap(opts?: { wait?: boolean }): Promise<FuelMapReport>;
  /** False while no copy of the account list exists yet (its first download is running). */
  hasLeaderboard?(): boolean;
}

export interface PlannerDeps {
  aster: PlannerAster;
  levels: PlannerLevels;
  /** Leverage brackets (signed, live mode only); null in trial mode. */
  bracketsFor(symbol: string): Promise<LeverageBracket[] | null>;
  /** Cryptographic random in [0, 1) for placed Sets. */
  random: RandomSource;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => number;
  /** Wait function for the bounded trader read (tests pass a fake clock's). */
  sleep?: (ms: number) => Promise<void>;
}

/** A wait that never keeps the process alive on its own. */
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** What one plan was built from, printed and returned so a zero is visible. */
export interface PlanSources {
  levels: LevelsReport | { unavailable: string } | null;
  depth: { bids: number; asks: number; skipped: number } | { unavailable: string } | null;
  klines: { candles1h: number; candles4h: number; sigma1h: number | null; returnsUsed: number; tooFewCandles: boolean; swingHighs: number[]; swingLows: number[] } | { unavailable: string } | null;
  fuelMap: (FuelLevels["report"] & { status: "ok" | "unavailable"; note: string | null; reading: string | null }) | null;
  /** The anti-chase guard's verdict and numbers (A12); null when no candles were available. */
  chase: ChaseResult | null;
  maintenance: "brackets" | "assumed";
  seed: number | null;
}

/** How long candles stay fresh. */
const KLINE_TTL_MS = 60_000;

export function createPlanner(deps: PlannerDeps) {
  const log = deps.log ?? ((l: string) => console.log(l));
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const now = deps.now ?? Date.now;
  const klineCache = new Map<string, { at: number; klines: Kline[] }>();

  async function klines(symbol: string, interval: "1h" | "4h", limit: number): Promise<Kline[]> {
    const key = `${symbol}:${interval}:${limit}`;
    const hit = klineCache.get(key);
    if (hit && now() - hit.at < KLINE_TTL_MS) return hit.klines;
    const k = await deps.aster.getKlines(symbol, interval, limit);
    klineCache.set(key, { at: now(), klines: k });
    return k;
  }

  /** Candles for the target and the anti-chase guard. Best effort, every gap counted. */
  async function candlesFor(symbol: string): Promise<{ market: PlanMarket; klines: PlanSources["klines"]; h1: Kline[] | null; sigma1h: number | null }> {
    const t = activeRules().target;
    const market: PlanMarket = {};
    try {
      const [h1, h4] = await Promise.all([klines(symbol, "1h", Math.max(t.volLookbackHours + 1, t.swingLookback["1h"])), klines(symbol, "4h", Math.max(1, t.swingLookback["4h"]))]);
      const vol = realizedVol1h(h1.map((c) => c.close));
      const sw = swingLevels(h1, h4);
      market.sigma1h = vol.tooFewCandles ? null : vol.sigma1h;
      market.sigmaFloored = vol.floored;
      market.swingHighs = sw.highs;
      market.swingLows = sw.lows;
      return {
        market,
        h1,
        sigma1h: vol.sigma1h,
        klines: { candles1h: h1.length, candles4h: h4.length, sigma1h: market.sigma1h, returnsUsed: vol.returnsUsed, tooFewCandles: vol.tooFewCandles, swingHighs: sw.highs, swingLows: sw.lows },
      };
    } catch (e) {
      warn(`[klines] ${symbol} candles unavailable for the target, volatility floor used: ${(e as Error).message}`);
      return { market, h1: null, sigma1h: null, klines: { unavailable: (e as Error).message } };
    }
  }

  /** The liquidation map for the target, after the map has been asked for (A10: waits at most fuelMapWaitMs). */
  async function fuelFor(symbol: string, price: number): Promise<{ fuel: NonNullable<PlanMarket["fuel"]>; report: PlanSources["fuelMap"] }> {
    await deps.levels.ensureFuelMap();
    const f = deps.levels.getFuelLevels(coinFromSymbol(symbol), price);
    if (f.status === "unavailable" && !f.reading) warn(`[levels] ${symbol} ${f.note}`);
    if (f.reading) warn(`[levels] ${symbol} ${f.reading}`);
    return { fuel: { levels: f.levels, status: f.status, note: f.note, reading: f.reading }, report: { ...f.report, status: f.status, note: f.note, reading: f.reading } };
  }

  /** Kept for callers of the older name: candles plus the map. */
  async function marketFor(symbol: string, price: number): Promise<{ market: PlanMarket; klines: PlanSources["klines"]; fuelMap: PlanSources["fuelMap"] }> {
    const c = await candlesFor(symbol);
    const f = await fuelFor(symbol, price);
    return { market: { ...c.market, fuel: f.fuel }, klines: c.klines, fuelMap: f.report };
  }

  /**
   * Build a plan from a request body. allowSeed: previews may carry {"seed": <integer>} to
   * reproduce the random picks; placement never does.
   *
   * Order (A10, A12): candles first, then the entry, then the anti-chase guard on that entry
   * (no map needed); a chase is refused before the map is waited for. Then the map (quick map,
   * at most 8 s), then the target. The plan is built twice with the SAME random draws (the
   * first build only finds the entry), so the guard judges exactly the entry that is placed.
   */
  async function planFromBody(body: unknown, allowSeed: boolean): Promise<PlanOutcome> {
    const input = parseSetInput(body);
    const seedRaw = (body as { seed?: unknown } | null)?.seed;
    const seed = allowSeed && Number.isInteger(seedRaw) ? (seedRaw as number) : null;
    const rec = replayableRandom(seed !== null ? seededRandom(seed) : deps.random);
    const [{ price }, rules] = await Promise.all([deps.aster.getPrice(input.symbol), deps.aster.getSymbolRules(input.symbol)]);
    const empty: TraderLevels = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };
    const coin = coinFromSymbol(input.symbol);
    const sources: PlanSources = { levels: null, depth: null, klines: null, fuelMap: null, chase: null, maintenance: "assumed", seed };
    let levels: TraderLevels = empty;
    let depth: OrderBookDepth | null = null;
    const isDraw = input.entryMode === "draw";
    const candles = await candlesFor(input.symbol);
    sources.klines = candles.klines;
    const brackets = await deps.bracketsFor(input.symbol);
    sources.maintenance = brackets ? "brackets" : "assumed";
    const build = (random: RandomSource, market: PlanMarket | undefined) => buildSetPlan({ input, currentPrice: price, rules, levels, depth, brackets, random, market });

    // 0. Without candles the anti-chase guard cannot judge: refuse (architect's review 2026-11-21),
    //    before anything else is read. Never a silent pass.
    if (!candles.h1) {
      const error = "unavailable" in (candles.klines ?? {}) ? (candles.klines as { unavailable: string }).unavailable : "no candles";
      const refusal: PlanRefusal = {
        status: "refused: guard unavailable",
        message: `No Set now: the anti-chase check could not load Aster's hourly prices.\nError: ${error}`,
        hint: null,
        chase: null,
      };
      warn(`[chase] ${input.symbol}: guard unavailable, refused: ${error}`);
      return { plan: build(rec.random, undefined), sources, refusal };
    }
    const guard = (entry: number): PlanRefusal | null => {
      const chase = chaseCheck(entry, input.side, candles.h1 as Kline[], candles.sigma1h ?? activeRules().target.volFloor, activeRules().chase, { asOf: now(), coin });
      sources.chase = chase;
      if (!chase.chase) return null;
      const opposite = input.side === "buy" ? "sell" : "buy";
      log(`[chase] ${input.symbol} ${positionWords(input.side).position} from ${entry} refused: ${(chase.sentence as string).replace("\n", " ")}`);
      return {
        status: "refused: chasing",
        message: chase.sentence as string,
        hint: { label: `preview a ${positionWords(opposite).position} instead`, input: { ...input, side: opposite } },
        chase,
      };
    };

    // 1. Now: the entry is the price, so the guard runs first, before any map or trader read.
    //    Draw: the painted bands are the entry; no map, no traders.
    if (input.entryMode === "now" || isDraw) {
      const first = build(rec.random, isDraw ? undefined : candles.market);
      const refusal = guard(first.entry.expectedFillPrice);
      if (refusal) return { plan: first, sources, refusal };
      if (isDraw) {
        log(countsLine(first, sources));
        return { plan: first, sources, refusal: null };
      }
    }

    // 2. The liquidation map FIRST, in every mode, so its quick read gets the per-minute budget
    //    (2026-11-21: read after the trader sample, a cold Nearby got "thin: 50 of 600").
    const deadline = now() + activeRules().target.fuelMapWaitMs;
    const f = await fuelFor(input.symbol, price);
    sources.fuelMap = f.report;

    // 3. The traders' levels. Nearby and Patient ARE these levels (a failure is an error); for
    //    Now they feed only the target's walls (best effort, bounded by the same 8 s deadline
    //    when no copy of the account list exists yet).
    if (input.entryMode === "nearby" || input.entryMode === "patient") {
      const r = await deps.levels.getLevels(coin);
      levels = r.levels;
      sources.levels = r.report;
    } else {
      const waitMs = activeRules().target.fuelMapWaitMs;
      const read = deps.levels.getLevels(coin).then(
        (r) => ({ ok: true as const, r }),
        (e: Error) => ({ ok: false as const, e }),
      );
      const bound = deps.levels.hasLeaderboard?.() === false ? Math.max(0, deadline - now()) : waitMs;
      const timeout = (deps.sleep ?? defaultSleep)(bound).then(() => null);
      const got = await Promise.race([read, timeout]);
      if (got === null) {
        const why = `traders' levels not ready after ${waitMs / 1000} s: the account list is still downloading (no cached copy yet)`;
        warn(`[levels] ${coin} ${why}`);
        sources.levels = { unavailable: why };
      } else if (got.ok) {
        levels = got.r.levels;
        sources.levels = got.r.report;
      } else {
        warn(`[levels] ${coin} unavailable for the target, using Aster's book and round numbers: ${got.e.message}`);
        sources.levels = { unavailable: got.e.message };
      }
    }
    // Aster's public order book: walls for the target. Best effort.
    try {
      const d = await deps.aster.getDepth(input.symbol);
      depth = d;
      sources.depth = { bids: d.bids.length, asks: d.asks.length, skipped: d.skipped };
    } catch (e) {
      warn(`[depth] ${input.symbol} order book unavailable for the target: ${(e as Error).message}`);
      sources.depth = { unavailable: (e as Error).message };
    }

    // 4. Nearby and Patient: their entry exists only now; the guard judges it (the map was read
    //    already, which a refused Nearby or Patient Set costs; nothing is placed).
    const market = { ...candles.market, fuel: f.fuel };
    if (input.entryMode === "nearby" || input.entryMode === "patient") {
      const first = build(rec.random, market);
      const refusal = guard(first.entry.expectedFillPrice);
      if (refusal) return { plan: first, sources, refusal };
    }

    // 5. The plan, with the same random draws as the entry the guard judged.
    const plan = build(rec.replay(), market);
    // Nearby and Patient ARE the traders' levels: say how old the sample is (reused up to 5 minutes).
    const age = sources.levels && "ageMs" in sources.levels ? sources.levels.ageMs : 0;
    if ((input.entryMode === "nearby" || input.entryMode === "patient") && age >= 60_000) {
      plan.entry.reason = `${plan.entry.reason} (skilled traders' levels read ${Math.round(age / 60_000)} min ago)`;
    }
    log(countsLine(plan, sources));
    return { plan, sources, refusal: null };
  }

  return { planFromBody, marketFor };
}

/**
 * A plan refused before anything is sent: by the anti-chase guard (A12; the card offers the
 * other side), or because the guard could not run (no candles; no hint, try again).
 */
export interface PlanRefusal {
  status: "refused: chasing" | "refused: guard unavailable";
  message: string;
  hint: { label: string; input: SetInput } | null;
  chase: ChaseResult | null;
}
/** Kept for callers of the older name. */
export type ChaseRefusal = PlanRefusal;

/** What planFromBody returns: the plan, its sources, and the refusal when the guard said no. */
export interface PlanOutcome {
  plan: SetPlan;
  sources: PlanSources;
  refusal: PlanRefusal | null;
}

/**
 * A random source whose draws can be played again: the first plan finds the entry, the
 * second (with the map) repeats exactly those draws, then continues with fresh ones.
 */
export function replayableRandom(src: RandomSource): { random: RandomSource; replay(): RandomSource } {
  const draws: number[] = [];
  return {
    random: () => {
      const r = src();
      draws.push(r);
      return r;
    },
    replay: () => {
      let i = 0;
      return () => (i < draws.length ? (draws[i++] as number) : src());
    },
  };
}

/** The structural counts of one plan in one line (entry, target, data sources). */
export function countsLine(plan: SetPlan, sources: PlanSources): string {
  const d = plan.diagnostics;
  const t = d.takeProfit;
  const fm = sources.fuelMap;
  const target = t
    ? `target: fuel levels read ${t.liquidationLevelsRead}, on the profit side ${t.liquidationsOnProfitSide}, in window ${t.liquidationsInWindow}, clusters ${t.clustersFound} (too small ${t.clustersTooSmall}, inside the line ${t.clustersBelowSlackLine}); ` +
      `book levels ${d.oppositeVolumeLevels.venueBook} + traders ${d.oppositeVolumeLevels.traders}, in window ${t.levelsInWindow}; brakes ${t.brakesFound} (walls ${t.walls}, round ${t.roundNumbers}, swing ${t.swingHighs}, trader tps ${t.traderTakeProfits}); ` +
      `candidates ${t.candidatesScored} (out of reach ${t.candidatesOutOfReach}, outside window ${t.candidatesOutsideWindow}); sigma1h ${t.sigma1h.toFixed(4)} (${t.sigmaSource}), H ${t.horizonHours} h; ` +
      `winner ${t.winner ? `${t.winner.kind} pull ${t.winner.pull} reach ${t.winner.reach} pass ${t.winner.pass} score ${t.winner.score}` : "none (bare floor)"}`
    : "target: drawn";
  const map = fm ? `; liquidation map ${fm.status}, stage ${fm.stage}, usable ${fm.addressesWithFreshAnswer} of ${fm.addressesInSample} (fresh ${fm.fresh})` : "";
  const lv = sources.levels ? ("unavailable" in sources.levels ? `; trader sample unavailable (${sources.levels.unavailable})` : `; trader sample ${Math.round((sources.levels.ageMs ?? 0) / 1000)} s old, skipped by budget ${sources.levels.skippedByRateBudget}`) : "";
  const ch = sources.chase ? `; chase ${sources.chase.chase ? "REFUSED" : "no"} (edge ${sources.chase.edge}, fast ${sources.chase.fast})` : "";
  return (
    `[counts] ${plan.input.symbol} ${plan.input.side} ${plan.input.entryMode}: ` +
    `liquidations read ${d.entry.liquidationsRead ?? "-"}, on side ${d.entry.liquidationsOnSide ?? "-"}, in window ${d.entry.liquidationsInWindow ?? "-"}; ` +
    `orders read ${d.entry.ordersRead ?? "-"}, in window ${d.entry.ordersInWindow ?? "-"}, buckets kept ${d.entry.nearbyBucketsKept ?? "-"}; ` +
    `${target}${map}${lv}${ch}; maintenance ${sources.maintenance}`
  );
}

/**
 * What a plan was built from, short enough for every plans.jsonl line: the liquidation map's
 * freshness and request counts, whether candles were there, the book, the trader sample.
 */
export function sourcesForLog(s: PlanSources): Record<string, unknown> {
  const fm = s.fuelMap;
  const k = s.klines;
  return {
    fuelMap: fm
      ? {
          status: fm.status,
          stage: fm.stage,
          note: fm.note,
          reading: fm.reading,
          usable: fm.addressesWithFreshAnswer,
          fresh: fm.fresh,
          inSample: fm.addressesInSample,
          asked: fm.addressesAsked,
          answered: fm.answered,
          failed: fm.failed,
          skippedByBudget: fm.skippedByBudget,
          levelsOnCoin: fm.liquidationLevels,
        }
      : null,
    chase: s.chase ? { chase: s.chase.chase, edge: s.chase.edge, fast: s.chase.fast, enabled: s.chase.enabled, numbers: s.chase.numbers } : null,
    klines: k === null ? null : "unavailable" in k ? { available: false, error: k.unavailable } : { available: true, candles1h: k.candles1h, candles4h: k.candles4h, sigma1h: k.sigma1h, tooFewCandles: k.tooFewCandles },
    depth: s.depth,
    levels:
      s.levels === null
        ? null
        : "unavailable" in s.levels
          ? s.levels
          : { positionAddressesOk: s.levels.positionAddressesOk, orderAddressesOk: s.levels.orderAddressesOk, skippedByRateBudget: s.levels.skippedByRateBudget, fromCache: s.levels.fromCache, ageSeconds: Math.round((s.levels.ageMs ?? 0) / 1000) },
    maintenance: s.maintenance,
    seed: s.seed,
  };
}

/**
 * The line one plan adds to logs/plans.jsonl: the orders, the stop, and the target with its
 * reason, its top 5 candidates by score and its counts.
 */
export function planLogLine(kind: "preview" | "place", plan: SetPlan, extra: Record<string, unknown> = {}, at = new Date()): Record<string, unknown> {
  return {
    at: at.toISOString(),
    kind,
    headline: summaryOf(plan),
    symbol: plan.input.symbol,
    side: plan.input.side,
    ticketUsd: plan.input.ticketUsd,
    leverage: plan.input.leverage,
    entryMode: `${plan.entry.requestedMode}->${plan.entry.usedMode}`,
    orders: plan.orders,
    liquidation: plan.liquidationPrice,
    stop: plan.stop,
    takeProfit: {
      price: plan.takeProfit.price,
      ratio: plan.takeProfit.ratio,
      source: plan.takeProfit.source,
      reason: plan.takeProfit.reason,
      candidates: plan.takeProfit.candidates.map((c) => ({
        kind: c.kind,
        price: c.price,
        ratio: round(c.ratio, 4),
        pull: round(c.pull, 4),
        reach: round(c.reach, 5),
        pass: round(c.pass, 4),
        score: round(c.score, 4),
        weightUsd: Math.round(c.weightUsd),
        traders: c.traders,
      })),
      counts: plan.takeProfit.counts,
    },
    ...extra,
  };
}

/** The A13 headline of a plan: "ETH Short from 1,764.96, buy back 1,667.52 (2.29x), stop 1,807.46". */
export function summaryOf(plan: SetPlan): string {
  return planHeadline({ symbol: plan.input.symbol, side: plan.input.side, entry: plan.entry.expectedFillPrice, takeProfit: plan.takeProfit.price, ratio: plan.takeProfit.ratio, stop: plan.stop.price });
}

/** Append one plan line to <dir>/plans.jsonl and print a one-line summary with the reason. */
export async function appendPlanLog(dir: string, kind: "preview" | "place", plan: SetPlan, extra: Record<string, unknown> = {}, log: (l: string) => void = (l) => console.log(l)): Promise<Record<string, unknown>> {
  const line = planLogLine(kind, plan, extra);
  log(
    `[plan] ${kind} ${line.headline} $${plan.input.ticketUsd} ${plan.input.leverage}x ${line.entryMode} (${plan.takeProfit.source}): ${plan.takeProfit.reason}`,
  );
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "plans.jsonl"), JSON.stringify(line) + "\n");
  return line;
}

function round(x: number, places: number): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
