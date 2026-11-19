/**
 * The Set card: one portrait (9:16) card, one big Enter button.
 *
 * Rows (owner rule 2026-11-20): the card asks only Side (Buy / Sell) and Ticket ($10 /
 * $30 / $100). Below them ONE tappable options line shows what the options hold, from the
 * current plan, for example "30x · target +5.2% ($15.6) · stop -2.6% ($7.9) · entry at
 * market". Tapping it opens the options sheet (SetOptionsSheet.tsx): leverage (default
 * 30x), target greed (default Deserved) and when to enter (default Nearby). Choices and
 * defaults come from the rule set (api.getRules when the api offers it, else the defaults).
 * Nearby and Patient show "Checking traders' orders..." while the plan (which loads the
 * traders' levels) is fetched through TanStack Query, then the chosen price. When Patient
 * or Nearby falls back, the card itself says so (amber line), not only the sheet.
 * Draw swaps in the vertical price strip. After Enter: waiting/open status, progress bar
 * to take-profit, the halfway and result toasts, and the result with the fee split.
 *
 * Wiring: everything external comes through the `api` prop (SetCardApi). Blackboard passes
 * its own implementation (Privy wallet, its backend) and keeps this component unchanged.
 * The card needs a QueryClientProvider above it (Blackboard already has one).
 */
import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Bell, CheckCircle2, ChevronRight, Loader2, ShieldAlert, Skull } from "lucide-react";
import { activeRules, type SetRules } from "../rules/rules";
import type { SetAlertEvent } from "../core/alerts";
import { estimateLiquidationPrice } from "../core/liquidation";
import type { DrawBands, EntryMode, Leverage, SetInput, Side, TicketUsd, TpMode } from "../core/types";
import type { SetCardApi } from "../api/client";
import { theme } from "../theme";
import { PriceStrip } from "./PriceStrip";
import { SetOptionsSheet } from "./SetOptionsSheet";
import { fallbackNotice, optionsLine, px, usd } from "./setSummary";
import { useSetSession } from "./useSetSession";

export interface SetCardProps {
  api: SetCardApi;
  symbol?: string;
  /** Called on every alert (halfway, result), e.g. to send a push notification. */
  onAlert?(e: SetAlertEvent): void;
}

