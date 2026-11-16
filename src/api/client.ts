/**
 * The card's data layer: the four calls it needs, as one interface.
 *
 * Blackboard replaces `demoServerApi` with its own implementation (its backend, signing
 * through Privy or its agent key); the card itself does not change. Nothing here holds a key.
 */
import type { SetPlan } from "../core/plan";
import type { SetInput } from "../core/types";

/** Answer of a preview. asterOrders is the exact legs the server would sign (opaque to the card). */
export interface PreviewResponse {
  plan: SetPlan;
  asterOrders?: unknown;
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
  preview(input) {
    return call<PreviewResponse>("/api/set/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  },
  place(input) {
    return call<PlaceResponse>("/api/set/place", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  },
};
