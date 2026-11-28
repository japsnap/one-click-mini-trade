/**
 * Wick Catcher's own routes on this server (/api/wc/), added 2026-11-25 (Wick Catcher build plan section 10.10).
 *
 * Why here: the Aster key stays in the one process that already holds it, and the Set's proven
 * order form (a limit entry whose fill places a reduce-only take-profit and a reduce-only stop
 * on the mark price, one OTOCO) is reused. The card's own route POST /api/set/place is never
 * used by Wick Catcher and its cap (MAX_LIVE_TICKET_USD) is untouched; these routes carry their
 * own cap, WC_MAX_TICKET_USD (default 12 since 2026-11-28; was 5).
 *
 * Routes (every one needs the header x-wc-token, the token in the file WC_INTENT_TOKEN_FILE,
 * default ~/wick-data/engine/intent.token, written by `python3 -m wc token`, never printed):
 *   GET  /api/wc/state       BTCUSDT position, every open wc_ order, foreign orders, live Sets on BTC,
 *                            margin mode, the first bracket's maintenance rate, free balance, the counter
 *   POST /api/wc/place       { clientId, quantity, price, takeProfit, stop, leverage: 20, symbol: "BTCUSDT" }
 *   POST /api/wc/cancel      { clientId }: cancels that entry (exits are placed only by a fill)
 *   POST /api/wc/close       { quantity }: a reduce-only market sell of the long position
 *   POST /api/wc/move-stop   { oldClientOrderId, newClientOrderId, stopPrice, quantity }: the new
 *                            reduce-only stop first, read back, then the old one cancelled
 *   POST /api/wc/isolated    switch BTCUSDT to isolated margin once, only with nothing open on BTC
 *   GET  /api/wc/multi-assets      the account's Multi-Assets mode and its non-zero asset balances (read only)
 *   POST /api/wc/multi-assets-off  Single-Asset mode for the whole account (added 2026-11-28, Shota's yes: Aster
 *                            refuses isolated margin under Multi-Assets, code -4168). Only with no position and no
 *                            open order on ANY symbol and no live Set; reads the mode before, switches, reads back.
 * Guards inside the server: the token, BTCUSDT only, 20x only, margin at or under the cap, never
 * merge (no position on BTC, no order that is not wc_, no live Set), and one trade: the counter
 * file logs/wc-entries.json refuses a new entry once one entry has filled. A refusal answers 409
 * with a plain sentence; nothing is sent.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatToStep, isOnStep } from "../src/core/rounding";
import { activeSets, type SetLedger } from "../src/core/ledger";
import { parseAccountRisk } from "../src/core/risk";
import type { LeverageBracket, SymbolRules } from "../src/core/types";
import { parsePositionRows, symbolLeverageFromRows, type NewOrderParams, type StrategySubOrder } from "../src/exchange/aster";

export const WC_SYMBOL = "BTCUSDT";
export const WC_LEVERAGE = 20;
export const WC_PREFIX = "wc_";
const CLIENT_ID = /^wc_[A-Za-z0-9_]{2,28}$/;

/** The part of AsterClient these routes use (tests pass the real client over a fake Aster). */
export interface WcClient {
  getSymbolRules(symbol: string): Promise<SymbolRules>;
  positionRisk(symbol?: string): Promise<unknown>;
  openOrders(symbol: string): Promise<unknown>;
  account(): Promise<unknown>;
  leverageBrackets(symbol: string): Promise<LeverageBracket[]>;
  changeLeverage(symbol: string, leverage: number): Promise<unknown>;
  ensureIsolated(symbol: string): Promise<void>;
  multiAssetsMode(): Promise<boolean>;
  setMultiAssetsMode(on: boolean): Promise<unknown>;
  openOrdersAll(): Promise<unknown>;
  balance(): Promise<unknown>;
  placeOtoco(entry: StrategySubOrder, takeProfit: StrategySubOrder, stop: StrategySubOrder, clientStrategyId?: string): Promise<unknown>;
  cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<unknown>;
  newOrder(p: NewOrderParams): Promise<unknown>;
  queryOrderByClientId(symbol: string, clientOrderId: string): Promise<{ status: string; executedQty: number; avgPrice: number; clientOrderId: string } | null>;
}

