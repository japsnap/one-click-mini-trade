/**
 * Aster futures V3 client (https://fapi.asterdex.com, docs: aster-finance-futures-api-v3.md).
 *
 * Authentication (from the V3 doc, "Authentication signature payload" and the Python examples):
 *  - Every signed call carries: the business parameters, then `nonce`, `user`, `signer`, then `signature`.
 *      user   = the main account address (the wallet that owns the margin; Blackboard's embedded EVM wallet)
 *      signer = the API wallet ("agent") address that the user authorised on Aster
 *      nonce  = current time in MICROseconds, unique per call (Aster keeps the last 100 per agent and
 *               rejects repeats and anything older than 60 s)
 *  - The signed message `msg` is the urlencoded parameter string (Python urllib.parse.urlencode
 *    format), in that order, WITHOUT the signature. It is signed as EIP-712 typed data:
 *      domain  { name: "AsterSignTransaction", version: "1", chainId: 1666,
 *                verifyingContract: 0x0000000000000000000000000000000000000000 }
 *      types   { Message: [ { name: "msg", type: "string" } ] }, primaryType "Message"
 *  - The request sends exactly the same string plus `&signature=0x...`
 *    (GET: as the query string; POST/DELETE: as an x-www-form-urlencoded body).
 *
 * Doc ambiguity resolved here: the first order example adds only nonce and signer to the
 * signed string, while the Noop example and the auth-payload table add nonce, user AND
 * signer. We sign nonce, user and signer (the fuller form), which is what the doc's table
 * calls the authentication payload. If the first live call answers a signature error,
 * set `includeUserInSignedString: false` to try the shorter form.
 *
 * Builder attribution (Blackboard): the V3 doc lists `builder` (address) and `feeRate`
 * (decimal, e.g. "0.0001" = 0.01%) on POST /fapi/v3/placeStrategyOrder. Blackboard's guide says the
 * builder fields go into every signed order, including closes and conditional orders. This
 * client adds them, when configured, to every order request (new order and strategy order),
 * inside the signed string. The New Order table does not list them; see README "Open items".
 */
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, zeroAddress, type Hex } from "viem";
import { stopPriceFromLiquidation } from "../core/stop";
import { activeRules } from "../rules/rules";
import type { Level, LeverageBracket, OrderBookDepth, Side, SymbolRules } from "../core/types";
import type { OrderUpdate } from "../core/ledger";

/** Mainnet host from the V3 doc. Testnet: https://fapi.asterdex-testnet.com */
export const ASTER_MAINNET_URL = "https://fapi.asterdex.com";

/** Blackboard's builder approval ceiling: 0.001 = 0.1%. A higher feeRate is refused before signing. */
export const BLACKBOARD_MAX_FEE_RATE = 0.001;

/** EIP-712 domain, exactly as in the V3 doc. */
export const ASTER_EIP712_DOMAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: zeroAddress,
} as const;

/** EIP-712 types (viem adds EIP712Domain itself from the domain fields). */
export const ASTER_EIP712_TYPES = {
  Message: [{ name: "msg", type: "string" }],
} as const;

/**
 * The full typed-data object for one message.
 * Why: lets an app sign with any EIP-712 signer (a viem account, a Privy embedded wallet's
 * signTypedData) instead of a raw key.
 */
export function asterTypedData(msg: string) {
  return {
    domain: ASTER_EIP712_DOMAIN,
    types: ASTER_EIP712_TYPES,
    primaryType: "Message" as const,
    message: { msg },
  };
}

/** Something that signs Aster's typed data and returns a 0x signature. */
export type AsterSigner = (msg: string) => Promise<Hex>;

/**
 * Build a signer from a private key (server only; the browser never sees a key).
 * Units: privateKey is a 0x-prefixed 32-byte hex string.
 */
export function privateKeySigner(privateKey: Hex): { address: Hex; sign: AsterSigner } {
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, sign: (msg) => account.signTypedData(asterTypedData(msg)) };
}

/**
 * Recover the address that signed a message. Used by the signing test and the live startup probe.
 */
export async function recoverAsterSigner(msg: string, signature: Hex): Promise<Hex> {
  return recoverTypedDataAddress({ ...asterTypedData(msg), signature });
}

/**
 * URL-encode parameters exactly like Python's urllib.parse.urlencode (quote_plus).
 * Why: the doc's reference signer is Python; the signed string must match byte for byte.
 * Differences from encodeURIComponent: space -> "+", and ! ' ( ) * are percent-encoded.
 */
export function pyUrlencode(params: Array<[string, string]>): string {
  const q = (s: string) =>
    encodeURIComponent(s)
      .replace(/%20/g, "+")
      .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return params.map(([k, v]) => `${q(k)}=${q(v)}`).join("&");
}

