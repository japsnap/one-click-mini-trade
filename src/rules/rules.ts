/**
 * The active rule set: the defaults (defaultRules.ts) with an optional override laid over
 * them, checked before use. Pure: no file access (the server reads the file, server/rules.ts).
 *
 * Every core function reads activeRules() when it runs, so one setActiveRules() at start
 * changes the whole product. A bad override fails loudly with the key's name: a typo must
 * never fall back to a default without anyone noticing.
 */
import { DEFAULT_RULES, type SetRules } from "./defaultRules";

export { DEFAULT_RULES, type SetRules };

/** Thrown for any bad rule override. The message names the key. */
export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesError";
  }
}

type Check =
  | { kind: "number"; min: number; max: number; integer?: boolean; minExclusive?: boolean }
  | { kind: "numberList"; min: number; max: number; integer?: boolean }
  | { kind: "stringList"; pattern: RegExp }
  | { kind: "oneOf"; values: readonly string[] }
  | { kind: "boolean" }
  /** An object of named numbers ({"shy": 24, ...}); an override may give only some of the names. */
  | { kind: "numberMap"; keys: readonly string[]; min: number; max: number; integer?: boolean }
  /** An old key, still accepted for one release so an override file keyed to it loads; its value is ignored. */
  | { kind: "deprecated"; replacedBy: string };

const fraction = (max = 1): Check => ({ kind: "number", min: 0, max, minExclusive: true });
const MODES = ["shy", "deserved", "greedy"] as const;

/** Every rule key with its allowed type and range. A key missing here is unknown. */
const SCHEMA: Record<string, Check> = {
  "stop.fractionOfLiquidation": { kind: "number", min: 0.1, max: 0.99 },
  "stop.fractionOfTicket": { kind: "number", min: 0.1, max: 0.99 },
  "target.shy": { kind: "number", min: 1, max: 50 },
  "target.deserved": { kind: "number", min: 1, max: 50 },
  "target.greedy": { kind: "number", min: 1, max: 50 },
  "target.default": { kind: "oneOf", values: ["shy", "deserved", "greedy"] },
  "target.ratioSlack": { kind: "number", min: 0, max: 0.5 },
  "target.windowTop": { kind: "number", min: 1, max: 10 },
  "target.horizonHours": { kind: "numberMap", keys: MODES, min: 1, max: 720 },
  "target.rewardPower": { kind: "numberMap", keys: MODES, min: 0, max: 3 },
  "target.volLookbackHours": { kind: "number", min: 2, max: 1000, integer: true },
  "target.volFloor": fraction(0.1),
  "target.minReach": { kind: "number", min: 0, max: 0.5 },
  "target.fuelMinUsd": { kind: "number", min: 0, max: 1e10 },
  "target.fuelClusterWidth": { kind: "number", min: 0.001, max: 0.05 },
  "target.fuelMinTraders": { kind: "number", min: 1, max: 20, integer: true },
  "target.fuelMaxShare": { kind: "number", min: 0.5, max: 1 },
  "target.fuelMinRestUsd": { kind: "number", min: 0, max: 1e10 },
  "target.fuelInset": { kind: "number", min: 0, max: 0.05 },
  "target.fuelDensityBonus": { kind: "number", min: 0, max: 2 },
  "target.fuelMapTopN": { kind: "number", min: 0, max: 2000, integer: true },
  "target.fuelMapRefreshMinutes": { kind: "number", min: 1, max: 1440 },
  "target.fuelMapQuickN": { kind: "number", min: 0, max: 2000, integer: true }, // and at most fuelMapTopN (checkConsistency)
  "target.fuelMapWaitMs": { kind: "number", min: 0, max: 30_000 },
  "target.fuelMapTtlMinutes": { kind: "number", min: 1, max: 60 },
  "target.fuelMapIdleMinutes": { kind: "number", min: 1, max: 1440 },
  "target.brakeWeight": { kind: "number", min: 0, max: 10 },
  "target.brakePass": { kind: "number", min: 0, max: 1 },
  "target.brakeShadow": { kind: "number", min: 0, max: 0.05 },
  "target.sameSpotGap": { kind: "number", min: 0, max: 0.05 },
  "target.wallMinUsd": { kind: "number", min: 0, max: 1e9 },
  "target.wallBandWidth": fraction(0.05),
  "target.wallFrontGap": { kind: "number", min: 0, max: 0.05 },
  "target.wallJitter": { kind: "number", min: 0, max: 0.05 },
  "target.swingLookback": { kind: "numberMap", keys: ["1h", "4h"], min: 0, max: 1000, integer: true },
  // Old keys of the v1 target (wall search, round-number snap), retired 2026-11-20 by the v2 target.
  "target.wallSearchReach": { kind: "deprecated", replacedBy: "target.windowTop" },
  "target.roundNumberReach": { kind: "deprecated", replacedBy: "target.windowTop" },
  // Old keys of the 0.1% band clusters, retired 2026-11-21 by the 1.5% breadth clusters (A11).
  "target.fuelBandWidth": { kind: "deprecated", replacedBy: "target.fuelClusterWidth" },
  "target.fuelMaxBands": { kind: "deprecated", replacedBy: "target.fuelClusterWidth" },
  "chase.enabled": { kind: "boolean" },
  "chase.edgeShare": { kind: "number", min: 0, max: 0.5 },
  "chase.minRange": { kind: "number", min: 0, max: 0.5 },
  "chase.daySigmas": { kind: "number", min: 0, max: 5 },
  "entry.default": { kind: "oneOf", values: ["now", "nearby", "patient", "draw"] },
  "entry.nudge": { kind: "number", min: 0, max: 0.01 },
  "entry.nearbyMinDistance": { kind: "number", min: 0, max: 0.1 },
  "entry.nearbyMaxDistance": fraction(0.1),
  "entry.nearbyBandWidth": fraction(0.05),
  "entry.nearbyTopBands": { kind: "number", min: 1, max: 50, integer: true },
  "entry.nearbyMinUsd": { kind: "number", min: 0, max: 1e9 },
  "entry.patientMinDistance": { kind: "number", min: 0, max: 0.5 },
  "entry.patientMaxDistance": fraction(0.5),
  "entry.patientBandWidth": fraction(0.05),
  "entry.drawMaxOrders": { kind: "number", min: 1, max: 9, integer: true },
  "ticket.choices": { kind: "numberList", min: 1, max: 100_000 },
  "ticket.default": { kind: "number", min: 1, max: 100_000 },
  "leverage.choices": { kind: "numberList", min: 1, max: 125, integer: true },
  "leverage.default": { kind: "number", min: 1, max: 125, integer: true },
  "risk.liquidationShrinkBlock": fraction(1),
  "risk.liquidationShrinkWarn": fraction(1),
  "risk.assumedMaintenanceRate": { kind: "number", min: 0, max: 0.05 },
  "risk.assumedFeeRate": { kind: "number", min: 0, max: 0.01 },
  "profitShare.blackboard": { kind: "number", min: 0, max: 1 },
  "profitShare.trader": { kind: "number", min: 0, max: 1 },
  "live.maxTicketUsd": { kind: "number", min: 0, max: 100_000, minExclusive: true },
  "live.symbols": { kind: "stringList", pattern: /^[A-Z0-9]{2,20}USDT$/ },
};
const GROUPS = new Set(Object.keys(SCHEMA).map((k) => k.split(".")[0] as string));

