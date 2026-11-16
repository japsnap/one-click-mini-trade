/**
 * Tick-size and step-size rounding.
 *
 * Exchanges reject a price that is not a whole multiple of the tick size, and a
 * quantity that is not a whole multiple of the step size. JavaScript numbers are
 * binary floats, so 0.1 + 0.2 is 0.30000000000000004; every helper here rounds
 * through an integer count of ticks and then trims to the tick's decimal places,
 * so the result prints exactly as the exchange expects ("64312.4", never "64312.400000001").
 */

/** Tolerance used when dividing by a tick: absorbs float noise such as 0.3 / 0.1 = 2.9999999999999996. */
const EPS = 1e-9;

/**
 * Number of decimal places in a step or tick size.
 * Why: we print prices and quantities with exactly this many decimals.
 * Units: none (a count). Example: 0.1 -> 1, 0.001 -> 3, 5 -> 0, 1e-7 -> 7.
 */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) throw new RangeError(`step must be a positive number, got ${step}`);
  // toString gives "1e-7" for very small numbers, so handle the exponent form first.
  const s = step.toString();
  const exp = /e-(\d+)$/.exec(s);
  if (exp) {
    const mantissa = s.split("e")[0] ?? "";
    const mantissaDecimals = (mantissa.split(".")[1] ?? "").length;
    return Number(exp[1]) + mantissaDecimals;
  }
  return (s.split(".")[1] ?? "").length;
}

/** Direction for rounding to a grid. "nearest" for display, "down"/"up" when one side must be safe. */
export type RoundMode = "nearest" | "down" | "up";

/**
 * Round a value onto a grid of `step` (a tick for prices, a step for quantities).
 * Why: the exchange only accepts values on its grid.
 * Units: same unit as `value` and `step` (price or quantity).
 */
export function roundToStep(value: number, step: number, mode: RoundMode = "nearest"): number {
  if (!Number.isFinite(value)) throw new RangeError(`value must be finite, got ${value}`);
  const dec = decimalsOf(step);
  const ratio = value / step; // how many steps fit, as a float
  let n: number;
  if (mode === "down") n = Math.floor(ratio + EPS); // +EPS so 2.9999999 counts as 3
  else if (mode === "up") n = Math.ceil(ratio - EPS); // -EPS so 3.0000001 counts as 3
  else n = Math.round(ratio);
  // Multiply back and cut float noise at the step's own decimal places.
  return Number((n * step).toFixed(dec));
}

/**
 * Round a price to the symbol's tick size.
 * Units: quote currency per base unit (USDT per BTC).
 */
export function roundToTick(price: number, tickSize: number, mode: RoundMode = "nearest"): number {
  return roundToStep(price, tickSize, mode);
}

/**
 * Round a quantity DOWN to the symbol's step size.
 * Why down: rounding up would spend more margin than the ticket allows.
 * Units: base asset (BTC for BTCUSDT).
 */
export function floorToStep(qty: number, stepSize: number): number {
  return roundToStep(qty, stepSize, "down");
}

/**
 * Format a number as the exact decimal string the exchange expects for a given step.
 * Why: sending 0.1 + 0.2 as "0.30000000000000004" fails the PRICE_FILTER check.
 * Units: same as value.
 */
export function formatToStep(value: number, step: number): string {
  return value.toFixed(decimalsOf(step));
}

/**
 * True when `value` sits exactly on the grid of `step` (within float noise).
 * Used by tests and by the order builder as a last safety check before signing.
 */
export function isOnStep(value: number, step: number): boolean {
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}
