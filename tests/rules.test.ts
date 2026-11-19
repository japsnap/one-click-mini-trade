/**
 * The rule set (src/rules): defaults, an override laid over them, and the load-time check.
 * REAL: the real merge and check, the real plan builder and input parser reading the
 * active rules, and the real file loader on files written to a temp folder (never
 * rules/my-rules.json). Every test puts the default rules back afterwards.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { activeRules, DEFAULT_RULES, mergeRules, RulesError, setActiveRules } from "../src/rules/rules";
import { buildSetPlan } from "../src/core/plan";
import { parseSetInput } from "../src/core/validate";
import { checkNewSetRisk } from "../src/core/risk";
import type { SymbolRules } from "../src/core/types";
import { loadConfig } from "../server/config";
import { loadRulesFile } from "../server/rules";

const BTC: SymbolRules = { symbol: "BTCUSDT", tickSize: 0.1, stepSize: 0.001, minQty: 0.001, marketStepSize: 0.001, marketMinQty: 0.001, minNotionalUsd: 5 };
const NO_LEVELS = { limitLevels: [], takeProfitLevels: [], liquidationLevels: [] };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const plan = () =>
  buildSetPlan({ input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, currentPrice: 64000, rules: BTC, levels: NO_LEVELS, random: () => 0.5 });

afterEach(() => setActiveRules());

describe("Rule set: defaults", () => {
  it("hold the product numbers of 2026-11-16 to 20 and pass their own check", () => {
    expect(mergeRules({})).toEqual(DEFAULT_RULES);
    expect(DEFAULT_RULES.stop.fractionOfLiquidation).toBe(0.85);
    expect([DEFAULT_RULES.target.shy, DEFAULT_RULES.target.deserved, DEFAULT_RULES.target.greedy]).toEqual([1, 2, 4]);
    expect(DEFAULT_RULES.ticket.choices).toEqual([10, 30, 100]);
    expect(DEFAULT_RULES.leverage).toEqual({ choices: [30, 50, 100], default: 30 });
    expect([DEFAULT_RULES.risk.liquidationShrinkBlock, DEFAULT_RULES.risk.liquidationShrinkWarn]).toEqual([0.3, 0.1]);
    expect(DEFAULT_RULES.profitShare).toEqual({ blackboard: 0.05, trader: 0.05 });
    expect(activeRules()).toBe(DEFAULT_RULES);
  });
});

describe("Rule set: an override changes the product", () => {
  it("a higher Deserved ratio and a tighter stop change the plan; going back to the defaults restores it", () => {
    const before = plan();
    expect(before.takeProfit.ratio).toBeGreaterThanOrEqual(2);
    expect(before.takeProfit.ratio).toBeLessThan(3);
    setActiveRules(mergeRules({ target: { deserved: 3 }, stop: { fractionOfLiquidation: 0.7 } }));
    const after = plan();
    expect(after.takeProfit.ratio).toBeGreaterThanOrEqual(3);
    // 70% of the way to liquidation is nearer the entry than 85%.
    expect(after.stop.price).toBeGreaterThan(before.stop.price);
    expect(after.stop.fractionOfLiquidation).toBe(0.7);
    setActiveRules();
    expect(plan()).toEqual(before);
  });

  it("ticket and leverage choices gate the input; profit shares change the split; the block threshold changes the risk check", () => {
    setActiveRules(mergeRules({ ticket: { choices: [20, 50], default: 20 }, leverage: { choices: [20, 30], default: 20 }, profitShare: { blackboard: 0.1, trader: 0 } }));
    expect(parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 20, leverage: 20, entryMode: "now" }).ticketUsd).toBe(20);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 20, entryMode: "now" })).toThrow(/ticketUsd must be one of 20, 50/);
    expect(() => parseSetInput({ symbol: "BTCUSDT", side: "buy", ticketUsd: 20, leverage: 50, entryMode: "now" })).toThrow(/leverage must be one of 20, 30/);
    const p = buildSetPlan({ input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 20, leverage: 20, tpMode: "deserved", entryMode: "now" }, currentPrice: 64000, rules: BTC, levels: NO_LEVELS, random: () => 0.5 });
    expect(p.expected.feeSplitOnWin.blackboardUsd).toBeCloseTo(p.expected.profitAtTpUsd * 0.1, 2);
    expect(p.expected.feeSplitOnWin.traderUsd).toBe(0);

    // A Set that shrinks an ETH liquidation by about 17% is fine at the default 30% block, refused at 15%.
    const account = {
      cushionUsd: 306.15,
      availableBalanceUsd: 167,
      equityUsd: 320,
      positions: [{ symbol: "ETHUSDT", positionSide: "BOTH" as const, positionAmt: 2, entryPrice: 3000, markPrice: 3000, maintMarginUsd: 24, isolated: false }],
    };
    const set = { symbol: "BTCUSDT", side: "buy" as const, qty: 0.2, price: 64000, stopPrice: 63500, maintenanceMarginRate: 0.003, positionMode: "one-way" as const };
    setActiveRules();
    const relaxed = checkNewSetRisk(account, set, []);
    const shrink = relaxed.rows.find((r) => r.symbol === "ETHUSDT")!.shrink;
    expect(shrink).toBeGreaterThan(0.15);
    expect(shrink).toBeLessThan(0.3);
    expect(relaxed.ok).toBe(true);
    setActiveRules(mergeRules({ risk: { liquidationShrinkBlock: 0.15, liquidationShrinkWarn: 0.05 } }));
    const strict = checkNewSetRisk(account, set, []);
    expect(strict.ok).toBe(false);
    expect(strict.reasons[0]).toMatch(/ETH long's liquidation .* closer to the price \(the limit is 15%\)/);
  });

  it("the live cap defaults to the rules; MAX_LIVE_TICKET_USD still wins when set", () => {
    setActiveRules(mergeRules({ live: { maxTicketUsd: 30, symbols: ["ETHUSDT"] } }));
    expect(loadConfig({})).toMatchObject({ maxLiveTicketUsd: 30, liveSymbols: ["ETHUSDT"] });
    expect(loadConfig({ MAX_LIVE_TICKET_USD: "10" }).maxLiveTicketUsd).toBe(10);
  });
});

describe("Rule set: a bad override fails loudly with the key's name (negative)", () => {
  it("an out-of-range value is refused", () => {
    expect(() => mergeRules({ stop: { fractionOfLiquidation: 1.5 } })).toThrow(RulesError);
    expect(() => mergeRules({ stop: { fractionOfLiquidation: 1.5 } })).toThrow(/"stop.fractionOfLiquidation": must be at least 0.1 and at most 0.99 \(got 1.5\)/);
    expect(() => mergeRules({ target: { shy: 0.5 } })).toThrow(/"target.shy"/);
    expect(() => mergeRules({ leverage: { choices: [30, 200] } })).toThrow(/"leverage.choices"/);
    expect(() => mergeRules({ entry: { nearbyTopBands: 2.5 } })).toThrow(/"entry.nearbyTopBands".*whole number/);
  });

  it("a wrong type is refused", () => {
    expect(() => mergeRules({ target: { deserved: "2" } })).toThrow(/"target.deserved": must be a number \(got "2"\)/);
    expect(() => mergeRules({ ticket: { choices: 10 } })).toThrow(/"ticket.choices": must be a non-empty list/);
    expect(() => mergeRules({ target: { default: "brave" } })).toThrow(/"target.default": must be one of shy, deserved, greedy/);
    expect(() => mergeRules({ stop: 0.85 })).toThrow(/rule group "stop" must be an object/);
    expect(() => mergeRules([1])).toThrow(/one JSON object/);
  });

  it("an unknown key or group is refused; _comment keys are allowed", () => {
    expect(() => mergeRules({ target: { greedyy: 5 } })).toThrow(/unknown rule "target.greedyy"/);
    expect(() => mergeRules({ targets: { greedy: 5 } })).toThrow(/unknown rule group "targets"/);
    expect(mergeRules({ _comment: "note", target: { _comment: "note", greedy: 5 } }).target.greedy).toBe(5);
  });

  it("rules that contradict each other are refused", () => {
    expect(() => mergeRules({ ticket: { choices: [20, 50] } })).toThrow(/"ticket.default" \(10\) must be one of "ticket.choices"/);
    expect(() => mergeRules({ target: { deserved: 5 } })).toThrow(/must not decrease/);
    expect(() => mergeRules({ risk: { liquidationShrinkWarn: 0.5 } })).toThrow(/"risk.liquidationShrinkWarn" must not be above/);
    expect(() => mergeRules({ profitShare: { blackboard: 0.6, trader: 0.5 } })).toThrow(/at most 1/);
    expect(() => mergeRules({ leverage: { choices: [30, 125] }, risk: { assumedMaintenanceRate: 0.01 } })).toThrow(/below 1\/leverage for 125x/);
  });
});

describe("Rule set: the file loader (server/rules.ts)", () => {
  it("SETS_RULES_FILE is read, checked and made active; the source is reported; a missing named file or a bad value stops the start (negative)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "set-rules-"));
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ target: { greedy: 6 } }));
    const loaded = loadRulesFile({ SETS_RULES_FILE: good }, dir);
    expect(loaded.source).toBe(good);
    expect(activeRules().target.greedy).toBe(6);

    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ stop: { fractionOfTicket: 2 } }));
    expect(() => loadRulesFile({ SETS_RULES_FILE: bad }, dir)).toThrow(/bad.json: rule "stop.fractionOfTicket"/);
    writeFileSync(bad, "{ not json");
    expect(() => loadRulesFile({ SETS_RULES_FILE: bad }, dir)).toThrow(/not valid JSON/);
    expect(() => loadRulesFile({ SETS_RULES_FILE: path.join(dir, "nope.json") }, dir)).toThrow(/does not exist/);
  });

  it("with no named file and no rules/my-rules.json the defaults apply", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "set-rules-none-"));
    setActiveRules(mergeRules({ target: { greedy: 6 } }));
    expect(loadRulesFile({}, empty).source).toMatch(/^defaults/);
    expect(activeRules()).toBe(DEFAULT_RULES);
  });

  it("the shipped rules/my-rules.example.json passes the check (load-time check of the example)", () => {
    const loaded = loadRulesFile({ SETS_RULES_FILE: "rules/my-rules.example.json" }, ROOT);
    expect(loaded.rules.leverage.default).toBe(20);
    expect(loaded.rules.target.deserved).toBe(2.5);
  });
});
