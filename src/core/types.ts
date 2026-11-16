/**
 * Shared types for a "Set": one leveraged trade opened with one button.
 *
 * Everything in src/core is plain TypeScript with no network and no React,
 * so an app (Blackboard or any other) can copy the folder as is.
 *
 * Units used everywhere in src/core:
 *  - prices: quote currency per 1 unit of the base asset (USDT per BTC for BTCUSDT)
 *  - quantities: base asset units (BTC for BTCUSDT)
 *  - "Usd" suffixed values: US dollars (USDT treated as 1 USD)
 *  - percentages are decimal fractions: 0.005 means 0.5%
 */

/** Direction of the Set. "buy" opens a long position, "sell" opens a short one. */
export type Side = "buy" | "sell";

/** Allowed ticket sizes in USD. The ticket is the margin: the most the user can lose. */
export type TicketUsd = 10 | 30 | 100;
export const TICKETS_USD: readonly TicketUsd[] = [10, 30, 100];

/**
 * Allowed leverage multipliers. Position size = ticket x leverage.
 * LEVERAGES is what core validation accepts (30x, 50x, 100x). The card shows only
 * CARD_LEVERAGES (30x, 50x); 100x is an advanced choice inside the options sheet
 * (owner rule 2026-11-16), so ADVANCED_LEVERAGES lists it separately.
 */
export type Leverage = 30 | 50 | 100;
export const LEVERAGES: readonly Leverage[] = [30, 50, 100];
export const CARD_LEVERAGES: readonly Leverage[] = [30, 50];
export const ADVANCED_LEVERAGES: readonly Leverage[] = [100];

/** Take-profit appetite. Each mode sets a minimum reward-to-risk ratio (see takeProfit.ts). */
export type TpMode = "shy" | "deserved" | "greedy";
export const TP_MODES: readonly TpMode[] = ["shy", "deserved", "greedy"];

/** When to enter. See entry.ts for now/nearby/patient and drawSplit.ts for draw. */
export type EntryMode = "now" | "nearby" | "patient" | "draw";
export const ENTRY_MODES: readonly EntryMode[] = ["now", "nearby", "patient", "draw"];

/**
 * A price with a weight. The weight is the USD notional sitting at that price
 * (order size x price, or position value), so bigger money counts more.
 */
export interface Level {
  price: number;
  weightUsd: number;
}

/** A resting limit order level. side = the side of the trader who placed it ("buy" = a bid). */
export interface SidedLevel extends Level {
  side: Side;
}

/** A liquidation price of another trader's open position. positionSide "long" liquidates when price falls to it. */
export interface LiquidationLevel extends Level {
  positionSide: "long" | "short";
}

/** Everything the level source (Hyperliquid today) returns for one coin. */
export interface TraderLevels {
  /** Resting limit orders that are not take-profits (bids and asks of skilled traders). */
  limitLevels: SidedLevel[];
  /** Take-profit prices skilled traders hold (trigger TPs and reduce-only limits). */
  takeProfitLevels: Level[];
  /** Liquidation prices of skilled traders' open positions. */
  liquidationLevels: LiquidationLevel[];
}

/**
 * Trading rules of one symbol, read from the exchange (Aster exchangeInfo filters).
 * The exchange rejects any order that breaks them.
 */
export interface SymbolRules {
  symbol: string;
  /** PRICE_FILTER.tickSize: every price must be a whole multiple of this. */
  tickSize: number;
  /** LOT_SIZE.stepSize: every quantity must be a whole multiple of this. */
  stepSize: number;
  /** LOT_SIZE.minQty: smallest quantity allowed for a limit order. */
  minQty: number;
  /** MARKET_LOT_SIZE.stepSize (falls back to stepSize when missing). */
  marketStepSize: number;
  /** MARKET_LOT_SIZE.minQty (falls back to minQty when missing). */
  marketMinQty: number;
  /** MIN_NOTIONAL.notional: smallest price x quantity in USD for one order. */
  minNotionalUsd: number;
}

/** A user's choices on the card. */
export interface SetInput {
  symbol: string;
  side: Side;
  ticketUsd: TicketUsd;
  leverage: Leverage;
  tpMode: TpMode;
  entryMode: EntryMode;
  /** Only for entryMode "draw": the two price bands the user painted on the strip. */
  draw?: DrawBands;
}

/** A closed price range. low <= high, both in quote currency. */
export interface PriceBand {
  low: number;
  high: number;
}

/** The In band (where to enter) and the Out band (where to take profit) painted in Draw mode. */
export interface DrawBands {
  inBand: PriceBand;
  outBand: PriceBand;
}

/** A source of random numbers in [0, 1). Injected so tests can be exact. Math.random fits. */
export type RandomSource = () => number;

/**
 * Seeded random source (mulberry32): the same seed always gives the same sequence.
 * Why: Nearby, the take-profit zone and the nudge all draw random numbers; a seed lets a
 * test, a replay or a support case reproduce one Set's exact prices. Production should
 * use a cryptographic source instead (the demo server uses node:crypto randomInt).
 * Units: seed any 32-bit integer; output in [0, 1).
 */
export function seededRandom(seed: number): RandomSource {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The venue's own order book (Aster public GET /fapi/v3/depth), as USD-weighted levels.
 * bids = resting buy orders below the price, asks = resting sell orders above it.
 * Used by the take-profit to find a wall of resting volume to stop just in front of.
 * Units: price quote per base; weightUsd = price x quantity.
 */
export interface OrderBookDepth {
  bids: Level[];
  asks: Level[];
}

/**
 * One notional bracket from Aster's leverage brackets (signed GET /fapi/v3/leverageBrackets).
 * The maintenance margin rate depends on how big the position is.
 * Units: notional in USD; maintMarginRatio a decimal fraction (0.004 = 0.4%).
 */
export interface LeverageBracket {
  notionalFloor: number;
  notionalCap: number;
  initialLeverage: number;
  maintMarginRatio: number;
}

/** The card's starting choices (owner rules 2026-11-16). */
export const DEFAULT_CHOICES = {
  side: "buy" as Side,
  ticketUsd: 10 as TicketUsd,
  leverage: 30 as Leverage,
  tpMode: "deserved" as TpMode,
  entryMode: "nearby" as EntryMode,
};
