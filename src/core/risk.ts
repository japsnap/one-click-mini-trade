/**
 * Pre-trade risk check for a new Set on an account that may already hold positions
 * (Shota's rules, 2026-11-19):
 *  1. Margin: the free balance must carry the new ticket (checkMarginForSet in ledger.ts).
 *  2. Warning when the coin already has a position (his own trade or other Sets): the new
 *     Set merges into it, one liquidation price for both.
 *  3. Block when the Set moves any liquidation price too close: for every open position
 *     on the account, distance = |mark - liquidation| / mark. If the new Set shrinks that
 *     distance by more than LIQ_SHRINK_BLOCK (30%, the middle of his 20 to 40% range),
 *     the Set is refused.
 *  4. Block when a stop leaves its rule: every open Set's stop on the coin, and the new
 *     Set's own stop, must stay at most STOP_FRACTION (85%) of the way from its entry to
 *     the predicted liquidation price.
 *
 * THE MODEL (cross margin, all positions share one cushion). The account is liquidated
 * when equity falls to the total maintenance margin. Cushion X = equity - maintenance,
 * both at current mark prices. Holding every other position at its mark, position r
 * (quantity Q, entry E, maintenance rate m) is liquidated at P where
 *   long  (Q > 0):  P = (Q*E - K) / (Q*(1 - m))
 *   short (A = -Q): P = (A*E + K) / (A*(1 + m))
 *   K = X - uPnL_r + MM_r   (the cushion that is not this position's own)
 * Checked live on 2026-11-19: Shota's BTC long (0.067 at 63,530.08, m = 0.3066%) with
 * X = 306.15 gives 59,280; Aster showed 59,286.
 * X comes from GET /fapi/v3/account: availableBalance + totalPositionInitialMargin +
 * totalOpenOrderInitialMargin - totalMaintMargin (availableBalance is account-wide in
 * multi-asset mode, the other totals are USDT, which is what every USDT perp uses).
 * A new Set at price p, quantity q (signed), mark M changes X by
 *   q*(M - p) - fee - (new maintenance - old maintenance)
 * An isolated position has its own cushion and is skipped (Blackboard accounts are cross).
 * Hedge mode: each side is its own row; the other side is held at mark (an estimate).
 * This is an estimate; once filled, Aster's own liquidationPrice is the truth.
 */
import type { Side } from "./types";

export const LIQ_SHRINK_BLOCK = 0.3;
export const LIQ_SHRINK_WARN = 0.1;
export const STOP_FRACTION = 0.85;
/** Fee assumed for the new Set's fill, as a fraction of notional (taker plus builder, rounded up). */
export const ASSUMED_FEE_RATE = 0.001;

export interface RiskPosition {
  symbol: string;
  positionSide: "BOTH" | "LONG" | "SHORT";
  /** + long, - short. */
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  /** Maintenance margin in USD at the mark (account endpoint positions[].maintMargin). */
  maintMarginUsd: number;
  isolated: boolean;
}

export interface AccountRisk {
  /** equity - maintenance at current marks, USD. */
  cushionUsd: number;
  availableBalanceUsd: number;
  /** Account equity in USD (availableBalance + initial margins). */
  equityUsd: number;
  positions: RiskPosition[];
}

/** Coerce GET /fapi/v3/account. Every number is checked; a broken answer fails loudly. */
export function parseAccountRisk(json: unknown): AccountRisk {
  const a = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : null;
  if (!a) throw new Error("account: answer is not an object");
  const n = (v: unknown, k: string) => {
    const x = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    if (!Number.isFinite(x)) throw new Error(`account: ${k} missing or not a number`);
    return x;
  };
  const available = n(a.availableBalance, "availableBalance");
  const posIm = n(a.totalPositionInitialMargin, "totalPositionInitialMargin");
  const ordIm = n(a.totalOpenOrderInitialMargin ?? "0", "totalOpenOrderInitialMargin");
  const mm = n(a.totalMaintMargin, "totalMaintMargin");
  const rows = Array.isArray(a.positions) ? (a.positions as Array<Record<string, unknown>>) : [];
  const positions: RiskPosition[] = [];
  for (const r of rows) {
    const amt = n(r.positionAmt ?? "0", `positions ${String(r.symbol)} positionAmt`);
    if (amt === 0) continue;
    const notional = Math.abs(n(r.notional ?? "0", `positions ${String(r.symbol)} notional`));
    const side = r.positionSide === "LONG" || r.positionSide === "SHORT" ? r.positionSide : "BOTH";
    positions.push({
      symbol: String(r.symbol),
      positionSide: side,
      positionAmt: amt,
      entryPrice: n(r.entryPrice, `positions ${String(r.symbol)} entryPrice`),
      markPrice: notional / Math.abs(amt),
      maintMarginUsd: n(r.maintMargin ?? "0", `positions ${String(r.symbol)} maintMargin`),
      isolated: r.isolated === true || r.isolated === "true",
    });
  }
  const equity = available + posIm + ordIm;
  return { cushionUsd: equity - mm, availableBalanceUsd: available, equityUsd: equity, positions };
}

