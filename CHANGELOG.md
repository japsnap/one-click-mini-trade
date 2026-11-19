# Changelog

## 2026-11-20 (later): reduce-only exits proven live, quieter watcher

- Live test, one $10 ETH Set at 30x (set_mwo3x09sj3ycx): entry 1,746.73, target 1,848.87 (in front of a $59k wall at 1,849.55), stop 1,701.42, both exits `reduceOnly: "true"`, accepted. Closed with an outside market order at 1,747.03 (what a hand close in Blackboard sends). Aster expired both exits itself; 0 open orders after. Result +$0.05 on price, $0.39 fees, so -$0.34.
- Fix found by that test: once Aster expires the exits, the Set no longer had "exits working", so the watcher never closed it and never-merge would have blocked the coin. `uncoveredSets` now includes such Sets; replay test added (fails without the fix).
- `ASTER_EXIT_REDUCE_ONLY` defaults to true. Watcher backup poll: asks Aster only while a Set is open; 15 s, or 60 s with reduce-only exits; start-up and stream reconnect still force a check. Three cadence tests.
- Tests: 150 before, 154 after.

## 2026-11-20: never merge, the watcher, the rules window, a two-choice card

- Never merge (owner's ruling): a new Set is refused when its coin already holds any position (his own or a Set's, either side) or a live Set; plain refusal text, nothing sent (`checkCoinIsFree` in `src/core/risk.ts`, `preTradeCheck`). The merge warning and the outside-baseline path for new Sets are gone; old ledgers with `outside` still reconcile. Margin, liquidation-shrink and stop checks stay (cross margin links coins).
- Watcher (`server/watch.ts`, `scripts/watch.ts`, `--dry`): user data stream with listenKey keepalive every 30 min and reconnect with backoff, plus a positionRisk poll every 15 s. A live Set whose position is gone or no longer covers its fill, with exits still working, has both exits cancelled by client order id and is closed "closed outside the Set"; an exit read back as filled closes the Set by its own exit instead. Missed entry fills are caught up with `GET /fapi/v3/order`; a fill is never counted twice (cumulative filled quantity). Logs to `logs/watch.jsonl`. Started by the server in live mode.
- Reduce-only exits: the V3 doc lists `reduceOnly` and `closePosition` on strategy sub-orders; `ASTER_EXIT_REDUCE_ONLY=true` adds `reduceOnly: "true"` to both exits in one-way mode. Default off (untested live).
- Rules: every tunable number in `src/rules/defaultRules.ts`; override file from `SETS_RULES_FILE` or `rules/my-rules.json` (gitignored), checked at load (unknown key, wrong type, out of range, contradictions fail with the key's name); `GET /api/rules`; example `rules/my-rules.example.json`. No behaviour change at the defaults.
- Card: asks only Side and Ticket; leverage (default 30x), target and entry moved into the options sheet; the options line shows the plan, e.g. "30x · target +5.2% ($12.9) · stop -2.4% ($6.0) · entry at 62,278.2". Screenshot `docs/set-card-live-2026-11-20.png`.
- Tests: 124 before, 150 after (old "Set next to his own trade" and two-Sets-on-a-coin placements became refusal tests; the multi-Set executor tests start from a pre-ruling ledger). Trial smoke on live public data with no keys.


## 2026-11-19: first live Set; Sets next to the user's own trade

- First live $10 ETH Set at 30x: OTOCO accepted after adding root trigger ids to the entry leg; fill, take-profit, stop and order events with Set ids all confirmed.
- New pre-trade check (`src/core/risk.ts`, `preTradeCheck` in `server/execute.ts`): own position on the coin allowed with a warning (outside baseline in the ledger), refused when a liquidation moves more than 30% closer or a stop leaves the 85% rule; margin uses account equity (multi-asset margin).
- Reconcile keeps the Sets when only the user's own part changed.
- Scripts: `scripts/check-account.ts` (read-only), `scripts/listen-stream.ts` (user data stream to `logs/stream.jsonl`).
- Tests: 124 pass.

## 2026-11-16 (many Sets at once)
- A Set ledger (`src/core/ledger.ts`) so many Sets per account work together: a Buy and a Sell Set on one coin, several Sets on one coin and side, Sets at different leverages. Every order carries a client order id `<setId>-<leg><E|T|S>`; each Set's own filled quantity, price and fees are recorded from Aster's order events.
- Decision: the account's position mode and margin type are read, never changed (they belong to Blackboard's app). Live Sets no longer switch the coin to isolated margin. One-way mode: exits are plain opposite-side orders of the Set's quantity, not reduce-only, so the net position equals the sum of open Sets. Hedge mode: positionSide LONG / SHORT per Set direction.
- Decision: exits are sized to the Set's filled quantity. The OTOCO is kept (the exchange still cancels one exit when the other fills); after each fill `syncSetExits` resizes the exits with `POST /fapi/v3/updateStrategyOrder`. When an exit closes a leg, only that Set's sibling exit and unfilled entry are cancelled.
- Decision: stop per Set = the price where the Set loses 85% of its ticket, capped at 85% of the real liquidation distance of the account's position on that coin (positionRisk), or of the pre-fill estimate at the symbol's leverage when there is no position on the Set's side; whichever fires first (`setStopPrice` in `src/core/stop.ts`).
- Decision: the symbol leverage is raised to the highest open Set's leverage and never lowered while Sets are open; a Set's sizing stays its own leverage and its stops are pulled in to the symbol's (`withSymbolLeverage`). A Set is refused when the free balance is below its ticket or the wallet is below all open tickets plus this one, and when the coin's position does not match the open Sets.
- Decision: `reconcileSymbol` compares the position with the open Sets; a mismatch seen twice, the same, at least 5 s apart (our addition: the position moves before the fill event arrives) cancels the affected Sets' orders and marks them "closed outside the Set". Nothing is ever placed to fix a mismatch.
- Decision: per-Set profit and the profit share come from the Set's own fills, after its own trading fees, never from Aster's realizedPnl; no share on a Set closed outside.
- `reconcileStop()` replaced by `syncSetExits()` (it cancelled the OTOCO stop and placed a standalone reduce-only stop for the whole position, which broke the OCO link); its 2 tests moved to `tests/_archive/`. New Aster client calls: balance, updateStrategyOrder, strategyOpenOrder, cancel by client id, position rows with leverage, ORDER_TRADE_UPDATE parser. Demo server: ledger in `logs/set-ledger.json`, `GET /api/sets`, refusals answer 409. 119 tests (17 new); read-only smoke on Aster public data.

