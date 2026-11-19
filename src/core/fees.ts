/**
 * Profit-share fee model for the pitch.
 *
 * On a WINNING Set: 5% of the profit goes to Blackboard and 5% to the copied
 * trader whose levels placed the entry or take-profit. On a losing Set: $0.
 * The user pays only when they win, which aligns everyone with the user.
 *
 * In this MVP nothing moves on-chain for this split; it is computed and shown.
 * (Aster's builder feeRate, if configured, is a separate per-trade fee charged by
 * the exchange on every fill; see src/exchange/aster.ts.)
 */
import { activeRules, DEFAULT_RULES } from "../rules/rules";

/** Default profit shares. Units: decimal fractions of the profit (0.05 = 5%). */
export const DEFAULT_FEE_SHARES = { blackboard: DEFAULT_RULES.profitShare.blackboard, trader: DEFAULT_RULES.profitShare.trader } as const;

/** The split of one Set's result. Units: USD. */
export interface FeeSplit {
  /** Profit or loss before the split (negative on a loss). */
  grossPnlUsd: number;
  /** Blackboard's share; 0 on a loss. */
  blackboardUsd: number;
  /** The copied trader's share; 0 on a loss. */
  traderUsd: number;
  /** What the user keeps (the full loss on a loss). */
  userNetUsd: number;
}

/**
 * Split a Set's result between the user, Blackboard and the copied trader.
 * Why: the pitch's revenue model; zero on a loss by design.
 * Units: pnlUsd in USD; shares as decimal fractions. Shares are rounded to cents.
 */
export function splitFees(
  pnlUsd: number,
  shares: { blackboard: number; trader: number } = activeRules().profitShare,
): FeeSplit {
  if (!Number.isFinite(pnlUsd)) throw new RangeError(`pnlUsd must be finite, got ${pnlUsd}`);
  if (shares.blackboard < 0 || shares.trader < 0 || shares.blackboard + shares.trader > 1) {
    throw new RangeError("fee shares must be >= 0 and sum to at most 1");
  }
  // A loss (or exactly zero) pays nobody.
  if (pnlUsd <= 0) return { grossPnlUsd: pnlUsd, blackboardUsd: 0, traderUsd: 0, userNetUsd: pnlUsd };
  const blackboardUsd = round2(pnlUsd * shares.blackboard);
  const traderUsd = round2(pnlUsd * shares.trader);
  return { grossPnlUsd: pnlUsd, blackboardUsd, traderUsd, userNetUsd: round2(pnlUsd - blackboardUsd - traderUsd) };
}

/** Round to cents. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