/** Liquidation price of one position given the cushion K that is not its own; null = none (a long that cannot fall that far). */
export function liquidationFromCushion(qty: number, entry: number, mmRate: number, k: number): number | null {
  if (qty === 0) return null;
  if (qty > 0) {
    const p = (qty * entry - k) / (qty * (1 - mmRate));
    return p > 0 ? p : null;
  }
  const a = -qty;
  return (a * entry + k) / (a * (1 + mmRate));
}

/** Distance from mark to liquidation as a fraction of the mark; a long with no liquidation counts as 1 (price to zero). */
export function liquidationDistance(qty: number, mark: number, liq: number | null): number {
  if (qty > 0) return liq === null ? 1 : Math.max(0, (mark - liq) / mark);
  if (qty < 0) return liq === null ? Number.POSITIVE_INFINITY : Math.max(0, (liq - mark) / mark);
  return Number.POSITIVE_INFINITY;
}

export interface OpenSetStop {
  setId: string;
  side: Side;
  entryPrice: number;
  stopPrice: number;
}

export interface NewSetForRisk {
  symbol: string;
  side: Side;
  /** Positive quantity of the new Set. */
  qty: number;
  /** Expected fill price. */
  price: number;
  stopPrice: number;
  /** The plan's maintenance margin rate (brackets), used when the coin has no position yet. */
  maintenanceMarginRate: number;
  positionMode: "one-way" | "hedge";
}

export interface RiskRow {
  symbol: string;
  positionSide: string;
  qtyBefore: number;
  qtyAfter: number;
  liqBefore: number | null;
  liqAfter: number | null;
  distanceBefore: number;
  distanceAfter: number;
  /** 1 - after/before; 0 when the distance grows. */
  shrink: number;
}

export interface RiskVerdict {
  ok: boolean;
  /** Plain sentences for the card. */
  warnings: string[];
  /** Why it is refused (empty when ok). */
  reasons: string[];
  rows: RiskRow[];
  /** Predicted liquidation of the new Set's own position side after the fill. */
  newLiquidation: number | null;
}

const fmt = (x: number) => (x >= 100 ? x.toFixed(1) : x.toPrecision(5));
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Run rules 2 to 4 for a new Set. Pure.
 * openStops: the active Sets on the new Set's symbol (their filled entry and current stop).
 */
