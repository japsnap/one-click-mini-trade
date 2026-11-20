/**
 * Turn a SetPlan into Aster orders and keep many Sets per account apart (live mode only
 * sends anything).
 *
 * Each entry goes out with its own take-profit AND its own stop as one OTOCO strategy
 * order ("One Triggers, One Cancels the Other", POST /fapi/v3/placeStrategyOrder,
 * exactly 3 legs):
 *   leg 1  entry (MARKET or LIMIT GTC)
 *   leg 2  take-profit, TAKE_PROFIT_MARKET, placed once leg 1 is (partly) filled;
 *          cancelled by the exchange if leg 3 fills
 *   leg 3  stop, STOP_MARKET, placed once leg 1 is (partly) filled; cancelled if leg 2 fills
 * Both exits trigger on the MARK price (Aster liquidates on the mark price too).
 *
 * MANY SETS, ONE PER COIN (2026-11-16, never-merge ruling 2026-11-20; design in src/core/ledger.ts):
 *  - A new Set is refused when its coin already holds any position or a live Set
 *    (preTradeCheck), so a Set's position never merges with another.
 *  - Every order carries a client order id `<setId>-<leg><E|T|S>`; each OTOCO carries
 *    `<setId>-<leg>`. The ledger records each Set's own fills.
 *  - The account's position mode and margin type are READ, never changed (Blackboard's
 *    own app owns them). One-way mode: exits are plain opposite-side orders of the Set's
 *    quantity; reduce-only when the reduceOnlyExits option is on (the server's default since the live proof
 *    live). Hedge mode: positionSide LONG / SHORT per Set direction (reduceOnly is not allowed).
 *  - Exits are sized to the Set's FILLED quantity: the OTOCO places them at the planned
 *    quantity on the first fill, and syncSetExits resizes them (updateStrategyOrder) after
 *    every fill event, and moves each stop to the Set's own stop (85% of its ticket,
 *    capped at 85% of the real liquidation distance of the account's position).
 *  - The symbol leverage is raised to the highest open Set's leverage, never lowered
 *    while Sets are open; a Set is refused when the balance cannot carry its ticket.
 *  - reconcileSymbol compares the exchange position with the Sets and, on a confirmed
 *    mismatch, cancels the affected Sets' orders and marks them "closed outside the Set".
 *    Nothing here ever places an order to fix a mismatch.
 *
 * WHO CALLS WHAT (Blackboard's backend):
 *   executeLive        when the user taps Enter
 *   handleOrderUpdate  for every ORDER_TRADE_UPDATE from Aster's user data stream
 *   reconcileSymbol    after handleOrderUpdate says needsReconcile, and on a timer
 *                      (every 30 to 60 s for each symbol with open Sets)
 * All three run under one lock per ledger store, so two of them never interleave.
 *
 * The leg wiring below was proven live on 2026-11-19 (one $10 ETH Set, README "Open items").
 */
import type { SetPlan } from "../src/core/plan";
import { withSymbolLeverage } from "../src/core/plan";
import type { SymbolRules } from "../src/core/types";
import { activeRules } from "../src/rules/rules";
import { checkCoinIsFree, checkNewSetRisk, parseAccountRisk, type RiskVerdict } from "../src/core/risk";
import { formatToStep, isOnStep } from "../src/core/rounding";
import { cleanRatio, remeasureAfterFill } from "../src/core/takeProfit";
import {
  activeSets,
  applyOrderUpdate,
  averagePrice,
  checkMarginForSet,
  createSetRecord,
  desiredExits,
  emptyLedger,
  legOpenQty,
  newSetId,
  reconcile,
  setClientOrderId,
  setPnl,
  setStrategyClientId,
  stopCapFor,
  symbolLeverageTarget,
  type LedgerAction,
  type LedgerLog,
  type OrderUpdate,
  type PositionMode,
  type SetLedger,
  type SetLeg,
  type SetRecord,
} from "../src/core/ledger";
import {
  AsterApiError,
  parsePositionRows,
  parseUsdtBalance,
  symbolLeverageFromRows,
  type AsterClient,
  type PositionRow,
  type StrategySubOrder,
  type StrategySubOrderUpdate,
} from "../src/exchange/aster";

/** One entry with its two exits, ready to sign as one OTOCO. */
export interface SetLegs {
  entry: StrategySubOrder;
  takeProfit: StrategySubOrder;
  stop: StrategySubOrder;
}

/**
 * Pure conversion from plan to the exact strategy legs Aster expects.
 * Why separate from sending: the trial mode shows these legs, and tests check them.
 * hedgeMode: the account's position mode (read with isHedgeMode, never changed).
 * setId: when given, every leg carries its Set client order id (live Sets always pass one).
 * opts.reduceOnlyExits: one-way mode only, marks both exits reduceOnly "true" (the V3 doc
 * lists reduceOnly on strategy sub-orders; proven live 2026-11-19; on unless the server's
 * ASTER_EXIT_REDUCE_ONLY is "true").
 */
