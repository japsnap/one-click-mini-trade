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
import type { SymbolRules } from "../core/types";

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
  type: "MARKET" | "LIMIT" | "TAKE_PROFIT_MARKET";
  quantity?: string;
  price?: string;
  /** LIMIT needs GTC; TAKE_PROFIT_MARKET accepts only GTC if sent. */
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
  type: "LIMIT" | "MARKET" | "TAKE_PROFIT_MARKET";
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: "GTC";
  workingType?: "MARK_PRICE" | "CONTRACT_PRICE";
  reduceOnly?: "true" | "false";
  firstDrivenId?: string;
  firstDrivenOn?: "NEW" | "PARTIALLY_FILLED_OR_FILLED" | "FILLED";
  firstTrigger?: "PLACE_ORDER" | "CANCEL_ORDER";
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
  private async send(method: "GET" | "POST" | "DELETE", path: string, query: string, body?: string): Promise<unknown> {
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

  /** Sign and send. GET puts everything in the query; POST/DELETE in the form body. */
  async signed(method: "GET" | "POST" | "DELETE", path: string, params: Array<[string, string]>): Promise<unknown> {
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
   * POST /fapi/v3/marginType. A Set needs ISOLATED: only then is the ticket the most you can lose.
   * Aster answers -4046 when the type is already set; that counts as success.
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
  async placeOto(entry: StrategySubOrder, takeProfit: StrategySubOrder, clientStrategyId?: string) {
    const params: Array<[string, string]> = [];
    if (clientStrategyId) params.push(["clientStrategyId", clientStrategyId]);
    params.push(["strategyType", "OTO"], ["subOrderList", JSON.stringify([entry, takeProfit])]);
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

  /** GET /fapi/v3/openOrders for one symbol. */
  openOrders(symbol: string) {
    return this.signed("GET", "/fapi/v3/openOrders", [["symbol", symbol]]);
  }

  /** GET /fapi/v3/positionRisk (Position Information v3). Also the cheapest credential probe. */
  positionRisk(symbol?: string) {
    return this.signed("GET", "/fapi/v3/positionRisk", symbol ? [["symbol", symbol]] : []);
  }
}