/**
 * Microsecond nonce source, strictly increasing within the process.
 * Why: Aster rejects a repeated nonce, and two calls in the same millisecond would collide
 * with a plain Date.now() x 1000. Returned as a string (it exceeds 2^53 in a few centuries only,
 * but string keeps it exact and is what goes on the wire).
 */
export function createNonceSource(nowMs: () => number = Date.now): () => string {
  let last = 0n;
  return () => {
    let n = BigInt(Math.floor(nowMs())) * 1000n; // ms -> µs
    if (n <= last) n = last + 1n; // same or earlier clock reading: bump by 1 µs
    last = n;
    return n.toString();
  };
}

/** Error answered by Aster. code is Aster's own code (e.g. -1022 bad signature, -4046 no need to change margin type). */
export class AsterApiError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: number | null,
    public readonly apiMessage: string,
    public readonly path: string,
  ) {
    super(`Aster ${path} failed: HTTP ${httpStatus}, code ${code ?? "none"}: ${apiMessage}`);
    this.name = "AsterApiError";
  }
}

/** Builder attribution. feeRate is a decimal string: "0.0001" = 0.01% of each fill's notional. */
export interface BuilderConfig {
  address: Hex;
  feeRate: string;
}

/**
 * Validate builder settings before they ever reach a signed order.
 * Rules: 0x + 40 hex address; feeRate a plain decimal in (0, 0.001] (Blackboard's ceiling).
 */
export function validateBuilder(cfg: { address: string; feeRate: string }, maxFeeRate = BLACKBOARD_MAX_FEE_RATE): BuilderConfig {
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.address)) throw new Error("builder address must be 0x followed by 40 hex characters");
  if (!/^\d+(\.\d+)?$/.test(cfg.feeRate)) throw new Error("builder feeRate must be a plain decimal such as 0.0001");
  const rate = Number(cfg.feeRate);
  if (!(rate > 0) || rate > maxFeeRate) throw new Error(`builder feeRate must be above 0 and at most ${maxFeeRate}`);
  return { address: cfg.address as Hex, feeRate: cfg.feeRate };
}

/** Parameters of POST /fapi/v3/order that this app uses. Prices and quantities as exact decimal strings. */
export interface NewOrderParams {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "TAKE_PROFIT_MARKET" | "STOP_MARKET";
  quantity?: string;
  price?: string;
  /** LIMIT needs GTC; TAKE_PROFIT_MARKET and STOP_MARKET accept only GTC if sent. */
  timeInForce?: "GTC";
  stopPrice?: string;
  /** "true" makes the order only shrink a position. Not allowed in Hedge Mode or with closePosition. */
  reduceOnly?: "true" | "false";
  /** "true" closes the whole position when triggered (STOP_MARKET / TAKE_PROFIT_MARKET only). */
  closePosition?: "true" | "false";
  /** Required in Hedge Mode: LONG or SHORT. Omit in One-way Mode (defaults to BOTH). */
  positionSide?: "BOTH" | "LONG" | "SHORT";
  /** Trigger source for stopPrice. We use MARK_PRICE so a single odd trade cannot fire the take-profit. */
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
  newClientOrderId?: string;
  newOrderRespType?: "ACK" | "RESULT";
}

/** One leg of a strategy order (subOrderList element). Field names from the V3 doc. */
export interface StrategySubOrder {
  strategySubId: string;
  securityType: "USDT_FUTURES";
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  type: "LIMIT" | "MARKET" | "TAKE_PROFIT_MARKET" | "STOP_MARKET";
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: "GTC";
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
  reduceOnly?: "true" | "false";
  firstDrivenId?: string;
  firstDrivenOn?: "NEW" | "PARTIALLY_FILLED_OR_FILLED" | "FILLED";
  firstTrigger?: "PLACE_ORDER" | "CANCEL_ORDER";
  /** Second trigger (OTOCO): e.g. the stop is cancelled when the take-profit fills, and the other way round. */
  secondDrivenId?: string;
  secondDrivenOn?: "PARTIALLY_FILLED_OR_FILLED" | "FILLED";
  secondTrigger?: "PLACE_ORDER" | "CANCEL_ORDER";
  /**
   * Our own id for this leg's order (V3 doc sub-order field "clientOrderId"). Sets use
   * `<setId>-<leg><E|T|S>` (src/core/ledger.ts) so fills can be matched to the Set.
   * Whether Aster echoes it in ORDER_TRADE_UPDATE "c" is not shown in the doc; the ledger
   * also matches by orderId (see linkSetOrders in server/execute.ts).
   */
  clientOrderId?: string;
}

/**
 * One sub-order change for POST /fapi/v3/updateStrategyOrder (V3 doc "Update Strategy
 * Order"): strategySubId, securityType, symbol, side, type are required; quantity and
 * stopPrice are what Sets change (exits resized to the filled quantity, stop re-capped).
 */
