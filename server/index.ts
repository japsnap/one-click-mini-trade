/**
 * The demo signing server (run: npm run server).
 *
 * It is the ONLY place a private key lives. The browser sends the user's choices,
 * the server rebuilds the plan itself (it never trusts a plan from the client),
 * and only the server signs. In Blackboard, this role is played by its own backend
 * or the Privy-held agent key; the routes here show the contract.
 *
 * Routes:
 *   GET  /api/price?symbol=BTCUSDT        latest Aster price
 *   GET  /api/levels?coin=BTC             skilled traders' levels from Hyperliquid
 *   POST /api/set/preview                 full order plan, nothing sent (optional "seed": an integer, reproduces the random picks)
 *   POST /api/set/place                   trial by default ("trial: not sent");
 *                                         live only when LIVE_TRADING=true, ticket <= MAX_LIVE_TICKET_USD
 *                                         and symbol is BTCUSDT or ETHUSDT
 *   GET  /api/sets                        every Set in the ledger with its status and its own profit
 *   GET  /api/health                      mode and which settings are present (no values)
 *
 * Many Sets at once (2026-11-16): live Sets are recorded in a Set ledger
 * (src/core/ledger.ts), kept here in logs/set-ledger.json. This demo server has no Aster
 * user data stream, so it never calls handleOrderUpdate or reconcileSymbol
 * (server/execute.ts); Blackboard's backend does (README "Many Sets at once").
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSetPlan, type SetPlan } from "../src/core/plan";
import { InvalidSetInputError, parseSetInput } from "../src/core/validate";
import { seededRandom, type LeverageBracket, type OrderBookDepth, type RandomSource, type TraderLevels } from "../src/core/types";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";
import { HyperliquidLevelSource, coinFromSymbol, type LevelsReport } from "../src/levels/hyperliquid";
import { ConfigError, describeConfig, loadConfig } from "./config";
import { describeLedger, executeLive, planToSetLegs, preTradeCheck, type LedgerStore } from "./execute";
import { parsePositionRows } from "../src/exchange/aster";
import { emptyLedger, newSetId, type SetLedger } from "../src/core/ledger";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env if present (Node's own loader; values go into process.env and are never printed).
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`[config] ${e.message}`);
    process.exit(1);
  }
  throw e;
}
const cfg = config;

// Signing key -> signer. Built once; the key itself is not kept anywhere else.
const signer = cfg.credentials ? privateKeySigner(cfg.credentials.privateKey) : null;
const aster = new AsterClient({
  baseUrl: cfg.baseUrl,
  auth: cfg.credentials && signer ? { user: cfg.credentials.user, signer: cfg.credentials.signer, sign: signer.sign } : undefined,
  builder: cfg.builder ?? undefined,
});

// Hyperliquid levels, with the trimmed leaderboard cached on disk for 6 hours.
// Trader sets and the rate budget use the source's defaults (src/levels/hyperliquid.ts).
const cacheFile = path.join(ROOT, ".cache", "hl-leaderboard.json");
const levelsSource = new HyperliquidLevelSource({
  diskCache: {
    read: () => readFile(cacheFile, "utf8").catch(() => null),
    write: async (t) => {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, t);
    },
  },
});

/**
 * The Set ledger of this server's one account, as a JSON file. Blackboard keeps one per
 * account in its own database. A missing file is an empty ledger; a corrupt one stops the
 * request loudly (a silent empty ledger would make every open Set look like a stranger's trade).
 */
