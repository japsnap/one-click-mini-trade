// @vitest-environment jsdom
/**
 * The Set card's behaviour (HYBRID): the real card, the real core plan builder, the real
 * summary helpers, rendered in jsdom. Only the network is replaced: the fake `api` builds
 * each preview with the same buildSetPlan the server uses, from fixed market data, and
 * records every request so the test asserts on what the card actually asked for.
 * What this does not prove: real phone rendering and the demo server's HTTP routes
 * (the live smoke run covers the server).
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildSetPlan } from "../src/core/plan";
import type { SetInput, SymbolRules, TraderLevels } from "../src/core/types";
import type { SetCardApi } from "../src/api/client";
import { SetCard } from "../src/components/SetCard";
import { fallbackNotice, optionsLine, summaryLines } from "../src/components/setSummary";
import { mergeRules } from "../src/rules/rules";

const BTC: SymbolRules = { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
// Bids for Nearby; no liquidations, so Patient must fall back.
const LEVELS: TraderLevels = { limitLevels: [{ price: 63800, weightUsd: 1e5, side: "buy" }], takeProfitLevels: [], liquidationLevels: [] };

function fakeApi(extra: Partial<SetCardApi> = {}) {
  const previews: SetInput[] = [];
  const api: SetCardApi = {
    ...extra,
    getPrice: async () => 64000,
    preview: async (input) => {
      previews.push(input);
      return { plan: buildSetPlan({ input, currentPrice: 64000, rules: BTC, levels: LEVELS, random: () => 0.5 }) };
    },
    place: async () => {
      throw new Error("not used in this test");
    },
  };
  return { api, previews };
}

function renderCard(api: SetCardApi) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SetCard api={api} />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe("Set card", () => {
  it("asks only Side and Ticket; starts at Buy, $10, 30x, Deserved, Nearby (owner rule 2026-11-20)", async () => {
    const { api, previews } = fakeApi();
    renderCard(api);
    await waitFor(() => expect(previews.length).toBeGreaterThan(0));
    expect(previews[0]).toMatchObject({ side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "nearby" });
    for (const name of ["Buy", "Sell", "$10", "$30", "$100"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    // Leverage, target and entry live in the sheet only.
    for (const name of ["30x", "50x", "100x", "Greedy", "Patient"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("the options line shows what the options hold, from the plan, not their names; it opens the sheet with leverage, target and entry", async () => {
    const { api } = fakeApi();
    renderCard(api);
    const row = await screen.findByTestId("set-summary-row");
    const plan = buildSetPlan({ input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "nearby" }, currentPrice: 64000, rules: BTC, levels: LEVELS, random: () => 0.5 });
    await waitFor(() => expect(row.textContent).toContain(optionsLine(30, plan)));
    expect(row.textContent).toMatch(/30x · target \+[\d.]+% \(\$[\d.]+\) · stop -[\d.]+% \(\$[\d.]+\) · entry at [\d,.]+/);
    expect(row.textContent).not.toMatch(/Deserved|Nearby/);
    fireEvent.click(row);
    const sheet = await screen.findByRole("dialog", { name: "Set options" });
    for (const t of ["Leverage", "30x", "50x", "100x", "Greedy", "Patient"]) expect(sheet.textContent).toContain(t);
  });

  it("leverage is chosen in the sheet; the plan and the line follow", async () => {
    const { api, previews } = fakeApi();
    renderCard(api);
    fireEvent.click(await screen.findByTestId("set-summary-row"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "50x" })));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(previews.at(-1)?.leverage).toBe(50));
    await waitFor(() => expect(screen.getByTestId("set-summary-row").textContent).toMatch(/50x · target \+/));
  });

  it("with api.getRules the card offers the rule set's tickets and starts on its defaults", async () => {
    const rules = mergeRules({ ticket: { choices: [20, 50], default: 50 }, leverage: { choices: [20, 40], default: 20 } });
    const { api, previews } = fakeApi({ getRules: async () => rules });
    renderCard(api);
    expect(await screen.findByRole("button", { name: "$50" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "$10" })).toBeNull();
    await waitFor(() => expect(previews.at(-1)).toMatchObject({ ticketUsd: 50, leverage: 20 }));
  });

  it("when Patient falls back, the card itself says so", async () => {
    const { api, previews } = fakeApi();
    renderCard(api);
    fireEvent.click(await screen.findByTestId("set-summary-row"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Patient" })));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(previews.at(-1)?.entryMode).toBe("patient"));
    const notice = await screen.findByTestId("fallback-notice");
    expect(notice.textContent).toMatch(/^Patient found no liquidation cluster 0.5% to 5% below the price, so waiting in an area/);
  });
});

describe("summary helpers", () => {
  it("lines without a plan, and no notice without a fallback", () => {
    expect(summaryLines("greedy", "draw", null)).toEqual({ title: "Greedy · Draw", detail: null });
    expect(fallbackNotice(null)).toBeNull();
    const plan = buildSetPlan({
      input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "nearby" },
      currentPrice: 64000,
      rules: BTC,
      levels: LEVELS,
      random: () => 0.5,
    });
    expect(fallbackNotice(plan)).toBeNull();
    const d = summaryLines("deserved", "nearby", plan).detail!;
    expect(d).toContain(`Max loss $${Math.abs(plan.expected.lossAtStopUsd).toFixed(2)}`);
  });

  it("options line by hand: Now, Buy $10 at 30x from 64,000", () => {
    const now = buildSetPlan({ input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, currentPrice: 64000, rules: BTC, levels: LEVELS, random: () => 0.5 });
    // Stop 62,458.7 (2.4% below). No candles are passed, so the volatility floor puts every level out of
    // reach and the target is the bare 2x, 67,082.6 (4.8% above; target v2 of 2026-11-20); 0.004 BTC wins $12.3, loses $6.2.
    expect(now.takeProfit.source).toBe("exact-ratio");
    expect(optionsLine(30, now)).toBe("30x · target +4.8% ($12.3) · stop -2.4% ($6.2) · entry at market");
    expect(optionsLine(30, null)).toBe("30x · ...");
  });
});
