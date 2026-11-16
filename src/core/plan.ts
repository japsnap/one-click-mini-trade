/**
 * Build the full order plan of a Set from the user's choices plus market data.
 *
 * This is the one function both the preview and the placement use, so the recipe
 * is identical. Placement rebuilds the plan on the server with a fresh price and a
 * fresh nudge (it never trusts a plan sent by a client), so the placed numbers can
 * differ slightly from the preview; the card shows the placed plan after Enter. It only computes; it never
 * talks to a network. Inputs come from the exchange (price, symbol rules) and the
 * level source (skilled traders' orders and positions).
 */
import { pickEntry, type EntryDecision, type EntryOptions } from "./entry";
import { splitDraw } from "./drawSplit";
import { splitFees, type FeeSplit } from "./fees";
import { liquidationDistance } from "./liquidation";
import { nudgePrice } from "./nudge";
import { floorToStep, roundToTick } from "./rounding";
import { pickTakeProfit, type TpSource } from "./takeProfit";
import { TicketTooSmallError } from "./drawSplit";
import type { RandomSource, SetInput, SymbolRules, TraderLevels } from "./types";

/** One entry order. price is null for a market order. Units: quote per base; qty base. */
export interface PlannedEntry {
  type: "MARKET" | "LIMIT";
  price: number | null;
  qty: number;
}

/** One reduce-only take-profit order (TAKE_PROFIT_MARKET triggered at stopPrice). */
export interface PlannedTakeProfit {
  stopPrice: number;
  qty: number;
}

/** The whole plan of one Set. */
export interface SetPlan {
  input: SetInput;
  /** Price the plan was built against. Units: quote per base. */
  currentPrice: number;
  /** ticket x leverage. Units: USD. */
  notionalUsd: number;
  entry: {
    requestedMode: SetInput["entryMode"];
    usedMode: SetInput["entryMode"];
    reason: string;
    fellBackFrom: string[];
    /** Level price before the nudge (null for market). */
    levelPrice: number | null;
    /** Final limit price after nudge and tick rounding (null for market). */
    nudgedPrice: number | null;
    /** Expected average fill. For market, the current price (real fill may differ by slippage). */
    expectedFillPrice: number;
  };
  orders: { entries: PlannedEntry[]; takeProfits: PlannedTakeProfit[] };
  /** Total base quantity across entries. */
  quantity: number;
  liquidationPrice: number;
  takeProfit: {
    /** Quantity-weighted average take-profit price (single price unless Draw). */
    price: number;
    /** Reward-to-risk ratio achieved (the smallest one in Draw). */
    ratio: number;
    source: TpSource | "drawn";
  };
  expected: {
    /** Profit if every take-profit fills, before exchange fees. USD. */
    profitAtTpUsd: number;
    /** Loss if liquidated (about the ticket). USD, negative. */
    lossAtLiquidationUsd: number;
    /** How the profit would be split on a win. */
    feeSplitOnWin: FeeSplit;
  };
}

/** Optional knobs; all have product defaults. */
export interface PlanOptions {
  entry?: Partial<EntryOptions>;
  nudgeFraction?: number;
  tpTolerance?: number;
  maintenanceMarginRate?: number;
}

/**
 * Build a SetPlan.
 * Why: one deterministic recipe (given the random source) from choices to orders.
 * Units: currentPrice quote per base; ticket USD; quantities base units.
 */
