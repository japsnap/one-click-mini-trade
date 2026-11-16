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
import { fallbackNotice, summaryLines } from "../src/components/setSummary";

const BTC: SymbolRules = { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
// Bids for Nearby; no liquidations, so Patient must fall back.
const LEVELS: TraderLevels = { limitLevels: [{ price: 63800, weightUsd: 1e5, side: "buy" }], takeProfitLevels: [], liquidationLevels: [] };

function fakeApi() {
  const previews: SetInput[] = [];
  const api: SetCardApi = {
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
  it("starts at Buy, $10, 30x, Deserved, Nearby; the card offers only 30x and 50x", async () => {
    const { api, previews } = fakeApi();
    renderCard(api);
    await waitFor(() => expect(previews.length).toBeGreaterThan(0));
    expect(previews[0]).toMatchObject({ side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "nearby" });
    expect(screen.getByRole("button", { name: "30x" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "50x" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "100x" })).toBeNull();
    // No Take-profit or When rows on the card itself.
    expect(screen.queryByRole("button", { name: "Greedy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Patient" })).toBeNull();
  });

  it("one summary row shows the modes, target, win and max loss, and opens the sheet", async () => {
    const { api } = fakeApi();
    renderCard(api);
    const row = await screen.findByTestId("set-summary-row");
    expect(row.textContent).toContain("Deserved · Nearby");
    await waitFor(() => expect(row.textContent).toMatch(/Target [\d,.]+ · Win \$[\d.]+ · Max loss \$[\d.]+/));
    fireEvent.click(row);
    const sheet = await screen.findByRole("dialog", { name: "Set options" });
    expect(sheet.textContent).toContain("Greedy");
    expect(sheet.textContent).toContain("Patient");
    expect(sheet.textContent).toContain("100x leverage");
  });

  it("100x is chosen inside the sheet, then shows on the card as the active leverage", async () => {
    const { api, previews } = fakeApi();
    renderCard(api);
    fireEvent.click(await screen.findByTestId("set-summary-row"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "100x leverage" })));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "100x" })).toBeTruthy();
    await waitFor(() => expect(previews.at(-1)?.leverage).toBe(100));
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
});
