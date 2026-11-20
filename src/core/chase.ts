/**
 * The anti-chase guard (Sets_Rules.md A12, 2026-11-21). Owner's hard rule, for Sets and the
 * wick catcher: "not to follow trend at the edge ... That could be the worst decision and
 * perhaps opposite should be done."
 *
 * Chasing = opening a Set in the direction of a move that has already run to the edge of its
 * recent range. Two measures on the Set's ENTRY price (Now: the price; Nearby, Patient, Draw:
 * the limit or average limit price, so a Patient Short waiting above a drop is not a chase),
 * from the last 72 completed one-hour candles:
 *   edge  the entry sits in the outer edgeShare (10%) of the 72-hour low-to-high range, on the
 *         side's own end (Short: near or below the low; Long: near or above the high), and the
 *         range is at least minRange (3%) of the price;
 *   fast  the entry is at least daySigmas (1.5) typical days' moves (sigma1h x sqrt 24) beyond
 *         the last 24 hours' extreme on the other end (Short: below the 24-hour high; Long:
 *         above the 24-hour low).
 * Both: chase, the Set is refused. Never flipped and no other side suggested (owner's ruling
 * 2026-11-21: "Avoid long instead. Saying that is risky.").
 * Pure: no network, no clock (asOf is passed in). No liquidation data needed.
 * Units: prices quote per base; shares are fractions (0.103 = 10.3%).
 */
import type { Side } from "./types";
import { activeRules, type SetRules } from "../rules/rules";

/** One one-hour candle (src/exchange/aster.ts Kline fits). */
export interface ChaseCandle {
  openTime: number;
  high: number;
  low: number;
  close: number;
}

export interface ChaseResult {
  /** Refused: edge and fast both hold and the guard is on. */
  chase: boolean;
  edge: boolean;
  fast: boolean;
  enabled: boolean;
  /** The plain sentence when edge and fast both hold (also when the guard is off), else null. Two lines split by "\n". */
  sentence: string | null;
  numbers: {
    entry: number;
    candles: number;
    low72: number;
    high72: number;
    /** (high - low) / entry. */
    rangeShare: number;
    /** Where the entry sits in the 72-hour range: 0 at the low, 1 at the high (can be outside 0..1). */
    position: number;
    high24: number;
    low24: number;
    /** Short: (24 h high - entry) / 24 h high. Long: (entry - 24 h low) / 24 h low. */
    dayMove: number;
    /** sigma1h x sqrt 24, and daySigmas times it. */
    dayTypical: number;
    fastThreshold: number;
  } | null;
  /** Why the guard could not judge (too few candles), else null. */
  note: string | null;
}

const HOUR_MS = 3_600_000;

/**
 * Judge one entry. klines1h: Aster one-hour candles, oldest first. asOf (ms): candles still
 * forming at that time are left out (the guard reads completed hours only).
 */
export function chaseCheck(
  entry: number,
  side: Side,
  klines1h: ChaseCandle[],
  sigma1h: number,
  rules: SetRules["chase"] = activeRules().chase,
  opts: { asOf?: number; coin?: string } = {},
): ChaseResult {
  const done = klines1h.filter((k) => k.high > 0 && k.low > 0 && (opts.asOf === undefined || k.openTime + HOUR_MS <= opts.asOf));
  const last72 = done.slice(-72);
  const last24 = done.slice(-24);
  if (last24.length < 24 || !(entry > 0)) {
    return { chase: false, edge: false, fast: false, enabled: rules.enabled, sentence: null, numbers: null, note: `too few completed one-hour candles (${done.length}) to judge a chase` };
  }
  const low72 = Math.min(...last72.map((k) => k.low));
  const high72 = Math.max(...last72.map((k) => k.high));
  const high24 = Math.max(...last24.map((k) => k.high));
  const low24 = Math.min(...last24.map((k) => k.low));
  const range = high72 - low72;
  const rangeShare = range / entry;
  const position = range > 0 ? (entry - low72) / range : 0.5;
  const dayTypical = sigma1h * Math.sqrt(24);
  const fastThreshold = rules.daySigmas * dayTypical;
  const short = side === "sell";
  const dayMove = short ? (high24 - entry) / high24 : (entry - low24) / low24;
  const edge = rangeShare >= rules.minRange && (short ? position <= rules.edgeShare : position >= 1 - rules.edgeShare);
  const fast = dayMove >= fastThreshold;
  const coin = opts.coin ?? "The price";
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const where = short
    ? entry < low72
      ? "below its 3-day low"
      : `in the bottom ${Math.round(rules.edgeShare * 100)}% of its 3-day range`
    : entry > high72
      ? "above its 3-day high"
      : `in the top ${Math.round(rules.edgeShare * 100)}% of its 3-day range`;
  // Two short lines, one claim each (copy rule 2026-11-21); the card shows each on its own line.
  const sentence = edge && fast ? `${coin} ${short ? "fell" : "rose"} ${pct(dayMove)} in a day, ${where}.\nA ${short ? "Short" : "Long"} here would follow the move at its edge.` : null;
  return {
    chase: rules.enabled && edge && fast,
    edge,
    fast,
    enabled: rules.enabled,
    sentence,
    numbers: { entry, candles: done.length, low72, high72, rangeShare, position, high24, low24, dayMove, dayTypical, fastThreshold },
    note: null,
  };
}