const ledgerFile = path.join(ROOT, "logs", "set-ledger.json");
const ledgerStore: LedgerStore = {
  load: async () => {
    const text = await readFile(ledgerFile, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (text === null) return emptyLedger();
    const l = JSON.parse(text) as SetLedger;
    if (l?.version !== 1 || !Array.isArray(l.sets)) throw new Error(`${ledgerFile} is not a Set ledger`);
    return l;
  },
  save: async (l) => {
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(ledgerFile, JSON.stringify(l, null, 2));
  },
};

/** Cryptographic random in [0, 1) for the price nudge. */
const random = () => randomInt(0, 2 ** 31) / 2 ** 31;

/** Append one plan to logs/plans.jsonl and print a one-line summary. */
async function logPlan(kind: "preview" | "place", plan: SetPlan, extra: Record<string, unknown> = {}) {
  const line = {
    at: new Date().toISOString(),
    kind,
    symbol: plan.input.symbol,
    side: plan.input.side,
    ticketUsd: plan.input.ticketUsd,
    leverage: plan.input.leverage,
    entryMode: `${plan.entry.requestedMode}->${plan.entry.usedMode}`,
    orders: plan.orders,
    liquidation: plan.liquidationPrice,
    stop: plan.stop,
    takeProfit: plan.takeProfit,
    ...extra,
  };
  console.log(
    `[plan] ${kind} ${line.symbol} ${line.side} $${line.ticketUsd} ${line.leverage}x ${line.entryMode} entries=${plan.orders.entries.length} tp=${plan.takeProfit.price} (${plan.takeProfit.source}) stop=${plan.stop.price} ratio=${plan.takeProfit.ratio.toFixed(2)}`,
  );
  await mkdir(path.join(ROOT, "logs"), { recursive: true });
  await appendFile(path.join(ROOT, "logs", "plans.jsonl"), JSON.stringify(line) + "\n");
}

/**
 * Leverage brackets (maintenance margin rate per position size) are a SIGNED Aster call,
 * so they are read only in live mode, cached for an hour. In trial mode the plan uses the
 * assumed rate (src/core/stop.ts DEFAULT_ASSUMED_MAINTENANCE_RATE) and says so.
 */
const bracketCache = new Map<string, { at: number; brackets: LeverageBracket[] }>();
async function bracketsFor(symbol: string): Promise<LeverageBracket[] | null> {
  if (!cfg.liveTrading || !cfg.credentials) return null;
  const hit = bracketCache.get(symbol);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.brackets;
  const brackets = await aster.leverageBrackets(symbol); // throws loudly: a live stop must not run on a silent guess
  bracketCache.set(symbol, { at: Date.now(), brackets });
  return brackets;
}

/** What one plan was built from, printed and returned so a zero is visible. */
interface PlanSources {
  levels: LevelsReport | { unavailable: string } | null;
  depth: { bids: number; asks: number; skipped: number } | { unavailable: string } | null;
  maintenance: "brackets" | "assumed";
  seed: number | null;
}

/**
 * Build a plan from a request body, fetching price, rules, levels and the order book.
 * allowSeed: previews may carry {"seed": <integer>} to reproduce the random picks exactly;
 * placement never does (a placed Set always draws fresh cryptographic randomness).
 */
async function planFromBody(body: unknown, allowSeed: boolean): Promise<{ plan: SetPlan; sources: PlanSources }> {
  const input = parseSetInput(body);
  const seedRaw = (body as { seed?: unknown } | null)?.seed;
  const seed = allowSeed && Number.isInteger(seedRaw) ? (seedRaw as number) : null;
  const rnd: RandomSource = seed !== null ? seededRandom(seed) : random;
  const [{ price }, rules] = await Promise.all([aster.getPrice(input.symbol), aster.getSymbolRules(input.symbol)]);
  const empty: TraderLevels = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };
  const coin = coinFromSymbol(input.symbol);
  const sources: PlanSources = { levels: null, depth: null, maintenance: "assumed", seed };
  let levels: TraderLevels = empty;
  let depth: OrderBookDepth | null = null;
  if (input.entryMode !== "draw") {
    if (input.entryMode === "nearby" || input.entryMode === "patient") {
      // These modes ARE the traders' levels: a failure here is an error, never a silent "Now".
      const r = await levelsSource.getLevels(coin);
      levels = r.levels;
      sources.levels = r.report;
    } else {
      // Now uses traders' orders only for the take-profit zone; if Hyperliquid is down,
      // Aster's own book and round numbers still work, so this is best effort (logged).
      try {
        const r = await levelsSource.getLevels(coin);
        levels = r.levels;
        sources.levels = r.report;
      } catch (e) {
        console.warn(`[levels] ${coin} unavailable for the take-profit zone, using Aster's book and round numbers: ${(e as Error).message}`);
        sources.levels = { unavailable: (e as Error).message };
      }
    }
    // Aster's public order book feeds the take-profit volume zone. Best effort: without it
    // the zone uses traders' orders only, then the round-number fallback.
    try {
      const d = await aster.getDepth(input.symbol);
      depth = d;
      sources.depth = { bids: d.bids.length, asks: d.asks.length, skipped: d.skipped };
    } catch (e) {
      console.warn(`[depth] ${input.symbol} order book unavailable for the take-profit zone: ${(e as Error).message}`);
      sources.depth = { unavailable: (e as Error).message };
    }
  } // Draw: the user painted both bands; no levels or book needed.
  const brackets = await bracketsFor(input.symbol);
  sources.maintenance = brackets ? "brackets" : "assumed";
  const plan = buildSetPlan({ input, currentPrice: price, rules, levels, depth, brackets, random: rnd });
  const d = plan.diagnostics;
  console.log(
    `[counts] ${input.symbol} ${input.side} ${input.entryMode}: ` +
      `liquidations read ${d.entry.liquidationsRead ?? "-"}, on side ${d.entry.liquidationsOnSide ?? "-"}, in window ${d.entry.liquidationsInWindow ?? "-"}; ` +
      `orders read ${d.entry.ordersRead ?? "-"}, in window ${d.entry.ordersInWindow ?? "-"}, buckets kept ${d.entry.nearbyBucketsKept ?? "-"}; ` +
      `tp zone levels venue ${d.oppositeVolumeLevels.venueBook} + traders ${d.oppositeVolumeLevels.traders}, in window ${d.takeProfitZone?.levelsInWindow ?? "-"}, ` +
      `buckets ${d.takeProfitZone?.bucketsInWindow ?? "-"}, heaviest $${Math.round(d.takeProfitZone?.heaviestBucketUsd ?? 0)}; maintenance ${sources.maintenance}`,
  );
  return { plan, sources };
}

