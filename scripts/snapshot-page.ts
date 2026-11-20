/**
 * Page data from the real planner: every Set a BTCUSDT card can show at one moment.
 * Run: npx tsx scripts/snapshot-page.ts <output.json>
 *
 * Trial mode, public data only: no keys are read, no .env is loaded, nothing is signed or sent.
 * Combinations: ticket {10, 30, 100} x side {buy, sell} x leverage {30, 50, 100} x greed
 * {shy, deserved, greedy} x entry {now, nearby, patient} = 3 x 2 x 3 x 3 x 3 = 162.
 *
 * One shared market read for all of them: one Aster price, one order book, one candles read
 * (1h and 4h), one read of the skilled traders' levels, and the liquidation map read to the
 * whole sample (600 accounts), then frozen. Each combination gets its own seeded random, and
 * the seed leaves the ticket out, so a $10 and a $100 Set of the same choices get the same
 * prices; the script checks that on its own output and says how many groups differ.
 *
 * Output: { time, symbol, counts, sets: { "<ticket>_<side>_<lev>_<greed>_<entry>": row } }.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlanner, type PlannerAster, type PlannerLevels, type PlanOutcome } from "../server/planning";
import { loadRulesFile } from "../server/rules";
import { AsterClient } from "../src/exchange/aster";
import { HyperliquidLevelSource, type FuelLevels } from "../src/levels/hyperliquid";
import { activeRules } from "../src/rules/rules";
import type { EntryMode, Leverage, Side, TicketUsd, TpMode } from "../src/core/types";

export const TICKETS: TicketUsd[] = [10, 30, 100] as TicketUsd[];
export const SIDES: Side[] = ["buy", "sell"];
export const LEVERAGES: Leverage[] = [30, 50, 100] as Leverage[];
export const GREEDS: TpMode[] = ["shy", "deserved", "greedy"];
export const ENTRIES: Exclude<EntryMode, "draw">[] = ["now", "nearby", "patient"];

export interface Combo {
  ticket: TicketUsd;
  side: Side;
  lev: Leverage;
  greed: TpMode;
  entry: Exclude<EntryMode, "draw">;
}

/** "10_buy_30_deserved_now". */
export function comboKey(c: Combo): string {
  return `${c.ticket}_${c.side}_${c.lev}_${c.greed}_${c.entry}`;
}

/** Every combination, ticket first (162). */
export function combinations(): Combo[] {
  const out: Combo[] = [];
  for (const ticket of TICKETS) for (const side of SIDES) for (const lev of LEVERAGES) for (const greed of GREEDS) for (const entry of ENTRIES) out.push({ ticket, side, lev, greed, entry });
  return out;
}

/**
 * The seed of one combination: FNV-1a of side, leverage, greed and entry. The ticket is left
 * out on purpose, so the random picks (Nearby's band, the nudge, the jitter in front of a
 * brake) are the same for every ticket size.
 */
