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
 *   GET  /api/levels?coin=BTC             skilled traders' levels from Hyperliquid, plus the liquidation map's counts
 *   POST /api/set/preview                 full order plan, nothing sent (optional "seed": an integer, reproduces the random picks)
 *   POST /api/set/place                   trial by default ("trial: not sent");
 *                                         live only when LIVE_TRADING=true, ticket <= MAX_LIVE_TICKET_USD
 *                                         and symbol is BTCUSDT or ETHUSDT
 *   GET  /api/sets                        every Set in the ledger with its status and its own profit
 *   GET  /api/rules                       the active rule set and the file it came from
 *   GET  /api/health                      mode and which settings are present (no values)
 *
 * Live Sets are recorded in a Set ledger (src/core/ledger.ts), kept here in
 * logs/set-ledger.json. In live mode the server also runs the watcher (server/watch.ts):
 * it records order events and cancels a Set's exits when its position was closed by hand.
 * It never resizes exits (handleOrderUpdate does; Blackboard's backend runs that).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SetPlan } from "../src/core/plan";
import { InvalidSetInputError } from "../src/core/validate";
import type { LeverageBracket } from "../src/core/types";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";
import { HyperliquidLevelSource } from "../src/levels/hyperliquid";
import { activeRules } from "../src/rules/rules";
import { appendPlanLog, createPlanner, sourcesForLog } from "./planning";
import { ConfigError, describeConfig, loadConfig } from "./config";
import { describeLedger, executeLive, planToSetLegs, preTradeCheck } from "./execute";
import { parsePositionRows } from "../src/exchange/aster";
import { newSetId } from "../src/core/ledger";
import { fileLedgerStore } from "./ledgerFile";
import { loadRulesFile, type LoadedRules } from "./rules";
import { fileWatchLog, SetWatcher } from "./watch";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load .env if present (Node's own loader; values go into process.env and are never printed).
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

// Rules first: the config's live caps default to them.
let loadedRules: LoadedRules;
try {
  loadedRules = loadRulesFile(process.env, ROOT);
  console.log(`[rules] ${loadedRules.source}`);
  for (const k of loadedRules.ignored) console.warn(`[rules] ${k} is no longer used and is ignored; remove it from the rules file`);
} catch (e) {
  console.error(`[rules] ${(e as Error).message}`);
  process.exit(1);
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
// Trader sets and the rate budget use the source's defaults (src/levels/hyperliquid.ts);
// the liquidation map (fuel map) for the target follows the rules and refreshes itself in
// the background (public reads only, also in trial mode).
const cacheFile = path.join(ROOT, ".cache", "hl-leaderboard.json");
const levelsSource = new HyperliquidLevelSource({
  diskCache: {
    read: () => readFile(cacheFile, "utf8").catch(() => null),
    write: async (t) => {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, t);
    },
  },
  fuelMap: { topN: activeRules().target.fuelMapTopN, refreshMinutes: activeRules().target.fuelMapRefreshMinutes },
});

/** The Set ledger of this server's one account (server/ledgerFile.ts). */
const ledgerStore = fileLedgerStore(path.join(ROOT, "logs", "set-ledger.json"));

/** Cryptographic random in [0, 1) for the price nudge. */
const random = () => randomInt(0, 2 ** 31) / 2 ** 31;

/** Append one plan to logs/plans.jsonl (server/planning.ts) and print a one-line summary with the target's reason. */
function logPlan(kind: "preview" | "place", plan: SetPlan, extra: Record<string, unknown> = {}) {
  return appendPlanLog(path.join(ROOT, "logs"), kind, plan, extra);
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

/** Builds plans from request bodies: price, rules, book, levels, candles and the liquidation map (server/planning.ts). */
const planner = createPlanner({ aster, levels: levelsSource, bracketsFor, random });
const planFromBody = planner.planFromBody;

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
    if (req.method === "GET" && url.pathname === "/api/rules") {
      return send(res, 200, { source: loadedRules.source, rules: loadedRules.rules });
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
      // The liquidation map's counts around the current price (read from memory, no request to Hyperliquid).
      const price = await aster.getPrice(`${coin}USDT`).then((p) => p.price).catch(() => undefined);
      const fuel = levelsSource.getFuelLevels(coin, price);
      return send(res, 200, {
        coin,
        report,
        fuelMap: { status: fuel.status, note: fuel.note, price: price ?? null, ...fuel.report },
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
      await logPlan("preview", plan, { sources: sourcesForLog(sources) });
      // With keys set, run the same read-only checks a live Set must pass, so the card can
      // show the refusal (coin already holds a position) or warnings before the tap.
      let check: unknown = null;
      if (cfg.credentials) {
        const hedge = await aster.isHedgeMode();
        const rows = parsePositionRows(await aster.positionRisk(plan.input.symbol), plan.input.symbol);
        const c = await preTradeCheck(aster, plan, rules, { ledger: await ledgerStore.load(), mode: hedge ? "hedge" : "one-way", rows });
        check = c.ok ? { ok: true, warnings: c.risk.warnings } : { ok: false, message: c.message, warnings: c.risk?.warnings ?? [] };
      }
      // Show the exact legs that would be signed (one-way mode assumed for the preview).
      return send(res, 200, { plan, sources, check, asterOrders: planToSetLegs(plan, rules, false, undefined, { reduceOnlyExits: cfg.reduceOnlyExits }) });
    }
    if (req.method === "POST" && url.pathname === "/api/set/place") {
      const { plan, sources } = await planFromBody(await readJson(req), false);
      const rules = await aster.getSymbolRules(plan.input.symbol);
      // Three gates for a real order. Any one failing keeps it a trial.
      const why: string[] = [];
      if (!cfg.liveTrading) why.push("LIVE_TRADING is not true");
      if (plan.input.ticketUsd > cfg.maxLiveTicketUsd) why.push(`ticket $${plan.input.ticketUsd} is above MAX_LIVE_TICKET_USD`);
      if (!cfg.liveSymbols.includes(plan.input.symbol)) why.push(`${plan.input.symbol} is not one of ${cfg.liveSymbols.join(", ")}`);
      if (why.length > 0) {
        await logPlan("place", plan, { status: "trial: not sent", why, sources: sourcesForLog(sources) });
        // The legs a live Set would carry, with a Set id so the client order ids are visible (one-way mode assumed).
        const trialId = newSetId(Date.now(), random);
        return send(res, 200, { status: "trial: not sent", trial: true, why, plan, sources, setId: trialId, asterOrders: planToSetLegs(plan, rules, false, trialId, { reduceOnlyExits: cfg.reduceOnlyExits }) });
      }
      const result = await executeLive(aster, plan, rules, { store: ledgerStore, random, reduceOnlyExits: cfg.reduceOnlyExits });
      for (const l of result.log) console[l.level === "error" ? "error" : l.level === "warn" ? "warn" : "log"](`[sets] ${l.message}`);
      const status = result.ok ? "sent" : result.refused ? "refused" : "failed";
      await logPlan("place", plan, { status, result, sources: sourcesForLog(sources) });
      // Refused = nothing was sent (the coin already holds a position or a Set, balance, liquidation rules).
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
if (cfg.liveTrading && cfg.credentials) {
  // Same ledger store object as the routes, so its lock keeps them from interleaving.
  const watcher = new SetWatcher({ client: aster, store: ledgerStore, reduceOnlyExits: cfg.reduceOnlyExits, log: fileWatchLog(path.join(ROOT, "logs", "watch.jsonl")) });
  await watcher.start();
}
levelsSource.startFuelMap();
server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`[server] http://127.0.0.1:${cfg.port} ${describeConfig(cfg)}`);
});