export interface StrategySubOrderUpdate {
  strategySubId: string;
  securityType: "USDT_FUTURES";
  symbol: string;
  side: "BUY" | "SELL";
  positionSide?: "BOTH" | "LONG" | "SHORT";
  type: "TAKE_PROFIT_MARKET" | "STOP_MARKET";
  quantity?: string;
  stopPrice?: string;
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
}

/** Options for AsterClient. */
export interface AsterClientOptions {
  baseUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Needed only for signed calls. */
  auth?: { user: Hex; signer: Hex; sign: AsterSigner };
  builder?: BuilderConfig;
  /** See the header comment. Default true. */
  includeUserInSignedString?: boolean;
  nonce?: () => string;
  timeoutMs?: number;
}

/** Read an object field as a number from Aster's string-typed JSON. */
function num(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
}

/**
 * Turn exchangeInfo JSON into SymbolRules for one symbol. Throws if the symbol or a
 * required filter is missing (a silent default here would send rejected orders).
 */
export function parseSymbolRules(exchangeInfo: unknown, symbol: string): SymbolRules {
  const symbols = (exchangeInfo as { symbols?: unknown })?.symbols;
  if (!Array.isArray(symbols)) throw new Error("exchangeInfo has no symbols array");
  const s = symbols.find((x) => (x as { symbol?: unknown })?.symbol === symbol) as { filters?: unknown; status?: unknown } | undefined;
  if (!s) throw new Error(`symbol ${symbol} not found on Aster`);
  if (s.status !== undefined && s.status !== "TRADING") throw new Error(`symbol ${symbol} is not trading (status ${String(s.status)})`);
  const filters = Array.isArray(s.filters) ? (s.filters as Array<Record<string, unknown>>) : [];
  const f = (t: string) => filters.find((x) => x.filterType === t);
  const price = f("PRICE_FILTER");
  const lot = f("LOT_SIZE");
  const mlot = f("MARKET_LOT_SIZE");
  const minN = f("MIN_NOTIONAL");
  const rules: SymbolRules = {
    symbol,
    tickSize: num(price?.tickSize),
    stepSize: num(lot?.stepSize),
    minQty: num(lot?.minQty),
    marketStepSize: num(mlot?.stepSize ?? lot?.stepSize),
    marketMinQty: num(mlot?.minQty ?? lot?.minQty),
    // Binance-style venues name the field "notional"; some older ones "minNotional".
    minNotionalUsd: num(minN?.notional ?? minN?.minNotional),
  };
  for (const [k, v] of Object.entries(rules)) {
    if (k !== "symbol" && !(typeof v === "number" && v > 0)) throw new Error(`exchangeInfo ${symbol}: ${k} missing or not positive`);
  }
  return rules;
}

/**
 * Parse public GET /fapi/v3/depth into USD-weighted levels.
 * Shape (V3 doc "Order Book"): {"lastUpdateId", "E", "T", "bids": [["price","qty"], ...], "asks": [...]}.
 * Every row is coerced; a malformed row is skipped, never trusted. weightUsd = price x qty.
 * Units: price quote per base; weight USD.
 */
export function parseDepth(json: unknown): OrderBookDepth & { skipped: number } {
  const o = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
  let skipped = 0;
  const side = (rows: unknown): Level[] => {
    const out: Level[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const price = num(Array.isArray(r) ? r[0] : undefined);
      const qty = num(Array.isArray(r) ? r[1] : undefined);
      if (!(price > 0) || !(qty > 0)) {
        skipped++;
        continue;
      }
      out.push({ price, weightUsd: price * qty });
    }
    return out;
  };
  return { bids: side(o.bids), asks: side(o.asks), skipped };
}

/**
 * Parse signed GET /fapi/v3/leverageBrackets for one symbol into LeverageBracket rows.
 * Accepts both documented shapes: an array of {symbol, brackets} or one {symbol, brackets}.
 * Throws when the symbol or its brackets are missing (a silent empty list would quietly
 * switch the stop to the assumed rate).
 * Units: notional USD; maintMarginRatio decimal.
 */
