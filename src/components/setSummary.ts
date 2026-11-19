/**
 * Words and numbers for the card's one tappable options line (owner rule 2026-11-20): it
 * shows what the options hold, from the current plan, not the option names, for example
 * "30x · target +5.2% ($15.6) · stop -2.6% ($7.9) · entry at market".
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

/** "$15.6"; under $1 two decimals ("$0.43"). Units: USD, sign dropped. */
function money1(v: number): string {
  const a = Math.abs(v);
  return `$${a < 1 ? a.toFixed(2) : a.toFixed(1)}`;
}

/**
 * The options line. Without a plan yet only the leverage is known: "30x · ...".
 * Target and stop are measured from the expected entry; the dollars are the plan's win at
 * the take-profit and loss at the stop.
 */
export function optionsLine(leverage: number, plan: SetPlan | null | undefined): string {
  if (!plan) return `${leverage}x · ...`;
  const entry = plan.entry.expectedFillPrice;
  const pct = (p: number) => `${((Math.abs(p - entry) / entry) * 100).toFixed(1)}%`;
  const where =
    plan.entry.usedMode === "now"
      ? "entry at market"
      : plan.orders.entries.length > 1
        ? `entry across ${plan.orders.entries.length} orders`
        : `entry at ${px(entry)}`;
  return [
    `${plan.input.leverage}x`,
    `target +${pct(plan.takeProfit.price)} (${money1(plan.expected.profitAtTpUsd)})`,
    `stop -${pct(plan.stop.price)} (${money1(plan.expected.lossAtStopUsd)})`,
    where,
  ].join(" · ");
}

/** The older summary row (mode names, then target, win and max loss), kept for other screens. */
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