export function planToSetLegs(plan: SetPlan, rules: SymbolRules, hedgeMode: boolean, setId?: string, opts: { reduceOnlyExits?: boolean } = {}): SetLegs[] {
  const openSide: "BUY" | "SELL" = plan.input.side === "buy" ? "BUY" : "SELL";
  const closeSide: "BUY" | "SELL" = plan.input.side === "buy" ? "SELL" : "BUY";
  const positionSide: "LONG" | "SHORT" | undefined = hedgeMode ? (plan.input.side === "buy" ? "LONG" : "SHORT") : undefined;
  const out: SetLegs[] = [];
  plan.orders.entries.forEach((e, i) => {
    const tp = plan.orders.takeProfits[i];
    const sl = plan.orders.stops[i];
    if (!tp) throw new Error(`plan has no take-profit for entry ${i + 1}`);
    if (!sl) throw new Error(`plan has no stop for entry ${i + 1}`);
    const qtyStep = e.type === "MARKET" ? rules.marketStepSize : rules.stepSize;
    // Last safety checks before signing: values on the exchange grid, exits on the right sides.
    if (!isOnStep(e.qty, qtyStep)) throw new Error(`entry ${i + 1} quantity ${e.qty} is off the step ${qtyStep}`);
    if (e.price !== null && !isOnStep(e.price, rules.tickSize)) throw new Error(`entry ${i + 1} price ${e.price} is off the tick ${rules.tickSize}`);
    if (!isOnStep(tp.stopPrice, rules.tickSize)) throw new Error(`take-profit ${i + 1} price is off the tick`);
    if (!isOnStep(sl.stopPrice, rules.tickSize)) throw new Error(`stop ${i + 1} price is off the tick`);
    const ref = e.price ?? plan.entry.expectedFillPrice;
    const isLong = plan.input.side === "buy";
    if (isLong ? !(sl.stopPrice < ref && tp.stopPrice > ref) : !(sl.stopPrice > ref && tp.stopPrice < ref)) {
      throw new Error(`leg ${i + 1}: stop ${sl.stopPrice} and take-profit ${tp.stopPrice} are not on opposite sides of entry ${ref}`);
    }
    if (isLong ? !(sl.stopPrice > plan.liquidationPrice) : !(sl.stopPrice < plan.liquidationPrice)) {
      // Draw legs each carry their own stop, so only the single-entry modes are held to the plan's liquidation.
      if (plan.orders.entries.length === 1) throw new Error(`stop ${sl.stopPrice} is beyond the liquidation estimate ${plan.liquidationPrice}`);
    }
    const ids = setId
      ? { e: setClientOrderId(setId, i + 1, "entry"), t: setClientOrderId(setId, i + 1, "takeProfit"), s: setClientOrderId(setId, i + 1, "stop") }
      : null;

    const entry: StrategySubOrder = {
      strategySubId: "1",
      // Aster's gateway refuses an OTOCO whose first leg lacks firstDrivenId or
      // secondDrivenId (code -1102, live 2026-11-19), although the doc lists both as
      // optional; "0" means "driven by nothing", the value its own query answer shows
      // for a root sub-order.
      firstDrivenId: "0",
      secondDrivenId: "0",
      securityType: "USDT_FUTURES",
      symbol: rules.symbol,
      side: openSide,
      type: e.type,
      quantity: formatToStep(e.qty, qtyStep),
      ...(positionSide ? { positionSide } : {}),
      ...(e.type === "LIMIT" && e.price !== null ? { price: formatToStep(e.price, rules.tickSize), timeInForce: "GTC" as const } : {}),
      ...(ids ? { clientOrderId: ids.e } : {}),
    };
    // Shared fields of the two exits.
    //  one-way: plain opposite orders of the Set's quantity (decision 2 in src/core/ledger.ts);
    //           reduce-only when switched on, so a hand-closed position cannot be reopened by an exit.
    //  hedge:   positionSide closes the Set's side (reduceOnly is not allowed there).
    const exitBase = {
      securityType: "USDT_FUTURES" as const,
      symbol: rules.symbol,
      side: closeSide,
      workingType: "MARK_PRICE" as const,
      ...(positionSide ? { positionSide } : {}),
      ...(!positionSide && opts.reduceOnlyExits ? { reduceOnly: "true" as const } : {}),
      // Placed by leg 1 as soon as the entry is partly or fully filled; resized to the
      // filled quantity by syncSetExits.
      firstDrivenId: "1",
      firstDrivenOn: "PARTIALLY_FILLED_OR_FILLED" as const,
      firstTrigger: "PLACE_ORDER" as const,
      secondDrivenOn: "FILLED" as const,
      secondTrigger: "CANCEL_ORDER" as const,
    };
    const takeProfit: StrategySubOrder = {
      ...exitBase,
      strategySubId: "2",
      type: "TAKE_PROFIT_MARKET",
      quantity: formatToStep(tp.qty, rules.stepSize),
      stopPrice: formatToStep(tp.stopPrice, rules.tickSize),
      secondDrivenId: "3", // the stop filling cancels the take-profit
      ...(ids ? { clientOrderId: ids.t } : {}),
    };
    const stop: StrategySubOrder = {
      ...exitBase,
      strategySubId: "3",
      type: "STOP_MARKET",
      quantity: formatToStep(sl.qty, rules.stepSize),
      stopPrice: formatToStep(sl.stopPrice, rules.tickSize),
      secondDrivenId: "2", // the take-profit filling cancels the stop
      ...(ids ? { clientOrderId: ids.s } : {}),
    };
    out.push({ entry, takeProfit, stop });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Ledger storage and the per-account lock
// ---------------------------------------------------------------------------

/**
 * Where one account's ledger lives. Blackboard: a row per account in its own database.
 * The demo server keeps logs/set-ledger.json. Tests use memoryLedgerStore.
 */
export interface LedgerStore {
  load(): Promise<SetLedger>;
  save(ledger: SetLedger): Promise<void>;
}

export function memoryLedgerStore(initial: SetLedger = emptyLedger()): LedgerStore & { current(): SetLedger } {
  let l = structuredClone(initial);
  return {
    load: async () => structuredClone(l),
    save: async (x) => {
      l = structuredClone(x);
    },
    current: () => structuredClone(l),
  };
}

const locks = new WeakMap<LedgerStore, Promise<unknown>>();
/**
 * Run fn alone for this ledger store: placements, order events and reconciles of one
 * account never interleave (two Enters at once would otherwise both read the leverage,
 * or a reconcile could read the ledger between a fill and its save).
 */
export function withLedgerLock<T>(store: LedgerStore, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(store) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(store, run.catch(() => undefined));
  return run;
}

// ---------------------------------------------------------------------------
// Placing a Set
// ---------------------------------------------------------------------------

export type PlaceResult =
  | { ok: true; setId: string; legs: SetLegs[]; sent: unknown[]; leverage: { target: number; changed: boolean; reason: string }; warnings: string[]; risk: RiskVerdict; log: LedgerLog[] }
  | { ok: false; refused: true; message: string; risk?: RiskVerdict; log: LedgerLog[] }
  | { ok: false; refused: false; setId: string; sent: unknown[]; failedAt: number; error: string; legs: SetLegs[]; log: LedgerLog[] };

/**
 * Send a plan live as a new Set.
 *  1. Read the position mode (never change it) and the symbol's position rows.
 *  2. Refuse when the coin already holds any position or a live Set (never merge), when
 *     the balance cannot carry the ticket, or when the cross-margin cushion rules fail
 *     (preTradeCheck).
 *  3. Set the symbol leverage to this Set's (symbolLeverageTarget; with no other Set on the
 *     coin it simply follows the Set) and pull the stops in if it stands higher (withSymbolLeverage).
 *  5. Save the Set record, then send one OTOCO per leg, saving after each.
 * Stops at the first send failure and reports what was already sent; nothing is retried
 * blindly (after an unknown answer the order may exist: its fills are still matched by id).
 */
export async function executeLive(
  client: AsterClient,
  plan: SetPlan,
  rules: SymbolRules,
  opts: { store: LedgerStore; now?: () => number; random?: () => number; setId?: string; reduceOnlyExits?: boolean },
): Promise<PlaceResult> {
  return withLedgerLock(opts.store, async () => {
    const now = opts.now ?? Date.now;
    const log: LedgerLog[] = [];
    const symbol = rules.symbol;
    const hedge = await client.isHedgeMode();
    const mode: PositionMode = hedge ? "hedge" : "one-way";
    const rows = parsePositionRows(await client.positionRisk(symbol), symbol);
    let ledger = await opts.store.load();

    const check = await preTradeCheck(client, plan, rules, { ledger, mode, rows });
    if (!check.ok) return { ok: false, refused: true, message: check.message, ...(check.risk ? { risk: check.risk } : {}), log };
    ledger = check.ledger;
    const risk = check.risk;

    const lev = symbolLeverageTarget({ ledger, symbol, newLeverage: plan.input.leverage, currentLeverage: symbolLeverageFromRows(rows) });
    if (lev.change) await client.changeLeverage(symbol, lev.target);
    log.push({ level: "info", message: `leverage ${symbol}: ${lev.change ? `set to ${lev.target}x` : `kept at ${lev.target}x`} (${lev.reason})` });
    const placed = withSymbolLeverage(plan, rules, lev.target);

    const setId = opts.setId ?? newSetId(now(), opts.random ?? Math.random);
    const legs = planToSetLegs(placed, rules, hedge, setId, { reduceOnlyExits: opts.reduceOnlyExits });
    const record = createSetRecord({
      id: setId,
      symbol,
      side: plan.input.side,
      leverage: plan.input.leverage,
      ticketUsd: plan.input.ticketUsd,
      positionMode: mode,
      now: now(),
      legs: placed.orders.entries.map((e, i) => ({
        entryType: e.type,
        qty: e.qty,
        price: e.price,
        takeProfitPrice: (placed.orders.takeProfits[i] as { stopPrice: number }).stopPrice,
        stopPrice: (placed.orders.stops[i] as { stopPrice: number }).stopPrice,
      })),
      target: placed.takeProfit.basis ? { reason: placed.takeProfit.reason, planRatio: placed.takeProfit.ratio, basis: placed.takeProfit.basis } : null,
    });
    ledger.sets.push(record);
    await opts.store.save(ledger); // saved BEFORE sending: no untracked order after a crash

    const sent: unknown[] = [];
    for (const [i, l] of legs.entries()) {
      const leg = record.legs[i] as SetLeg;
      try {
        const answer = (await client.placeOtoco(l.entry, l.takeProfit, l.stop, setStrategyClientId(setId, i + 1))) as Record<string, unknown>;
        sent.push(answer);
        leg.sent = "sent";
        leg.strategyId = answer?.strategyId !== undefined && answer?.strategyId !== null ? String(answer.strategyId) : null;
        leg.entry.state = "working";
        if (!leg.strategyId) log.push({ level: "error", setId, message: `leg ${i + 1}: placement answer has no strategyId; exits cannot be resized until linkSetOrders finds it` });
      } catch (e) {
        leg.sent = "send-failed";
        record.needsAttention = `leg ${i + 1} failed to send: ${(e as Error).message}. Check open orders before trying again.`;
        if (i === 0) record.status = "not-sent";
        ledger = replaceSet(ledger, record);
        await opts.store.save(ledger);
        log.push({ level: "error", setId, message: record.needsAttention });
        return { ok: false, refused: false, setId, sent, failedAt: i + 1, error: (e as Error).message, legs, log };
      }
      ledger = replaceSet(ledger, record);
      await opts.store.save(ledger);
    }
    return { ok: true, setId, legs, sent, leverage: { target: lev.target, changed: lev.change, reason: lev.reason }, warnings: risk.warnings, risk, log };
  });
}

/**
 * Every check a new Set must pass before anything is sent (read-only: it only reads the
 * account). Used by executeLive and by the live preview, so the card can show the same
 * refusal or warnings before the tap.
 *  1. Never merge (owner's ruling 2026-11-20): the coin holds no position on any side (the
 *     user's own or a Set's) and no live Set in the ledger (core/risk.ts checkCoinIsFree).
 *  2. Margin: free balance carries the ticket; account equity carries every open ticket
 *     plus this one (checkMarginForSet). Equity comes from the account endpoint because
 *     Blackboard accounts run multi-asset margin, where the USDT wallet alone is small.
 *  3. Liquidation and stops (core/risk.ts): refused when any other coin's liquidation moves
 *     more than the "risk.liquidationShrinkBlock" rule closer (cross margin links coins), or
 *     the new Set's stop would sit past the stop rule's share of the way to its liquidation.
 */
export async function preTradeCheck(
  client: AsterClient,
  plan: SetPlan,
  rules: SymbolRules,
  ctx: { ledger: SetLedger; mode: PositionMode; rows: PositionRow[] },
): Promise<{ ok: true; ledger: SetLedger; risk: RiskVerdict } | { ok: false; message: string; risk?: RiskVerdict }> {
  const symbol = rules.symbol;
  const ledger = ctx.ledger;
  const free = checkCoinIsFree({ symbol, positionAmts: ctx.rows.map((r) => r.positionAmt), liveSetIds: activeSets(ledger, symbol).map((s) => s.id) });
  if (!free.ok) return { ok: false, message: free.message };
  const account = parseAccountRisk(await client.account());
  const margin = checkMarginForSet({ ledger, ticketUsd: plan.input.ticketUsd, availableBalanceUsd: account.availableBalanceUsd, walletBalanceUsd: account.equityUsd });
  if (!margin.ok) return { ok: false, message: margin.message };
  const qty = plan.orders.entries.reduce((s, e) => s + e.qty, 0);
  const price = plan.orders.entries.reduce((s, e) => s + e.qty * (e.price ?? plan.entry.expectedFillPrice), 0) / qty;
  const risk = checkNewSetRisk(
    account,
    { symbol, side: plan.input.side, qty, price, stopPrice: plan.stop.price, maintenanceMarginRate: plan.stop.maintenanceMarginRate ?? activeRules().risk.assumedMaintenanceRate, positionMode: ctx.mode },
    [],
  );
  if (!risk.ok) return { ok: false, message: risk.reasons.join(" "), risk };
  return { ok: true, ledger, risk };
}

function replaceSet(ledger: SetLedger, set: SetRecord): SetLedger {
  return { ...ledger, sets: ledger.sets.map((s) => (s.id === set.id ? structuredClone(set) : s)) };
}

// ---------------------------------------------------------------------------
// Order events
// ---------------------------------------------------------------------------

/**
 * Apply one order event (parseOrderTradeUpdate of Aster's ORDER_TRADE_UPDATE) and do what
 * it requires: cancel that Set's sibling exit (and unfilled entry) when an exit fills, then
 * resize and re-cap the exits of every open Set on the symbol after any fill there.
 * Returns needsReconcile: the caller then runs reconcileSymbol.
 */
export async function handleOrderUpdate(
  client: AsterClient,
  update: OrderUpdate,
  rules: SymbolRules,
  opts: {
    store: LedgerStore;
    now?: () => number;
    maintenanceMarginRate?: number;
    /**
     * After a fill, re-place the take-profit when the re-measure (A7) finds a better level.
     * Default false: updateStrategyOrder is unproven live, so the target is kept and the
     * better level only logged ("kept, update unproven").
     */
    replaceTakeProfitAfterFill?: boolean;
  },
): Promise<{ log: LedgerLog[]; actions: LedgerAction[]; needsReconcile: boolean; matched: boolean }> {
  return withLedgerLock(opts.store, async () => {
    const now = opts.now ?? Date.now;
    let ledger = await opts.store.load();
    let step = applyOrderUpdate(ledger, update, now());
    if (!step.matched && update.orderId && activeSets(ledger, update.symbol).length > 0) {
      // Aster may not echo our sub-order client ids: learn the orderIds, then try once more.
      const linked = await linkSetOrders(client, ledger, update.symbol);
      ledger = linked.ledger;
      step = applyOrderUpdate(ledger, update, now());
      step.log.unshift(...linked.log);
    }
    ledger = step.ledger;
    const log = [...step.log];
    ledger = await performCancels(client, ledger, step.actions, log);
    if (step.actions.some((a) => a.kind === "syncExits")) {
      ledger = await syncSetExits(client, ledger, rules, log, { maintenanceMarginRate: opts.maintenanceMarginRate });
      ledger = await remeasureTargets(client, ledger, rules, log, { replaceTakeProfit: opts.replaceTakeProfitAfterFill === true });
    }
    await opts.store.save(ledger);
    return { log, actions: step.actions, needsReconcile: step.needsReconcile, matched: step.matched };
  });
}

/**
 * Check one symbol: exchange position vs the open Sets (src/core/ledger.ts reconcile), cancel
 * what a confirmed mismatch requires, then (refreshStops, default true) re-cap the stops of
 * the Sets still open, because the merged position's liquidation moves when others change.
 * Uses the position mode recorded on the open Sets: no extra mode call.
 */
export async function reconcileSymbol(
  client: AsterClient,
  rules: SymbolRules,
  opts: { store: LedgerStore; now?: () => number; graceMs?: number; refreshStops?: boolean; maintenanceMarginRate?: number },
): Promise<{ log: LedgerLog[]; mismatches: Array<{ key: string; expected: number; actual: number }>; cancelled: number }> {
  return withLedgerLock(opts.store, async () => {
    const now = opts.now ?? Date.now;
    let ledger = await opts.store.load();
    const open = activeSets(ledger, rules.symbol);
    if (open.length === 0) return { log: [{ level: "info", message: `${rules.symbol}: no open Sets, nothing to reconcile` }], mismatches: [], cancelled: 0 };
    const mode = (open[0] as SetRecord).positionMode;
    const rows = parsePositionRows(await client.positionRisk(rules.symbol), rules.symbol);
    const step = reconcile(ledger, { symbol: rules.symbol, mode, positions: rows, stepSize: rules.stepSize, now: now(), graceMs: opts.graceMs });
    ledger = step.ledger;
    const log = [...step.log];
    ledger = await performCancels(client, ledger, step.actions, log);
    if (opts.refreshStops !== false) {
      ledger = await syncSetExits(client, ledger, rules, log, { rows, maintenanceMarginRate: opts.maintenanceMarginRate });
      ledger = await remeasureTargets(client, ledger, rules, log); // log only: the re-place belongs to handleOrderUpdate
    }
    await opts.store.save(ledger);
    const cancels = step.actions.filter((a) => a.kind === "cancel").length;
    log.push({ level: step.mismatches.length ? "error" : "info", message: `[counts] reconcile ${rules.symbol}: open Sets ${open.length}, mismatches ${step.mismatches.length}, cancels ${cancels}` });
    return { log, mismatches: step.mismatches, cancelled: cancels };
  });
}

/** Cancel orders by our client id. "Unknown order" (-2011, -2013) means already gone: logged, not an error. A failed cancel flags the Set. */
export async function performCancels(client: AsterClient, ledger0: SetLedger, actions: LedgerAction[], log: LedgerLog[]): Promise<SetLedger> {
  const ledger = structuredClone(ledger0);
  for (const a of actions) {
    if (a.kind !== "cancel") continue;
    try {
      await client.cancelOrderByClientId(a.symbol, a.clientOrderId);
      log.push({ level: "info", setId: a.setId, message: `cancelled ${a.clientOrderId} (${a.reason})` });
    } catch (e) {
      if (e instanceof AsterApiError && (e.code === -2011 || e.code === -2013)) {
        log.push({ level: "info", setId: a.setId, message: `${a.clientOrderId} already gone (${e.code})` });
        continue;
      }
      const set = ledger.sets.find((s) => s.id === a.setId);
      if (set) set.needsAttention = `cancel of ${a.clientOrderId} failed: ${(e as Error).message}`;
      log.push({ level: "error", setId: a.setId, message: `CANCEL FAILED ${a.clientOrderId}: ${(e as Error).message}` });
    }
  }
  return ledger;
}

/**
 * The sub-order changes that bring one leg's exits to `desiredExits` (only what differs:
 * quantity off by half a step, stop off by more than a tick). Pure; tests read it.
 */
export function exitUpdatesForLeg(
  set: SetRecord,
  leg: SetLeg,
  desired: NonNullable<ReturnType<typeof desiredExits>>,
  rules: SymbolRules,
): StrategySubOrderUpdate[] {
  const closeSide: "BUY" | "SELL" = set.side === "buy" ? "SELL" : "BUY";
  const positionSide = set.positionMode === "hedge" ? (set.side === "buy" ? ("LONG" as const) : ("SHORT" as const)) : undefined;
  const base = { securityType: "USDT_FUTURES" as const, symbol: set.symbol, side: closeSide, workingType: "MARK_PRICE" as const, ...(positionSide ? { positionSide } : {}) };
  const out: StrategySubOrderUpdate[] = [];
  if (Math.abs(leg.takeProfit.qty - desired.takeProfitQty) > rules.stepSize / 2) {
    out.push({ ...base, strategySubId: "2", type: "TAKE_PROFIT_MARKET", quantity: formatToStep(desired.takeProfitQty, rules.stepSize) });
  }
  const qtyChanged = Math.abs(leg.stop.qty - desired.stopQty) > rules.stepSize / 2;
  const priceChanged = Math.abs(leg.stop.stopPrice - desired.stop.stopPrice) > rules.tickSize + 1e-12;
  if (qtyChanged || priceChanged) {
    out.push({
      ...base,
      strategySubId: "3",
      type: "STOP_MARKET",
      quantity: formatToStep(desired.stopQty, rules.stepSize),
      stopPrice: formatToStep(desired.stop.stopPrice, rules.tickSize),
    });
  }
  return out;
}

/**
 * Resize and re-cap the exits of every open Set on the symbol (one positionRisk read for
 * all of them). A leg whose exits already match is not touched. A failed update keeps the
 * old exits, flags the Set and logs an error; it is never retried here.
 */
export async function syncSetExits(
  client: AsterClient,
  ledger0: SetLedger,
  rules: SymbolRules,
  log: LedgerLog[],
  opts: { rows?: PositionRow[]; maintenanceMarginRate?: number } = {},
): Promise<SetLedger> {
  const ledger = structuredClone(ledger0);
  const open = ledger.sets.filter((s) => s.symbol === rules.symbol && s.status === "open");
  if (open.length === 0) return ledger;
  const rows = opts.rows ?? parsePositionRows(await client.positionRisk(rules.symbol), rules.symbol);
  const symbolLeverage = symbolLeverageFromRows(rows);
  const mmr = opts.maintenanceMarginRate ?? activeRules().risk.assumedMaintenanceRate;
  let updates = 0;
  for (const set of open) {
    const cap = stopCapFor(set, rows, { symbolLeverage, maintenanceMarginRate: mmr });
    for (const leg of set.legs) {
      if (!(legOpenQty(leg) > 0)) continue;
      let desired;
      try {
        desired = desiredExits(leg, set.side, cap, rules.tickSize);
      } catch (e) {
        log.push({ level: "error", setId: set.id, message: `leg ${leg.index}: stop not computable, exits kept: ${(e as Error).message}` });
        continue;
      }
      if (!desired) continue;
      const subs = exitUpdatesForLeg(set, leg, desired, rules);
      if (subs.length === 0) continue;
      if (!leg.strategyId) {
        set.needsAttention = `leg ${leg.index} exits need resizing but its strategyId is unknown`;
        log.push({ level: "error", setId: set.id, message: set.needsAttention });
        continue;
      }
      try {
        await client.updateStrategyOrder(leg.strategyId, "OTOCO", subs);
        updates++;
        leg.takeProfit.qty = desired.takeProfitQty;
        leg.stop.qty = desired.stopQty;
        leg.stop.stopPrice = desired.stop.stopPrice;
        leg.stop.boundBy = desired.stop.boundBy;
        log.push({
          level: "info",
          setId: set.id,
          message: `leg ${leg.index} exits: take-profit qty ${desired.takeProfitQty}, stop ${desired.stop.stopPrice} qty ${desired.stopQty} (bound by ${desired.stop.boundBy}, cap from ${desired.stop.capSource})`,
        });
      } catch (e) {
        set.needsAttention = `exit update of leg ${leg.index} failed: ${(e as Error).message}`;
        log.push({ level: "error", setId: set.id, message: `EXIT UPDATE FAILED leg ${leg.index}: ${(e as Error).message}` });
      }
    }
  }
  log.push({ level: "info", message: `[counts] syncSetExits ${rules.symbol}: open Sets ${open.length}, legs updated ${updates}` });
  return ledger;
}

/**
 * The target against the real fill (Sets_Rules.md A7). For every open single-entry Set with
 * a stored target, after syncSetExits has re-set its stop from the fill:
 *   ratio = |take-profit - average fill| / |average fill - stop|.
 * At or above the slack line (floor - 0.1): nothing moves. Below it, the target is chosen
 * again from the stored candidates (remeasureAfterFill). A different winner is re-placed
 * with updateStrategyOrder only when opts.replaceTakeProfit is true; otherwise the target
 * stays and the log says "kept, update unproven" with the level it would have used.
 * Never touches the entry or the stop. Runs once per (fill, stop) pair, so a repeated
 * event does not repeat the log.
 */
export async function remeasureTargets(
  client: AsterClient,
  ledger0: SetLedger,
  rules: SymbolRules,
  log: LedgerLog[],
  opts: { replaceTakeProfit?: boolean } = {},
): Promise<SetLedger> {
  const ledger = structuredClone(ledger0);
  let measured = 0;
  let moved = 0;
  for (const set of ledger.sets) {
    if (set.symbol !== rules.symbol || set.status !== "open" || !set.target || set.legs.length !== 1) continue;
    const leg = set.legs[0] as SetLeg;
    if (!(legOpenQty(leg) > 0)) continue;
    const fill = averagePrice(leg.entry);
    if (!(fill > 0)) continue;
    // Already measured at this (fill, stop): skip, unless a better level is still pending and
    // re-placing is on now (a log-only pass, e.g. reconcileSymbol, may have stamped the pair first).
    const samePair = set.target.measuredAtFill === cleanRatio(fill) && set.target.measuredAtStop === leg.stop.stopPrice;
    if (samePair && !(opts.replaceTakeProfit && set.target.pendingPrice != null)) continue;

    let r;
    try {
      r = remeasureAfterFill({ basis: set.target.basis, side: set.side, fill, stopPrice: leg.stop.stopPrice, takeProfitPrice: leg.takeProfit.stopPrice, tickSize: rules.tickSize });
    } catch (e) {
      log.push({ level: "error", setId: set.id, message: `target re-measure failed, target kept: ${(e as Error).message}` });
      continue;
    }
    measured++;
    set.target.measuredAtFill = cleanRatio(fill);
    set.target.measuredAtStop = leg.stop.stopPrice;
    set.target.realRatio = r.realRatio;
    if (r.action !== "re-choose" || !r.choice) {
      set.target.lastCheck = r.message;
      log.push({ level: r.action === "keep" ? "info" : "warn", setId: set.id, message: r.message });
      continue;
    }
    const next = r.choice;
    if (!opts.replaceTakeProfit) {
      set.target.pendingPrice = next.price;
      set.target.lastCheck = `kept, update unproven: ${r.message}`;
      log.push({ level: "warn", setId: set.id, message: `kept, update unproven: ${r.message} (would re-place at ${next.price}, ${next.ratio.toFixed(2)}x)` });
      continue;
    }
    if (!leg.strategyId) {
      set.needsAttention = `target re-choice ${next.price} not placed: the leg's strategyId is unknown`;
      set.target.pendingPrice = next.price;
      log.push({ level: "error", setId: set.id, message: set.needsAttention });
      continue;
    }
    const closeSide: "BUY" | "SELL" = set.side === "buy" ? "SELL" : "BUY";
    const positionSide = set.positionMode === "hedge" ? (set.side === "buy" ? ("LONG" as const) : ("SHORT" as const)) : undefined;
    try {
      await client.updateStrategyOrder(leg.strategyId, "OTOCO", [
        {
          strategySubId: "2",
          securityType: "USDT_FUTURES",
          symbol: set.symbol,
          side: closeSide,
          type: "TAKE_PROFIT_MARKET",
          quantity: formatToStep(leg.takeProfit.qty, rules.stepSize),
          stopPrice: formatToStep(next.price, rules.tickSize),
          workingType: "MARK_PRICE",
          ...(positionSide ? { positionSide } : {}),
        },
      ]);
      moved++;
      leg.takeProfit.stopPrice = next.price;
      set.target.realRatio = next.ratio;
      set.target.pendingPrice = null;
      set.target.lastCheck = `re-placed: ${r.message}`;
      log.push({ level: "info", setId: set.id, message: `re-placed take-profit at ${next.price} (${next.ratio.toFixed(2)}x against the real fill): ${r.message}` });
    } catch (e) {
      set.needsAttention = `take-profit re-place failed: ${(e as Error).message}`;
      set.target.pendingPrice = next.price;
      set.target.lastCheck = `kept, update failed: ${r.message}`;
      log.push({ level: "error", setId: set.id, message: `TAKE-PROFIT RE-PLACE FAILED, kept at ${leg.takeProfit.stopPrice}: ${(e as Error).message}` });
    }
  }
  log.push({ level: "info", message: `[counts] remeasureTargets ${rules.symbol}: measured ${measured}, re-placed ${moved}` });
  return ledger;
}

/**
 * Learn Aster's orderIds (and strategyIds) of every active Set leg on a symbol from
 * GET /fapi/v3/strategyOpenOrder, so events can be matched by orderId when Aster does not
 * echo our client ids. Best effort: a failed query is logged, never thrown.
 */
export async function linkSetOrders(client: AsterClient, ledger0: SetLedger, symbol: string): Promise<{ ledger: SetLedger; log: LedgerLog[] }> {
  const ledger = structuredClone(ledger0);
  const log: LedgerLog[] = [];
  for (const set of activeSets(ledger, symbol)) {
    for (const leg of set.legs) {
      if (leg.sent === "not-sent") continue;
      try {
        const j = (await client.strategyOpenOrder(leg.strategyClientId, "OTOCO")) as Record<string, unknown>;
        if (!leg.strategyId && j?.strategyId !== undefined) leg.strategyId = String(j.strategyId);
        for (const sub of (Array.isArray(j?.subOrders) ? j.subOrders : []) as Array<Record<string, unknown>>) {
          const id = String(sub.strategySubId);
          const role = id === "1" ? "entry" : id === "2" ? "takeProfit" : id === "3" ? "stop" : null;
          const oid = sub.orderId !== undefined && sub.orderId !== null && String(sub.orderId) !== "0" ? String(sub.orderId) : null;
          if (role && oid) leg[role].orderId = oid;
        }
      } catch (e) {
        log.push({ level: "warn", setId: set.id, message: `could not link leg ${leg.index} orders: ${(e as Error).message}` });
      }
    }
  }
  return { ledger, log };
}

/** Every Set with its profit from its own fills, for a list screen or the demo route. */
export function describeLedger(ledger: SetLedger) {
  return ledger.sets.map((s) => ({
    id: s.id,
    symbol: s.symbol,
    side: s.side,
    leverage: s.leverage,
    ticketUsd: s.ticketUsd,
    status: s.status,
    needsAttention: s.needsAttention,
    pnl: setPnl(s),
    target: describeTarget(s),
  }));
}

/**
 * The target of one Set for a list screen: its reason, the planned ratio and the ratio
 * against the real fill ("1.97x against the real fill"), computed from the ledger as it is
 * (so it works for Sets the demo server's watcher only records). null for Draw and old Sets.
 */
export function describeTarget(s: SetRecord): { reason: string; planRatio: number; realRatio: number | null; realRatioText: string | null; pendingPrice: number | null } | null {
  if (!s.target || s.legs.length !== 1) return null;
  const leg = s.legs[0] as SetLeg;
  const fill = averagePrice(leg.entry);
  const dist = Math.abs(fill - leg.stop.stopPrice);
  const realRatio = fill > 0 && dist > 0 ? cleanRatio(Math.abs(leg.takeProfit.stopPrice - fill) / dist) : null;
  return {
    reason: s.target.reason,
    planRatio: s.target.planRatio,
    realRatio,
    realRatioText: realRatio === null ? null : `${realRatio.toFixed(2)}x against the real fill`,
    pendingPrice: s.target.pendingPrice ?? null,
  };
}
