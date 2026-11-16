/**
 * Build the full order plan of a Set from the user's choices plus market data.
 *
 * This is the one function both the preview and the placement use, so the recipe
 * is identical. Placement rebuilds the plan on the server with a fresh price and a
 * fresh random draw (it never trusts a plan sent by a client), so the placed numbers
 * can differ slightly from the preview; the card shows the placed plan after Enter. It
 * only computes; it never talks to a network. Inputs come from the exchange (price,
 * symbol rules, order book, leverage brackets) and the level source (skilled traders'
 * orders and positions on Hyperliquid).
 *
 * Every Set is three orders per entry (since 2026-11-16):
 *   entry  (market or limit)
 *   take-profit  (reduce-only TAKE_PROFIT_MARKET; takeProfit.ts)
 *   stop         (reduce-only STOP_MARKET at 85% of the liquidation distance; stop.ts)
 *
 * Order of random draws (for a seeded source): Nearby bucket, price inside the bucket,
 * nudge, then the take-profit's jitter in front of a volume wall. Now draws only the
 * take-profit jitter; Patient draws the nudge and the jitter (plus the two Nearby draws
 * when it falls back to Nearby). Draw draws one nudge per entry leg.
 */
import { pickEntry, type EntryDecision, type EntryDiagnostics, type EntryOptions } from "./entry";
import { splitDraw } from "./drawSplit";
import { splitFees, type FeeSplit } from "./fees";
import { liquidationDistance } from "./liquidation";
import { nudgePrice } from "./nudge";
import { floorToStep, roundToTick } from "./rounding";
import { planStop, resolveMaintenanceRate, type MaintenanceSource } from "./stop";
import { pickTakeProfit, type TpSource, type TpZoneDiagnostics, type TpZoneOptions, type VolumeZone } from "./takeProfit";
import { TicketTooSmallError } from "./drawSplit";
import type { Level, LeverageBracket, OrderBookDepth, RandomSource, SetInput, SymbolRules, TraderLevels } from "./types";

/** One entry order. price is null for a market order. Units: quote per base; qty base. */
export interface PlannedEntry {
  type: "MARKET" | "LIMIT";
  price: number | null;
  qty: number;
}

/** One reduce-only trigger order (TAKE_PROFIT_MARKET or STOP_MARKET) at stopPrice. */
export interface PlannedTrigger {
  stopPrice: number;
  qty: number;
}
/** Kept for callers of the older name. */
export type PlannedTakeProfit = PlannedTrigger;

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
  /** Same index = same leg: entries[i] opens, takeProfits[i] and stops[i] close it. */
  orders: { entries: PlannedEntry[]; takeProfits: PlannedTrigger[]; stops: PlannedTrigger[] };
  /** Total base quantity across entries. */
  quantity: number;
  /** Estimated liquidation price (at the average entry for Draw). */
  liquidationPrice: number;
  stop: {
    /** Stop trigger price (Draw: quantity-weighted average of the legs' stops). */
    price: number;
    /** 0.85: share of the liquidation distance. */
    fractionOfLiquidation: number;
    /** Maintenance margin rate used for the liquidation estimate (decimal) and its source. */
    maintenanceMarginRate: number;
    maintenanceSource: MaintenanceSource;
  };
  takeProfit: {
    /** Quantity-weighted average take-profit price (single price unless Draw). */
    price: number;
    /** Reward-to-risk ratio vs the STOP distance (the smallest one in Draw). */
    ratio: number;
    source: TpSource | "drawn";
    /** The volume wall the target sits in front of, when source is "volume-zone". */
    zone: VolumeZone | null;
  };
  expected: {
    /** Profit if every take-profit fills, before exchange fees. USD. */
    profitAtTpUsd: number;
    /** Loss if the stop fires, before exchange fees: the real maximum loss. USD, negative. */
    lossAtStopUsd: number;
    /** Loss if the position were liquidated instead (about the ticket), for comparison. USD, negative. */
    lossAtLiquidationUsd: number;
    /** How the profit would be split on a win. */
    feeSplitOnWin: FeeSplit;
  };
  /** Structural counts for the log and the smoke run. */
  diagnostics: {
    entry: EntryDiagnostics;
    takeProfitZone: TpZoneDiagnostics | null;
    /** Opposite-side levels offered to the zone search, by source. */
    oppositeVolumeLevels: { venueBook: number; traders: number };
  };
}

