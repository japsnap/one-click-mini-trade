/**
 * The default rule set of a Set: every number a product owner may want to tune, in one
 * place (owner's order 2026-11-20). What Blackboard receives is the code plus this default
 * set; each deployment can lay its own JSON file over it (rules/my-rules.example.json,
 * loaded by server/rules.ts and checked by src/rules/rules.ts).
 *
 * Units: fractions are decimals (0.005 = 0.5%), money is USD, leverage a multiplier.
 * Changing a value here changes the product for everyone; prefer an override file.
 */
export const DEFAULT_RULES = {
  stop: {
    /** The stop sits this share of the way from the entry to the liquidation price. */
    fractionOfLiquidation: 0.85,
    /** Once filled, a Set also stops before it has lost this share of its own ticket. */
    fractionOfTicket: 0.85,
  },
  target: {
    /** Shy: the take-profit wins at least this many times the loss at the stop. */
    shy: 1,
    /** Deserved: at least this many times the loss. */
    deserved: 2,
    /** Greedy: at least this many times the loss. */
    greedy: 4,
    /** The target choice a new card starts on. */
    default: "deserved" as "shy" | "deserved" | "greedy",
    /** Look for a wall of resting orders up to this many times the minimum target distance. */
    wallSearchReach: 1.5,
    /** The smallest pile of resting orders in one band that counts as a wall, in USD. */
    wallMinUsd: 25_000,
    /** Width of one band when adding up resting orders, as a share of the entry price. */
    wallBandWidth: 0.0005,
    /** The target sits this far in front of the wall, as a share of the wall's price. */
    wallFrontGap: 0.0003,
    /** The target moves at random by up to this much either way, as a share of price. */
    wallJitter: 0.0003,
    /** No wall: snap to a round number up to this share of the target distance beyond it. */
    roundNumberReach: 0.35,
  },
  entry: {
    /** The entry choice a new card starts on: now, nearby, patient or draw. */
    default: "nearby" as "now" | "nearby" | "patient" | "draw",
    /** Every limit price moves at random by up to this share of the price. */
    nudge: 0.0005,
    /** Nearby: skilled traders' orders count from this far from the price... */
    nearbyMinDistance: 0.0005,
    /** ...up to this far. */
    nearbyMaxDistance: 0.005,
    /** Nearby: width of one band of orders, as a share of the price. */
    nearbyBandWidth: 0.0005,
    /** Nearby: how many of the heaviest bands stay in the random pick. */
    nearbyTopBands: 3,
    /** Nearby: a band needs at least this many USD of orders to count. */
    nearbyMinUsd: 5_000,
    /** Patient: liquidation clusters count from this far from the price... */
    patientMinDistance: 0.005,
    /** ...up to this far. */
    patientMaxDistance: 0.05,
    /** Patient: width of one band of liquidation prices, as a share of the price. */
    patientBandWidth: 0.001,
    /** Draw: the ticket is split into at most this many orders. */
    drawMaxOrders: 5,
  },
  ticket: {
    /** The ticket sizes offered on the card, in USD. */
    choices: [10, 30, 100] as number[],
    /** The ticket a new card starts on. */
    default: 10,
  },
  leverage: {
    /** The leverages offered in the options sheet. */
    choices: [30, 50, 100] as number[],
    /** The leverage a new card starts on. */
    default: 30,
  },
  risk: {
    /** Refuse a Set that pulls any position's liquidation more than this share closer to the price. */
    liquidationShrinkBlock: 0.3,
    /** Warn when it pulls a liquidation more than this share closer. */
    liquidationShrinkWarn: 0.1,
    /** Maintenance margin rate assumed when the exchange's own brackets are not loaded. */
    assumedMaintenanceRate: 0.005,
    /** Trading fee assumed for the new Set's fill in the risk check, as a share of its size. */
    assumedFeeRate: 0.001,
  },
  profitShare: {
    /** Share of a winning Set's profit that goes to Blackboard. */
    blackboard: 0.05,
    /** Share that goes to the trader whose levels were copied. */
    trader: 0.05,
  },
  live: {
    /** The largest ticket the demo server sends for real, in USD (env MAX_LIVE_TICKET_USD wins when set). */
    maxTicketUsd: 10,
    /** The only symbols the demo server trades for real. */
    symbols: ["BTCUSDT", "ETHUSDT"] as string[],
  },
};

export type SetRules = typeof DEFAULT_RULES;