function checkLeaf(key: string, v: unknown, c: Check): void {
  const bad = (why: string) => new RulesError(`rule "${key}": ${why} (got ${JSON.stringify(v)})`);
  const inRange = (x: number, lim: { min: number; max: number; integer?: boolean; minExclusive?: boolean }) =>
    Number.isFinite(x) && (lim.minExclusive ? x > lim.min : x >= lim.min) && x <= lim.max && (!lim.integer || Number.isInteger(x));
  if (c.kind === "number") {
    if (typeof v !== "number") throw bad("must be a number");
    if (!inRange(v, c)) throw bad(`must be ${c.minExclusive ? "above" : "at least"} ${c.min} and at most ${c.max}${c.integer ? ", a whole number" : ""}`);
  } else if (c.kind === "numberList") {
    if (!Array.isArray(v) || v.length === 0) throw bad("must be a non-empty list of numbers");
    for (const x of v) if (typeof x !== "number" || !inRange(x, c)) throw bad(`every entry must be a number from ${c.min} to ${c.max}${c.integer ? ", whole" : ""}`);
    if (new Set(v).size !== v.length) throw bad("has the same value twice");
  } else if (c.kind === "stringList") {
    if (!Array.isArray(v) || v.length === 0) throw bad("must be a non-empty list of names");
    for (const x of v) if (typeof x !== "string" || !c.pattern.test(x)) throw bad("every entry must look like BTCUSDT");
  } else if (c.kind === "numberMap") {
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad(`must be an object with ${c.keys.join(", ")}`);
    for (const [name, x] of Object.entries(v as Record<string, unknown>)) {
      if (name.startsWith("_")) continue;
      if (!c.keys.includes(name)) throw new RulesError(`unknown rule "${key}.${name}" (known: ${c.keys.join(", ")})`);
      if (typeof x !== "number" || !inRange(x, c)) {
        throw new RulesError(`rule "${key}.${name}": must be a number from ${c.min} to ${c.max}${c.integer ? ", a whole number" : ""} (got ${JSON.stringify(x)})`);
      }
    }
  } else if (c.kind === "boolean") {
    if (typeof v !== "boolean") throw bad("must be true or false");
  } else if (c.kind === "deprecated") {
    // Accepted and ignored; the server's loader names it so the owner can remove it.
    if (typeof v !== "number") throw bad("must be a number (the key is no longer used)");
  } else if (!c.values.includes(v as string)) {
    throw bad(`must be one of ${c.values.join(", ")}`);
  }
}