export function checkNewSetRisk(account: AccountRisk, set: NewSetForRisk, openStops: OpenSetStop[]): RiskVerdict {
  const warnings: string[] = [];
  const reasons: string[] = [];
  const signed = set.side === "buy" ? set.qty : -set.qty;
  const wantSide = set.positionMode === "hedge" ? (set.side === "buy" ? "LONG" : "SHORT") : "BOTH";
  const cross = account.positions.filter((p) => !p.isolated);
  const target = cross.find((p) => p.symbol === set.symbol && p.positionSide === wantSide) ?? null;
  const mark = target?.markPrice ?? set.price;

  // The target row after the fill.
  const qBefore = target?.positionAmt ?? 0;
  const qAfter = qBefore + signed;
  let eAfter: number;
  if (qBefore === 0) eAfter = set.price; // a new position
  else if (Math.sign(signed) === Math.sign(qBefore)) eAfter = (qBefore * (target as RiskPosition).entryPrice + signed * set.price) / qAfter; // an add: weighted entry
  else if (Math.abs(signed) < Math.abs(qBefore)) eAfter = (target as RiskPosition).entryPrice; // a reduce keeps the entry
  else eAfter = set.price; // flat or flipped: what is left was opened at the Set's price
  const mTarget = target && target.positionAmt !== 0 ? target.maintMarginUsd / (Math.abs(target.positionAmt) * target.markPrice) : set.maintenanceMarginRate;
  const mmBefore = target?.maintMarginUsd ?? 0;
  const mmAfter = Math.abs(qAfter) * mark * mTarget;
  const fee = set.qty * set.price * ASSUMED_FEE_RATE;
  const cushionAfter = account.cushionUsd + signed * (mark - set.price) - fee - (mmAfter - mmBefore);

  if (qBefore !== 0) {
    const own = qBefore > 0 ? "long" : "short";
    warnings.push(
      `You already hold a ${set.symbol.replace("USDT", "")} ${own} of ${Math.abs(qBefore)}. This Set merges into it: one position, one liquidation price. Closing the whole position in the app also closes this Set.`,
    );
  }

  const rows: RiskRow[] = [];
  let newLiquidation: number | null = null;
  const all = target ? cross : [...cross, { symbol: set.symbol, positionSide: wantSide, positionAmt: 0, entryPrice: set.price, markPrice: mark, maintMarginUsd: 0, isolated: false } as RiskPosition];
  for (const p of all) {
    const isTarget = p.symbol === set.symbol && p.positionSide === wantSide;
    const m = p.positionAmt !== 0 ? p.maintMarginUsd / (Math.abs(p.positionAmt) * p.markPrice) : mTarget;
    const uBefore = p.positionAmt * (p.markPrice - p.entryPrice);
    const kBefore = account.cushionUsd - uBefore + p.maintMarginUsd;
    const liqBefore = liquidationFromCushion(p.positionAmt, p.entryPrice, m, kBefore);
    let q = p.positionAmt;
    let e = p.entryPrice;
    let k: number;
    if (isTarget) {
      q = qAfter;
      e = eAfter;
      k = cushionAfter - q * (p.markPrice - e) + mmAfter;
    } else {
      k = cushionAfter - uBefore + p.maintMarginUsd;
    }
    const liqAfter = liquidationFromCushion(q, e, m, k);
    if (isTarget) newLiquidation = liqAfter;
    const dB = liquidationDistance(p.positionAmt, p.markPrice, liqBefore);
    const dA = liquidationDistance(q, p.markPrice, liqAfter);
    const shrink = Number.isFinite(dB) && dB > 0 && Number.isFinite(dA) ? Math.max(0, 1 - dA / dB) : 0;
    rows.push({ symbol: p.symbol, positionSide: p.positionSide, qtyBefore: p.positionAmt, qtyAfter: q, liqBefore, liqAfter, distanceBefore: dB, distanceAfter: dA, shrink });
    if (p.positionAmt === 0) continue; // a new position has no "before" to shrink from
    const name = `${p.symbol.replace("USDT", "")} ${p.positionAmt > 0 ? "long" : "short"}`;
    if (shrink > LIQ_SHRINK_BLOCK) {
      reasons.push(
        `This Set moves your ${name}'s liquidation from ${liqBefore === null ? "none" : fmt(liqBefore)} to ${liqAfter === null ? "none" : fmt(liqAfter)}: ${pct(shrink)} closer to the price (the limit is ${pct(LIQ_SHRINK_BLOCK)}).`,
      );
    } else if (shrink > LIQ_SHRINK_WARN) {
      warnings.push(`Your ${name}'s liquidation moves ${pct(shrink)} closer: ${liqBefore === null ? "none" : fmt(liqBefore)} to ${liqAfter === null ? "none" : fmt(liqAfter)}.`);
    }
  }

  // Rule 4: every stop on the resulting side stays within 85% of the way to the new liquidation.
  if (newLiquidation !== null && qAfter !== 0) {
    const dir: Side = qAfter > 0 ? "buy" : "sell";
    const stops: OpenSetStop[] = [...openStops.filter((s) => s.side === dir), ...(dir === set.side ? [{ setId: "this Set", side: set.side, entryPrice: set.price, stopPrice: set.stopPrice }] : [])];
    for (const s of stops) {
      const toLiq = Math.abs(s.entryPrice - newLiquidation);
      const toStop = Math.abs(s.entryPrice - s.stopPrice);
      const beyond = dir === "buy" ? s.stopPrice <= newLiquidation : s.stopPrice >= newLiquidation;
      const frac = toLiq > 0 ? toStop / toLiq : Number.POSITIVE_INFINITY;
      if (beyond || frac > STOP_FRACTION + 1e-9) {
        reasons.push(
          `${s.setId === "this Set" ? "This Set's" : `Set ${s.setId}'s`} stop at ${fmt(s.stopPrice)} would sit ${beyond ? "past" : `${pct(frac)} of the way to`} the new liquidation ${fmt(newLiquidation)} (the rule is at most ${pct(STOP_FRACTION)}).`,
        );
      }
    }
  }
  return { ok: reasons.length === 0, warnings, reasons, rows, newLiquidation };
}