export function SetCard({ api, symbol = "BTCUSDT", onAlert }: SetCardProps) {
  const fetchedRules = useQuery({ queryKey: ["set-rules"], queryFn: () => api.getRules!(), enabled: !!api.getRules, staleTime: Infinity, retry: false });
  const rules: SetRules = fetchedRules.data ?? activeRules();
  const [side, setSide] = useState<Side>("buy");
  const [ticketUsd, setTicket] = useState<TicketUsd>(rules.ticket.default);
  const [leverage, setLeverage] = useState<Leverage>(rules.leverage.default);
  const [tpMode, setTpMode] = useState<TpMode>(rules.target.default);
  const [entryMode, setEntryMode] = useState<EntryMode>(rules.entry.default);
  // The server's rules arrive after the first render: start over on their defaults.
  useEffect(() => {
    if (!fetchedRules.data) return;
    const r = fetchedRules.data;
    setTicket(r.ticket.default);
    setLeverage(r.leverage.default);
    setTpMode(r.target.default);
    setEntryMode(r.entry.default);
  }, [fetchedRules.data]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bands, setBands] = useState<Partial<DrawBands>>({});
  const [painting, setPainting] = useState<"in" | "out">("in");

  const price = useQuery({ queryKey: ["price", symbol], queryFn: () => api.getPrice(symbol), refetchInterval: 5_000 });

  const drawReady = entryMode !== "draw" || (!!bands.inBand && !!bands.outBand);
  const input: SetInput = useMemo(
    () => ({ symbol, side, ticketUsd, leverage, tpMode, entryMode, ...(entryMode === "draw" && drawReady ? { draw: bands as DrawBands } : {}) }),
    [symbol, side, ticketUsd, leverage, tpMode, entryMode, bands, drawReady],
  );

  // The plan for the current choices. For Nearby/Patient this is where traders' levels load.
  const preview = useQuery({
    queryKey: ["set-preview", input],
    queryFn: () => api.preview(input),
    enabled: drawReady,
    staleTime: 15_000,
    retry: false,
  });

  const place = useMutation({ mutationFn: () => api.place(input) });
  const session = useSetSession({ plan: place.data?.plan ?? null, getPrice: api.getPrice, onAlert });

  // Draw strip shows about five liquidation distances either side of the price.
  const range = price.data ? { low: price.data * (1 - 5 / leverage), high: price.data * (1 + 5 / leverage) } : null;
  const inMid = bands.inBand ? (bands.inBand.low + bands.inBand.high) / 2 : undefined;
  const plan = preview.data?.plan;
  const loadingLevels = preview.isFetching && (entryMode === "nearby" || entryMode === "patient");
  const line = optionsLine(leverage, preview.isFetching ? null : plan);
  const notice = preview.isFetching ? null : fallbackNotice(plan);

  return (
    <Card>
      <Header>
        <Title>Set</Title>
        <Price>{symbol.replace("USDT", "")} {price.data ? px(price.data) : "..."}</Price>
      </Header>

      <Row label="Direction">
        <Seg>
          <Opt $on={side === "buy"} $tone={theme.color.success} onClick={() => setSide("buy")}>
            <ArrowUpRight size={16} /> Buy
          </Opt>
          <Opt $on={side === "sell"} $tone={theme.color.negative} onClick={() => setSide("sell")}>
            <ArrowDownRight size={16} /> Sell
          </Opt>
        </Seg>
      </Row>
      <Row label="Ticket (max loss)">
        <Seg>
          {rules.ticket.choices.map((t) => (
            <Opt key={t} $on={ticketUsd === t} onClick={() => setTicket(t)} $mono>
              ${t}
            </Opt>
          ))}
        </Seg>
      </Row>
      <Summary type="button" aria-haspopup="dialog" aria-label="Options" onClick={() => setSheetOpen(true)} data-testid="set-summary-row">
        <SummaryText>
          <SummaryTitle>Options</SummaryTitle>
          <SummaryDetail>{loadingLevels ? `${leverage}x · checking traders' orders...` : line}</SummaryDetail>
        </SummaryText>
        <ChevronRight size={20} />
      </Summary>
      {notice && <Warn data-testid="fallback-notice">{notice}</Warn>}

      {entryMode === "draw" && price.data && range && (
        <DrawBox>
          <Seg>
            <Opt $on={painting === "in"} $tone={theme.color.mint} onClick={() => setPainting("in")}>Paint In</Opt>
            <Opt $on={painting === "out"} $tone={theme.color.blue} onClick={() => setPainting("out")}>Paint Out</Opt>
          </Seg>
          <PriceStrip
            currentPrice={price.data}
            range={range}
            bands={bands}
            painting={painting}
            onChange={setBands}
            liquidationPrice={inMid ? estimateLiquidationPrice(inMid, leverage, side) : undefined}
          />
        </DrawBox>
      )}

      <PlanBox aria-live="polite">
        {loadingLevels ? (
          <Muted>
            <Spin size={14} /> Checking traders' orders...
          </Muted>
        ) : preview.isError ? (
          <Warn>{(preview.error as Error).message}</Warn>
        ) : !drawReady ? (
          <Muted>Paint an In band and an Out band.</Muted>
        ) : plan ? (
          <>
            <Kv k="Entry" v={plan.entry.usedMode === "now" ? `market ~${px(plan.entry.expectedFillPrice)}` : px(plan.entry.expectedFillPrice)} />
            <Kv k="Orders" v={`${plan.orders.entries.length} in / ${plan.orders.takeProfits.length} out / ${plan.orders.stops.length} stop`} />
            <Kv k="Take-profit" v={`${px(plan.takeProfit.price)} (${plan.takeProfit.ratio.toFixed(2)}x)`} tone={theme.color.success} />
            <Kv k="Stop" v={px(plan.stop.price)} tone={theme.color.negative} />
            <Kv k="Liquidation" v={px(plan.liquidationPrice)} tone={theme.color.dim} />
            <Kv k="Win / max loss" v={`${usd(plan.expected.profitAtTpUsd)} / ${usd(plan.expected.lossAtStopUsd)}`} />
          </>
        ) : (
          <Muted>...</Muted>
        )}
      </PlanBox>

      <Enter disabled={!plan || place.isPending || preview.isFetching} onClick={() => place.mutate()} $side={side}>
        {place.isPending ? <Spin size={18} /> : `Enter ${side === "buy" ? "Buy" : "Sell"} $${ticketUsd}`}
      </Enter>

      {place.isError && <Warn>{(place.error as Error).message}</Warn>}
      {place.data && (
        <Status>
          <StatusLine>
            {place.data.trial && <Pill $tone={theme.color.amber}>trial: not sent</Pill>}
            <span>{session.phase === "waiting" ? "Waiting for entry" : session.phase === "open" ? "Open" : session.phase === "closed" ? "Closed" : ""}</span>
          </StatusLine>
          <Bar>
            <Fill style={{ width: `${Math.round(session.progress * 100)}%` }} />
          </Bar>
          {session.events.map((e, i) =>
            e.type === "halfway" ? (
              <Toast key={i}>
                <Bell size={14} /> Halfway to take-profit at {px(e.price)}
              </Toast>
            ) : (
              <Toast key={i} $tone={e.outcome === "take-profit" ? theme.color.success : theme.color.negative}>
                {e.outcome === "take-profit" ? <CheckCircle2 size={14} /> : e.outcome === "stopped" ? <ShieldAlert size={14} /> : <Skull size={14} />}
                {e.outcome === "take-profit" ? "Take-profit hit" : e.outcome === "stopped" ? "Stopped" : "Liquidated"} at {px(e.price)}
              </Toast>
            ),
          )}
          {session.result && session.result.type === "result" && (
            <Result>
              <Kv k="Result" v={usd(session.result.pnlUsd)} tone={session.result.pnlUsd > 0 ? theme.color.success : theme.color.negative} />
              <Kv k="Blackboard 5%" v={usd(session.result.fees.blackboardUsd)} />
              <Kv k="Trader 5%" v={usd(session.result.fees.traderUsd)} />
              <Kv k="You keep" v={usd(session.result.fees.userNetUsd)} />
            </Result>
          )}
        </Status>
      )}

      <SetOptionsSheet
        open={sheetOpen}
        rules={rules}
        tpMode={tpMode}
        entryMode={entryMode}
        leverage={leverage}
        onTpMode={setTpMode}
        onEntryMode={setEntryMode}
        onLeverage={setLeverage}
        onClose={() => setSheetOpen(false)}
      />
    </Card>
  );
}