/** Old keys present in an override (parsed JSON), as "group.key" names. Their values are ignored. */
export function deprecatedKeysIn(override: unknown): string[] {
  const out: string[] = [];
  if (override === null || typeof override !== "object" || Array.isArray(override)) return out;
  for (const [group, value] of Object.entries(override as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    for (const k of Object.keys(value as Record<string, unknown>)) {
      const c = SCHEMA[`${group}.${k}`];
      if (c?.kind === "deprecated") out.push(`${group}.${k} (replaced by ${c.replacedBy})`);
    }
  }
  return out;
}

/**
 * Lay an override (parsed JSON) over a base rule set and check the result. Throws a
 * RulesError naming the key for an unknown key, a wrong type, an out-of-range value, or
 * rules that contradict each other (a default that is not among the choices).
 */
export function mergeRules(override: unknown, base: SetRules = DEFAULT_RULES): SetRules {
  if (override === null || typeof override !== "object" || Array.isArray(override)) throw new RulesError("the rules file must hold one JSON object");
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  for (const [group, value] of Object.entries(override as Record<string, unknown>)) {
    if (group.startsWith("_")) continue; // "_comment" keys let the file explain itself
    if (!GROUPS.has(group)) throw new RulesError(`unknown rule group "${group}" (known: ${[...GROUPS].join(", ")})`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RulesError(`rule group "${group}" must be an object`);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith("_")) continue;
      const key = `${group}.${k}`;
      const check = SCHEMA[key];
      if (!check) throw new RulesError(`unknown rule "${key}"`);
      checkLeaf(key, v, check);
      if (check.kind === "deprecated") continue; // accepted, not used
      const g = out[group] as Record<string, unknown>;
      if (check.kind === "numberMap") g[k] = { ...(g[k] as Record<string, number>), ...withoutNotes(v as Record<string, unknown>) };
      else g[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  const r = out as unknown as SetRules;
  checkConsistency(r);
  return r;
}

/** An object without its "_comment" style keys. */
function withoutNotes(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));
}

/** Rules that only make sense together. */
function checkConsistency(r: SetRules): void {
  const fail = (m: string) => {
    throw new RulesError(m);
  };
  if (!(r.target.shy <= r.target.deserved && r.target.deserved <= r.target.greedy)) fail('rules "target.shy", "target.deserved", "target.greedy" must not decrease');
  if (!(r.target.fuelMapQuickN <= r.target.fuelMapTopN)) fail('rule "target.fuelMapQuickN" must not be above "target.fuelMapTopN"');
  if (!r.ticket.choices.includes(r.ticket.default)) fail(`rule "ticket.default" (${r.ticket.default}) must be one of "ticket.choices"`);
  if (!r.leverage.choices.includes(r.leverage.default)) fail(`rule "leverage.default" (${r.leverage.default}) must be one of "leverage.choices"`);
  if (!(r.entry.nearbyMinDistance < r.entry.nearbyMaxDistance)) fail('rule "entry.nearbyMinDistance" must be below "entry.nearbyMaxDistance"');
  if (!(r.entry.patientMinDistance < r.entry.patientMaxDistance)) fail('rule "entry.patientMinDistance" must be below "entry.patientMaxDistance"');
  if (!(r.risk.liquidationShrinkWarn <= r.risk.liquidationShrinkBlock)) fail('rule "risk.liquidationShrinkWarn" must not be above "risk.liquidationShrinkBlock"');
  if (r.profitShare.blackboard + r.profitShare.trader > 1) fail('rules "profitShare.blackboard" + "profitShare.trader" must add up to at most 1');
  for (const lev of r.leverage.choices) {
    if (!(r.risk.assumedMaintenanceRate < 1 / lev)) fail(`rule "risk.assumedMaintenanceRate" must stay below 1/leverage for ${lev}x`);
  }
}

let active: SetRules = DEFAULT_RULES;

/** The rule set every core function uses right now. */
export function activeRules(): SetRules {
  return active;
}

/** Switch the whole product to a rule set (made by mergeRules). Pass nothing to go back to the defaults. */
export function setActiveRules(r: SetRules = DEFAULT_RULES): void {
  active = r;
}
