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
    /** A level may sit this much ratio inside the floor and still count (owner's ruling 2026-11-20: "0.1 x is fine"). */
    ratioSlack: 0.1,
    /** Levels are looked for up to this many times the floor (Deserved: up to 4x). */
    windowTop: 2,
    /** Hours over which the chance of reaching a level is measured, per target choice. */
    horizonHours: { shy: 24, deserved: 48, greedy: 96 },
    /** How much a bigger ratio counts in the score (ratio to this power), per target choice. */
    rewardPower: { shy: 0.5, deserved: 1, greedy: 1.5 },
    /** Hours of one-hour candles used to measure how much the price moves. */
    volLookbackHours: 72,
    /** The smallest hourly move assumed, as a share of the price, even in a dead quiet market. */
    volFloor: 0.002,
    /** A level with a smaller chance than this of being reached is dropped. */
    minReach: 0.03,
    /** Width of one band of liquidation prices, as a share of the entry price. */
    fuelBandWidth: 0.001,
    /** Neighbouring bands merge into one cluster up to this many bands wide. */
    fuelMaxBands: 5,
    /** A cluster counts only when this many USD of positions get liquidated in it. */
    fuelMinUsd: 100_000,
    /** The target sits this far inside a cluster's near edge, as a share of the price. */
    fuelInset: 0.0005,
    /** Score bonus per extra trader in a cluster (up to 4 extra), for many separate liquidations. */
    fuelDensityBonus: 0.1,
    /** How many Hyperliquid accounts (by 30-day volume) the liquidation map reads; 0 turns it off. */
    fuelMapTopN: 600,
    /** The liquidation map is read again every this many minutes, in the background. */
    fuelMapRefreshMinutes: 5,
    /** A wall, round number or swing high pulls half as much as a cluster of the same size. */
    brakeWeight: 0.5,
    /** The score is multiplied by this for each wall, round number or swing high in the way (at most 3). */
    brakePass: 0.8,
    /** A cluster edge this close behind a wall or round number puts the target in front of that instead. */
    brakeShadow: 0.003,
    /** The target never sits this close behind a wall or round number, as a share of its price. */
    sameSpotGap: 0.001,
    /** The smallest pile of resting orders in one band that counts as a wall, in USD. */
    wallMinUsd: 25_000,
    /** Width of one band when adding up resting orders, as a share of the entry price. */
    wallBandWidth: 0.0005,
    /** The target sits this far in front of a wall or round number, as a share of its price. */
    wallFrontGap: 0.0003,
    /** The target moves at random by up to this much either way, as a share of price. */
    wallJitter: 0.0003,
    /** Candles looked at for the recent high (Buy) or low (Sell): one-hour and four-hour. */
    swingLookback: { "1h": 48, "4h": 42 },
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
