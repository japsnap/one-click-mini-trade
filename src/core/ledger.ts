/**
 * The Set ledger: many open Sets per account, on the same coin, on both sides and at
 * different leverages, without breaking each other (rules of 2026-11-16).
 *
 * THE PROBLEM IT SOLVES
 * Aster keeps one position per symbol (one-way mode) or one per symbol and side (hedge
 * mode). It does not know what a "Set" is. Two Buy Sets on BTC merge into one long; a Buy
 * and a Sell Set in one-way mode net against each other; leverage is one number per
 * symbol; the liquidation price and realizedPnl belong to the merged position. So the
 * truth about each Set has to live HERE, in a ledger the app keeps, and the exchange is
 * only checked against it.
 *
 * DECISIONS (also in CHANGELOG.md, 2026-11-16 "Many Sets at once")
 *  1. Every Set has an id ("set_" + time + random). Every order it sends carries a client
 *     order id made from it: `<setId>-<leg><E|T|S>` (Entry, Take-profit, Stop), and each
 *     leg's OTOCO strategy carries `<setId>-<leg>`. Fills are matched to Sets by that id
 *     (falling back to Aster's orderId), so the Set's OWN filled quantity and price are known.
 *  2. The account's position mode and margin type are NEVER changed (that would change
 *     Blackboard's own app for the user). The mode is read and stored per Set.
 *       one-way: exits are plain opposite-side orders of the Set's quantity, NOT reduce-only.
 *                Then the exchange's net position always equals the sum of open Sets
 *                (+ for Buy Sets, - for Sell Sets). A reduce-only exit would be refused or
 *                shrunk whenever another Set had moved the net to the other side.
 *       hedge:   positionSide LONG for Buy Sets, SHORT for Sell Sets; exits close that
 *                side by quantity. (Aster forbids reduceOnly in hedge mode.)
 *  3. Each Set's take-profit and stop are sized to that Set's FILLED quantity and its stop
 *     comes from the Set's own numbers (core/stop.ts setStopPrice: 85% of the ticket,
 *     capped at 85% of the real liquidation distance of the account's position).
 *  4. Leverage: the Set's leverage is its sizing (notional = ticket x leverage). The symbol
 *     leverage is raised to the highest leverage among open Sets on that symbol and never
 *     lowered while Sets are open there (symbolLeverageTarget).
 *  5. Margin: a Set is refused when the free balance cannot carry its ticket, or the wallet
 *     cannot carry every open ticket plus this one (checkMarginForSet).
 *  6. Reconcile: the exchange's position per symbol and side must equal the sum of open
 *     Sets' open quantity. On a mismatch (the user closed or added by hand in Blackboard's
 *     app, or the venue liquidated) the Sets on that symbol (and side, in hedge mode) are
 *     marked "closed-outside", their remaining orders are cancelled, and it is logged
 *     loudly. NOTHING is ever placed to "fix" a mismatch.
 *     Safety refinement (ours): a mismatch must be seen twice, the same both times, at
 *     least `graceMs` apart (default 5 s), before anything is cancelled. Why: the position
 *     moves on the exchange a moment before the fill event reaches the ledger; acting on
 *     the first sight would cancel every Set's exits on every ordinary fill. graceMs: 0
 *     acts at once.
 *  7. When one Set's exit fills, only THAT Set's sibling exit is cancelled (and its
 *     unfilled entry remainder, so it cannot reopen a position with no exits). The OTOCO
 *     already cancels the sibling on the exchange; our cancel is the backstop.
 *  8. Profit and the profit share come from the Set's own fills (setPnl), never from
 *     Aster's realizedPnl, which is measured against the merged position's average entry.
 *
 * Everything here is pure: no network, no clock (time is passed in), no randomness except
 * the injected source of newSetId. Functions take a ledger and return a NEW ledger plus a
 * list of actions (orders to cancel, exits to re-sync) and log lines; server/execute.ts
 * performs the actions on Aster. The ledger is plain JSON, so Blackboard can store it in
 * its own database (one ledger per account).
 *
 * Units: prices quote per base (USDT per BTC); quantities base units; money USD.
 */
import { splitFees, type FeeSplit } from "./fees";
import { setStopPrice, type SetStop, type StopBound, type StopCap } from "./stop";
import type { Side } from "./types";

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Every Set id starts with this, so the app's orders can be told apart from the user's own. */
export const SET_ID_PREFIX = "set_";

/** Aster: newClientOrderId / sub-order clientOrderId must match this, at most 36 characters. */
export const ASTER_CLIENT_ORDER_ID = /^[\.A-Z\:/a-z0-9_-]{1,36}$/;
/** Aster: clientStrategyId must match this, at most 28 characters. */
export const ASTER_CLIENT_STRATEGY_ID = /^[\.A-Z\:/a-z0-9_-]{1,28}$/;

/** The three orders of one leg. */
export type OrderRole = "entry" | "takeProfit" | "stop";
const ROLE_CODE: Record<OrderRole, string> = { entry: "E", takeProfit: "T", stop: "S" };
const CODE_ROLE: Record<string, OrderRole> = { E: "entry", T: "takeProfit", S: "stop" };

