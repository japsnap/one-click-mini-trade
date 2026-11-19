/**
 * The options sheet: opened from the card's options line (owner rule 2026-11-20).
 * Holds the choices most users keep at their defaults:
 *  - Leverage: the rule set's choices (default 30x, 50x, 100x; starts at 30x)
 *  - Target: Shy, Deserved (default), Greedy, each winning at least N times the loss
 *  - When to enter: Now, Nearby (default), Patient, Draw
 * It slides up over the lower part of the card; tapping the dim area or Done closes it.
 * Every change applies at once (the plan behind the card refreshes), so Done only closes.
 *
 * State lives in SetCard; this component only shows it and reports taps. The hints read
 * their numbers from the rule set, so an override file changes the words too.
 */
import styled from "styled-components";
import { X } from "lucide-react";
import { ENTRY_MODES, TP_MODES, type EntryMode, type Leverage, type TpMode } from "../core/types";
import type { SetRules } from "../rules/rules";
import { theme } from "../theme";
import { TP_LABEL, WHEN_LABEL } from "./setSummary";

/** 0.005 -> "0.5%". */
const pct = (f: number) => `${Number((f * 100).toFixed(2))}%`;

/** One plain line under each entry mode, so the choice explains itself. */
function whenHint(m: EntryMode, r: SetRules): string {
  switch (m) {
    case "now":
      return "Market order at the current price.";
    case "nearby":
      return `A limit among skilled traders' resting orders within ${pct(r.entry.nearbyMaxDistance)}.`;
    case "patient":
      return `A limit inside a cluster of other traders' liquidations ${pct(r.entry.patientMinDistance)} to ${pct(r.entry.patientMaxDistance)} away. Falls back to Nearby when there is none.`;
    case "draw":
      return "Paint where to enter and where to take profit.";
  }
}

/** How far price may move against the Set before its stop, as a rough share: stop share x (1/leverage - maintenance). */
function leverageHint(lev: number, r: SetRules): string {
  const move = r.stop.fractionOfLiquidation * (1 / lev - r.risk.assumedMaintenanceRate);
  return `At ${lev}x a move of about ${pct(Math.round(move * 1000) / 1000)} against you reaches the stop.`;
}

export interface SetOptionsSheetProps {
  open: boolean;
  rules: SetRules;
  tpMode: TpMode;
  entryMode: EntryMode;
  leverage: Leverage;
  onTpMode(m: TpMode): void;
  onEntryMode(m: EntryMode): void;
  onLeverage(l: Leverage): void;
  onClose(): void;
}

export function SetOptionsSheet(p: SetOptionsSheetProps) {
  if (!p.open) return null;
  const r = p.rules;
  return (
    <Overlay onClick={p.onClose} data-testid="set-options-sheet">
      <Sheet role="dialog" aria-label="Set options" onClick={(e) => e.stopPropagation()}>
        <Head>
          <span>Options</span>
          <Close aria-label="Close" onClick={p.onClose}>
            <X size={18} />
          </Close>
        </Head>

        <Label>Leverage</Label>
        <Seg>
          {r.leverage.choices.map((l) => (
            <Opt key={l} $on={p.leverage === l} aria-pressed={p.leverage === l} onClick={() => p.onLeverage(l)} $mono>
              {l}x
            </Opt>
          ))}
        </Seg>
        <Hint>{leverageHint(p.leverage, r)}</Hint>

        <Label>Target</Label>
        <Seg>
          {TP_MODES.map((m) => (
            <Opt key={m} $on={p.tpMode === m} aria-pressed={p.tpMode === m} onClick={() => p.onTpMode(m)}>
              {TP_LABEL[m]}
              <Small>{`≥${r.target[m]}x loss`}</Small>
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
        <Hint>{whenHint(p.entryMode, r)}</Hint>

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
