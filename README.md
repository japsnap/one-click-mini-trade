# One-click mini trade: the Set

A **Set** is a leveraged trade opened with one button. On one portrait card the user picks:

- **Direction**: Buy or Sell (default Buy).
- **Ticket**: $10, $30 or $100 (default $10). This is the margin; on isolated margin it is the most the user can lose.
- **Leverage**: 30x or 50x on the card (default 30x). 100x is an advanced choice inside the options sheet.
- **One summary row**, for example "Deserved · Nearby ›" with the target price, the win and the max loss. Tapping it opens the options sheet with:
  - **Take-profit**: Shy (at least 1x the loss), Deserved (at least 2x, the default) or Greedy (at least 4x).
  - **When to enter**: Now (market order), Nearby (the default), Patient, or Draw (paint an In band and an Out band on a price strip; the ticket is split into up to 5 orders).

How each piece is chosen (rules of 2026-11-16):

- **Stop**: every Set carries a stop just before liquidation, at 85% of the way from entry to the liquidation price. Stopped there, the user keeps about 15% of what liquidation would take and pays no liquidation fee (Aster's BTCUSDT liquidation fee is 2.5% of the position), and because the stop is a normal signed order, Blackboard's builder fee applies to the close. The take-profit ratio is measured against this stop distance, because it is the real loss. Once the entry fills, each Set's stop is re-set from its own fill (see "Many Sets at once").
- **Nearby**: not the nearest level. Skilled traders' resting limit orders on the good side (bids below the price for a Buy) between 0.05% and 0.5% away are grouped into 0.05%-wide price bands; the 3 heaviest bands by dollars stay; one is picked at random, weighted by dollars; then a random price inside that band.
- **Patient**: a limit inside the heaviest cluster of other traders' liquidation prices 0.5% to 5% away (longs below the price for a Buy, shorts above for a Sell). It now reads up to about 200 Hyperliquid traders (the 50 most profitable this month plus the 150 most active by volume). When there is no cluster it falls back to Nearby, and the card says so.
- **Take-profit**: first the minimum (1x, 2x or 4x the stop distance), then the heaviest wall of resting orders on the other side between that minimum and 1.5 times it (asks above a Buy, bids below a Sell), from Aster's own order book plus skilled Hyperliquid traders' resting orders. The target sits just in front of that wall, moved at random by up to 0.03%, never below the minimum. No wall, then the nearest round number beyond the minimum.

Every limit price is moved at random by up to 0.05% so many Sets never stack on one number. All randomness comes from one injected random source, so a seed reproduces a Set exactly (tests use this; the preview route accepts `"seed"`). On a winning Set, 5% of the profit goes to Blackboard and 5% to the copied trader; a losing Set pays nothing.

Orders go to **Aster**. Skilled traders' levels come from **Hyperliquid**, because Aster does not publish other users' positions or orders while Hyperliquid's are public. BTC and ETH trade at nearly the same price on both.

![The Set card on live data](docs/set-card-live-2026-11-16.png)

## The four parts, and what Blackboard copies

| Part | Folder | Copy into Blackboard? |
|---|---|---|
| Core maths: entry, nudge, take-profit, stop, liquidation, Draw split, fees, alerts, input checks | `src/core/` | Yes, first and as is. Plain TypeScript, no network, no React, no dependencies. |
| Trader levels from Hyperliquid | `src/levels/hyperliquid.ts` | Yes, on a backend (it downloads a 39 MB leaderboard and makes about 200 requests per refresh, at most one refresh a minute; keep it off phones). |
| Aster V3 client: EIP-712 signing, orders, order book, brackets, positions, builder fields | `src/exchange/aster.ts` | Yes, where the signing key lives. `asterTypedData()` also works with a Privy wallet's signTypedData. |
| The card | `src/components/` (`SetCard.tsx`, `SetOptionsSheet.tsx`, `setSummary.ts`, `PriceStrip.tsx`, `useSetSession.ts`) | Yes. Pass your own `api` prop (see `src/api/client.ts`) instead of the demo server. Colours and fonts come from `src/theme.ts`. |

`server/` is a demo signing server. It shows the contract (routes below) and is the only place a private key lives; the browser never sees one.

Stack, matching Blackboard's app: React 18, TypeScript (strict), Vite, styled-components, TanStack Query, viem, lucide-react, Vitest.

## Setup

1. `npm install`
2. Optional, only for live orders: copy `.env.example` to `.env` and fill these four values:
   - `ASTER_USER`: the main account address (on Blackboard: Settings, Account, the embedded EVM address).
   - `ASTER_SIGNER`: the API wallet address you authorised on Aster's API wallet page (https://www.asterdex.com/en/api-wallet, "Pro API").
   - `ASTER_SIGNER_PRIVATE_KEY`: that API wallet's private key.
   - `LIVE_TRADING`: leave `false` until you mean it.
3. `npm run server` (the demo server on http://127.0.0.1:8787)
4. In a second terminal: `npm run dev`, then open http://localhost:5173

Other scripts: `npm test`, `npm run typecheck`, `npm run build`.

## Trial mode and live mode

- **Trial (default).** `POST /api/set/place` builds the full plan, logs it to `logs/plans.jsonl`, and answers `"status": "trial: not sent"`. The card then follows the Set on the live price as a simulation (progress bar, halfway alert, result with fee split).
- **Live.** Only when all three hold: `LIVE_TRADING=true`, the ticket is at most `MAX_LIVE_TICKET_USD` (default $10), and the symbol is BTCUSDT or ETHUSDT. At start the server checks the key belongs to `ASTER_SIGNER` and makes one signed read; if either fails it stops with a message. A live Set: reads the account's position mode (never changes it, nor the margin type), checks the coin's position matches the open Sets and that the balance covers the ticket, raises the symbol leverage if needed (see "Many Sets at once"), then sends each entry with its take-profit and its stop as one OTOCO order: once the entry fills, Aster places both exits, and whichever fills cancels the other. Every Set is recorded in `logs/set-ledger.json`; `GET /api/sets` lists them with their own profit.
- **After the fill.** `handleOrderUpdate()` in `server/execute.ts` takes each order event from Aster's user data stream, sizes the Set's exits to what actually filled and moves its stop to the Set's own stop (85% of its ticket, never beyond 85% of Aster's real liquidation distance, `GET /fapi/v3/positionRisk`). `reconcileSymbol()` checks the coin's position against the open Sets. The demo server has no user data stream, so it calls neither; Blackboard's backend does.
- **Builder attribution.** Set `ASTER_BUILDER_ADDRESS` and `ASTER_BUILDER_FEE_RATE` (a decimal fraction, for example `0.0001` = 0.01%, at most `0.001`, Blackboard's approval ceiling) to add `builder` and `feeRate` to every signed order, the stop included.

## Server routes

- `GET /api/price?symbol=BTCUSDT`: the latest Aster price.
- `GET /api/levels?coin=BTC`: skilled traders' resting orders, take-profits and liquidation prices, with counts (addresses read, positions with a liquidation price, orders, request weight spent).
- `POST /api/set/preview`: the full plan (entry, nudged price, quantity, stop, liquidation, take-profit and the wall it sits in front of, ratio, expected win and max loss, fee split, structural counts) plus the exact Aster order legs. Body: `{"symbol":"BTCUSDT","side":"buy","ticketUsd":10,"leverage":30,"tpMode":"deserved","entryMode":"nearby"}`; add `"seed": 1` to repeat the same random picks; Draw adds `"draw":{"inBand":{"low":..,"high":..},"outBand":{"low":..,"high":..}}`.
- `POST /api/set/place`: same body; trial or live as above. A trial answer also carries a `setId` and the legs with their client order ids. A refused live Set (balance, a trade outside the Sets on that coin, a position mode change) answers 409 with a plain `message`; nothing was sent.
- `GET /api/sets`: every Set in the ledger with its status and its profit from its own fills.

## Many Sets at once

A user can hold many Sets at the same time: a Buy and a Sell Set on BTC together, several Buy Sets on BTC, Sets at 30x and 50x on the same coin. Aster itself only sees one position per coin (or one per side in hedge mode), so the app keeps its own record of each Set (`src/core/ledger.ts`) and checks Aster against it.

- **Each Set has an id.** Every order it sends carries it (`set_...-1E` entry, `-1T` take-profit, `-1S` stop), so each Set's own fills, entry price and profit are known even when Aster merges the positions.
- **Blackboard's settings stay as they are.** The account's position mode and margin type are read, never changed. In one-way mode a Set's exits are plain opposite orders of the Set's own size (not reduce-only), so the coin's position always equals the sum of open Sets. In hedge mode Buy Sets use the LONG side and Sell Sets the SHORT side.
- **Stop per Set.** The price where the Set has lost 85% of its ticket, or 85% of the way to the real liquidation of the coin's position, whichever comes first.
- **Leverage.** One number per coin on Aster. It is raised to the highest open Set's leverage and never lowered while Sets are open. A 30x Set stays sized at 30x; its stop moves in to match the higher leverage.
- **Money.** A Set is refused when the free balance cannot carry its ticket, or the balance cannot carry every open ticket plus this one.
- **Closed by hand.** If the user closes or changes the position in Blackboard's app, the next check (seen twice, 5 seconds apart) cancels those Sets' orders and marks them "closed outside the Set". It never places an order to fix it.
- **Profit share.** From each Set's own fills, after its own trading fees; nothing on a loss or on a Set closed outside.

What Blackboard's backend runs: `executeLive` on Enter, `handleOrderUpdate` for every `ORDER_TRADE_UPDATE` from Aster's user data stream, and `reconcileSymbol` after an event that asks for it and every 30 to 60 seconds for each coin with open Sets. All three take one ledger store per account (`LedgerStore`: load and save the ledger JSON).

## Risk notes

- **Stop just before liquidation.** The stop is a stop-market order: in a sudden gap it can fill worse than its price, and if price jumps past liquidation the venue liquidates instead. On isolated margin the loss is still capped by the margin; on cross margin only the stop caps it. Since 2026-11-16 a Set no longer switches the coin to isolated margin (that setting belongs to the user's Blackboard app), so on a cross-margin account the stop is the only cap.
- **Plain exits in one-way mode.** An exit that is not reduce-only needs margin when it moves the net position to the other side (for example a Buy Set's take-profit while a Sell Set is open). The balance check at placement covers every open ticket, but a balance drained in between could get an exit refused; the Set is then flagged `needsAttention` and logged.
- **The max loss shown is the loss at the stop**, before exchange trading fees and funding. With a $10 ticket at 30x it is about $6.20 (smoke run 2026-11-16), because the quantity is rounded down to Aster's 0.001 BTC step and the stop sits at 85% of a distance already shortened by the maintenance margin.
- **Leverage rules differ by country.** Several countries cap retail leverage on crypto derivatives or ban them outright; check where each user lives before offering 30x to 100x.
- **Levels are a guide, not a promise.** A level that mattered on Hyperliquid may not hold on Aster.

## A Set next to the user's own trade (2026-11-19)

- The user's own position on a coin is recorded as the outside baseline when the first Set opens there; the card warns that the Set merges into it. The exchange must then show outside + Sets.
- If he cuts or adds to his own part and the Sets' part is still covered, the baseline moves and the Sets keep their exits. If the position no longer covers the Sets (he closed everything), the Sets are closed outside and their orders cancelled.
- Refused before sending (`src/core/risk.ts`): free balance below the ticket; account equity below every open ticket plus this one (equity from `GET /fapi/v3/account`, because Blackboard accounts use multi-asset margin and the USDT wallet alone is small); any position's liquidation moving more than 30% closer to the price; any stop on the coin sitting past 85% of the way to the new liquidation. A move of 10 to 30% is a warning.
- Isolated margin does not separate Sets: Aster isolates per coin (per side in hedge mode), so two Sets on one coin and side still share one position. Sets read the margin type and never change it.
- `npx tsx scripts/check-account.ts` reads the account (no order); `POST /api/set/preview` returns the same checks as `check` when keys are set.

## Open items

- Aster's V3 doc lists `builder` and `feeRate` only on the strategy order endpoint, which is what live Sets use. Adding them to a plain `POST /fapi/v3/order` is done because Blackboard's guide asks for it, but that table does not list them, and the doc says unlisted parameters are rejected. The first live $10 Set will show which holds.
- Signing with `nonce`, `user` and `signer` works: proven live 2026-11-19.
- Patient needs liquidation prices near the price. With the wider set (171 traders on 2026-11-16) a Sell found a short cluster 4.15% above the price, but a Buy found no long liquidations within 5% below (8 longs below the price, none inside the window), so a Patient Buy fell back to Nearby. Hyperliquid's public liquidation feed would add more.
- OTOCO works live (2026-11-19, one $10 ETH Set at 30x): entry filled 0.166 at 1,805.73, take-profit 1,900.12 and stop 1,758.19 placed by Aster, and every order event carried our client order ids (`set_...-1E`, `-1T`, `-1S`) plus `si` (strategyId) and `ss` (sub id). Aster's gateway needs `firstDrivenId: "0"` and `secondDrivenId: "0"` on the entry leg, although the doc marks them optional (two refusals with code -1102 before that, nothing sent).
- Still unproven: `POST /fapi/v3/updateStrategyOrder` resizing working exits, and cancelling one sub-order by `origClientOrderId`. Both need a partial fill or a second Set on the same coin.
- The user data stream closed itself a few minutes after opening (`scripts/listen-stream.ts`); Blackboard's backend needs a reconnect loop.
- Before the fill, trial mode has no leverage brackets (a signed call), so it assumes a 0.5% maintenance margin rate. Live mode reads the real brackets; after the fill, `reconcileStop()` uses Aster's own liquidation price.