/**
 * A new Set id: "set_" + time in base 36 (8 characters until the year 2059) + 5 random
 * characters. 17 characters, so `<id>-5E` (20) and `<id>-5` (19) stay inside Aster's limits.
 * Units: now in ms since 1970; random in [0, 1).
 */
export function newSetId(now: number, random: () => number): string {
  let r = "";
  for (let i = 0; i < 5; i++) r += Math.min(35, Math.floor(random() * 36)).toString(36);
  return `${SET_ID_PREFIX}${Math.floor(now).toString(36)}${r}`;
}

/** The client order id of one order of a Set. legIndex starts at 1 (Draw has up to 5 legs). */
export function setClientOrderId(setId: string, legIndex: number, role: OrderRole): string {
  const id = `${setId}-${legIndex}${ROLE_CODE[role]}`;
  if (!ASTER_CLIENT_ORDER_ID.test(id)) throw new RangeError(`client order id ${id} breaks Aster's rule`);
  return id;
}

/** The client strategy id of one leg's OTOCO. */
export function setStrategyClientId(setId: string, legIndex: number): string {
  const id = `${setId}-${legIndex}`;
  if (!ASTER_CLIENT_STRATEGY_ID.test(id)) throw new RangeError(`client strategy id ${id} breaks Aster's rule`);
  return id;
}

