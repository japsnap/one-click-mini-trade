/**
 * The Set card: one portrait (9:16) card, one big Enter button.
 *
 * Rows: Buy/Sell, Ticket, Leverage, Take-profit, When (Now / Nearby / Patient / Draw).
 * Nearby and Patient show "Checking traders' orders..." while the plan (which loads the
 * traders' levels) is fetched through TanStack Query, then the chosen price.
 * Draw swaps in the vertical price strip. After Enter: waiting/open status, progress bar
 * to take-profit, the halfway and result toasts, and the result with the fee split.
 *
 * Wiring: everything external comes through the `api` prop (SetCardApi). Blackboard passes
 * its own implementation (Privy wallet, its backend) and keeps this component unchanged.
 * The card needs a QueryClientProvider above it (Blackboard already has one).
 */
import { useMemo, useState } from "react";
import styled from "styled-components";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Bell, CheckCircle2, Loader2, Skull } from "lucide-react";
import type { SetAlertEvent } from "../core/alerts";
import { estimateLiquidationPrice } from "../core/liquidation";
import { ENTRY_MODES, LEVERAGES, TICKETS_USD, TP_MODES, type DrawBands, type EntryMode, type Leverage, type SetInput, type Side, type TicketUsd, type TpMode } from "../core/types";
import type { SetCardApi } from "../api/client";
import { theme } from "../theme";
import { PriceStrip } from "./PriceStrip";
import { useSetSession } from "./useSetSession";

export interface SetCardProps {
  api: SetCardApi;
  symbol?: string;
  /** Called on every alert (halfway, result), e.g. to send a push notification. */
  onAlert?(e: SetAlertEvent): void;
}

const TP_LABEL: Record<TpMode, string> = { shy: "Shy", deserved: "Deserved", greedy: "Greedy" };
const WHEN_LABEL: Record<EntryMode, string> = { now: "Now", nearby: "Nearby", patient: "Patient", draw: "Draw" };

/** "$1,234.56" */
const usd = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Price with up to 2 decimals. */
const px = (v: number | null | undefined) => (v == null ? "market" : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

export function SetCard({ api, symbol = "BTCUSDT", onAlert }: SetCardProps) {
  const [side, setSide] = useState<Side>("buy");
  const [ticketUsd, setTicket] = useState<TicketUsd>(30);
  const [leverage, setLeverage] = useState<Leverage>(50);
  const [tpMode, setTpMode] = useState<TpMode>("deserved");
  const [entryMode, setEntryMode] = useState<EntryMode>("now");
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
          {TICKETS_USD.map((t) => (
            <Opt key={t} $on={ticketUsd === t} onClick={() => setTicket(t)} $mono>
              ${t}
            </Opt>
          ))}
        </Seg>
      </Row>
      <Row label="Leverage">
        <Seg>
          {LEVERAGES.map((l) => (
            <Opt key={l} $on={leverage === l} onClick={() => setLeverage(l)} $mono>
              {l}x
            </Opt>
          ))}
        </Seg>
      </Row>
      <Row label="Take-profit">
        <Seg>
          {TP_MODES.map((m) => (
            <Opt key={m} $on={tpMode === m} onClick={() => setTpMode(m)}>
              {TP_LABEL[m]}
            </Opt>
          ))}
        </Seg>
      </Row>
      <Row label="When">
        <Seg>
          {ENTRY_MODES.map((m) => (
            <Opt key={m} $on={entryMode === m} onClick={() => setEntryMode(m)}>
              {WHEN_LABEL[m]}
            </Opt>
          ))}
        </Seg>
      </Row>

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
            {plan.entry.fellBackFrom.length > 0 && <Warn>{plan.entry.reason}</Warn>}
            <Kv k="Entry" v={plan.entry.usedMode === "now" ? `market ~${px(plan.entry.expectedFillPrice)}` : px(plan.entry.expectedFillPrice)} />
            <Kv k="Orders" v={`${plan.orders.entries.length} in / ${plan.orders.takeProfits.length} out`} />
            <Kv k="Take-profit" v={`${px(plan.takeProfit.price)} (${plan.takeProfit.ratio.toFixed(2)}x)`} tone={theme.color.success} />
            <Kv k="Liquidation (stop)" v={px(plan.liquidationPrice)} tone={theme.color.negative} />
            <Kv k="Win / lose" v={`${usd(plan.expected.profitAtTpUsd)} / ${usd(plan.expected.lossAtLiquidationUsd)}`} />
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
                {e.outcome === "take-profit" ? <CheckCircle2 size={14} /> : <Skull size={14} />}
                {e.outcome === "take-profit" ? "Take-profit hit" : "Liquidated"} at {px(e.price)}
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
