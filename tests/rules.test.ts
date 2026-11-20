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

describe("Rule set: the target v2 knobs (Sets_Rules.md A, 2026-11-20)", () => {
  it("hold the spec's defaults", () => {
    const t = DEFAULT_RULES.target;
    expect([t.ratioSlack, t.windowTop, t.volLookbackHours, t.volFloor, t.minReach]).toEqual([0.1, 2, 72, 0.002, 0.03]);
    expect(t.horizonHours).toEqual({ shy: 24, deserved: 48, greedy: 96 });
    expect(t.rewardPower).toEqual({ shy: 0.5, deserved: 1, greedy: 1.5 });
    expect([t.fuelMinUsd, t.fuelInset, t.fuelDensityBonus, t.fuelMapTopN, t.fuelMapRefreshMinutes]).toEqual([100_000, 0.0005, 0.1, 600, 5]);
    // A10 and A11 (2026-11-21).
    expect([t.fuelClusterWidth, t.fuelMinTraders, t.fuelMaxShare, t.fuelMinRestUsd]).toEqual([0.015, 2, 0.9, 100_000]);
    expect([t.fuelMapQuickN, t.fuelMapWaitMs, t.fuelMapTtlMinutes, t.fuelMapIdleMinutes]).toEqual([200, 8000, 5, 10]);
    expect(DEFAULT_RULES.chase).toEqual({ enabled: true, edgeShare: 0.1, minRange: 0.03, daySigmas: 1.5 });
    expect("fuelBandWidth" in t || "fuelMaxBands" in t).toBe(false);
    expect([t.brakeWeight, t.brakePass, t.brakeShadow, t.sameSpotGap]).toEqual([0.5, 0.8, 0.003, 0.001]);
    expect([t.wallMinUsd, t.wallBandWidth, t.wallFrontGap, t.wallJitter]).toEqual([25_000, 0.0005, 0.0003, 0.0003]);
    expect(t.swingLookback).toEqual({ "1h": 48, "4h": 42 });
  });

  it("every new bound refuses a value just outside it, naming the key (negative)", () => {
    const cases: Array<[string, unknown]> = [
      ["ratioSlack", -0.01], ["ratioSlack", 0.51],
      ["windowTop", 0.99], ["windowTop", 10.1],
      ["volLookbackHours", 1], ["volLookbackHours", 1001], ["volLookbackHours", 72.5],
      ["volFloor", 0], ["volFloor", 0.11],
      ["minReach", -0.01], ["minReach", 0.51],
      ["fuelClusterWidth", 0.0009], ["fuelClusterWidth", 0.051],
      ["fuelMinTraders", 0], ["fuelMinTraders", 21], ["fuelMinTraders", 2.5],
      ["fuelMaxShare", 0.49], ["fuelMaxShare", 1.01],
      ["fuelMinRestUsd", -1], ["fuelMinRestUsd", 1e11],
      ["fuelMapQuickN", -1], ["fuelMapQuickN", 2001], ["fuelMapQuickN", 1.5],
      ["fuelMapWaitMs", -1], ["fuelMapWaitMs", 30_001],
      ["fuelMapTtlMinutes", 0.5], ["fuelMapTtlMinutes", 61],
      ["fuelMapIdleMinutes", 0.5], ["fuelMapIdleMinutes", 1441],
      ["fuelMinUsd", -1], ["fuelMinUsd", 1e11],
      ["fuelInset", -0.001], ["fuelInset", 0.06],
      ["fuelDensityBonus", -0.1], ["fuelDensityBonus", 2.1],
      ["fuelMapTopN", -1], ["fuelMapTopN", 2001], ["fuelMapTopN", 600.5],
      ["fuelMapRefreshMinutes", 0.5], ["fuelMapRefreshMinutes", 1441],
      ["brakeWeight", -0.1], ["brakeWeight", 10.1],
      ["brakePass", -0.1], ["brakePass", 1.1],
      ["brakeShadow", -0.001], ["brakeShadow", 0.06],
      ["sameSpotGap", -0.001], ["sameSpotGap", 0.06],
    ];
    for (const [k, v] of cases) expect(() => mergeRules({ target: { [k]: v } }), `${k} = ${v}`).toThrow(new RegExp(`"target\\.${k}"`));
    // The anti-chase guard's own group (A12).
    const chase: Array<[string, unknown]> = [["edgeShare", -0.01], ["edgeShare", 0.51], ["daySigmas", -0.1], ["daySigmas", 5.1], ["minRange", -0.01], ["minRange", 0.51], ["enabled", "yes"], ["enabled", 1]];
    for (const [k, v] of chase) expect(() => mergeRules({ chase: { [k]: v } }), `chase.${k} = ${v}`).toThrow(new RegExp(`"chase\\.${k}"`));
    expect(mergeRules({ chase: { enabled: false, edgeShare: 0.5, daySigmas: 5 } }).chase).toEqual({ enabled: false, edgeShare: 0.5, minRange: 0.03, daySigmas: 5 });
    // The quick map can never be bigger than the map (a contradiction, refused).
    expect(() => mergeRules({ target: { fuelMapTopN: 100 } })).toThrow(/"target.fuelMapQuickN" must not be above "target.fuelMapTopN"/);
    expect(mergeRules({ target: { fuelMapTopN: 100, fuelMapQuickN: 100 } }).target.fuelMapQuickN).toBe(100);
    const maps: Array<[string, string, unknown]> = [
      ["horizonHours", "deserved", 0.5], ["horizonHours", "greedy", 721],
      ["rewardPower", "greedy", -0.1], ["rewardPower", "shy", 3.1],
      ["swingLookback", "1h", -1], ["swingLookback", "4h", 1001], ["swingLookback", "4h", 1.5],
    ];
    for (const [k, n, v] of maps) expect(() => mergeRules({ target: { [k]: { [n]: v } } }), `${k}.${n} = ${v}`).toThrow(new RegExp(`"target\\.${k}\\.${n}"`));
    expect(() => mergeRules({ target: { horizonHours: { brave: 10 } } })).toThrow(/unknown rule "target.horizonHours.brave"/);
    expect(() => mergeRules({ target: { horizonHours: 48 } })).toThrow(/"target.horizonHours": must be an object/);
    // The edges themselves are allowed.
    expect(() => mergeRules({ target: { ratioSlack: 0.5, windowTop: 10, minReach: 0.5, fuelMapTopN: 2000, horizonHours: { shy: 1, greedy: 720 }, rewardPower: { shy: 0, greedy: 3 } } })).not.toThrow();
  });

  it("a per-mode override keeps the other modes; the knobs change the pick", () => {
    expect(mergeRules({ target: { horizonHours: { deserved: 72, _comment: "note" } } }).target.horizonHours).toEqual({ shy: 24, deserved: 72, greedy: 96 });
    const at = () => buildSetPlan({ input: { symbol: "BTCUSDT", side: "buy", ticketUsd: 10, leverage: 30, tpMode: "deserved", entryMode: "now" }, currentPrice: 64000, rules: BTC, levels: NO_LEVELS, random: () => 0.5, market: { sigma1h: 0.007 } });
    expect(at().takeProfit.source).toBe("round-number"); // 67,000 is reachable at 0.7% an hour
    setActiveRules(mergeRules({ target: { minReach: 0.5 } }));
    const strict = at();
    expect(strict.takeProfit.source).toBe("exact-ratio"); // nothing has a 50% chance
    expect(strict.takeProfit.reason).toMatch(/^Long from 64,000; take profit \(sell\) at [0-9,.]+, 2x the stop \(sell at [0-9,.]+\): the bare 2x/);
  });

  it("the old band keys fuelBandWidth and fuelMaxBands (retired 2026-11-21 by the 1.5% clusters) still load and are ignored", () => {
    const r = mergeRules({ target: { fuelBandWidth: 0.001, fuelMaxBands: 5 } });
    expect(r).toEqual(DEFAULT_RULES);
    expect(() => mergeRules({ target: { fuelMaxBands: "5" } })).toThrow(/"target.fuelMaxBands": must be a number/);
    const dir = mkdtempSync(path.join(tmpdir(), "set-rules-bands-"));
    const file = path.join(dir, "bands.json");
    writeFileSync(file, JSON.stringify({ target: { fuelBandWidth: 0.002, fuelMaxBands: 3 } }));
    expect(loadRulesFile({ SETS_RULES_FILE: file }, dir).ignored).toEqual(["target.fuelBandWidth (replaced by target.fuelClusterWidth)", "target.fuelMaxBands (replaced by target.fuelClusterWidth)"]);
  });

  it("the old keys wallSearchReach and roundNumberReach still load and are ignored (deprecation window); the loader names them", () => {
    const r = mergeRules({ target: { wallSearchReach: 1.5, roundNumberReach: 0.35, greedy: 5 } });
    expect(r.target.greedy).toBe(5);
    expect("wallSearchReach" in r.target).toBe(false);
    expect("roundNumberReach" in r.target).toBe(false);
    expect(() => mergeRules({ target: { roundNumberReach: "0.35" } })).toThrow(/"target.roundNumberReach": must be a number/);
    const dir = mkdtempSync(path.join(tmpdir(), "set-rules-old-"));
    const file = path.join(dir, "old.json");
    writeFileSync(file, JSON.stringify({ target: { wallSearchReach: 2, roundNumberReach: 0.5, deserved: 2.5 } }));
    const loaded = loadRulesFile({ SETS_RULES_FILE: file }, dir);
    expect(activeRules().target.deserved).toBe(2.5);
    expect(loaded.ignored).toEqual(["target.wallSearchReach (replaced by target.windowTop)", "target.roundNumberReach (replaced by target.windowTop)"]);
  });
});