export interface WcDeps {
  client: WcClient;
  loadLedger: () => Promise<SetLedger>;
  counterFile: string;
  token: string | null;
  maxTicketUsd: number;
  liveTrading: boolean;
  now?: () => number;
}

/** One open order as the routes see it. */
export interface WcOrder {
  orderId: string;
  clientOrderId: string;
  type: string;
  side: string;
  price: number;
  stopPrice: number;
  origQty: number;
  reduceOnly: boolean;
  status: string;
}

export function parseOpenOrders(json: unknown): WcOrder[] {
  if (!Array.isArray(json)) throw new Error("openOrders: answer is not a list");
  const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);
  return (json as Array<Record<string, unknown>>).map((o) => ({
    orderId: String(o.orderId ?? ""),
    clientOrderId: typeof o.clientOrderId === "string" ? o.clientOrderId : "",
    type: String(o.type ?? ""),
    side: String(o.side ?? ""),
    price: n(o.price) || 0,
    stopPrice: n(o.stopPrice) || 0,
    origQty: n(o.origQty) || 0,
    reduceOnly: o.reduceOnly === true || o.reduceOnly === "true",
    status: String(o.status ?? ""),
  }));
}

/** The counter of Wick Catcher entries: every entry placed, its last known state. */
export interface WcEntry {
  clientId: string;
  placedAt: number;
  quantity: string;
  price: string;
  status: "sending" | "working" | "filled" | "closed-unfilled" | "send-failed";
  strategyId: string | null;
  note?: string;
}
export interface WcCounter {
  version: 1;
  entries: WcEntry[];
}

export async function loadCounter(file: string): Promise<WcCounter> {
  const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (text === null) return { version: 1, entries: [] };
  const c = JSON.parse(text) as WcCounter;
  if (c?.version !== 1 || !Array.isArray(c.entries)) throw new Error(`${file} is not a Wick Catcher counter`);
  return c;
}

async function saveCounter(file: string, c: WcCounter): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 2));
  await rename(tmp, file);
}

/** The token from its file, or null. Never printed. */
export function readTokenFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const t = readFileSync(file, "utf8").trim();
  return t.length >= 24 ? t : null;
}

export function defaultTokenFile(env: Record<string, string | undefined>): string {
  return env.WC_INTENT_TOKEN_FILE?.trim() || path.join(os.homedir(), "wick-data", "engine", "intent.token");
}