export function buildSetPlan(args: {
  input: SetInput;
  currentPrice: number;
  rules: SymbolRules;
  levels: TraderLevels;
  random: RandomSource;
  options?: PlanOptions;
}): SetPlan {
  const { input, currentPrice, rules, levels } = args;
  const o = args.options ?? {};
  const notionalUsd = input.ticketUsd * input.leverage; // position size
  const mmr = o.maintenanceMarginRate ?? 0;

  if (input.entryMode === "draw") {
    if (!input.draw) throw new RangeError("draw mode needs the In and Out bands");
    const d = splitDraw({
      side: input.side,
      bands: input.draw,
      ticketUsd: input.ticketUsd,
      leverage: input.leverage,
      rules,
      random: args.random,
      nudgeFraction: o.nudgeFraction,
      maintenanceMarginRate: mmr,
    });
    const tpQty = d.takeProfits.reduce((s, t) => s + t.qty, 0);
    const avgTp = d.takeProfits.reduce((s, t) => s + t.price * t.qty, 0) / tpQty; // qty-weighted
    const sign = input.side === "buy" ? 1 : -1;
    // Each TP closes its paired entry: profit = sum of qty x (tp - entry) in the trade's direction.
    const profit = d.takeProfits.reduce((s, t, i) => s + sign * (t.price - (d.entries[i]?.price ?? t.price)) * t.qty, 0);
    return {
      input,
      currentPrice,
      notionalUsd,
      entry: {
        requestedMode: "draw",
        usedMode: "draw",
        reason: `${d.entries.length} limit order${d.entries.length > 1 ? "s" : ""} across the In band, ${d.takeProfits.length} take-profit${d.takeProfits.length > 1 ? "s" : ""} across the Out band`,
        fellBackFrom: [],
        levelPrice: null,
        nudgedPrice: null,
        expectedFillPrice: d.averageEntry,
      },
      orders: {
        entries: d.entries.map((e) => ({ type: "LIMIT", price: e.price, qty: e.qty })),
        takeProfits: d.takeProfits.map((t) => ({ stopPrice: t.price, qty: t.qty })),
      },
      quantity: d.totalQty,
      liquidationPrice: d.liquidationPrice,
      takeProfit: { price: avgTp, ratio: d.minRatio, source: "drawn" },
      expected: {
        profitAtTpUsd: round2(profit),
        lossAtLiquidationUsd: -round2(d.totalQty * liquidationDistance(d.averageEntry, d.liquidationPrice)),
        feeSplitOnWin: splitFees(round2(profit)),
      },
    };
  }

  // Now / Nearby / Patient
  const decision: EntryDecision = pickEntry({ mode: input.entryMode, side: input.side, currentPrice, levels, options: o.entry });
  let fill = currentPrice;
  let nudged: number | null = null;
  if (decision.orderType === "limit") {
    nudged = nudgePrice(decision.price, rules.tickSize, args.random, o.nudgeFraction).price;
    // A limit must stay on the favourable side of the price, or it fills at once as a
    // market order. The nudge can cross it when the level sits within 0.05% of price.
    if (input.side === "buy" && nudged >= currentPrice) nudged = roundToTick(currentPrice - rules.tickSize, rules.tickSize, "down");
    if (input.side === "sell" && nudged <= currentPrice) nudged = roundToTick(currentPrice + rules.tickSize, rules.tickSize, "up");
    fill = nudged;
  }
  // Market orders use MARKET_LOT_SIZE; limits use LOT_SIZE. Quantity rounded down so the ticket is never exceeded.
  const isMarket = decision.orderType === "market";
  const step = isMarket ? rules.marketStepSize : rules.stepSize;
  const minQty = isMarket ? rules.marketMinQty : rules.minQty;
  const qty = floorToStep(notionalUsd / fill, step);
  if (qty < minQty || qty * fill < rules.minNotionalUsd) {
    throw new TicketTooSmallError(notionalUsd, Math.max(rules.minNotionalUsd, minQty * fill));
  }

  const tp = pickTakeProfit({
    entry: fill,
    side: input.side,
    leverage: input.leverage,
    mode: input.tpMode,
    tickSize: rules.tickSize,
    traderTakeProfits: levels.takeProfitLevels,
    tolerance: o.tpTolerance,
    maintenanceMarginRate: mmr,
  });
  const profit = round2(qty * Math.abs(tp.price - fill)); // TP is always on the profit side
  return {
    input,
    currentPrice,
    notionalUsd,
    entry: {
      requestedMode: decision.requestedMode,
      usedMode: decision.usedMode,
      reason: decision.reason,
      fellBackFrom: decision.fellBackFrom,
      levelPrice: isMarket ? null : decision.price,
      nudgedPrice: nudged,
      expectedFillPrice: fill,
    },
    orders: {
      entries: [{ type: isMarket ? "MARKET" : "LIMIT", price: nudged, qty }],
      takeProfits: [{ stopPrice: tp.price, qty }],
    },
    quantity: qty,
    liquidationPrice: tp.liquidationPrice,
    takeProfit: { price: tp.price, ratio: tp.ratio, source: tp.source },
    expected: {
      profitAtTpUsd: profit,
      lossAtLiquidationUsd: -round2(qty * liquidationDistance(fill, tp.liquidationPrice)),
      feeSplitOnWin: splitFees(profit),
    },
  };
}

/** Round to cents. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