export function parseLeverageBrackets(json: unknown, symbol: string): LeverageBracket[] {
  const list = Array.isArray(json) ? json : [json];
  const entry = list.find((x) => (x as { symbol?: unknown })?.symbol === symbol) as { brackets?: unknown } | undefined;
  if (!entry || !Array.isArray(entry.brackets)) throw new Error(`leverageBrackets has no brackets for ${symbol}`);
  const out: LeverageBracket[] = [];
  for (const b of entry.brackets as Array<Record<string, unknown>>) {
    const row: LeverageBracket = {
      notionalFloor: num(b?.notionalFloor),
      notionalCap: num(b?.notionalCap),
      initialLeverage: num(b?.initialLeverage),
      maintMarginRatio: num(b?.maintMarginRatio),
    };
    if (!(row.notionalFloor >= 0) || !(row.notionalCap > row.notionalFloor) || !(row.initialLeverage >= 1) || !(row.maintMarginRatio >= 0 && row.maintMarginRatio < 1)) {
      throw new Error(`leverageBrackets ${symbol}: malformed bracket ${JSON.stringify(b)}`);
    }
    out.push(row);
  }
  if (out.length === 0) throw new Error(`leverageBrackets ${symbol}: empty`);
  return out.sort((a, b) => a.notionalFloor - b.notionalFloor);
}

/** One open position as read from positionRisk. Units: prices quote per base; amount base (negative = short). */
export interface PositionRiskRow {
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: number;
  entryPrice: number;
  liquidationPrice: number;
  markPrice: number;
}

/**
 * Parse signed GET /fapi/v3/positionRisk (V3 doc "Position Information v3") and return
 * the open position on `symbol`, or null when there is none (positionAmt 0).
 * Strings are coerced; "liquidationPrice": "0" means none known and is returned as 0.
 * hedgePositionSide: in Hedge Mode pass "LONG" or "SHORT" to pick the right row.
 */
export function parsePositionRisk(json: unknown, symbol: string, hedgePositionSide?: "LONG" | "SHORT"): PositionRiskRow | null {
  const rows = Array.isArray(json) ? json : [json];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r?.symbol !== symbol) continue;
    const positionSide = (typeof r.positionSide === "string" ? r.positionSide : "BOTH") as PositionRiskRow["positionSide"];
    if (hedgePositionSide && positionSide !== hedgePositionSide) continue;
    const positionAmt = num(r.positionAmt);
    if (!Number.isFinite(positionAmt) || positionAmt === 0) continue;
    return {
      symbol,
      positionSide,
      positionAmt,
      entryPrice: num(r.entryPrice),
      liquidationPrice: num(r.liquidationPrice),
      markPrice: num(r.markPrice),
    };
  }
  return null;
}

/**
 * Every position row of one symbol from signed GET /fapi/v3/positionRisk, flat rows
 * included (the doc returns a row per symbol in one-way mode, LONG and SHORT rows in
 * hedge mode). Also gives the symbol's current leverage ("leverage", same on every row).
 * Used by the Set ledger: reconcile compares these amounts with the open Sets, and the
 * per-Set stop is capped by the liquidation price of the row on the Set's side.
 * Units: prices quote per base; positionAmt base (negative = short); leverage multiplier.
 */
export interface PositionRow {
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: number;
  entryPrice: number;
  liquidationPrice: number;
  markPrice: number;
  /** null when the row does not carry it. */
  leverage: number | null;
}
export function parsePositionRows(json: unknown, symbol: string): PositionRow[] {
  const rows = Array.isArray(json) ? json : json && typeof json === "object" ? [json] : [];
  const out: PositionRow[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (r?.symbol !== symbol) continue;
    const side = r.positionSide === "LONG" || r.positionSide === "SHORT" ? r.positionSide : "BOTH";
    const amt = num(r.positionAmt);
    if (!Number.isFinite(amt)) throw new Error(`positionRisk ${symbol}: positionAmt missing or not a number`);
    const lev = num(r.leverage);
    out.push({
      positionSide: side,
      positionAmt: amt,
      entryPrice: num(r.entryPrice) || 0,
      liquidationPrice: num(r.liquidationPrice) || 0,
      markPrice: num(r.markPrice) || 0,
      leverage: Number.isFinite(lev) && lev >= 1 ? lev : null,
    });
  }
  return out;
}
/** The symbol's leverage from its position rows (first row that carries one), or null. */
export function symbolLeverageFromRows(rows: PositionRow[]): number | null {
  return rows.find((r) => r.leverage !== null)?.leverage ?? null;
}

/**
 * USDT balances from signed GET /fapi/v3/balance (V3 doc "Futures Account Balance v3").
 * Throws when there is no USDT row: refusing a Set is better than sizing on a guess.
 * Units: USD (USDT).
 */
export function parseUsdtBalance(json: unknown): { walletBalanceUsd: number; availableBalanceUsd: number } {
  const rows = Array.isArray(json) ? json : [];
  const usdt = (rows as Array<Record<string, unknown>>).find((r) => r?.asset === "USDT");
  if (!usdt) throw new Error("balance: no USDT row");
  const wallet = num(usdt.balance);
  const available = num(usdt.availableBalance);
  if (!Number.isFinite(wallet) || !Number.isFinite(available)) throw new Error("balance: USDT balance or availableBalance is not a number");
  return { walletBalanceUsd: wallet, availableBalanceUsd: available };
}

