import { describe, expect, it } from "vitest";
import { targetWhy, type TakeProfitPick, type ScoredCandidate } from "../src/core/takeProfit";

// The card's short reason: one case per kind of level, both sides where the words differ.
const pick = (over: Partial<TakeProfitPick> = {}) => ({ ratio: 2.5, pulledInFrontOf: null, ...over }) as TakeProfitPick;
const cluster = { kind: "liquidation-cluster", cluster: { notionalUsd: 4_200_000 } } as unknown as ScoredCandidate;
const brake = (kind: string, price = 60000, restingUsd = 1_200_000) =>
  ({ kind, brake: { kind, price, restingUsd } }) as unknown as ScoredCandidate;

describe("targetWhy", () => {
  it("names the cluster's money and whose positions close", () => {
    expect(targetWhy(pick(), cluster, "buy", 0.1)).toBe("Just before $4.2M of other traders' shorts get force-closed.");
    expect(targetWhy(pick(), cluster, "sell", 0.1)).toBe("Just before $4.2M of other traders' longs get force-closed.");
  });
  it("names a wall, a round number, a swing and a trader's exit", () => {
    expect(targetWhy(pick(), brake("wall"), "buy", 0.1)).toBe("Just before a $1.2M stack of sell orders.");
    expect(targetWhy(pick(), brake("wall"), "sell", 0.1)).toBe("Just before a $1.2M stack of buy orders.");
    expect(targetWhy(pick(), brake("round-number"), "buy", 0.1)).toBe("Just before the round number 60,000.");
    expect(targetWhy(pick(), brake("swing"), "buy", 0.1)).toBe("Just below the recent high.");
    expect(targetWhy(pick(), brake("swing"), "sell", 0.1)).toBe("Just above the recent low.");
    expect(targetWhy(pick(), brake("trader-tp"), "buy", 0.1)).toBe("Where skilled traders take profit.");
  });
  it("a level the target was pulled in front of wins over the cluster", () => {
    const p = pick({ pulledInFrontOf: { kind: "wall", price: 61000, restingUsd: 900_000 } });
    expect(targetWhy(p, cluster, "buy", 0.1)).toBe("Just before a $900k stack of sell orders.");
  });
  it("with nothing in the way it gives the multiple of the stop", () => {
    expect(targetWhy(pick(), null, "buy", 0.1)).toMatch(/^Nothing in the way, so 2\.5x the stop distance\.$/);
  });
});