export function comboSeed(c: Omit<Combo, "ticket"> & { ticket?: unknown }): number {
  const text = `${c.side}|${c.lev}|${c.greed}|${c.entry}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h | 0;
}

/** One row of the page data. Price fields are null when the Set was refused. */
export interface SnapshotRow {
  px: number | null;
  used: string | null;
  why: string | null;
  fb: string[];
  e: number | null;
  s: number | null;
  l: number | null;
  t: number | null;
  r: number | null;
  src: string | null;
  reason: string | null;
  w: number | null;
  x: number | null;
  q: number | null;
  refused?: { status: string; message: string };
}

/** The row of a planner outcome: refused (anti-chase or guard) gives null prices and the refusal. */
export function rowFromOutcome(o: PlanOutcome): SnapshotRow {
  const p = o.plan;
  if (o.refusal) {
    return { px: p.currentPrice, used: null, why: null, fb: [], e: null, s: null, l: null, t: null, r: null, src: null, reason: null, w: null, x: null, q: null, refused: { status: o.refusal.status, message: o.refusal.message } };
  }
  return {
    px: p.currentPrice,
    used: p.entry.usedMode,
    why: p.entry.reason,
    fb: [...p.entry.fellBackFrom],
    e: p.entry.expectedFillPrice,
    s: p.stop.price,
    l: p.liquidationPrice,
    t: p.takeProfit.price,
    r: p.takeProfit.ratio,
    src: p.takeProfit.source,
    reason: p.takeProfit.reason,
    w: p.expected.profitAtTpUsd,
    x: p.expected.lossAtStopUsd,
    q: p.quantity,
  };
}

/** The row of a combination that threw (ticket too small, bad input...): refused, with the error. */
export function rowFromError(e: unknown, px: number | null): SnapshotRow {
  const err = e as Error;
  return { px, used: null, why: null, fb: [], e: null, s: null, l: null, t: null, r: null, src: null, reason: null, w: null, x: null, q: null, refused: { status: `error: ${err.name ?? "Error"}`, message: err.message ?? String(e) } };
}

/**
 * Groups of the same choices (all but the ticket) whose prices differ between tickets. Empty
 * means the page can switch the ticket without any price moving.
 */
export function ticketMismatches(sets: Record<string, SnapshotRow>): string[] {
  const groups = new Map<string, string[]>();
  for (const [k, row] of Object.entries(sets)) {
    const g = k.split("_").slice(1).join("_");
    const sig = JSON.stringify([row.px, row.used, row.e, row.s, row.l, row.t, row.r, row.src, row.refused?.status ?? null]);
    groups.set(g, [...(groups.get(g) ?? []), sig]);
  }
  return [...groups.entries()].filter(([, sigs]) => new Set(sigs).size > 1).map(([g]) => g);
}

/** An Aster client wrapper that answers every repeated public read with its first answer. */
function frozenAster(a: AsterClient): PlannerAster & { reads: Record<string, number> } {
  const memo = new Map<string, Promise<unknown>>();
  const reads: Record<string, number> = {};
  const once = <R>(key: string, f: () => Promise<R>): Promise<R> => {
    if (!memo.has(key)) {
      reads[key.split(":")[0] as string] = (reads[key.split(":")[0] as string] ?? 0) + 1;
      memo.set(key, f());
    }
    return memo.get(key) as Promise<R>;
  };
  return {
    reads,
    getPrice: (s) => once(`price:${s}`, () => a.getPrice(s)),
    getSymbolRules: (s) => once(`rules:${s}`, () => a.getSymbolRules(s)),
    getDepth: (s) => once(`depth:${s}`, () => a.getDepth(s)),
    getKlines: (s, i, n) => once(`klines:${s}:${i}:${n}`, () => a.getKlines(s, i, n)),
  };
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: npx tsx scripts/snapshot-page.ts <output.json>");
    process.exit(2);
  }
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // The owner's rule file when present (rules/my-rules.json), else the defaults. No environment is read.
  const loaded = loadRulesFile({}, ROOT);
  console.log(`[rules] ${loaded.source}`);
  const symbol = "BTCUSDT";
  const coin = "BTC";
  const t = activeRules().target;

  const aster = frozenAster(new AsterClient()); // no auth: public calls only
  const cacheFile = path.join(ROOT, ".cache", "hl-leaderboard.json");
  const hl = new HyperliquidLevelSource({
    diskCache: {
      read: () => readFile(cacheFile, "utf8").catch(() => null),
      write: async (text) => {
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, text);
      },
    },
    fuelMap: { topN: t.fuelMapTopN, refreshMinutes: t.fuelMapRefreshMinutes, quickN: t.fuelMapQuickN, waitMs: t.fuelMapWaitMs, ttlMinutes: t.fuelMapTtlMinutes, idleMinutes: t.fuelMapIdleMinutes },
    log: () => {},
  });

  // 1. The liquidation map, read to the whole sample (at most 8 minutes), then frozen.
  const started = Date.now();
  await hl.ensureFuelMap();
  let map: FuelLevels = hl.getFuelLevels(coin);
  for (;;) {
    map = hl.getFuelLevels(coin);
    const { addressesWithFreshAnswer: got, addressesInSample: of } = map.report;
    if (of > 0 && got >= of) break;
    if (Date.now() - started > 8 * 60_000) {
      console.warn(`[map] not full after 8 minutes: ${got} of ${of}; building with what answered`);
      break;
    }
    await hl.ensureFuelMap({ wait: false }); // keeps the reading loop from going idle
    console.log(`[map] ${got} of ${of} accounts, stage ${map.report.stage}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  hl.stopFuelMap();

  // 2. One price, one book, one candles read (through the frozen client), then the map at that price.
  const { price, time } = await aster.getPrice(symbol);
  const at = new Date();
  map = hl.getFuelLevels(coin, price);
  console.log(`[map] frozen: ${map.report.addressesWithFreshAnswer} of ${map.report.addressesInSample} accounts, stage ${map.report.stage}, ${map.levels.length} BTC liquidation levels (shorts above ${map.report.shortLevelsAbove}, longs below ${map.report.longLevelsBelow})`);

  // 3. The skilled traders' levels, read once.
  const traderRead = hl.getLevels(coin);
  traderRead.catch(() => {}); // a failure reaches each Nearby and Patient row as its error
  const levels: PlannerLevels = {
    getLevels: () => traderRead,
    getFuelLevels: () => map,
    ensureFuelMap: async () => ({ ...map.report }),
    hasLeaderboard: () => true,
  };

  const warnings: string[] = [];
  const planner = createPlanner({
    aster,
    levels,
    bracketsFor: async () => null, // trial: brackets are a signed call
    random: () => {
      throw new Error("an unseeded random draw: every combination must carry its seed");
    },
    log: () => {},
    warn: (l) => warnings.push(l),
  });

  // 4. Every combination.
  const sets: Record<string, SnapshotRow> = {};
  const winners = new Set<string>();
  let withCluster = 0;
  let maxClusters = 0;
  for (const c of combinations()) {
    const body = { symbol, side: c.side, ticketUsd: c.ticket, leverage: c.lev, tpMode: c.greed, entryMode: c.entry, seed: comboSeed(c) };
    try {
      const o = await planner.planFromBody(body, true);
      sets[comboKey(c)] = rowFromOutcome(o);
      if (!o.refusal) {
        const n = o.plan.takeProfit.counts?.clustersFound ?? 0;
        if (n > 0) withCluster++;
        maxClusters = Math.max(maxClusters, n);
        if (o.plan.takeProfit.source === "liquidation-cluster") winners.add(`${c.side}:${o.plan.takeProfit.price}`);
      }
    } catch (e) {
      sets[comboKey(c)] = rowFromError(e, price);
    }
  }

  const rows = Object.values(sets);
  const refused = rows.filter((r) => r.refused);
  const byStatus: Record<string, number> = {};
  for (const r of refused) byStatus[r.refused!.status] = (byStatus[r.refused!.status] ?? 0) + 1;
  const mismatches = ticketMismatches(sets);
  const doc = {
    time: at.toISOString(),
    priceTime: new Date(time).toISOString(),
    symbol,
    rules: loaded.source,
    counts: {
      combinations: rows.length,
      built: rows.length - refused.length,
      refused: refused.length,
      refusedByStatus: byStatus,
      ticketPriceMismatches: mismatches.length,
      mapFresh: map.report.addressesWithFreshAnswer,
      mapInSample: map.report.addressesInSample,
      mapStage: map.report.stage,
      mapStatus: map.status,
      liquidationLevels: map.levels.length,
      shortLevelsAbove: map.report.shortLevelsAbove,
      longLevelsBelow: map.report.longLevelsBelow,
      clusters: { combinationsWithAQualifyingCluster: withCluster, mostInOneWindow: maxClusters, distinctClusterTargetsChosen: winners.size },
      marketReads: aster.reads,
      hyperliquidRequests: hl.requestsSent(),
      warnings: warnings.length,
    },
    sets,
  };
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, JSON.stringify(doc, null, 1));
  console.log(`[snapshot] ${rows.length} combinations: built ${doc.counts.built}, refused ${refused.length} ${JSON.stringify(byStatus)}; ticket price mismatches ${mismatches.length}; reads ${JSON.stringify(aster.reads)}; written ${out}`);
  if (warnings.length) console.log(`[snapshot] planner warnings (${warnings.length}), first: ${warnings[0]}`);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`[snapshot] failed: ${(e as Error).stack ?? e}`);
      process.exit(1);
    },
  );
}