/**
 * Turn one user-data-stream message into the ledger's OrderUpdate, or null when it is
 * not an ORDER_TRADE_UPDATE. Field letters from the V3 doc "Event: Order Update":
 *   o.s symbol, o.c client order id, o.i order id, o.X status, o.x execution type,
 *   o.l last filled qty, o.L last filled price, o.n commission, o.N commission asset,
 *   o.t trade id, o.T trade time, o.z the order's total filled quantity so far.
 * Every field is coerced; a message without a symbol or a status is refused loudly.
 */
export function parseOrderTradeUpdate(json: unknown): OrderUpdate | null {
  const m = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (!m || m.e !== "ORDER_TRADE_UPDATE") return null;
  const o = (m.o ?? {}) as Record<string, unknown>;
  if (typeof o.s !== "string" || typeof o.X !== "string") throw new Error("ORDER_TRADE_UPDATE without symbol or status");
  const t = num(o.t);
  const time = num(o.T);
  const l = num(o.l);
  const L = num(o.L);
  const n = num(o.n);
  const z = num(o.z);
  return {
    symbol: o.s,
    clientOrderId: typeof o.c === "string" ? o.c : "",
    orderId: o.i === undefined || o.i === null ? null : String(o.i),
    status: o.X,
    executionType: typeof o.x === "string" ? o.x : "",
    lastFilledQty: Number.isFinite(l) ? l : 0,
    lastFilledPrice: Number.isFinite(L) ? L : 0,
    commission: Number.isFinite(n) ? n : 0,
    commissionAsset: typeof o.N === "string" ? o.N : null,
    tradeId: Number.isFinite(t) && t > 0 ? String(t) : null,
    time: Number.isFinite(time) ? time : num(m.E) || 0,
    ...(Number.isFinite(z) ? { cumulativeFilledQty: z } : {}),
  };
}

/** One order as read back from GET /fapi/v3/order (V3 doc "Query Order"). */
export interface QueriedOrder {
  symbol: string;
  clientOrderId: string;
  orderId: string | null;
  /** NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED. */
  status: string;
  executedQty: number;
  avgPrice: number;
  updateTime: number;
}

/** Coerce a Query Order answer; a missing status or quantity fails loudly. */
export function parseQueriedOrder(json: unknown): QueriedOrder {
  const o = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (!o || typeof o.status !== "string" || typeof o.symbol !== "string") throw new Error("query order: answer has no symbol or status");
  const executedQty = num(o.executedQty);
  if (!Number.isFinite(executedQty)) throw new Error("query order: executedQty missing or not a number");
  return {
    symbol: o.symbol,
    clientOrderId: typeof o.clientOrderId === "string" ? o.clientOrderId : "",
    orderId: o.orderId === undefined || o.orderId === null ? null : String(o.orderId),
    status: o.status,
    executedQty,
    avgPrice: num(o.avgPrice) || 0,
    updateTime: num(o.updateTime) || num(o.time) || 0,
  };
}

/**
 * A queried order as a ledger OrderUpdate, so a missed stream event can be caught up.
 * The cumulative filled quantity makes it safe to apply twice. Commission is not in the
 * query answer, so a caught-up fill carries none (its Set's profit is then before that fee).
 */
export function queriedOrderToUpdate(q: QueriedOrder): OrderUpdate {
  return {
    symbol: q.symbol,
    clientOrderId: q.clientOrderId,
    orderId: q.orderId,
    status: q.status,
    executionType: q.executedQty > 0 ? "TRADE" : q.status === "CANCELED" ? "CANCELED" : q.status === "EXPIRED" ? "EXPIRED" : "NEW",
    lastFilledQty: q.executedQty,
    lastFilledPrice: q.avgPrice,
    commission: 0,
    commissionAsset: null,
    tradeId: `catchup:${q.clientOrderId}:${q.executedQty}`,
    time: q.updateTime,
    cumulativeFilledQty: q.executedQty,
  };
}

/**
 * The stop recomputed from the exchange's own figures after a fill:
 * 85% of the distance from Aster's entryPrice to Aster's liquidationPrice.
 * Throws when the venue reports no usable liquidation price (0 or missing): the caller
 * must keep the existing stop and say so, never guess.
 * Units: prices quote per base.
 */
export function stopFromPositionRisk(row: PositionRiskRow, tickSize: number, fraction = activeRules().stop.fractionOfLiquidation): { side: Side; stopPrice: number } {
  if (!(row.liquidationPrice > 0)) throw new Error(`positionRisk ${row.symbol}: no liquidation price reported`);
  if (!(row.entryPrice > 0)) throw new Error(`positionRisk ${row.symbol}: no entry price reported`);
  const side: Side = row.positionAmt > 0 ? "buy" : "sell";
  return { side, stopPrice: stopPriceFromLiquidation(row.entryPrice, row.liquidationPrice, side, tickSize, fraction) };
}

