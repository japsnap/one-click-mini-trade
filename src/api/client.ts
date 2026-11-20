/**
 * The card's data layer: the calls it needs, as one interface.
 *
 * Blackboard replaces `demoServerApi` with its own implementation (its backend, signing
 * through Privy or its agent key); the card itself does not change. Nothing here holds a key.
 */
import type { SetPlan } from "../core/plan";
import type { SetInput } from "../core/types";
import type { SetRules } from "../rules/rules";

/** Answer of a preview. asterOrders is the exact legs the server would sign (opaque to the card). */
export interface PreviewPlan {
  plan: SetPlan;
  asterOrders?: unknown;
  /** What the plan was built from; the card reads only the liquidation map's progress. */
  sources?: { fuelMap?: { stage: string; addressesWithFreshAnswer: number; addressesInSample: number } | null };
}

/**
 * A preview the server refused before anything was sent (HTTP 409): the anti-chase guard
 * ("refused: chasing") or a guard that could not run ("refused: guard unavailable"). message
 * is the sentence the card shows. No other side is suggested (owner's ruling 2026-11-21).
 */
export interface PreviewRefusal {
  refused: true;
  status: string;
  message: string;
}

export type PreviewResponse = PreviewPlan | PreviewRefusal;

/** True for a refused preview. */
export function isRefusal(r: PreviewResponse | undefined): r is PreviewRefusal {
  return !!r && (r as PreviewRefusal).refused === true;
}

/** Answer of a placement. status "trial: not sent" in trial mode. */
export interface PlaceResponse {
  status: string;
  trial: boolean;
  why?: string[];
  plan: SetPlan;
}

/** Everything the Set card needs from the outside world. */
export interface SetCardApi {
  /** Latest price. Units: quote per base. */
  getPrice(symbol: string): Promise<number>;
  /** Plan for the current choices (loads traders' levels for Nearby and Patient). */
  preview(input: SetInput): Promise<PreviewResponse>;
  /** Place the Set (or run it as a trial). */
  place(input: SetInput): Promise<PlaceResponse>;
  /** The active rule set (ticket and leverage choices, defaults). Optional: without it the card uses the default rules. */
  getRules?(): Promise<SetRules>;
}

/** POST/GET JSON and surface the server's error text (never a silent empty result). */
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `request failed: HTTP ${res.status}`);
  return body as T;
}

/** The demo server's implementation (npm run server; Vite proxies /api). */
export const demoServerApi: SetCardApi = {
  async getPrice(symbol) {
    const r = await call<{ price: number }>(`/api/price?symbol=${encodeURIComponent(symbol)}`);
    return r.price;
  },
  async preview(input) {
    const res = await fetch("/api/set/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = (await res.json().catch(() => ({}))) as { error?: string; refused?: boolean };
    // A refusal is an answer, not a failure: the card shows its sentence.
    if (res.status === 409 && body.refused === true) return body as PreviewRefusal;
    if (!res.ok) throw new Error(body.error ?? `request failed: HTTP ${res.status}`);
    return body as PreviewPlan;
  },
  place(input) {
    return call<PlaceResponse>("/api/set/place", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  },
  async getRules() {
    return (await call<{ rules: SetRules }>("/api/rules")).rules;
  },
};