/** Read a client order id back into its Set, leg and role; null for any order not made by a Set. */
export function parseSetClientOrderId(clientOrderId: string): { setId: string; legIndex: number; role: OrderRole } | null {
  const m = /^(set_[a-z0-9]+)-(\d)([ETS])$/.exec(clientOrderId);
  if (!m) return null;
  return { setId: m[1] as string, legIndex: Number(m[2]), role: CODE_ROLE[m[3] as string] as OrderRole };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type PositionMode = "one-way" | "hedge";

/** Life of one order as the ledger knows it. "planned" = not (yet) confirmed by the exchange. */
export type OrderState = "planned" | "working" | "partially-filled" | "filled" | "cancelled" | "expired" | "rejected";

/** One fill (a trade). commission is positive = paid. Units: qty base; price quote per base. */
export interface Fill {
  tradeId: string;
  qty: number;
  price: number;
  commission: number;
  commissionAsset: string | null;
  time: number;
}

/** One order of a Set. */
export interface TrackedOrder {
  clientOrderId: string;
  /** Aster's orderId once an event or a query has told us. */
  orderId: string | null;
  state: OrderState;
  fills: Fill[];
  /** We asked the exchange to cancel it (so its CANCELED event is expected). */
  cancelRequested: boolean;
}

/** A take-profit or stop: a trigger order with its current size on the exchange. */
export interface TrackedExit extends TrackedOrder {
  /** Total quantity of this exit order as last sent (its own fills included). */
  qty: number;
  /** Trigger price as last sent. */
  stopPrice: number;
  /** Stops only: which rule set the price (core/stop.ts). */
  boundBy?: StopBound;
}

/** One entry with its two exits (one OTOCO strategy on Aster). */
export interface SetLeg {
  /** 1-based; Draw has up to 5 legs, every other mode 1. */
  index: number;
  strategyClientId: string;
  /** Aster's strategyId from the placement answer; needed to resize the exits. */
  strategyId: string | null;
  entryType: "MARKET" | "LIMIT";
  plannedQty: number;
  plannedPrice: number | null;
  /** This leg's share of the ticket: ticket x plannedQty / the Set's total planned qty. USD. */
  ticketShareUsd: number;
  /** "send-failed": the request failed or its answer was lost; events for its ids are still matched. */
  sent: "not-sent" | "sent" | "send-failed";
  entry: TrackedOrder;
  takeProfit: TrackedExit;
  stop: TrackedExit;
}

/**
 * pending        sent, nothing filled yet
 * open           some entry quantity filled and not all of it closed
 * closed         every filled quantity closed by the Set's own exits
 * closed-outside the exchange position stopped matching (closed or changed by hand, or liquidated)
 * never-filled   every entry ended (cancelled or expired) with nothing filled
 * not-sent       no leg reached the exchange
 */
export type SetStatus = "pending" | "open" | "closed" | "closed-outside" | "never-filled" | "not-sent";

export interface SetRecord {
  id: string;
  symbol: string;
  side: Side;
  /** The Set's own leverage: its sizing (notional = ticket x leverage). */
  leverage: number;
  ticketUsd: number;
  /** The account's position mode when the Set was placed (read, never changed). */
  positionMode: PositionMode;
  createdAt: number;
  status: SetStatus;
  closedAt: number | null;
  closeReason: string | null;
  /** Set when something needs a person: an exit lost on the exchange, a failed cancel. */
  needsAttention: string | null;
  legs: SetLeg[];
}

/** A mismatch seen once and waiting for its second sight (decision 6). */
export interface SuspectedMismatch {
  firstSeenAt: number;
  expected: number;
  actual: number;
}

/** The whole ledger of one account. Plain JSON. */
export interface SetLedger {
  version: 1;
  sets: SetRecord[];
  /** Key: `${symbol}:${BOTH|LONG|SHORT}`. */
  suspects: Record<string, SuspectedMismatch>;
  /**
   * The user's own position outside the Sets, per symbol and key (BOTH, LONG, SHORT; hedge
   * SHORT positive), recorded when the first Set opens on a coin that already holds a
   * position (2026-11-19, Shota: allow a Set next to his own trade, with a warning). The
   * exchange should then show outside + Sets. Optional: ledgers saved before it read as none.
   */
  outside?: Record<string, Record<string, number>>;
}

export function emptyLedger(): SetLedger {
  return { version: 1, sets: [], suspects: {} };
}

/** What createSetRecord needs per leg (taken from the plan's orders, same index). */
export interface NewLeg {
  entryType: "MARKET" | "LIMIT";
  qty: number;
  price: number | null;
  takeProfitPrice: number;
  stopPrice: number;
}

/**
 * A new Set record (status pending, every order "planned"). Add it to the ledger and save
 * it BEFORE sending, so a crash between send and save never leaves an untracked order.
 */
export function createSetRecord(args: {
  id: string;
  symbol: string;
  side: Side;
  leverage: number;
  ticketUsd: number;
  positionMode: PositionMode;
  legs: NewLeg[];
  now: number;
}): SetRecord {
  if (args.legs.length < 1 || args.legs.length > 9) throw new RangeError("a Set has 1 to 9 legs");
  const totalQty = args.legs.reduce((s, l) => s + l.qty, 0);
  if (!(totalQty > 0)) throw new RangeError("a Set needs a positive quantity");
  const order = (index: number, role: OrderRole): TrackedOrder => ({
    clientOrderId: setClientOrderId(args.id, index, role),
    orderId: null,
    state: "planned",
    fills: [],
    cancelRequested: false,
  });
  return {
    id: args.id,
    symbol: args.symbol,
    side: args.side,
    leverage: args.leverage,
    ticketUsd: args.ticketUsd,
    positionMode: args.positionMode,
    createdAt: args.now,
    status: "pending",
    closedAt: null,
    closeReason: null,
    needsAttention: null,
    legs: args.legs.map((l, i) => {
      const index = i + 1;
      return {
        index,
        strategyClientId: setStrategyClientId(args.id, index),
        strategyId: null,
        entryType: l.entryType,
        plannedQty: l.qty,
        plannedPrice: l.price,
        ticketShareUsd: (args.ticketUsd * l.qty) / totalQty,
        sent: "not-sent",
        entry: order(index, "entry"),
        takeProfit: { ...order(index, "takeProfit"), qty: l.qty, stopPrice: l.takeProfitPrice },
        stop: { ...order(index, "stop"), qty: l.qty, stopPrice: l.stopPrice },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

/** Cut float noise from sums of quantities (0.1 + 0.2). */
function clean(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}
export function filledQty(o: { fills: Fill[] }): number {
  return clean(o.fills.reduce((s, f) => s + f.qty, 0));
}
/** Quantity-weighted average fill price; 0 when nothing filled. */
export function averagePrice(o: { fills: Fill[] }): number {
  const q = o.fills.reduce((s, f) => s + f.qty, 0);
  return q > 0 ? o.fills.reduce((s, f) => s + f.qty * f.price, 0) / q : 0;
}
/** What this leg still holds on the exchange: entry filled minus both exits filled. */
export function legOpenQty(leg: SetLeg): number {
  return clean(filledQty(leg.entry) - filledQty(leg.takeProfit) - filledQty(leg.stop));
}
export function setOpenQty(set: SetRecord): number {
  return clean(set.legs.reduce((s, l) => s + legOpenQty(l), 0));
}
const FINAL: readonly OrderState[] = ["filled", "cancelled", "expired", "rejected"];
export function isFinal(o: TrackedOrder): boolean {
  return FINAL.includes(o.state);
}
/** Sets that still count on the exchange (or may soon): pending or open. */
export function activeSets(ledger: SetLedger, symbol?: string): SetRecord[] {
  return ledger.sets.filter((s) => (s.status === "pending" || s.status === "open") && (symbol === undefined || s.symbol === symbol));
}

// ---------------------------------------------------------------------------
// Order events
// ---------------------------------------------------------------------------

/**
 * One order event, normalised (src/exchange/aster.ts parseOrderTradeUpdate turns Aster's
 * user-data-stream ORDER_TRADE_UPDATE into this). lastFilled* describe THIS event's trade.
 */
export interface OrderUpdate {
  symbol: string;
  clientOrderId: string;
  orderId: string | null;
  /** Aster order status: NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, REJECTED, NEW_INSURANCE, NEW_ADL. */
  status: string;
  /** Aster execution type: NEW, TRADE, CANCELED, EXPIRED, CALCULATED (liquidation). */
  executionType: string;
  lastFilledQty: number;
  lastFilledPrice: number;
  commission: number;
  commissionAsset: string | null;
  /** Aster trade id; used to ignore a fill delivered twice. */
  tradeId: string | null;
  time: number;
}

/** Something the executor must do on the exchange. Never "place": the ledger only cancels or resizes. */
export type LedgerAction =
  | { kind: "cancel"; symbol: string; setId: string; legIndex: number; role: OrderRole; clientOrderId: string; orderId: string | null; reason: string }
  /** Recompute and resize the exits of every open Set on the symbol (after any fill there: merged liquidation moved). */
  | { kind: "syncExits"; symbol: string; reason: string };

export interface LedgerLog {
  level: "info" | "warn" | "error";
  setId?: string;
  message: string;
}

/** Result of every ledger step. */
export interface LedgerStep {
  ledger: SetLedger;
  actions: LedgerAction[];
  log: LedgerLog[];
  /** True when the event could have moved the position in a way the ledger cannot explain. */
  needsReconcile: boolean;
  /** Whether the event matched an order of a Set. */
  matched: boolean;
}

function mapState(status: string, prev: OrderState): OrderState {
  switch (status) {
    case "NEW":
      return prev === "planned" ? "working" : prev;
    case "PARTIALLY_FILLED":
      return "partially-filled";
    case "FILLED":
      return "filled";
    case "CANCELED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    case "REJECTED":
      return "rejected";
    default:
      return prev;
  }
}

/** Find the Set, leg and role of an order, by client order id first, then by Aster orderId. */
export function locateOrder(
  ledger: SetLedger,
  symbol: string,
  clientOrderId: string,
  orderId: string | null,
): { set: SetRecord; leg: SetLeg; role: OrderRole } | null {
  const p = parseSetClientOrderId(clientOrderId);
  if (p) {
    const set = ledger.sets.find((s) => s.id === p.setId);
    const leg = set?.legs.find((l) => l.index === p.legIndex);
    if (set && leg) return { set, leg, role: p.role };
  }
  if (orderId) {
    for (const set of ledger.sets) {
      if (set.symbol !== symbol) continue;
      for (const leg of set.legs) {
        for (const role of ["entry", "takeProfit", "stop"] as const) if (leg[role].orderId === orderId) return { set, leg, role };
      }
    }
  }
  return null;
}

/** Re-derive a Set's status from its legs (closed-outside and not-sent never change back). */
function refreshStatus(set: SetRecord, now: number): void {
  if (set.status === "closed-outside" || set.status === "not-sent" || set.status === "closed" || set.status === "never-filled") return;
  const anyFill = set.legs.some((l) => filledQty(l.entry) > 0);
  // A leg is done when nothing is open and its entry can no longer fill.
  const done = set.legs.every((l) => legOpenQty(l) <= 1e-12 && (isFinal(l.entry) || l.sent === "not-sent"));
  if (done) {
    set.status = anyFill ? "closed" : "never-filled";
    set.closedAt = now;
    set.closeReason = anyFill ? "closed by its own exits" : "entry ended with nothing filled";
  } else {
    set.status = anyFill ? "open" : "pending";
  }
}

/**
 * Apply one order event to the ledger.
 *  - Entry fill: record it, mark the Set open, ask for an exit re-sync (exits sized to the
 *    filled quantity; stops of every Set on the symbol re-capped).
 *  - Exit fill that closes the leg: cancel ONLY that leg's sibling exit and its unfilled
 *    entry remainder. Other Sets are not touched.
 *  - Exit cancelled or expired that we did not ask for while the leg is still open: loud
 *    error, needsAttention set (the Set has lost an exit on the exchange).
 *  - Orders not made by a Set: ignored, but a liquidation or a trade on a symbol with
 *    active Sets asks for a reconcile.
 * A fill already recorded (same tradeId) is ignored, so a replayed stream is harmless.
 */
export function applyOrderUpdate(ledger0: SetLedger, u: OrderUpdate, now: number): LedgerStep {
  const ledger = structuredClone(ledger0);
  const actions: LedgerAction[] = [];
  const log: LedgerLog[] = [];
  const found = locateOrder(ledger, u.symbol, u.clientOrderId, u.orderId);
  if (!found) {
    const liquidation = u.clientOrderId.startsWith("autoclose-") || u.clientOrderId === "adl_autoclose" || u.executionType === "CALCULATED";
    const touchesSets = activeSets(ledger, u.symbol).length > 0;
    if (liquidation && touchesSets) log.push({ level: "error", message: `${u.symbol}: the venue liquidated or auto-closed part of the position (${u.clientOrderId}); reconcile will mark the Sets` });
    const traded = u.executionType === "TRADE" || liquidation;
    return { ledger, actions, log, needsReconcile: touchesSets && traded, matched: false };
  }
  const { set, leg, role } = found;
  const order = leg[role];
  if (u.orderId && !order.orderId) order.orderId = u.orderId;
  if (leg.sent === "not-sent") leg.sent = "sent"; // the exchange knows it, whatever our send step thought

  let filled = false;
  if (u.executionType === "TRADE" && u.lastFilledQty > 0) {
    const tradeId = u.tradeId ?? `${u.orderId ?? u.clientOrderId}:${u.time}:${u.lastFilledQty}:${u.lastFilledPrice}`;
    if (order.fills.some((f) => f.tradeId === tradeId)) {
      log.push({ level: "info", setId: set.id, message: `duplicate fill ${tradeId} on ${order.clientOrderId} ignored` });
      return { ledger: ledger0, actions: [], log, needsReconcile: false, matched: true };
    }
    order.fills.push({
      tradeId,
      qty: u.lastFilledQty,
      price: u.lastFilledPrice,
      commission: Math.abs(u.commission || 0),
      commissionAsset: u.commissionAsset,
      time: u.time,
    });
    filled = true;
  }
  order.state = mapState(u.status, order.state);

  if (set.status === "closed-outside") {
    // Late events of a Set already given up: record, never act.
    log.push({ level: "warn", setId: set.id, message: `${order.clientOrderId} ${u.status} after the Set was closed outside; recorded only` });
    return { ledger, actions, log, needsReconcile: filled, matched: true };
  }

  if (role === "entry") {
    if (filled) {
      log.push({ level: "info", setId: set.id, message: `entry ${order.clientOrderId} filled ${u.lastFilledQty} @ ${u.lastFilledPrice} (leg ${leg.index} now ${filledQty(order)} of ${leg.plannedQty})` });
      actions.push({ kind: "syncExits", symbol: set.symbol, reason: `entry fill on ${set.id} leg ${leg.index}` });
    } else if (isFinal(order) && order.state !== "filled" && filledQty(order) > 0) {
      // Entry ended part-filled: exits must shrink to what was filled.
      actions.push({ kind: "syncExits", symbol: set.symbol, reason: `entry of ${set.id} leg ${leg.index} ended part-filled` });
    }
  } else {
    const sibling = role === "takeProfit" ? leg.stop : leg.takeProfit;
    const siblingRole: OrderRole = role === "takeProfit" ? "stop" : "takeProfit";
    if (filled) {
      log.push({ level: "info", setId: set.id, message: `${role} ${order.clientOrderId} filled ${u.lastFilledQty} @ ${u.lastFilledPrice}` });
      if (legOpenQty(leg) <= 1e-12) {
        // The leg is flat: cancel ONLY its own sibling and unfilled entry (decision 7).
        if (!isFinal(sibling) && !sibling.cancelRequested) {
          sibling.cancelRequested = true;
          actions.push({ kind: "cancel", symbol: set.symbol, setId: set.id, legIndex: leg.index, role: siblingRole, clientOrderId: sibling.clientOrderId, orderId: sibling.orderId, reason: `${role} filled` });
        }
        if (!isFinal(leg.entry) && !leg.entry.cancelRequested) {
          leg.entry.cancelRequested = true;
          actions.push({ kind: "cancel", symbol: set.symbol, setId: set.id, legIndex: leg.index, role: "entry", clientOrderId: leg.entry.clientOrderId, orderId: leg.entry.orderId, reason: `${role} closed the leg; the unfilled entry must not reopen it` });
        }
      } else {
        // A partial exit: the other exit shrinks to what is still open.
        actions.push({ kind: "syncExits", symbol: set.symbol, reason: `partial ${role} on ${set.id} leg ${leg.index}` });
      }
    } else if ((order.state === "cancelled" || order.state === "expired" || order.state === "rejected") && !order.cancelRequested) {
      const explained = sibling.state === "filled" || legOpenQty(leg) <= 1e-12 || (filledQty(leg.entry) === 0 && isFinal(leg.entry));
      if (!explained) {
        const msg = `${role} ${order.clientOrderId} was ${order.state} on the exchange while ${legOpenQty(leg)} is still open: this Set has lost an exit`;
        set.needsAttention = msg;
        log.push({ level: "error", setId: set.id, message: msg });
        return finish(ledger, set, now, actions, log, true);
      }
    }
  }
  return finish(ledger, set, now, actions, log, false);
}

function finish(ledger: SetLedger, set: SetRecord, now: number, actions: LedgerAction[], log: LedgerLog[], needsReconcile: boolean): LedgerStep {
  const before = set.status;
  refreshStatus(set, now);
  if (set.status !== before) log.push({ level: "info", setId: set.id, message: `Set ${set.id} ${before} -> ${set.status}` });
  return { ledger, actions, log, needsReconcile, matched: true };
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/** One position row of the exchange, as reconcile needs it (positionAmt: + long, - short). */
export interface ExchangePosition {
  positionSide: "BOTH" | "LONG" | "SHORT";
  positionAmt: number;
}

/**
 * What the exchange SHOULD show for a symbol: the sum of active Sets' open quantity.
 * one-way: { BOTH: Buy Sets minus Sell Sets }   hedge: { LONG: Buy Sets, SHORT: Sell Sets (positive) }
 */
export function expectedPositions(ledger: SetLedger, symbol: string, mode: PositionMode): Record<string, number> {
  const sets = setPositions(ledger, symbol, mode);
  const out = ledger.outside?.[symbol] ?? {};
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, clean(v + (out[k] ?? 0))]));
}

/** The Sets' own share of the position (without the user's outside position). */
export function setPositions(ledger: SetLedger, symbol: string, mode: PositionMode): Record<string, number> {
  const sets = activeSets(ledger, symbol);
  if (mode === "one-way") {
    return { BOTH: clean(sets.reduce((s, x) => s + (x.side === "buy" ? 1 : -1) * setOpenQty(x), 0)) };
  }
  return {
    LONG: clean(sets.filter((x) => x.side === "buy").reduce((s, x) => s + setOpenQty(x), 0)),
    SHORT: clean(sets.filter((x) => x.side === "sell").reduce((s, x) => s + setOpenQty(x), 0)),
  };
}

/**
 * Record the user's own position on a coin as the outside baseline. Only when no Set is
 * active on that coin (otherwise the exchange position mixes Sets and outside). Returns
 * the new ledger and the recorded baseline (zero keys dropped).
 */
export function recordOutside(ledger0: SetLedger, symbol: string, mode: PositionMode, rows: ExchangePosition[]): { ledger: SetLedger; outside: Record<string, number> } {
  const ledger = structuredClone(ledger0);
  if (activeSets(ledger, symbol).length > 0) return { ledger, outside: ledger.outside?.[symbol] ?? {} };
  const act = actualPositions(rows, mode);
  const outside = Object.fromEntries(Object.entries(act).filter(([, v]) => v !== 0));
  ledger.outside = { ...(ledger.outside ?? {}) };
  if (Object.keys(outside).length > 0) ledger.outside[symbol] = outside;
  else delete ledger.outside[symbol];
  return { ledger, outside };
}

/** What the exchange DOES show, in the same keys (hedge SHORT as a positive number). */
export function actualPositions(rows: ExchangePosition[], mode: PositionMode): Record<string, number> {
  if (mode === "one-way") return { BOTH: clean(rows.filter((r) => r.positionSide === "BOTH").reduce((s, r) => s + r.positionAmt, 0)) };
  return {
    LONG: clean(rows.filter((r) => r.positionSide === "LONG").reduce((s, r) => s + r.positionAmt, 0)),
    SHORT: clean(Math.abs(rows.filter((r) => r.positionSide === "SHORT").reduce((s, r) => s + r.positionAmt, 0))),
  };
}

/** Pure comparison (no state change): every key where expected and actual differ by more than half a step. */
export function comparePositions(
  ledger: SetLedger,
  symbol: string,
  mode: PositionMode,
  rows: ExchangePosition[],
  stepSize: number,
): Array<{ key: string; expected: number; actual: number }> {
  const exp = expectedPositions(ledger, symbol, mode);
  const act = actualPositions(rows, mode);
  return Object.keys(exp)
    .filter((k) => Math.abs((exp[k] ?? 0) - (act[k] ?? 0)) > stepSize / 2)
    .map((k) => ({ key: k, expected: exp[k] ?? 0, actual: act[k] ?? 0 }));
}

/**
 * Check the exchange against the ledger for one symbol (decision 6). Call it after each
 * fill event and on a timer (Blackboard's backend: every 30 to 60 s per symbol with
 * active Sets).
 * On a confirmed mismatch: every Set on that symbol (hedge: that side) that has filled
 * quantity becomes "closed-outside", all its unfinished orders are cancelled, and an
 * error line is logged. Pending Sets with nothing filled are left alone (they did not
 * cause it). No order is ever placed.
 */
export function reconcile(
  ledger0: SetLedger,
  args: { symbol: string; mode: PositionMode; positions: ExchangePosition[]; stepSize: number; now: number; graceMs?: number },
): LedgerStep & { mismatches: Array<{ key: string; expected: number; actual: number }> } {
  const ledger = structuredClone(ledger0);
  const graceMs = args.graceMs ?? 5_000;
  const actions: LedgerAction[] = [];
  const log: LedgerLog[] = [];
  const confirmed: Array<{ key: string; expected: number; actual: number }> = [];
  const diffs = comparePositions(ledger, args.symbol, args.mode, args.positions, args.stepSize);
  const diffKeys = new Set(diffs.map((d) => d.key));
  // A mismatch that went away clears its suspicion.
  for (const k of ["BOTH", "LONG", "SHORT"]) if (!diffKeys.has(k)) delete ledger.suspects[`${args.symbol}:${k}`];

  for (const d of diffs) {
    const sk = `${args.symbol}:${d.key}`;
    const prev = ledger.suspects[sk];
    const same = prev && Math.abs(prev.expected - d.expected) <= args.stepSize / 2 && Math.abs(prev.actual - d.actual) <= args.stepSize / 2;
    if (graceMs > 0 && (!same || args.now - (prev as SuspectedMismatch).firstSeenAt < graceMs)) {
      if (!same) ledger.suspects[sk] = { firstSeenAt: args.now, expected: d.expected, actual: d.actual };
      log.push({ level: "warn", message: `${sk}: exchange shows ${d.actual}, Sets add up to ${d.expected}; checking again before acting` });
      continue;
    }
    delete ledger.suspects[sk];
    // The Sets' part is still all there and only the user's own part changed (he cut or
    // added to his own trade in the app): move the outside baseline, keep the Sets.
    const setsPart = setPositions(ledger, args.symbol, args.mode)[d.key] ?? 0;
    const covered = setsPart !== 0 && Math.sign(d.actual) === Math.sign(setsPart) && Math.abs(d.actual) >= Math.abs(setsPart) - args.stepSize / 2;
    if (covered) {
      const rest = clean(d.actual - setsPart);
      ledger.outside = { ...(ledger.outside ?? {}), [args.symbol]: { ...(ledger.outside?.[args.symbol] ?? {}), [d.key]: rest } };
      if (rest === 0) delete (ledger.outside[args.symbol] as Record<string, number>)[d.key];
      log.push({ level: "warn", message: `${sk}: your own position changed outside the Sets (now ${rest}); the Sets' ${setsPart} is intact and keeps its exits` });
      continue;
    }
    confirmed.push(d);
    const affected = activeSets(ledger, args.symbol).filter(
      (s) => filledQty({ fills: s.legs.flatMap((l) => l.entry.fills) }) > 0 && (d.key === "BOTH" || (d.key === "LONG") === (s.side === "buy")),
    );
    log.push({
      level: "error",
      message: `${sk}: MISMATCH confirmed. Exchange ${d.actual}, Sets ${d.expected}. ${affected.length} Set(s) marked closed outside the Set; their orders are cancelled; nothing is placed.`,
    });
    for (const set of affected) {
      set.status = "closed-outside";
      set.closedAt = args.now;
      set.closeReason = `exchange position ${d.actual} did not match the Sets' ${d.expected} (closed or changed outside the Set)`;
      for (const leg of set.legs) {
        for (const role of ["takeProfit", "stop", "entry"] as const) {
          const o = leg[role];
          if (isFinal(o) || o.cancelRequested) continue;
          o.cancelRequested = true;
          actions.push({ kind: "cancel", symbol: set.symbol, setId: set.id, legIndex: leg.index, role, clientOrderId: o.clientOrderId, orderId: o.orderId, reason: "closed outside the Set" });
        }
      }
      log.push({ level: "error", setId: set.id, message: `Set ${set.id} (${set.side} ${setOpenQty(set)} ${set.symbol}) closed outside the Set` });
    }
  }
  return { ledger, actions, log, needsReconcile: false, matched: true, mismatches: confirmed };
}

// ---------------------------------------------------------------------------
// Exits: sizes and the per-Set stop
// ---------------------------------------------------------------------------

/** A position row with what the stop cap needs. */
export interface ExchangePositionRisk extends ExchangePosition {
  entryPrice: number;
  liquidationPrice: number;
}

/**
 * The cap source for one Set's stop (core/stop.ts StopCap):
 *  - the account's real position on the Set's side, when there is one with a usable
 *    liquidation price on the right side of its entry;
 *  - otherwise the pre-fill estimate at max(Set leverage, symbol leverage).
 * In one-way mode a net position on the OTHER side (a bigger Sell Set against this Buy
 * Set) says nothing about this Set's downside, so the estimate is used.
 */
export function stopCapFor(
  set: Pick<SetRecord, "side" | "leverage" | "positionMode">,
  rows: ExchangePositionRisk[],
  opts: { symbolLeverage: number | null; maintenanceMarginRate: number },
): StopCap {
  const wantSide = set.positionMode === "hedge" ? (set.side === "buy" ? "LONG" : "SHORT") : "BOTH";
  const row = rows.find((r) => r.positionSide === wantSide && r.positionAmt !== 0);
  const sameDirection = row && (set.side === "buy" ? row.positionAmt > 0 : row.positionAmt < 0);
  if (row && sameDirection && row.liquidationPrice > 0 && row.entryPrice > 0) {
    const rightSide = set.side === "buy" ? row.liquidationPrice < row.entryPrice : row.liquidationPrice > row.entryPrice;
    if (rightSide) return { source: "position", entryPrice: row.entryPrice, liquidationPrice: row.liquidationPrice };
  }
  return { source: "estimate", leverage: Math.max(set.leverage, opts.symbolLeverage ?? 0), maintenanceMarginRate: opts.maintenanceMarginRate };
}

/**
 * What one leg's exits SHOULD be now:
 *   take-profit qty = its own fills + what is still open
 *   stop qty        = its own fills + what is still open
 *   stop price      = setStopPrice from the leg's average entry, its planned qty and ticket
 *                     share (same distance as the filled part with its share), capped.
 * null when the leg holds nothing (nothing to protect).
 */
export function desiredExits(leg: SetLeg, side: Side, cap: StopCap, tickSize: number): { takeProfitQty: number; stopQty: number; stop: SetStop } | null {
  const open = legOpenQty(leg);
  if (!(open > 1e-12)) return null;
  const stop = setStopPrice({ side, entry: averagePrice(leg.entry), qty: leg.plannedQty, ticketUsd: leg.ticketShareUsd, tickSize, cap });
  return {
    takeProfitQty: clean(filledQty(leg.takeProfit) + open),
    stopQty: clean(filledQty(leg.stop) + open),
    stop,
  };
}

// ---------------------------------------------------------------------------
// Leverage and margin
// ---------------------------------------------------------------------------

/**
 * The symbol leverage to use before placing a Set (decision 4).
 *   target = max(leverage of every active Set on the symbol, this Set's leverage)
 *   never below the current symbol leverage while Sets are active there.
 * With no active Sets the symbol is set to this Set's leverage.
 * change: false when the symbol already stands at the target (no call needed).
 */
export function symbolLeverageTarget(args: { ledger: SetLedger; symbol: string; newLeverage: number; currentLeverage: number | null }): {
  target: number;
  change: boolean;
  reason: string;
} {
  const open = activeSets(args.ledger, args.symbol);
  if (open.length === 0) {
    return {
      target: args.newLeverage,
      change: args.currentLeverage !== args.newLeverage,
      reason: `no open Sets on ${args.symbol}: the symbol follows this Set's ${args.newLeverage}x`,
    };
  }
  const highest = Math.max(args.newLeverage, ...open.map((s) => s.leverage));
  const target = Math.max(highest, args.currentLeverage ?? 0); // never lower while Sets are open
  return {
    target,
    change: args.currentLeverage !== target,
    reason: `${open.length} open Set(s) on ${args.symbol}: highest Set leverage ${highest}x, symbol now ${args.currentLeverage ?? "unknown"}x, never lowered while Sets are open`,
  };
}

/**
 * Can the account carry one more Set? (decision 5)
 *  - free balance (Aster availableBalance) must be at least this Set's ticket;
 *  - wallet balance must be at least every active Set's ticket plus this one.
 * The message is plain, for the card.
 */
export function checkMarginForSet(args: { ledger: SetLedger; ticketUsd: number; availableBalanceUsd: number; walletBalanceUsd: number }): { ok: true } | { ok: false; message: string } {
  const openTickets = activeSets(args.ledger).reduce((s, x) => s + x.ticketUsd, 0);
  if (!(args.availableBalanceUsd >= args.ticketUsd)) {
    return { ok: false, message: `Not enough free balance for this Set: it needs $${args.ticketUsd}, and $${round2(args.availableBalanceUsd)} is free. Close a Set or add funds.` };
  }
  if (!(args.walletBalanceUsd >= openTickets + args.ticketUsd)) {
    return {
      ok: false,
      message: `Your balance of $${round2(args.walletBalanceUsd)} does not cover your open Sets ($${round2(openTickets)}) plus this one ($${args.ticketUsd}). Close a Set or add funds.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Profit, from the Set's own fills (decision 8)
// ---------------------------------------------------------------------------

export interface SetPnl {
  setId: string;
  status: SetStatus;
  /** Quantity closed by the Set's own exits. */
  closedQty: number;
  openQty: number;
  /** The Set's own average entry (all legs) and average exit. 0 when none. */
  entryAveragePrice: number;
  exitAveragePrice: number;
  /** Closed quantity x (exit - entry) in the Set's direction. USD. */
  grossPnlUsd: number;
  /** Trading fees of the Set's own fills (USDT commissions only). USD, positive = paid. */
  commissionUsd: number;
  /** False when some fill paid its fee in another asset (net then equals gross). */
  commissionComplete: boolean;
  /** gross - commission. USD. */
  netPnlUsd: number;
  /** True only for a Set closed by its own exits: the only case a profit share is due. */
  final: boolean;
  /** The 5% + 5% split of the NET profit on a win; all zero for a loss or a non-final Set. */
  profitShare: FeeSplit;
  note: string;
}

/**
 * Profit of one Set from its own entry and exit fills.
 * Why not Aster's realizedPnl: with merged positions it is measured against the merged
 * average entry, so it moves profit between Sets (test "per-Set PnL with merged positions").
 * The profit share is taken on the NET result (after the Set's own trading fees), so a
 * Set that won less than its fees pays nothing (README: a losing Set pays nothing).
 */
export function setPnl(set: SetRecord): SetPnl {
  const sign = set.side === "buy" ? 1 : -1;
  let gross = 0;
  let closedQty = 0;
  let commission = 0;
  let complete = true;
  const entryFills: Fill[] = [];
  const exitFills: Fill[] = [];
  for (const leg of set.legs) {
    const exits = [...leg.takeProfit.fills, ...leg.stop.fills];
    const q = exits.reduce((s, f) => s + f.qty, 0);
    const legEntry = averagePrice(leg.entry);
    gross += sign * (exits.reduce((s, f) => s + f.qty * f.price, 0) - q * legEntry);
    closedQty += q;
    entryFills.push(...leg.entry.fills);
    exitFills.push(...exits);
  }
  for (const f of [...entryFills, ...exitFills]) {
    if (f.commission === 0) continue;
    if (f.commissionAsset === null || f.commissionAsset === "USDT") commission += f.commission;
    else complete = false;
  }
  const grossPnlUsd = round2(gross);
  const netPnlUsd = round2(gross - commission);
  const final = set.status === "closed";
  let note: string;
  if (final) note = "closed by its own exits";
  else if (set.status === "closed-outside") note = "closed outside the Set: the close did not go through the Set's own orders, so no profit share is computed";
  else note = `not closed yet (${set.status})`;
  return {
    setId: set.id,
    status: set.status,
    closedQty: clean(closedQty),
    openQty: setOpenQty(set),
    entryAveragePrice: averagePrice({ fills: entryFills }),
    exitAveragePrice: averagePrice({ fills: exitFills }),
    grossPnlUsd,
    commissionUsd: round2(commission),
    commissionComplete: complete,
    netPnlUsd: complete ? netPnlUsd : grossPnlUsd,
    final,
    profitShare: splitFees(final ? (complete ? netPnlUsd : grossPnlUsd) : 0),
    note,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
