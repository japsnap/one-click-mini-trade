/**
 * Behaviour of an entered Set on the card: waiting -> open -> result, with alerts.
 *
 * Kept apart from the card's look (SetCard.tsx) so Blackboard can restyle freely, or swap
 * the price polling for its own websocket, without touching this logic.
 *
 *  - waiting: a limit entry has not been reached yet (Buy: price must fall to the entry;
 *    Sell: rise to it). Market entries skip straight to open.
 *  - open: every new price goes through core/alerts.evaluatePrice; "halfway" and "result"
 *    events become toasts and are passed to onAlert (for push notifications).
 *  - closed: the result is in; polling stops.
 *
 * In trial mode nothing was sent, so this runs as a simulation on the live price.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { evaluatePrice, INITIAL_WATCH_STATE, progressToTakeProfit, type OpenSet, type SetAlertEvent, type WatchState } from "../core/alerts";
import type { SetPlan } from "../core/plan";

export type SessionPhase = "idle" | "waiting" | "open" | "closed";

/** Poll interval for the price while a Set is live. Units: milliseconds. */
export const PRICE_POLL_MS = 2_000;

/**
 * Track one entered Set.
 * Units: prices quote per base; progress a fraction 0..1.
 */
export function useSetSession(args: {
  plan: SetPlan | null;
  getPrice: (symbol: string) => Promise<number>;
  onAlert?: (e: SetAlertEvent) => void;
}) {
  const { plan } = args;
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [events, setEvents] = useState<SetAlertEvent[]>([]);
  const watch = useRef<WatchState>(INITIAL_WATCH_STATE);
  const onAlert = useRef(args.onAlert);
  onAlert.current = args.onAlert;

  // A new plan (a new Enter) restarts the session.
  useEffect(() => {
    watch.current = INITIAL_WATCH_STATE;
    setEvents([]);
    if (!plan) return setPhase("idle");
    setPhase(plan.orders.entries.every((e) => e.type === "MARKET") ? "open" : "waiting");
  }, [plan]);

  const price = useQuery({
    queryKey: ["set-price", plan?.input.symbol],
    queryFn: () => args.getPrice(plan!.input.symbol),
    enabled: !!plan && phase !== "closed" && phase !== "idle",
    refetchInterval: PRICE_POLL_MS,
  });

  // The open position as core/alerts understands it.
  const openSet: OpenSet | null = plan
    ? {
        side: plan.input.side,
        entry: plan.entry.expectedFillPrice,
        takeProfit: plan.takeProfit.price,
        liquidation: plan.liquidationPrice,
        // Draw has one stop per leg; the session follows the average (the plan shows it the same way).
        stop: plan.stop.price,
        qty: plan.quantity,
      }
    : null;

  useEffect(() => {
    const p = price.data;
    if (!plan || !openSet || p === undefined) return;
    if (phase === "waiting") {
      // The nearest entry to the price fills first: highest entry for a Buy, lowest for a Sell.
      const prices = plan.orders.entries.map((e) => e.price ?? p);
      const first = plan.input.side === "buy" ? Math.max(...prices) : Math.min(...prices);
      const reached = plan.input.side === "buy" ? p <= first : p >= first;
      if (reached) setPhase("open");
      return;
    }
    if (phase !== "open") return;
    const r = evaluatePrice(openSet, watch.current, p);
    watch.current = r.state;
    if (r.events.length > 0) {
      setEvents((prev) => [...prev, ...r.events]);
      r.events.forEach((e) => onAlert.current?.(e));
      if (r.state.result) setPhase("closed");
    }
    // openSet is derived from plan; plan and price are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price.data, phase, plan]);

  const progress = openSet && price.data !== undefined && phase === "open" ? progressToTakeProfit(openSet, price.data) : phase === "closed" ? 1 : 0;
  const result = events.find((e) => e.type === "result") ?? null;
  return { phase, price: price.data, progress, events, result };
}
