/**
 * Random nudge of a limit entry price.
 *
 * Why: if thousands of Sets all rest a limit on the same number (say exactly the
 * centre of a liquidation cluster), they fill together and can push price further,
 * which can set off the very cascade we are trying to profit from, against us.
 * Spreading each entry at random within +-0.05% keeps Sets from stacking on one
 * number. The nudge is then rounded to the symbol's tick so the exchange accepts it.
 *
 * The random source is injected (a function returning [0, 1)), so tests are exact
 * and the app can use Math.random or crypto.getRandomValues.
 */
import { roundToTick } from "./rounding";
import type { RandomSource } from "./types";

/** Default maximum nudge as a fraction of the price: 0.0005 = 0.05%. */
export const DEFAULT_NUDGE_FRACTION = 0.0005;

/** Result of nudgePrice. */
export interface NudgeResult {
  /** Price after the nudge, on the tick grid. Units: quote per base. */
  price: number;
  /** Signed offset applied before tick rounding, as a fraction of the original price (e.g. -0.0003 = -0.03%). */
  offsetFraction: number;
  /** True when the band holds no tick other than the rounded original, so no real nudge was possible. */
  bandTooNarrow: boolean;
}

/**
 * Nudge a limit price at random within +-maxFraction and round it to the tick.
 * Guarantees: the result is on the tick grid, and |result - price| <= price x maxFraction
 * whenever the band contains at least one tick.
 * Units: price and tickSize in quote per base; maxFraction a decimal fraction.
 */
export function nudgePrice(
  price: number,
  tickSize: number,
  random: RandomSource,
  maxFraction: number = DEFAULT_NUDGE_FRACTION,
): NudgeResult {
  if (!(price > 0)) throw new RangeError(`price must be > 0, got ${price}`);
  if (!(maxFraction >= 0)) throw new RangeError(`maxFraction must be >= 0, got ${maxFraction}`);
  const r = random();
  if (!(r >= 0 && r < 1)) throw new RangeError(`random source must return [0, 1), got ${r}`);

  const band = price * maxFraction; // allowed distance either side, in price units
  const lowestTick = roundToTick(price - band, tickSize, "up"); // first tick inside the band
  const highestTick = roundToTick(price + band, tickSize, "down"); // last tick inside the band
  if (lowestTick > highestTick) {
    // No tick fits inside the band (tick larger than 2 x band and price off-grid):
    // the closest legal price is the best we can do; report it so the caller knows.
    return { price: roundToTick(price, tickSize), offsetFraction: 0, bandTooNarrow: true };
  }

  const offsetFraction = (r * 2 - 1) * maxFraction; // map [0,1) to [-max, +max)
  let nudged = roundToTick(price * (1 + offsetFraction), tickSize);
  // Rounding to the nearest tick can step just outside the band; clamp back to the
  // first or last tick that is inside it.
  if (nudged < lowestTick) nudged = lowestTick;
  if (nudged > highestTick) nudged = highestTick;
  return { price: nudged, offsetFraction, bandTooNarrow: lowestTick === highestTick };
}