## 2026-11-16 (product rules update)
- Card: Buy/Sell, ticket $10/$30/$100 (default $10), leverage 30x or 50x (default 30x). Take-profit mode (default Deserved) and when to enter (default Nearby) moved into an options sheet opened from one summary row that shows target, win and max loss. 100x stays as an advanced choice in the sheet. When Patient or Nearby falls back, the card says so.
- Stop: every Set now has a reduce-only stop-market at 85% of the way to liquidation, with builder fields; the take-profit ratio is measured against it. Live Sets go out as one OTOCO order (entry, take-profit, stop). Liquidation before the fill uses Aster's leverage brackets in live mode, else an assumed 0.5% maintenance rate (with no rate at all, 85% of the distance could land beyond the real liquidation at 100x). After the fill, `reconcileStop()` moves the stop to 85% of Aster's own liquidation price.
- Nearby: picks among the 3 heaviest 0.05%-wide bands of skilled traders' orders 0.05% to 0.5% away, weighted by dollars, then a random price inside the band, then the usual nudge.
- Take-profit: aims just in front of the heaviest wall of resting orders between the minimum and 1.5 times it (Aster's public order book plus Hyperliquid traders' orders), moved by up to 0.03%, never below the minimum; round numbers are the fallback.
- Patient: window 0.5% to 5% (was 1% to 5%); positions read from about 200 Hyperliquid traders (top 50 by monthly profit plus top 150 by monthly volume) with a request budget under Hyperliquid's limit and a 60-second cache; counts are logged.
- One injected random source for every pick (seedable); 104 tests; live read-only smoke on Aster and Hyperliquid in trial mode.

## 2026-11-16
- First build of the Set MVP: pure core (entry, nudge, take-profit, liquidation, Draw split, fees, alerts, input checks), Hyperliquid level source, Aster V3 client with EIP-712 signing and builder fields, demo signing server (trial by default), and the portrait Set card in Blackboard's style. 66 tests; live read-only smoke on Aster and Hyperliquid.