/** Read a JSON body (max 64 KB). */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new InvalidSetInputError("body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new InvalidSetInputError("body is not valid JSON");
  }
}

/** Send JSON. */
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { mode: cfg.liveTrading ? "live" : "trial", config: describeConfig(cfg) });
    }
    if (req.method === "GET" && url.pathname === "/api/sets") {
      const ledger = await ledgerStore.load();
      return send(res, 200, { count: ledger.sets.length, sets: describeLedger(ledger) });
    }
    if (req.method === "GET" && url.pathname === "/api/price") {
      const symbol = (url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
      if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return send(res, 400, { error: "symbol must look like BTCUSDT" });
      return send(res, 200, await aster.getPrice(symbol));
    }
    if (req.method === "GET" && url.pathname === "/api/levels") {
      const coin = (url.searchParams.get("coin") ?? "BTC").toUpperCase();
      if (!/^[A-Z0-9]{1,15}$/.test(coin)) return send(res, 400, { error: "coin must look like BTC" });
      const { levels, report } = await levelsSource.getLevels(coin);
      return send(res, 200, {
        coin,
        report,
        counts: {
          limitLevels: levels.limitLevels.length,
          takeProfitLevels: levels.takeProfitLevels.length,
          liquidationLevels: levels.liquidationLevels.length,
        },
        levels,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/set/preview") {
      const { plan, sources } = await planFromBody(await readJson(req), true);
      const rules = await aster.getSymbolRules(plan.input.symbol);
      await logPlan("preview", plan);
      // With keys set, run the same read-only checks a live Set must pass, so the card can
      // show the warnings (own position on the coin, liquidation moving closer) before the tap.
      let check: unknown = null;
      if (cfg.credentials) {
        const hedge = await aster.isHedgeMode();
        const rows = parsePositionRows(await aster.positionRisk(plan.input.symbol), plan.input.symbol);
        const c = await preTradeCheck(aster, plan, rules, { ledger: await ledgerStore.load(), mode: hedge ? "hedge" : "one-way", rows });
        check = c.ok ? { ok: true, warnings: c.risk.warnings } : { ok: false, message: c.message, warnings: c.risk?.warnings ?? [] };
      }
      // Show the exact legs that would be signed (one-way mode assumed for the preview).
      return send(res, 200, { plan, sources, check, asterOrders: planToSetLegs(plan, rules, false) });
    }
    if (req.method === "POST" && url.pathname === "/api/set/place") {
      const { plan, sources } = await planFromBody(await readJson(req), false);
      const rules = await aster.getSymbolRules(plan.input.symbol);
      // Three gates for a real order. Any one failing keeps it a trial.
      const why: string[] = [];
      if (!cfg.liveTrading) why.push("LIVE_TRADING is not true");
      if (plan.input.ticketUsd > cfg.maxLiveTicketUsd) why.push(`ticket $${plan.input.ticketUsd} is above MAX_LIVE_TICKET_USD`);
      if (!cfg.liveSymbols.includes(plan.input.symbol)) why.push(`${plan.input.symbol} is not BTCUSDT or ETHUSDT`);
      if (why.length > 0) {
        await logPlan("place", plan, { status: "trial: not sent", why });
        // The legs a live Set would carry, with a Set id so the client order ids are visible (one-way mode assumed).
        const trialId = newSetId(Date.now(), random);
        return send(res, 200, { status: "trial: not sent", trial: true, why, plan, sources, setId: trialId, asterOrders: planToSetLegs(plan, rules, false, trialId) });
      }
      const result = await executeLive(aster, plan, rules, { store: ledgerStore, random });
      for (const l of result.log) console[l.level === "error" ? "error" : l.level === "warn" ? "warn" : "log"](`[sets] ${l.message}`);
      const status = result.ok ? "sent" : result.refused ? "refused" : "failed";
      await logPlan("place", plan, { status, result });
      // Refused = nothing was sent (balance, a trade outside the Sets on this coin, a mode change).
      return send(res, result.ok ? 200 : result.refused ? 409 : 502, { status, trial: false, plan, result });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    const err = e as Error;
    const status = err instanceof InvalidSetInputError || err.name === "InvalidBandsError" || err.name === "RatioBelowOneError" || err.name === "TicketTooSmallError" || err.name === "InvalidStopError" ? 400 : 502;
    console.error(`[error] ${req.method} ${url.pathname}: ${err.message}`);
    return send(res, status, { error: err.message, kind: err.name });
  }
});

/**
 * Live mode start-up probe: the key must match ASTER_SIGNER, and one signed read must succeed.
 * Invalid credentials stop the server here, loudly, instead of failing on the first order.
 */
async function probeLive() {
  if (!cfg.liveTrading || !cfg.credentials || !signer) return;
  if (signer.address.toLowerCase() !== cfg.credentials.signer.toLowerCase()) {
    console.error("[live] ASTER_SIGNER_PRIVATE_KEY does not belong to ASTER_SIGNER. Stopping.");
    process.exit(1);
  }
  try {
    await aster.positionRisk("BTCUSDT");
    console.log("[live] credential probe ok (signed positionRisk read)");
  } catch (e) {
    console.error(`[live] credential probe failed: ${(e as Error).message}. Stopping.`);
    process.exit(1);
  }
}

await probeLive();
server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`[server] http://127.0.0.1:${cfg.port} ${describeConfig(cfg)}`);
});