/** Optional knobs; all have product defaults. */
export interface PlanOptions {
  entry?: Partial<EntryOptions>;
  nudgeFraction?: number;
  tpTolerance?: number;
  tpZone?: Partial<TpZoneOptions>;
  /** Overrides the assumed maintenance rate when no brackets are passed (decimal). */
  assumedMaintenanceRate?: number;
  /** Share of the liquidation distance for the stop. Default 0.85. */
  stopFraction?: number;
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
  /** Aster order book (public /fapi/v3/depth). Optional: without it only traders' orders feed the zone. */
  depth?: OrderBookDepth | null;
  /** Aster leverage brackets (signed /fapi/v3/leverageBrackets). Optional: without them a rate is assumed. */
  brackets?: LeverageBracket[] | null;
  options?: PlanOptions;
}): SetPlan {
  const { input, currentPrice, rules, levels } = args;
  const o = args.options ?? {};
  const notionalUsd = input.ticketUsd * input.leverage; // position size
  const mm = resolveMaintenanceRate({ notionalUsd, leverage: input.leverage, brackets: args.brackets, assumedRate: o.assumedMaintenanceRate });

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
      maintenanceMarginRate: mm.rate,
      maintenanceSource: mm.source,
    });
    const tpQty = d.takeProfits.reduce((s, t) => s + t.qty, 0);
    const avgTp = d.takeProfits.reduce((s, t) => s + t.price * t.qty, 0) / tpQty; // qty-weighted
    const avgStop = d.stops.reduce((s, t) => s + t.price * t.qty, 0) / tpQty; // qty-weighted, for display
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
        stops: d.stops.map((t) => ({ stopPrice: t.price, qty: t.qty })),
      },
      quantity: d.totalQty,
      liquidationPrice: d.liquidationPrice,
      stop: { price: avgStop, fractionOfLiquidation: o.stopFraction ?? 0.85, maintenanceMarginRate: mm.rate, maintenanceSource: mm.source },
      takeProfit: { price: avgTp, ratio: d.minRatio, source: "drawn", zone: null },
      expected: {
        profitAtTpUsd: round2(profit),
        lossAtStopUsd: -round2(d.lossAtStopsUsd),
        lossAtLiquidationUsd: -round2(d.totalQty * liquidationDistance(d.averageEntry, d.liquidationPrice)),
        feeSplitOnWin: splitFees(round2(profit)),
      },
      diagnostics: { entry: {}, takeProfitZone: null, oppositeVolumeLevels: { venueBook: 0, traders: 0 } },
    };
  }

  // Now / Nearby / Patient
  const decision: EntryDecision = pickEntry({
    mode: input.entryMode,
    side: input.side,
    currentPrice,
    levels,
    random: args.random,
    options: o.entry,
  });
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

  // Downside first: liquidation estimate, then the stop at 85% of that distance.
  const stop = planStop({
    entry: fill,
    side: input.side,
    leverage: input.leverage,
    tickSize: rules.tickSize,
    maintenanceMarginRate: mm.rate,
    maintenanceSource: mm.source,
    fraction: o.stopFraction,
  });

  // Opposite-side resting volume for the take-profit zone: sellers above a Buy, buyers below a Sell.
  const venueBook: Level[] = (input.side === "buy" ? args.depth?.asks : args.depth?.bids) ?? [];
  const traderSide = input.side === "buy" ? "sell" : "buy";
  const traderOrders: Level[] = levels.limitLevels.filter((l) => l.side === traderSide).map((l) => ({ price: l.price, weightUsd: l.weightUsd }));

  const tp = pickTakeProfit({
    entry: fill,
    side: input.side,
    stopPrice: stop.stopPrice,
    mode: input.tpMode,
    tickSize: rules.tickSize,
    oppositeVolume: [...venueBook, ...traderOrders],
    traderTakeProfits: levels.takeProfitLevels,
    random: args.random,
    tolerance: o.tpTolerance,
    zone: o.tpZone,
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
      stops: [{ stopPrice: stop.stopPrice, qty }],
    },
    quantity: qty,
    liquidationPrice: stop.liquidationPrice,
    stop: {
      price: stop.stopPrice,
      fractionOfLiquidation: stop.fractionOfLiquidation,
      maintenanceMarginRate: stop.maintenanceMarginRate,
      maintenanceSource: stop.maintenanceSource,
    },
    takeProfit: { price: tp.price, ratio: tp.ratio, source: tp.source, zone: tp.zone },
    expected: {
      profitAtTpUsd: profit,
      lossAtStopUsd: -round2(qty * stop.riskDistance),
      lossAtLiquidationUsd: -round2(qty * liquidationDistance(fill, stop.liquidationPrice)),
      feeSplitOnWin: splitFees(profit),
    },
    diagnostics: {
      entry: decision.diagnostics,
      takeProfitZone: tp.diagnostics,
      oppositeVolumeLevels: { venueBook: venueBook.length, traders: traderOrders.length },
    },
  };
}

/** Round to cents. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
