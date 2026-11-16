/** PriceStrip maths (REAL): pixel height <-> price, the only logic in the Draw strip. */
import { describe, expect, it } from "vitest";
import { priceToY, yToPrice } from "../src/components/PriceStrip";

describe("PriceStrip mapping", () => {
  const range = { low: 60000, high: 68000 };
  it("top is the high, bottom the low, and the two functions invert each other", () => {
    expect(yToPrice(0, 200, range)).toBe(68000);
    expect(yToPrice(200, 200, range)).toBe(60000);
    expect(yToPrice(100, 200, range)).toBe(64000);
    expect(priceToY(64000, 200, range)).toBe(100);
  });
  it("clamps drags outside the strip (negative)", () => {
    expect(yToPrice(-50, 200, range)).toBe(68000);
    expect(yToPrice(999, 200, range)).toBe(60000);
  });
});
