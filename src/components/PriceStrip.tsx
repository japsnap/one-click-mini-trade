/**
 * Draw mode's vertical price strip. The user drags to paint a band; only height (price)
 * matters, time does not exist on this strip.
 *
 * Interaction: pick "In" or "Out" above the strip, then press and drag. Pointer events
 * cover mouse, touch and pen in one path; touch-action: none stops the page scrolling
 * while painting on a phone.
 */
import { useRef } from "react";
import styled from "styled-components";
import type { DrawBands, PriceBand } from "../core/types";
import { theme } from "../theme";

export interface PriceStripProps {
  /** Current price, drawn as a line. Units: quote per base. */
  currentPrice: number;
  /** Visible price range, top = high. */
  range: PriceBand;
  bands: Partial<DrawBands>;
  /** Which band the next drag paints. */
  painting: "in" | "out";
  onChange(bands: Partial<DrawBands>): void;
  /** Liquidation estimate for the painted In band, drawn as a red line (optional). */
  liquidationPrice?: number;
  height?: number;
}

/**
 * Convert a vertical pixel position to a price on the strip.
 * Units: y in CSS pixels from the strip's top; result quote per base.
 */
export function yToPrice(y: number, height: number, range: PriceBand): number {
  const t = Math.min(1, Math.max(0, y / height)); // 0 at the top, 1 at the bottom
  return range.high - t * (range.high - range.low);
}

/** Inverse of yToPrice. */
export function priceToY(price: number, height: number, range: PriceBand): number {
  return ((range.high - price) / (range.high - range.low)) * height;
}

export function PriceStrip(p: PriceStripProps) {
  const h = p.height ?? 260;
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);

  const priceAt = (clientY: number) => {
    const top = ref.current?.getBoundingClientRect().top ?? 0;
    return yToPrice(clientY - top, h, p.range);
  };
  const paint = (a: number, b: number) => {
    const band = { low: Math.min(a, b), high: Math.max(a, b) };
    p.onChange({ ...p.bands, [p.painting === "in" ? "inBand" : "outBand"]: band });
  };

  return (
    <Strip
      ref={ref}
      style={{ height: h }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = priceAt(e.clientY);
        paint(start.current, start.current);
      }}
      onPointerMove={(e) => {
        if (start.current !== null) paint(start.current, priceAt(e.clientY));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      aria-label="Price strip: drag to paint a band"
    >
      {p.bands.inBand && <Band $color={theme.color.mint} style={bandStyle(p.bands.inBand, h, p.range)} data-label="In" />}
      {p.bands.outBand && <Band $color={theme.color.blue} style={bandStyle(p.bands.outBand, h, p.range)} data-label="Out" />}
      <Line $color={theme.color.text} style={{ top: priceToY(p.currentPrice, h, p.range) }}>
        <Tag>{p.currentPrice.toLocaleString()}</Tag>
      </Line>
      {p.liquidationPrice !== undefined && p.liquidationPrice > p.range.low && p.liquidationPrice < p.range.high && (
        <Line $color={theme.color.negative} style={{ top: priceToY(p.liquidationPrice, h, p.range) }}>
          <Tag $color={theme.color.negative}>liq {p.liquidationPrice.toFixed(1)}</Tag>
        </Line>
      )}
      <Edge style={{ top: 4 }}>{p.range.high.toFixed(0)}</Edge>
      <Edge style={{ bottom: 4 }}>{p.range.low.toFixed(0)}</Edge>
    </Strip>
  );
}

/** Absolute position of a band on the strip. */
function bandStyle(b: PriceBand, h: number, r: PriceBand) {
  const top = priceToY(b.high, h, r);
  return { top, height: Math.max(2, priceToY(b.low, h, r) - top) };
}

const Strip = styled.div`
  position: relative;
  width: 100%;
  background: ${theme.color.surface1};
  border: 1px solid ${theme.color.surface3};
  border-radius: ${theme.radius.md};
  touch-action: none;
  cursor: ns-resize;
  overflow: hidden;
  user-select: none;
`;
const Band = styled.div<{ $color: string }>`
  position: absolute;
  left: 0;
  right: 0;
  background: ${(p) => p.$color}33;
  border-top: 1px solid ${(p) => p.$color};
  border-bottom: 1px solid ${(p) => p.$color};
  &::after {
    content: attr(data-label);
    position: absolute;
    left: 8px;
    top: 2px;
    font: 600 11px ${theme.font.ui};
    color: ${(p) => p.$color};
  }
`;
const Line = styled.div<{ $color: string }>`
  position: absolute;
  left: 0;
  right: 0;
  height: 0;
  border-top: 1px dashed ${(p) => p.$color};
`;
const Tag = styled.span<{ $color?: string }>`
  position: absolute;
  right: 6px;
  top: -9px;
  padding: 1px 6px;
  border-radius: ${theme.radius.pill};
  background: ${theme.color.surface3};
  color: ${(p) => p.$color ?? theme.color.text};
  font: 500 11px ${theme.font.mono};
`;
const Edge = styled.span`
  position: absolute;
  left: 8px;
  font: 400 10px ${theme.font.mono};
  color: ${theme.color.dim};
`;