/** Equal-time compare of two strings. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function num(v: unknown, what: string): number {
  const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(x) || x <= 0) refuse(`${what} must be a positive number.`);
  return x;
}

/** The routes. handle() answers any /api/wc/ path and returns true; false for other paths. */
export function createWcRoutes(deps: WcDeps) {
  const now = deps.now ?? Date.now;
  const c = deps.client;
  let lock: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  async function readAccount() {
    const rawRows = await c.positionRisk(WC_SYMBOL);
    const rows = parsePositionRows(rawRows, WC_SYMBOL);
    const raw = (Array.isArray(rawRows) ? rawRows : [rawRows]) as Array<Record<string, unknown>>;
    const mt = raw.find((r) => r?.symbol === WC_SYMBOL)?.marginType;
    const orders = parseOpenOrders(await c.openOrders(WC_SYMBOL));
    const ledger = await deps.loadLedger();
    const liveSets = activeSets(ledger, WC_SYMBOL).map((s) => s.id);
    return { rows, orders, liveSets, marginType: typeof mt === "string" ? mt.toLowerCase() : null, leverage: symbolLeverageFromRows(rows) };
  }

  /** Bring the counter up to date with the venue: a working entry that filled (even partly) is "filled". */
  async function refreshCounter(): Promise<WcCounter> {
    const counter = await loadCounter(deps.counterFile);
    let changed = false;
    for (const e of counter.entries) {
      if (e.status !== "working" && e.status !== "sending") continue;
      const q = await c.queryOrderByClientId(WC_SYMBOL, `${e.clientId}-E`);
      if (q === null) continue;
      if (q.executedQty > 0) {
        e.status = "filled";
        e.note = `filled ${q.executedQty} at ${q.avgPrice}`;
        changed = true;
      } else if (q.status === "CANCELED" || q.status === "EXPIRED" || q.status === "REJECTED") {
        e.status = "closed-unfilled";
        changed = true;
      } else if (e.status === "sending") {
        e.status = "working";
        changed = true;
      }
    }
    if (changed) await saveCounter(deps.counterFile, counter);
    return counter;
  }

  async function state() {
    const a = await readAccount();
    const counter = await refreshCounter();
    const brackets = await c.leverageBrackets(WC_SYMBOL);
    const acct = parseAccountRisk(await c.account());
    const pos = a.rows.find((r) => r.positionAmt !== 0) ?? null;
    return {
      symbol: WC_SYMBOL,
      position: pos ? { amount: pos.positionAmt, entryPrice: pos.entryPrice, liquidationPrice: pos.liquidationPrice, markPrice: pos.markPrice } : null,
      leverage: a.leverage,
      marginType: a.marginType,
      maintenanceRate: brackets[0]!.maintMarginRatio,
      freeBalanceUsd: acct.availableBalanceUsd,
      wcOrders: a.orders.filter((o) => o.clientOrderId.startsWith(WC_PREFIX)),
      foreignOrders: a.orders.filter((o) => !o.clientOrderId.startsWith(WC_PREFIX)),
      liveSets: a.liveSets,
      busyByOther: a.orders.some((o) => !o.clientOrderId.startsWith(WC_PREFIX)) || a.liveSets.length > 0,
      entries: counter.entries,
      filledEntries: counter.entries.filter((e) => e.status === "filled").length,
      maxTicketUsd: deps.maxTicketUsd,
      liveTrading: deps.liveTrading,
    };
  }

  /** Never merge: refuse when BTC holds anything that is not Wick Catcher's own. */
  function neverMerge(a: Awaited<ReturnType<typeof readAccount>>, allowOwnPosition: boolean) {
    const foreign = a.orders.filter((o) => !o.clientOrderId.startsWith(WC_PREFIX));
    if (foreign.length > 0) refuse(`BTC has ${foreign.length} open order(s) that are not Wick Catcher's, so nothing was sent.`);
    if (a.liveSets.length > 0) refuse(`BTC has a live Set (${a.liveSets.join(", ")}), so nothing was sent.`);
    if (!allowOwnPosition && a.rows.some((r) => r.positionAmt !== 0)) refuse("BTC already has an open position, so nothing was sent.");
  }

  async function place(body: Record<string, unknown>) {
    if (!deps.liveTrading) refuse("LIVE_TRADING is not true on this server, so nothing was sent.");
    const clientId = String(body.clientId ?? "");
    if (!CLIENT_ID.test(clientId)) refuse("clientId must start with wc_ and hold 2 to 28 letters, digits or _.");
    if ((body.symbol ?? WC_SYMBOL) !== WC_SYMBOL) refuse("Wick Catcher trades BTCUSDT only, so nothing was sent.");
    if (Number(body.leverage ?? WC_LEVERAGE) !== WC_LEVERAGE) refuse("Wick Catcher trades at 20x only, so nothing was sent.");
    const rules = await c.getSymbolRules(WC_SYMBOL);
    const qty = num(body.quantity, "quantity");
    const price = num(body.price, "price");
    const tp = num(body.takeProfit, "takeProfit");
    const stop = num(body.stop, "stop");
    if (!isOnStep(qty, rules.stepSize) || qty < rules.minQty) refuse(`quantity ${qty} is off the step ${rules.stepSize} or under ${rules.minQty}.`);
    for (const [k, v] of [["price", price], ["takeProfit", tp], ["stop", stop]] as const) {
      if (!isOnStep(v, rules.tickSize)) refuse(`${k} ${v} is off the price step ${rules.tickSize}.`);
    }
    if (!(stop < price && price < tp)) refuse("The stop must sit under the bid and the take-profit above it.");
    const margin = (qty * price) / WC_LEVERAGE;
    if (margin > deps.maxTicketUsd + 1e-9) refuse(`This order needs $${margin.toFixed(2)} of margin, above Wick Catcher's cap of $${deps.maxTicketUsd} (WC_MAX_TICKET_USD), so nothing was sent.`);
    const brackets = await c.leverageBrackets(WC_SYMBOL);
    const mmr = brackets[0]!.maintMarginRatio;
    const liq = price * (1 - 1 / WC_LEVERAGE + mmr);
    if (!(stop > liq)) refuse(`The stop ${stop} sits at or under the liquidation estimate ${liq.toFixed(1)}, so nothing was sent.`);
    const counter = await refreshCounter();
    const filled = counter.entries.filter((e) => e.status === "filled");
    if (filled.length > 0) refuse(`One trade means one filled entry, and ${filled[0]!.clientId} has filled, so nothing more is placed until the counter is reset by hand.`);
    if (counter.entries.some((e) => e.clientId === clientId)) refuse(`clientId ${clientId} was used before, so nothing was sent.`);
    const a = await readAccount();
    neverMerge(a, false);
    const ownEntries = a.orders.filter((o) => o.clientOrderId.startsWith(WC_PREFIX) && o.clientOrderId.endsWith("-E"));
    if (ownEntries.length >= 2) refuse("Two Wick Catcher bids already rest on BTC, the most one trade holds, so nothing was sent.");
    if (a.leverage !== WC_LEVERAGE) await c.changeLeverage(WC_SYMBOL, WC_LEVERAGE);
    const entry: StrategySubOrder = {
      strategySubId: "1", firstDrivenId: "0", secondDrivenId: "0", securityType: "USDT_FUTURES", symbol: WC_SYMBOL, side: "BUY",
      type: "LIMIT", quantity: formatToStep(qty, rules.stepSize), price: formatToStep(price, rules.tickSize), timeInForce: "GTC",
      clientOrderId: `${clientId}-E`,
    };
    const exitBase = {
      securityType: "USDT_FUTURES" as const, symbol: WC_SYMBOL, side: "SELL" as const, workingType: "MARK_PRICE" as const, reduceOnly: "true" as const,
      firstDrivenId: "1", firstDrivenOn: "PARTIALLY_FILLED_OR_FILLED" as const, firstTrigger: "PLACE_ORDER" as const,
      secondDrivenOn: "FILLED" as const, secondTrigger: "CANCEL_ORDER" as const, quantity: formatToStep(qty, rules.stepSize),
    };
    const takeProfit: StrategySubOrder = { ...exitBase, strategySubId: "2", type: "TAKE_PROFIT_MARKET", stopPrice: formatToStep(tp, rules.tickSize), secondDrivenId: "3", clientOrderId: `${clientId}-T` };
    const stopLeg: StrategySubOrder = { ...exitBase, strategySubId: "3", type: "STOP_MARKET", stopPrice: formatToStep(stop, rules.tickSize), secondDrivenId: "2", clientOrderId: `${clientId}-S` };
    const rec: WcEntry = { clientId, placedAt: now(), quantity: entry.quantity!, price: entry.price!, status: "sending", strategyId: null };
    counter.entries.push(rec);
    await saveCounter(deps.counterFile, counter); // saved BEFORE sending: no untracked order after a crash
    try {
      const answer = (await c.placeOtoco(entry, takeProfit, stopLeg, clientId)) as Record<string, unknown>;
      rec.status = "working";
      rec.strategyId = answer?.strategyId !== undefined && answer?.strategyId !== null ? String(answer.strategyId) : null;
      await saveCounter(deps.counterFile, counter);
      return { status: "sent", clientId, strategyId: rec.strategyId, legs: { entry, takeProfit, stop: stopLeg }, marginUsd: margin, liquidationEstimate: liq };
    } catch (e) {
      rec.status = "send-failed";
      rec.note = (e as Error).message;
      await saveCounter(deps.counterFile, counter);
      throw e;
    }
  }

  async function cancel(body: Record<string, unknown>) {
    const clientId = String(body.clientId ?? "");
    if (!CLIENT_ID.test(clientId)) refuse("clientId must be a wc_ id.");
    const counter = await loadCounter(deps.counterFile);
    if (!counter.entries.some((e) => e.clientId === clientId)) refuse(`${clientId} is not a Wick Catcher entry of this server.`);
    const answer = await c.cancelOrderByClientId(WC_SYMBOL, `${clientId}-E`);
    const after = await refreshCounter();
    return { status: "cancel sent", clientId, answer, entry: after.entries.find((e) => e.clientId === clientId) };
  }

  async function close(body: Record<string, unknown>) {
    const qty = num(body.quantity, "quantity");
    const rules = await c.getSymbolRules(WC_SYMBOL);
    if (!isOnStep(qty, rules.marketStepSize)) refuse(`quantity ${qty} is off the step ${rules.marketStepSize}.`);
    const a = await readAccount();
    neverMerge(a, true);
    const long = a.rows.find((r) => r.positionAmt > 0);
    if (!long) refuse("BTC has no long position to close.");
    if (qty > long.positionAmt + 1e-12) refuse(`quantity ${qty} is more than the position ${long.positionAmt}.`);
    const id = `wc_close_${now()}`;
    const answer = await c.newOrder({ symbol: WC_SYMBOL, side: "SELL", type: "MARKET", quantity: formatToStep(qty, rules.marketStepSize), reduceOnly: "true", newClientOrderId: id, newOrderRespType: "RESULT" });
    return { status: "sent", clientOrderId: id, answer };
  }

  async function moveStop(body: Record<string, unknown>) {
    const oldId = String(body.oldClientOrderId ?? "");
    const newId = String(body.newClientOrderId ?? "");
    if (!oldId.startsWith(WC_PREFIX) || !CLIENT_ID.test(newId.replace(/-S$/, ""))) refuse("Both stop ids must be wc_ ids.");
    const rules = await c.getSymbolRules(WC_SYMBOL);
    const stopPrice = num(body.stopPrice, "stopPrice");
    const qty = num(body.quantity, "quantity");
    if (!isOnStep(stopPrice, rules.tickSize)) refuse(`stopPrice ${stopPrice} is off the price step ${rules.tickSize}.`);
    const a = await readAccount();
    neverMerge(a, true);
    const long = a.rows.find((r) => r.positionAmt > 0);
    if (!long) refuse("BTC has no long position, so there is no stop to move.");
    // 1. the new stop first
    await c.newOrder({ symbol: WC_SYMBOL, side: "SELL", type: "STOP_MARKET", quantity: formatToStep(qty, rules.stepSize), stopPrice: formatToStep(stopPrice, rules.tickSize), reduceOnly: "true", workingType: "MARK_PRICE", newClientOrderId: newId, newOrderRespType: "RESULT" });
    // 2. read it back; only a stop that exists lets the old one go
    const back = await c.queryOrderByClientId(WC_SYMBOL, newId);
    if (!back || !(back.status === "NEW" || back.status === "PARTIALLY_FILLED")) refuse(`The new stop ${newId} could not be read back as working, so the old stop ${oldId} was kept.`);
    // 3. the old stop goes
    const cancelled = await c.cancelOrderByClientId(WC_SYMBOL, oldId);
    return { status: "moved", newClientOrderId: newId, oldClientOrderId: oldId, newStop: back, cancelled };
  }

  async function isolated() {
    const a = await readAccount();
    neverMerge(a, false);
    if (a.orders.length > 0) refuse("BTC has open orders, so the margin mode was not changed.");
    if (a.marginType === "isolated") return { status: "already isolated" };
    await c.ensureIsolated(WC_SYMBOL);
    const after = await readAccount();
    return { status: after.marginType === "isolated" ? "isolated" : `margin mode reads ${after.marginType} after the change`, marginType: after.marginType };
  }

  /** Non-zero asset rows of GET /fapi/v3/balance: amounts only, so a report shows where the wallet sits. */
  async function balances() {
    const rows = await c.balance();
    if (!Array.isArray(rows)) throw new Error("balance: answer is not a list");
    const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);
    return (rows as Array<Record<string, unknown>>)
      .map((r) => ({ asset: String(r.asset ?? ""), balance: n(r.balance), availableBalance: n(r.availableBalance), marginAvailable: r.marginAvailable ?? null }))
      .filter((r) => Number.isFinite(r.balance) && r.balance !== 0);
  }

  async function multiAssets() {
    return { multiAssetsMargin: await c.multiAssetsMode(), balances: await balances() };
  }

  /** The mode changes every symbol, so the guard is account wide: no position, no open order, no live Set anywhere. */
  async function multiAssetsOff() {
    if (!deps.liveTrading) refuse("LIVE_TRADING is not true on this server, so the margin mode was not changed.");
    const before = await c.multiAssetsMode();
    const bal = await balances();
    if (!before) return { status: "already single-asset", before, after: before, balances: bal };
    const posRaw = await c.positionRisk();
    const pos = (Array.isArray(posRaw) ? posRaw : [posRaw]) as Array<Record<string, unknown>>;
    const open = pos.filter((r) => Number(r?.positionAmt ?? 0) !== 0).map((r) => String(r.symbol));
    if (open.length > 0) refuse(`The account holds positions on ${open.join(", ")}, so the Multi-Assets mode was not changed.`);
    const orders = parseOpenOrders(await c.openOrdersAll());
    if (orders.length > 0) refuse(`The account has ${orders.length} open order(s), so the Multi-Assets mode was not changed.`);
    const live = activeSets(await deps.loadLedger()).map((x) => x.id);
    if (live.length > 0) refuse(`A Set is live (${live.join(", ")}), so the Multi-Assets mode was not changed.`);
    await c.setMultiAssetsMode(false);
    const after = await c.multiAssetsMode();
    return { status: after === false ? "single-asset" : "still multi-assets after the change", before, after, balances: await balances() };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, readJson: (r: IncomingMessage) => Promise<unknown>): Promise<boolean> {
    if (!url.pathname.startsWith("/api/wc/")) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      if (!deps.token) refuse("This server has no Wick Catcher token file, so every /api/wc/ route is closed.");
      const got = req.headers["x-wc-token"];
      if (typeof got !== "string" || !sameToken(got, deps.token)) refuse("Wrong or missing Wick Catcher token, so nothing was done.");
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /api/wc/state") return send(200, await locked(state)), true;
      if (route === "GET /api/wc/multi-assets") return send(200, await locked(multiAssets)), true;
      const body = req.method === "POST" ? ((await readJson(req)) as Record<string, unknown>) : {};
      if (route === "POST /api/wc/place") return send(200, await locked(() => place(body))), true;
      if (route === "POST /api/wc/cancel") return send(200, await locked(() => cancel(body))), true;
      if (route === "POST /api/wc/close") return send(200, await locked(() => close(body))), true;
      if (route === "POST /api/wc/move-stop") return send(200, await locked(() => moveStop(body))), true;
      if (route === "POST /api/wc/isolated") return send(200, await locked(isolated)), true;
      if (route === "POST /api/wc/multi-assets-off") return send(200, await locked(multiAssetsOff)), true;
      send(404, { error: "not found" });
      return true;
    } catch (e) {
      if (e instanceof Refusal) {
        send(409, { refused: true, message: e.message });
        return true;
      }
      const err = e as Error;
      console.error(`[wc] ${req.method} ${url.pathname}: ${err.message}`);
      send(502, { error: err.message, kind: err.name });
      return true;
    }
  }

  return { handle, state, place, cancel, close, moveStop, isolated, multiAssets, multiAssetsOff, refreshCounter };
}