/**
 * The client. Public calls need nothing; signed calls need `auth`.
 */
export class AsterClient {
  readonly baseUrl: string;
  private readonly f: NonNullable<AsterClientOptions["fetch"]>;
  private readonly auth?: AsterClientOptions["auth"];
  private readonly builder?: BuilderConfig;
  private readonly includeUser: boolean;
  private readonly nextNonce: () => string;
  private readonly timeoutMs: number;
  private rulesCache = new Map<string, { at: number; rules: SymbolRules }>();
  private depthCache = new Map<string, { at: number; depth: OrderBookDepth & { skipped: number } }>();

  constructor(o: AsterClientOptions = {}) {
    this.baseUrl = (o.baseUrl || ASTER_MAINNET_URL).replace(/\/+$/, "");
    this.f = o.fetch ?? ((u, i) => fetch(u, i));
    this.auth = o.auth;
    this.builder = o.builder;
    this.includeUser = o.includeUserInSignedString ?? true;
    this.nextNonce = o.nonce ?? createNonceSource();
    this.timeoutMs = o.timeoutMs ?? 10_000;
  }

  // ---------- low level ----------

  /** Send one HTTP request and parse JSON; throw AsterApiError on failure or a negative Aster code. */
  private async send(method: "GET" | "POST" | "PUT" | "DELETE", path: string, query: string, body?: string): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}${path}${query ? `?${query}` : ""}`;
      const res = await this.f(url, {
        method,
        signal: ctrl.signal,
        headers: body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
        body,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new AsterApiError(res.status, null, `non-JSON answer: ${text.slice(0, 200)}`, path);
      }
      const code = num((json as { code?: unknown })?.code);
      const msg = String((json as { msg?: unknown })?.msg ?? "");
      if (!res.ok) throw new AsterApiError(res.status, Number.isFinite(code) ? code : null, msg || text.slice(0, 200), path);
      // Some endpoints answer HTTP 200 with {"code": -xxxx, "msg": ...}: that is still a failure.
      if (Number.isFinite(code) && code < 0) throw new AsterApiError(res.status, code, msg, path);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build the exact signed string for a set of business parameters.
   * Order: business params as given, then nonce, user (if enabled), signer. Exposed for tests.
   */
  buildSignedString(params: Array<[string, string]>, nonce: string): string {
    if (!this.auth) throw new Error("signed Aster call needs user, signer and a signing key");
    const all: Array<[string, string]> = [...params, ["nonce", nonce]];
    if (this.includeUser) all.push(["user", this.auth.user]);
    all.push(["signer", this.auth.signer]);
    return pyUrlencode(all);
  }

  /** Sign and send. GET puts everything in the query; POST, PUT and DELETE in the form body. */
  async signed(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params: Array<[string, string]>): Promise<unknown> {
    if (!this.auth) throw new Error("signed Aster call needs user, signer and a signing key");
    const msg = this.buildSignedString(params, this.nextNonce());
    const signature = await this.auth.sign(msg);
    const payload = `${msg}&signature=${signature}`;
    return method === "GET" ? this.send("GET", path, payload) : this.send(method, path, "", payload);
  }

  /** Append builder fields (when configured) to an order's params. */
  private withBuilder(params: Array<[string, string]>): Array<[string, string]> {
    if (!this.builder) return params;
    return [...params, ["builder", this.builder.address], ["feeRate", this.builder.feeRate]];
  }

  // ---------- public market data ----------

  /** Tick size, step size and minimums for a symbol; cached 10 minutes. */
  async getSymbolRules(symbol: string): Promise<SymbolRules> {
    const hit = this.rulesCache.get(symbol);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.rules;
    const info = await this.send("GET", "/fapi/v3/exchangeInfo", "");
    const rules = parseSymbolRules(info, symbol);
    this.rulesCache.set(symbol, { at: Date.now(), rules });
    return rules;
  }

  /**
   * Public order book, GET /fapi/v3/depth. limit 1000 (weight 20) reaches about 5-6%
   * either side of the BTC price (checked 2026-11-16). Cached 5 s per symbol so a card
   * re-rendering does not hammer the venue. Units: price quote per base; weight USD.
   */
  async getDepth(symbol: string, limit: 5 | 10 | 20 | 50 | 100 | 500 | 1000 = 1000): Promise<OrderBookDepth & { skipped: number }> {
    const key = `${symbol}:${limit}`;
    const hit = this.depthCache.get(key);
    if (hit && Date.now() - hit.at < 5_000) return hit.depth;
    const j = await this.send("GET", "/fapi/v3/depth", pyUrlencode([["symbol", symbol], ["limit", String(limit)]]));
    const depth = parseDepth(j);
    if (depth.bids.length === 0 && depth.asks.length === 0) throw new Error(`Aster depth for ${symbol} came back empty`);
    this.depthCache.set(key, { at: Date.now(), depth });
    return depth;
  }

  /** Latest trade price. Units: quote per base. */
  async getPrice(symbol: string): Promise<{ symbol: string; price: number; time: number }> {
    const j = (await this.send("GET", "/fapi/v3/ticker/price", pyUrlencode([["symbol", symbol]]))) as Record<string, unknown>;
    const price = num(j?.price);
    if (!(price > 0)) throw new Error(`Aster ticker for ${symbol} has no usable price`);
    return { symbol, price, time: num(j?.time) };
  }

  // ---------- signed: account setup ----------

  /** POST /fapi/v3/leverage. leverage: integer 1..125 (the symbol's bracket may allow less). */
  changeLeverage(symbol: string, leverage: number) {
    return this.signed("POST", "/fapi/v3/leverage", [["symbol", symbol], ["leverage", String(leverage)]]);
  }

  /**
   * POST /fapi/v3/marginType. Aster answers -4046 when the type is already set; that counts as success.
   * NOT CALLED BY SETS since 2026-11-16: the account's margin type (and position mode) belong
   * to the user's own Blackboard app and are never changed by a Set. Kept for tools only.
   */
  async ensureIsolated(symbol: string): Promise<void> {
    try {
      await this.signed("POST", "/fapi/v3/marginType", [["symbol", symbol], ["marginType", "ISOLATED"]]);
    } catch (e) {
      if (e instanceof AsterApiError && e.code === -4046) return; // NO_NEED_TO_CHANGE_MARGIN_TYPE
      throw e;
    }
  }

  /** GET /fapi/v3/positionSide/dual. true = Hedge Mode (positionSide must be sent, reduceOnly must not). */
  async isHedgeMode(): Promise<boolean> {
    const j = (await this.signed("GET", "/fapi/v3/positionSide/dual", [])) as { dualSidePosition?: unknown };
    return j?.dualSidePosition === true || j?.dualSidePosition === "true";
  }

  // ---------- signed: orders ----------

  /** POST /fapi/v3/order. Builder fields are added when configured. */
  newOrder(p: NewOrderParams) {
    // Keep only defined fields, in a stable order, as strings.
    const params = Object.entries(p).filter(([, v]) => v !== undefined) as Array<[string, string]>;
    return this.signed("POST", "/fapi/v3/order", this.withBuilder(params));
  }

  /**
   * POST /fapi/v3/placeStrategyOrder with strategyType OTO: the first leg (entry) places
   * the second (take-profit) once it fills. Builder fields are documented on this endpoint.
   * The response can be HTTP 200 with failureCode set; that is thrown as an error.
   */
  placeOto(entry: StrategySubOrder, takeProfit: StrategySubOrder, clientStrategyId?: string) {
    return this.placeStrategy("OTO", [entry, takeProfit], clientStrategyId);
  }

  /**
   * POST /fapi/v3/placeStrategyOrder with strategyType OTOCO (exactly 3 legs): the entry
   * places the take-profit AND the stop once it fills; whichever of those two fills
   * cancels the other. This is how a live Set is sent since 2026-11-16. The builder
   * fields sit on the request, so they cover all three legs, the stop included.
   */
  placeOtoco(entry: StrategySubOrder, takeProfit: StrategySubOrder, stop: StrategySubOrder, clientStrategyId?: string) {
    return this.placeStrategy("OTOCO", [entry, takeProfit, stop], clientStrategyId);
  }

  /** Shared body of the strategy calls. Throws on HTTP 200 with a failureCode. */
  private async placeStrategy(type: "OTO" | "OTOCO", legs: StrategySubOrder[], clientStrategyId?: string) {
    const params: Array<[string, string]> = [];
    if (clientStrategyId) params.push(["clientStrategyId", clientStrategyId]);
    params.push(["strategyType", type], ["subOrderList", JSON.stringify(legs)]);
    const j = (await this.signed("POST", "/fapi/v3/placeStrategyOrder", this.withBuilder(params))) as Record<string, unknown>;
    const failureCode = num(j?.failureCode);
    if (Number.isFinite(failureCode) && failureCode !== 0) {
      throw new AsterApiError(200, failureCode, String(j?.failureReason ?? "strategy rejected"), "/fapi/v3/placeStrategyOrder");
    }
    return j;
  }

  /** DELETE /fapi/v3/order by orderId. */
  cancelOrder(symbol: string, orderId: string) {
    return this.signed("DELETE", "/fapi/v3/order", [["symbol", symbol], ["orderId", orderId]]);
  }

  /** DELETE /fapi/v3/order by our own client order id (origClientOrderId). */
  cancelOrderByClientId(symbol: string, clientOrderId: string) {
    return this.signed("DELETE", "/fapi/v3/order", [["symbol", symbol], ["origClientOrderId", clientOrderId]]);
  }

  /**
   * POST /fapi/v3/updateStrategyOrder: change sub-orders of a working strategy (Sets use it
   * to size exits to the filled quantity and to move the stop, keeping the OTOCO link so
   * the exchange still cancels one exit when the other fills). The doc lists no builder
   * fields here, and unlisted parameters are rejected, so none are added. The answer is an
   * array with one result per sub-order; any failureCode or updateStatus other than
   * SUCCESS is thrown.
   */
  async updateStrategyOrder(strategyId: string, strategyType: "OTO" | "OCO" | "OTOCO", subs: StrategySubOrderUpdate[]) {
    const j = await this.signed("POST", "/fapi/v3/updateStrategyOrder", [
      ["strategyId", strategyId],
      ["strategyType", strategyType],
      ["subOrderList", JSON.stringify(subs)],
    ]);
    for (const r of (Array.isArray(j) ? j : [j]) as Array<Record<string, unknown>>) {
      const fc = num(r?.failureCode);
      const status = r?.updateStatus;
      if ((Number.isFinite(fc) && fc !== 0) || (typeof status === "string" && status !== "SUCCESS")) {
        throw new AsterApiError(200, Number.isFinite(fc) ? fc : null, String(r?.failureReason || status || "update rejected"), "/fapi/v3/updateStrategyOrder");
      }
    }
    return j;
  }

  /** GET /fapi/v3/strategyOpenOrder by our clientStrategyId: the sub-orders with Aster's orderIds. */
  strategyOpenOrder(clientStrategyId: string, strategyType: "OTO" | "OCO" | "OTOCO") {
    return this.signed("GET", "/fapi/v3/strategyOpenOrder", [["clientStrategyId", clientStrategyId], ["strategyType", strategyType]]);
  }

  /** GET /fapi/v3/balance (Futures Account Balance v3). Parse with parseUsdtBalance. */
  balance() {
    return this.signed("GET", "/fapi/v3/balance", []);
  }

  /** GET /fapi/v3/account (Account Information v3): cushion and maintenance for the pre-trade risk check (core/risk.ts parseAccountRisk). */
  account() {
    return this.signed("GET", "/fapi/v3/account", []);
  }

  /**
   * GET /fapi/v3/order by our client order id. null when Aster answers "order does not
   * exist" (-2013): never placed, or cancelled unfilled more than 7 days ago.
   */
  async queryOrderByClientId(symbol: string, clientOrderId: string): Promise<QueriedOrder | null> {
    try {
      return parseQueriedOrder(await this.signed("GET", "/fapi/v3/order", [["symbol", symbol], ["origClientOrderId", clientOrderId]]));
    } catch (e) {
      if (e instanceof AsterApiError && e.code === -2013) return null;
      throw e;
    }
  }

  /**
   * POST /fapi/v3/listenKey: the user data stream key. Answers the account's active key
   * when one exists (so it never disturbs another app's stream) and extends it 60 minutes.
   */
  async startUserStream(): Promise<string> {
    const j = (await this.signed("POST", "/fapi/v3/listenKey", [])) as { listenKey?: unknown };
    if (typeof j?.listenKey !== "string" || j.listenKey === "") throw new Error("listenKey: answer has no key");
    return j.listenKey;
  }

  /** PUT /fapi/v3/listenKey: keep the stream key alive another 60 minutes. Never DELETE: the key may be shared. */
  keepAliveUserStream() {
    return this.signed("PUT", "/fapi/v3/listenKey", []);
  }

  /** GET /fapi/v3/openOrders for one symbol. */
  openOrders(symbol: string) {
    return this.signed("GET", "/fapi/v3/openOrders", [["symbol", symbol]]);
  }

  /** GET /fapi/v3/positionRisk (Position Information v3). Also the cheapest credential probe. */
  positionRisk(symbol?: string) {
    return this.signed("GET", "/fapi/v3/positionRisk", symbol ? [["symbol", symbol]] : []);
  }

  /**
   * GET /fapi/v3/leverageBrackets (signed, USER_DATA): the maintenance margin rate per
   * notional bracket, used for the liquidation estimate before the fill. Signed, so the
   * demo server calls it only in live mode; trial mode uses the assumed rate (stop.ts).
   */
  async leverageBrackets(symbol: string): Promise<LeverageBracket[]> {
    return parseLeverageBrackets(await this.signed("GET", "/fapi/v3/leverageBrackets", [["symbol", symbol]]), symbol);
  }
}
