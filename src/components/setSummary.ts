/**
 * Words and numbers for the card's one tappable summary row (owner rule 2026-11-16):
 * the take-profit mode and the entry mode, then target price, win amount and max loss,
 * so the row shows what the choice is worth and invites a tap to change it.
 *
 * Pure functions, no React: the card, a Blackboard screen or a test can all call them.
 * Wording is a first draft for the branding manager to review; the numbers are the plan's.
 */
import type { SetPlan } from "../core/plan";
import type { EntryMode, TpMode } from "../core/types";

export const TP_LABEL: Record<TpMode, string> = { shy: "Shy", deserved: "Deserved", greedy: "Greedy" };
export const WHEN_LABEL: Record<EntryMode, string> = { now: "Now", nearby: "Nearby", patient: "Patient", draw: "Draw" };

/** "$1,234.56" (negative as "-$7.20"). Units: USD. */
export function usd(v: number): string {
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Price with up to 2 decimals, "market" for null. Units: quote per base. */
export function px(v: number | null | undefined): string {
  return v == null ? "market" : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** The summary row's two lines. Without a plan yet, the second line is null. */
export function summaryLines(tpMode: TpMode, entryMode: EntryMode, plan: SetPlan | null | undefined): { title: string; detail: string | null } {
  const title = `${TP_LABEL[tpMode]} · ${WHEN_LABEL[entryMode]}`;
  if (!plan) return { title, detail: null };
  const detail = `Target ${px(plan.takeProfit.price)} · Win ${usd(plan.expected.profitAtTpUsd)} · Max loss ${usd(Math.abs(plan.expected.lossAtStopUsd))}`;
  return { title, detail };
}

/** The fallback notice shown on the card itself (not only in the sheet), or null. */
export function fallbackNotice(plan: SetPlan | null | undefined): string | null {
  if (!plan || plan.entry.fellBackFrom.length === 0) return null;
  const r = plan.entry.reason;
  return r.charAt(0).toUpperCase() + r.slice(1) + ".";
}
