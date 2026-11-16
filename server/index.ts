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
 *   POST /api/set/preview                 full order plan, nothing sent
 *   POST /api/set/place                   trial by default ("trial: not sent");
 *                                         live only when LIVE_TRADING=true, ticket <= MAX_LIVE_TICKET_USD
 *                                         and symbol is BTCUSDT or ETHUSDT
 *   GET  /api/health                      mode and which settings are present (no values)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomInt } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSetPlan, type SetPlan } from "../src/core/plan";
import { InvalidSetInputError, parseSetInput } from "../src/core/validate";
import type { TraderLevels } from "../src/core/types";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";
import { HyperliquidLevelSource, coinFromSymbol } from "../src/levels/hyperliquid";
import { ConfigError, describeConfig, loadConfig } from "./config";
import { executeLive, planToOtoPairs } from "./execute";

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
    takeProfit: plan.takeProfit,
    ...extra,
  };
  console.log(
    `[plan] ${kind} ${line.symbol} ${line.side} $${line.ticketUsd} ${line.leverage}x ${line.entryMode} entries=${plan.orders.entries.length} tp=${plan.takeProfit.price} ratio=${plan.takeProfit.ratio.toFixed(2)}`,
  );
  await mkdir(path.join(ROOT, "logs"), { recursive: true });
  await appendFile(path.join(ROOT, "logs", "plans.jsonl"), JSON.stringify(line) + "\n");
}

/** Build a plan from a request body, fetching price, rules and (when needed) levels. */
async function planFromBody(body: unknown): Promise<SetPlan> {
  const input = parseSetInput(body);
  const [{ price }, rules] = await Promise.all([aster.getPrice(input.symbol), aster.getSymbolRules(input.symbol)]);
  const empty: TraderLevels = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };
  const coin = coinFromSymbol(input.symbol);
  let levels: TraderLevels = empty;
  if (input.entryMode === "nearby" || input.entryMode === "patient") {
    // These modes ARE the traders' levels: a failure here is an error, never a silent "Now".
    levels = (await levelsSource.getLevels(coin)).levels;
  } else if (input.entryMode === "now") {
    // Now only uses traders' take-profits to snap its target; if Hyperliquid is down,
    // round numbers still work, so this is best effort (logged, not hidden).
    levels = await levelsSource
      .getLevels(coin)
      .then((r) => r.levels)
      .catch((e: Error) => {
        console.warn(`[levels] ${coin} unavailable for Now's take-profit snap, using round numbers only: ${e.message}`);
        return empty;
      });
  } // Draw: the user painted both bands; no levels needed.
  return buildSetPlan({ input, currentPrice: price, rules, levels, random });
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
      const plan = await planFromBody(await readJson(req));
      const rules = await aster.getSymbolRules(plan.input.symbol);
      await logPlan("preview", plan);
      // Show the exact legs that would be signed (one-way mode assumed for the preview).
      return send(res, 200, { plan, asterOrders: planToOtoPairs(plan, rules, false) });
    }
    if (req.method === "POST" && url.pathname === "/api/set/place") {
      const plan = await planFromBody(await readJson(req));
      const rules = await aster.getSymbolRules(plan.input.symbol);
      // Three gates for a real order. Any one failing keeps it a trial.
      const why: string[] = [];
      if (!cfg.liveTrading) why.push("LIVE_TRADING is not true");
      if (plan.input.ticketUsd > cfg.maxLiveTicketUsd) why.push(`ticket $${plan.input.ticketUsd} is above MAX_LIVE_TICKET_USD`);
      if (!cfg.liveSymbols.includes(plan.input.symbol)) why.push(`${plan.input.symbol} is not BTCUSDT or ETHUSDT`);
      if (why.length > 0) {
        await logPlan("place", plan, { status: "trial: not sent", why });
        return send(res, 200, { status: "trial: not sent", trial: true, why, plan, asterOrders: planToOtoPairs(plan, rules, false) });
      }
      const result = await executeLive(aster, plan, rules);
      await logPlan("place", plan, { status: result.ok ? "sent" : "failed", result });
      return send(res, result.ok ? 200 : 502, { status: result.ok ? "sent" : "failed", trial: false, plan, result });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    const err = e as Error;
    const status = err instanceof InvalidSetInputError || err.name === "InvalidBandsError" || err.name === "RatioBelowOneError" || err.name === "TicketTooSmallError" ? 400 : 502;
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
