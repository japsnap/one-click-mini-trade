/**
 * The options sheet: opened from the card's summary row (owner rule 2026-11-16).
 * Holds the choices most users keep at their defaults:
 *  - Take-profit: Shy (>= 1x the loss), Deserved (>= 2x, default), Greedy (>= 4x)
 *  - When to enter: Now, Nearby (default), Patient, Draw
 *  - Advanced: 100x leverage (the card itself shows only 30x and 50x)
 * It slides up over the lower part of the card; tapping the dim area or Done closes it.
 * Every change applies at once (the plan behind the card refreshes), so Done only closes.
 *
 * State lives in SetCard; this component only shows it and reports taps.
 */
import styled from "styled-components";
import { X } from "lucide-react";
import { ENTRY_MODES, TP_MODES, type EntryMode, type Leverage, type TpMode } from "../core/types";
import { TP_MIN_RATIO } from "../core/takeProfit";
import { theme } from "../theme";
import { TP_LABEL, WHEN_LABEL } from "./setSummary";

/** One plain line under each entry mode, so the choice explains itself. */
const WHEN_HINT: Record<EntryMode, string> = {
  now: "Market order at the current price.",
  nearby: "A limit among skilled traders' resting orders within 0.5%.",
  patient: "A limit inside a cluster of other traders' liquidations 0.5% to 5% away. Falls back to Nearby when there is none.",
  draw: "Paint where to enter and where to take profit.",
};

export interface SetOptionsSheetProps {
  open: boolean;
  tpMode: TpMode;
  entryMode: EntryMode;
  leverage: Leverage;
  onTpMode(m: TpMode): void;
  onEntryMode(m: EntryMode): void;
  /** Turning 100x off returns to 30x, the card default. */
  onLeverage(l: Leverage): void;
  onClose(): void;
}

export function SetOptionsSheet(p: SetOptionsSheetProps) {
  if (!p.open) return null;
  return (
    <Overlay onClick={p.onClose} data-testid="set-options-sheet">
      <Sheet role="dialog" aria-label="Set options" onClick={(e) => e.stopPropagation()}>
        <Head>
          <span>Options</span>
          <Close aria-label="Close" onClick={p.onClose}>
            <X size={18} />
          </Close>
        </Head>

        <Label>Take-profit</Label>
        <Seg>
          {TP_MODES.map((m) => (
            <Opt key={m} $on={p.tpMode === m} aria-pressed={p.tpMode === m} onClick={() => p.onTpMode(m)}>
              {TP_LABEL[m]}
              <Small>{`≥${TP_MIN_RATIO[m]}x loss`}</Small>
            </Opt>
          ))}
        </Seg>

        <Label>When to enter</Label>
        <Seg>
          {ENTRY_MODES.map((m) => (
            <Opt key={m} $on={p.entryMode === m} aria-pressed={p.entryMode === m} onClick={() => p.onEntryMode(m)}>
              {WHEN_LABEL[m]}
            </Opt>
          ))}
        </Seg>
        <Hint>{WHEN_HINT[p.entryMode]}</Hint>

        <Label>Advanced</Label>
        <Seg>
          <Opt
            $on={p.leverage === 100}
            aria-pressed={p.leverage === 100}
            onClick={() => p.onLeverage(p.leverage === 100 ? 30 : 100)}
            $mono
          >
            100x leverage
          </Opt>
        </Seg>
        {p.leverage === 100 && <Hint>At 100x a move of about 0.4% against you reaches the stop.</Hint>}

        <Done onClick={p.onClose}>Done</Done>
      </Sheet>
    </Overlay>
  );
}

// ---------- styles (Blackboard tokens from ../theme) ----------
const Overlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.55);
  border-radius: ${theme.radius.xl};
  z-index: 10;
`;
const Sheet = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px 18px;
  background: ${theme.color.bgRaised};
  border-top: 1px solid ${theme.color.surface2};
  border-radius: ${theme.radius.xl} ${theme.radius.xl} ${theme.radius.xl} ${theme.radius.xl};
`;
const Head = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font: 600 16px ${theme.font.ui};
`;
const Close = styled.button`
  display: inline-flex;
  padding: 6px;
  border: 0;
  background: transparent;
  color: ${theme.color.muted};
  cursor: pointer;
`;
const Label = styled.span`
  margin-top: 4px;
  font-size: 12px;
  color: ${theme.color.dim};
`;
const Seg = styled.div`
  display: flex;
  gap: 4px;
  padding: 3px;
  background: ${theme.color.surface1};
  border-radius: ${theme.radius.md};
`;
const Opt = styled.button<{ $on: boolean; $mono?: boolean }>`
  flex: 1;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 40px;
  border: 0;
  border-radius: ${theme.radius.sm};
  cursor: pointer;
  font: 600 14px ${(p) => (p.$mono ? theme.font.mono : theme.font.ui)};
  color: ${(p) => (p.$on ? theme.color.text : theme.color.muted)};
  background: ${(p) => (p.$on ? theme.color.surface3 : "transparent")};
  -webkit-tap-highlight-color: transparent;
`;
const Small = styled.span`
  font: 400 11px ${theme.font.mono};
  color: ${theme.color.dim};
`;
const Hint = styled.span`
  font-size: 12px;
  color: ${theme.color.muted};
`;
const Done = styled.button`
  margin-top: 6px;
  min-height: 44px;
  border: 0;
  border-radius: ${theme.radius.pill};
  cursor: pointer;
  font: 700 15px ${theme.font.ui};
  color: #000;
  background: ${theme.color.mint};
`;