/** A labelled row. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <RowBox>
      <Label>{label}</Label>
      {children}
    </RowBox>
  );
}
/** A key-value line with a mono number. */
function Kv({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <KvBox>
      <span>{k}</span>
      <Num style={tone ? { color: tone } : undefined}>{v}</Num>
    </KvBox>
  );
}

// ---------- styles (Blackboard tokens from ../theme) ----------
const Card = styled.div`
  position: relative; /* anchors the options sheet */
  /* Portrait card: full width on a phone, 420px at most; at least 9:16 tall (420 x 16 / 9 = 746px)
     but never taller than the screen, so the Enter button stays reachable. */
  flex: 0 1 420px;
  width: 100%;
  max-width: 420px;
  min-height: min(calc(100dvh - 16px), 746px);
  margin: 0 auto;
  padding: 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: ${theme.color.bgRaised};
  border: 1px solid ${theme.color.surface2};
  border-radius: ${theme.radius.xl};
  color: ${theme.color.text};
  font-family: ${theme.font.ui};
`;
const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: baseline;
`;
const Title = styled.h1`
  margin: 0;
  font: 600 28px ${theme.font.display};
`;
const Price = styled.span`
  font: 500 14px ${theme.font.mono};
  color: ${theme.color.muted};
`;
const RowBox = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;
const Label = styled.span`
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
const Opt = styled.button<{ $on: boolean; $tone?: string; $mono?: boolean }>`
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 36px;
  border: 0;
  border-radius: ${theme.radius.sm};
  cursor: pointer;
  font: 600 14px ${(p) => (p.$mono ? theme.font.mono : theme.font.ui)};
  color: ${(p) => (p.$on ? (p.$tone ?? theme.color.text) : theme.color.muted)};
  background: ${(p) => (p.$on ? theme.color.surface3 : "transparent")};
  -webkit-tap-highlight-color: transparent;
`;
const Summary = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 56px;
  padding: 10px 12px;
  border: 1px solid ${theme.color.surface3};
  border-radius: ${theme.radius.md};
  background: ${theme.color.surface1};
  color: ${theme.color.text};
  cursor: pointer;
  text-align: left;
  -webkit-tap-highlight-color: transparent;
`;
const SummaryText = styled.span`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;
const SummaryTitle = styled.span`
  font: 600 15px ${theme.font.ui};
`;
const SummaryDetail = styled.span`
  font: 500 12px ${theme.font.mono};
  color: ${theme.color.muted};
`;
const DrawBox = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;
const PlanBox = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  min-height: 92px;
  background: ${theme.color.surface1};
  border-radius: ${theme.radius.md};
  font-size: 13px;
`;
const KvBox = styled.div`
  display: flex;
  justify-content: space-between;
  color: ${theme.color.muted};
`;
const Num = styled.span`
  font-family: ${theme.font.mono};
  color: ${theme.color.text};
`;
const Muted = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: ${theme.color.muted};
`;
const Warn = styled.span`
  color: ${theme.color.amber};
  font-size: 12px;
`;
const Spin = styled(Loader2)`
  animation: spin 1s linear infinite;
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
`;
const Enter = styled.button<{ $side: Side }>`
  margin-top: auto;
  min-height: 56px;
  border: 0;
  border-radius: ${theme.radius.pill};
  cursor: pointer;
  font: 700 17px ${theme.font.ui};
  color: #000;
  background: ${theme.color.mint};
  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
`;
const Status = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
`;
const StatusLine = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;
const Pill = styled.span<{ $tone: string }>`
  padding: 2px 8px;
  border-radius: ${theme.radius.pill};
  border: 1px solid ${(p) => p.$tone};
  color: ${(p) => p.$tone};
  font: 500 11px ${theme.font.mono};
`;
const Bar = styled.div`
  height: 6px;
  background: ${theme.color.surface2};
  border-radius: ${theme.radius.pill};
  overflow: hidden;
`;
const Fill = styled.div`
  height: 100%;
  background: ${theme.color.success};
  transition: width 0.4s ease;
`;
const Toast = styled.div<{ $tone?: string }>`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: ${theme.radius.md};
  background: ${theme.color.surface2};
  color: ${(p) => p.$tone ?? theme.color.blue};
`;
const Result = styled.div`
  padding: 10px 12px;
  border-radius: ${theme.radius.md};
  background: ${theme.color.surface1};
`;
