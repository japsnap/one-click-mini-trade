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
  | { kind: "oneOf"; values: readonly string[] };

const fraction = (max = 1): Check => ({ kind: "number", min: 0, max, minExclusive: true });

/** Every rule key with its allowed type and range. A key missing here is unknown. */
const SCHEMA: Record<string, Check> = {
  "stop.fractionOfLiquidation": { kind: "number", min: 0.1, max: 0.99 },
  "stop.fractionOfTicket": { kind: "number", min: 0.1, max: 0.99 },
  "target.shy": { kind: "number", min: 1, max: 50 },
  "target.deserved": { kind: "number", min: 1, max: 50 },
  "target.greedy": { kind: "number", min: 1, max: 50 },
  "target.default": { kind: "oneOf", values: ["shy", "deserved", "greedy"] },
  "target.wallSearchReach": { kind: "number", min: 1, max: 10 },
  "target.wallMinUsd": { kind: "number", min: 0, max: 1e9 },
  "target.wallBandWidth": fraction(0.05),
  "target.wallFrontGap": { kind: "number", min: 0, max: 0.05 },
  "target.wallJitter": { kind: "number", min: 0, max: 0.05 },
  "target.roundNumberReach": { kind: "number", min: 0, max: 5 },
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
  } else if (!c.values.includes(v as string)) {
    throw bad(`must be one of ${c.values.join(", ")}`);
  }
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
      (out[group] as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  const r = out as unknown as SetRules;
  checkConsistency(r);
  return r;
}

/** Rules that only make sense together. */
function checkConsistency(r: SetRules): void {
  const fail = (m: string) => {
    throw new RulesError(m);
  };
  if (!(r.target.shy <= r.target.deserved && r.target.deserved <= r.target.greedy)) fail('rules "target.shy", "target.deserved", "target.greedy" must not decrease');
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
