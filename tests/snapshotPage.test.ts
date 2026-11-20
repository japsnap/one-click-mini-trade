/**
 * The pure parts of scripts/snapshot-page.ts: the key format, the 162 combinations, a seed that
 * leaves the ticket out, and the check that prices never change with the ticket. The script's
 * network run is not tested here (it reads live public data); its output was read back by hand.
 */
import { describe, expect, it } from "vitest";
import { buildSetPlan } from "../src/core/plan";
import { seededRandom, type SymbolRules } from "../src/core/types";
import { comboKey, combinations, comboSeed, rowFromError, rowFromOutcome, ticketMismatches, type Combo } from "../scripts/snapshot-page";

const BTC: SymbolRules = { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };

describe("snapshot-page: keys, combinations, seeds", () => {
  it("the key is <ticket>_<side>_<lev>_<greed>_<entry>", () => {
    expect(comboKey({ ticket: 10, side: "buy", lev: 30, greed: "deserved", entry: "now" } as Combo)).toBe("10_buy_30_deserved_now");
    for (const c of combinations()) expect(comboKey(c)).toMatch(/^(10|30|100)_(buy|sell)_(30|50|100)_(shy|deserved|greedy)_(now|nearby|patient)$/);
  });

  it("162 combinations (3 tickets x 2 sides x 3 leverages x 3 greeds x 3 entries), every key once", () => {
    const keys = combinations().map(comboKey);
    expect(keys).toHaveLength(162);
    expect(new Set(keys).size).toBe(162);
  });

  it("the seed ignores the ticket and changes with every other choice", () => {
    const a = { side: "buy", lev: 30, greed: "deserved", entry: "nearby" } as const;
    expect(comboSeed({ ...a, ticket: 10 })).toBe(comboSeed({ ...a, ticket: 100 }));
    expect(Number.isInteger(comboSeed(a))).toBe(true);
    const seeds = new Set(combinations().map(comboSeed));
    expect(seeds.size).toBe(54); // 2 sides x 3 leverages x 3 greeds x 3 entries
  });

  it("with the same seed, the real plan builder gives the same prices for $10, $30 and $100 (REAL: buildSetPlan, no fakes)", () => {
    const levels = {
      limitLevels: [
        { price: 63900, weightUsd: 40_000, side: "buy" as const },
        { price: 63850, weightUsd: 90_000, side: "buy" as const },
        { price: 63780, weightUsd: 25_000, side: "buy" as const },
      ],
      takeProfitLevels: [],
      liquidationLevels: [],
    };
    const sets: Record<string, ReturnType<typeof rowFromOutcome>> = {};
    for (const ticket of [10, 30, 100] as const) {
      const c = { ticket, side: "buy", lev: 50, greed: "deserved", entry: "nearby" } as Combo;
      const plan = buildSetPlan({ input: { symbol: "BTCUSDT", side: "buy", ticketUsd: ticket, leverage: 50, tpMode: "deserved", entryMode: "nearby" }, currentPrice: 64000, rules: BTC, levels, random: seededRandom(comboSeed(c)) });
      sets[comboKey(c)] = rowFromOutcome({ plan, sources: {} as never, refusal: null });
    }
    expect(ticketMismatches(sets)).toEqual([]);
    const [a, b] = [sets["10_buy_50_deserved_nearby"]!, sets["100_buy_50_deserved_nearby"]!];
    expect(a.e).toBe(b.e);
    expect(a.t).toBe(b.t);
    // Only the size moves: $500 and $5,000 of notional, floored to the 0.001 BTC step.
    expect([a.q, b.q]).toEqual([0.007, 0.078]);
    expect(b.w! / a.w!).toBeCloseTo(b.q! / a.q!, 1); // profits are rounded to the cent
    expect(a.x).toBeLessThan(0);
  });

  it("ticketMismatches names a group whose price moved with the ticket (negative)", () => {
    const row = (t: number) => ({ px: 1, used: "now", why: "", fb: [], e: 1, s: 0.9, l: 0.8, t, r: 2, src: "wall", reason: "", w: 1, x: -1, q: 1 });
    expect(ticketMismatches({ "10_buy_30_shy_now": row(1.2), "30_buy_30_shy_now": row(1.2), "100_buy_30_shy_now": row(1.3) })).toEqual(["buy_30_shy_now"]);
  });

  it("a refused or failed combination keeps its reason and has no prices", () => {
    const plan = buildSetPlan({ input: { symbol: "BTCUSDT", side: "sell", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, currentPrice: 64000, rules: BTC, levels: { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] }, random: () => 0.5 });
    const r = rowFromOutcome({ plan, sources: {} as never, refusal: { status: "refused: chasing", message: "BTC fell 7.6% in a day, below its 3-day low.\nA Short here would follow the move at its edge.", chase: null } });
    expect(r.refused).toEqual({ status: "refused: chasing", message: expect.stringContaining("A Short here") });
    expect([r.e, r.s, r.l, r.t, r.w, r.x, r.q]).toEqual([null, null, null, null, null, null, null]);
    const f = rowFromError(new RangeError("ticket too small"), 64000);
    expect(f.refused).toEqual({ status: "error: RangeError", message: "ticket too small" });
  });
});
