# One-click mini trade: the Set

A **Set** is a leveraged trade opened with one button. On one portrait card the user picks only:

- **Direction**: Buy or Sell (default Buy).
- **Ticket**: $10, $30 or $100 (default $10). This is the margin; on isolated margin it is the most the user can lose.
- **One options line** below them shows what the options hold, from the current plan, for example `30x · target +5.2% ($15.6) · stop -2.6% ($7.9) · entry at market`. Tapping it opens the options sheet with:
  - **Leverage**: 30x (the default), 50x or 100x.
  - **Target**: Shy (at least 1x the loss), Deserved (at least 2x, the default) or Greedy (at least 4x).
  - **When to enter**: Now (market order), Nearby (the default), Patient, or Draw (paint an In band and an Out band on a price strip; the ticket is split into up to 5 orders).

Every number above is a rule in one file, `src/rules/defaultRules.ts`, and can be changed per deployment (see "Rules").

How each piece is chosen (rules of 2026-11-16):

- **Stop**: every Set carries a stop just before liquidation, at 85% of the way from entry to the liquidation price. Stopped there, the user keeps about 15% of what liquidation would take and pays no liquidation fee (Aster's BTCUSDT liquidation fee is 2.5% of the position), and because the stop is a normal signed order, Blackboard's builder fee applies to the close. The take-profit ratio is measured against this stop distance, because it is the real loss. Once the entry fills, the Set's stop is re-set from its own fill.
- **Nearby**: not the nearest level. Skilled traders' resting limit orders on the good side (bids below the price for a Buy) between 0.05% and 0.5% away are grouped into 0.05%-wide price bands; the 3 heaviest bands by dollars stay; one is picked at random, weighted by dollars; then a random price inside that band.
- **Patient**: a limit inside the heaviest cluster of other traders' liquidation prices 0.5% to 5% away (longs below the price for a Buy, shorts above for a Sell). It reads up to about 200 Hyperliquid traders (the 50 most profitable this month plus the 150 most active by volume). When there is no cluster it falls back to Nearby, and the card says so.
- **Take-profit**: first the minimum (1x, 2x or 4x the stop distance), then the heaviest wall of resting orders on the other side between that minimum and 1.5 times it (asks above a Buy, bids below a Sell), from Aster's own order book plus skilled Hyperliquid traders' resting orders. The target sits just in front of that wall, moved at random by up to 0.03%, never below the minimum. No wall, then the nearest round number beyond the minimum.

Every limit price is moved at random by up to 0.05% so many Sets never stack on one number. All randomness comes from one injected random source, so a seed reproduces a Set exactly (tests use this; the preview route accepts `"seed"`). On a winning Set, 5% of the profit goes to Blackboard and 5% to the copied trader; a losing Set pays nothing.

Orders go to **Aster**. Skilled traders' levels come from **Hyperliquid**, because Aster does not publish other users' positions or orders while Hyperliquid's are public. BTC and ETH trade at nearly the same price on both.

![The Set card on live data, 2026-11-20](docs/set-card-live-2026-11-20.png)

## The parts, and what Blackboard copies

| Part | Folder | Copy into Blackboard? |
|---|---|---|
| Core maths: entry, nudge, take-profit, stop, liquidation, Draw split, fees, alerts, input checks, the Set ledger, pre-trade checks | `src/core/` | Yes, first and as is, together with `src/rules/`. Plain TypeScript, no network, no React, no dependencies. |
| The rule set: every tunable number, and the check of an override | `src/rules/` (`defaultRules.ts`, `rules.ts`) | Yes. Blackboard ships its own defaults or an override file; see "Rules". |
| Trader levels from Hyperliquid | `src/levels/hyperliquid.ts` | Yes, on a backend (it downloads a 39 MB leaderboard and makes about 200 requests per refresh, at most one refresh a minute; keep it off phones). |
| Aster V3 client: EIP-712 signing, orders, order book, brackets, positions, order query, user data stream key, builder fields | `src/exchange/aster.ts` | Yes, where the signing key lives. `asterTypedData()` also works with a Privy wallet's signTypedData. |
| The watcher: cancels a Set's exits when its position was closed elsewhere | `server/watch.ts` | Yes, on the backend, one per account. |
| The card | `src/components/` (`SetCard.tsx`, `SetOptionsSheet.tsx`, `setSummary.ts`, `PriceStrip.tsx`, `useSetSession.ts`) | Yes. Pass your own `api` prop (see `src/api/client.ts`) instead of the demo server; give it `getRules()` so the card offers your rule set's tickets and leverages. Colours and fonts come from `src/theme.ts`. |

`server/` is a demo signing server. It shows the contract (routes below) and is the only place a private key lives; the browser never sees one.

Stack, matching Blackboard's app: React 18, TypeScript (strict), Vite, styled-components, TanStack Query, viem, lucide-react, Vitest.

## Setup

1. `npm install`
2. Optional, only for live orders: copy `.env.example` to `.env` and fill these four values:
   - `ASTER_USER`: the main account address (on Blackboard: Settings, Account, the embedded EVM address).
   - `ASTER_SIGNER`: the API wallet address you authorised on Aster's API wallet page (https://www.asterdex.com/en/api-wallet, "Pro API").
   - `ASTER_SIGNER_PRIVATE_KEY`: that API wallet's private key.
   - `LIVE_TRADING`: leave `false` until you mean it.
   Two more, both optional: `SETS_RULES_FILE` (a rules file other than `rules/my-rules.json`) and `ASTER_EXIT_REDUCE_ONLY` (`true` or `false`, default `false`; see "Open items").
3. `npm run server` (the demo server on http://127.0.0.1:8787)
4. In a second terminal: `npm run dev`, then open http://localhost:5173

Other scripts: `npm test`, `npm run typecheck`, `npm run build`, `npx tsx scripts/watch.ts` (the watcher on its own), `npx tsx scripts/check-account.ts` (reads the account, sends nothing).

## Trial mode and live mode

- **Trial (default).** `POST /api/set/place` builds the full plan, logs it to `logs/plans.jsonl`, and answers `"status": "trial: not sent"`. The card then follows the Set on the live price as a simulation (progress bar, halfway alert, result with fee split).
- **Live.** Only when all three hold: `LIVE_TRADING=true`, the ticket is at most the live cap (rule `live.maxTicketUsd`, default $10; `MAX_LIVE_TICKET_USD` wins when set), and the symbol is in rule `live.symbols` (default BTCUSDT and ETHUSDT). At start the server checks the key belongs to `ASTER_SIGNER` and makes one signed read; if either fails it stops with a message. A live Set: reads the account's position mode (never changes it, nor the margin type), refuses the Set when its coin already holds a position or a live Set (see "Never merge"), checks the balance and the cross-margin rules, sets the symbol leverage to the Set's, then sends the entry with its take-profit and its stop as one OTOCO order: once the entry fills, Aster places both exits, and whichever fills cancels the other. Every Set is recorded in `logs/set-ledger.json`; `GET /api/sets` lists them with their own profit. In live mode the server also runs the watcher (see "The watcher").
- **After the fill.** `handleOrderUpdate()` in `server/execute.ts` takes each order event from Aster's user data stream, sizes the Set's exits to what actually filled and moves its stop to the Set's own stop (85% of its ticket, never beyond 85% of Aster's real liquidation distance, `GET /fapi/v3/positionRisk`). The demo server's watcher records the events but does not resize exits (`updateStrategyOrder` is unproven live); Blackboard's backend runs `handleOrderUpdate`.
- **Builder attribution.** Set `ASTER_BUILDER_ADDRESS` and `ASTER_BUILDER_FEE_RATE` (a decimal fraction, for example `0.0001` = 0.01%, at most `0.001`, Blackboard's approval ceiling) to add `builder` and `feeRate` to every signed order, the stop included.

## Server routes

- `GET /api/price?symbol=BTCUSDT`: the latest Aster price.
- `GET /api/levels?coin=BTC`: skilled traders' resting orders, take-profits and liquidation prices, with counts (addresses read, positions with a liquidation price, orders, request weight spent).
- `POST /api/set/preview`: the full plan (entry, nudged price, quantity, stop, liquidation, take-profit and the wall it sits in front of, ratio, expected win and max loss, fee split, structural counts) plus the exact Aster order legs. Body: `{"symbol":"BTCUSDT","side":"buy","ticketUsd":10,"leverage":30,"tpMode":"deserved","entryMode":"nearby"}`; add `"seed": 1` to repeat the same random picks; Draw adds `"draw":{"inBand":{"low":..,"high":..},"outBand":{"low":..,"high":..}}`. With keys set it also runs the live checks and returns their refusal or warnings as `check`.
- `POST /api/set/place`: same body; trial or live as above. A trial answer also carries a `setId` and the legs with their client order ids. A refused live Set (the coin already holds a position or a Set, balance, a liquidation rule) answers 409 with a plain `message`; nothing was sent.
- `GET /api/sets`: every Set in the ledger with its status and its profit from its own fills.
- `GET /api/rules`: the active rule set and the file it came from.

## Never merge: one Set per coin (owner's ruling, 2026-11-20)

On one Aster account one coin holds one position (one per side in hedge mode). A Set opened on a coin that already holds a position would merge into it: one entry price, one liquidation, and closing either closes both. So a Set's position never merges with any other:

- **Refused before anything is sent** (`checkCoinIsFree` in `src/core/risk.ts`, called by `preTradeCheck` in `server/execute.ts`) when the coin has any open position, the user's own or another Set's, on either side, or a live Set in the ledger (a resting limit entry counts). The message is plain, for example "ETH already has an open position. A Set never shares a coin with another position, so nothing was sent."
- **Different coins are fine**, but they still share one cross-margin cushion, so two checks stay: a Set is refused when it would pull any other position's liquidation more than 30% closer to the price (10 to 30% is a warning), or when its own stop would sit past 85% of the way to its predicted liquidation. Margin: the free balance must carry the ticket and the account equity (`GET /fapi/v3/account`, because Blackboard accounts use multi-asset margin and the USDT wallet alone is small) must carry every open ticket plus this one.
- **Settings stay as they are.** The position mode and margin type are read, never changed. In one-way mode a Set's exits are opposite orders of the Set's own size; in hedge mode Buy Sets use the LONG side and Sell Sets the SHORT side.
- **Each Set has an id.** Every order carries it (`set_...-1E` entry, `-1T` take-profit, `-1S` stop), so each Set's fills and profit are known; the profit share comes from its own fills, after its own trading fees, and nothing is due on a loss or a Set closed outside.
- **Old ledgers still work.** Ledgers saved before the ruling may hold several Sets on one coin and the user's own position as `outside`; the ledger still reads and reconciles them (`reconcile`, `syncSetExits`, `symbolLeverageTarget`).

## The watcher (`server/watch.ts`)

In one-way mode a Set's exits are plain opposite orders. If the user closes the position by hand in Blackboard's app, the take-profit and stop stay on the book, and when one later triggers it opens a new position in the other direction. The watcher removes them.

- **The rule.** A live Set whose coin position is 0, or no longer covers the Set's filled quantity, while one of its exits is still working. Seen twice at least 5 seconds apart (the position moves a moment before the fill event arrives), then both exits are read back from Aster (`GET /fapi/v3/order` by client order id). An exit that filled means the Set closed by itself: it is recorded so and only the other exit is cancelled. Otherwise both exits, and any unfilled entry, are cancelled by client order id and the Set is marked closed with reason "closed outside the Set". It never places an order.
- **Two ways to notice.** (a) Aster's user data stream: the listenKey (`POST /fapi/v3/listenKey`, which returns the account's active key if one exists) is kept alive with a `PUT` every 30 minutes; a closed stream reconnects after 1 s, doubling up to 60 s; order events are recorded in the ledger, a position event on a coin with a live Set triggers a check. (b) A poll of `positionRisk` every 15 seconds for each coin with a live Set, because the stream closed itself after a few minutes in the live test of 2026-11-19.
- **Catch-up.** An entry the ledger has not seen finish is read back on every check, so a fill missed while nothing listened still counts (the live ETH Set of 2026-11-19 is one: the demo server had no stream).
- **Logs.** Every action goes to `logs/watch.jsonl` and the console, with a counts line per check (live Sets, position, uncovered, acted on, cancelled).
- **Running it.** The demo server starts it in live mode. On its own: `npx tsx scripts/watch.ts` (live: needs the keys and `LIVE_TRADING=true`), or `npx tsx scripts/watch.ts --dry` (reports what it would cancel and changes nothing; it still opens the stream key, which trades nothing). Run one watcher per account, not the script next to a live demo server.

## Rules (`src/rules/`)

What Blackboard receives is this setup plus a default rule set it can change; each owner can keep his own.

- `src/rules/defaultRules.ts` holds every tunable number with one plain line each: the stop's share of the way to liquidation (0.85) and of the ticket (0.85); the target ratios (Shy 1, Deserved 2, Greedy 4 times the loss) and the default target; the wall search (reach 1.5 times the minimum, smallest wall $25,000, band width, gap in front, random move, round-number reach); the entry default and the Nearby, Patient and Draw knobs; the nudge (0.05%); ticket choices (10, 30, 100) and default; leverage choices (30, 50, 100) and default (30); the liquidation-shrink block (0.30) and warning (0.10); the assumed maintenance and fee rates; the profit shares (5% Blackboard, 5% copied trader); the live caps.
- **An override** is a JSON file laid over the defaults: `SETS_RULES_FILE` when set, else `rules/my-rules.json` when it exists (kept out of git). Copy `rules/my-rules.example.json` to start; any key left out keeps its default; keys starting with `_` are notes.
- **Checked at load.** An unknown key, a wrong type, a value out of range, or rules that contradict each other (a default that is not among the choices, a warning above the block) stop the server with the key's name, for example `unknown rule "target.greedyy"`.
- `GET /api/rules` shows the active set and its file; the card reads it through `api.getRules()`, so its tickets, leverages, defaults and hints follow the file.

## Risk notes

- **Stop just before liquidation.** The stop is a stop-market order: in a sudden gap it can fill worse than its price, and if price jumps past liquidation the venue liquidates instead. On isolated margin the loss is still capped by the margin; on cross margin only the stop caps it. A Set never switches the coin to isolated margin (that setting belongs to the user's Blackboard app), so on a cross-margin account the stop is the only cap.
- **Plain exits in one-way mode.** An exit that is not reduce-only, left behind after a hand close, would open a new position when it triggers; the watcher cancels it within about 15 to 30 seconds. Reduce-only exits would close that gap (see "Open items").
- **The max loss shown is the loss at the stop**, before exchange trading fees and funding. With a $10 ticket at 30x it is about $6.20 (smoke run 2026-11-16), because the quantity is rounded down to Aster's 0.001 BTC step and the stop sits at 85% of a distance already shortened by the maintenance margin.
- **Leverage rules differ by country.** Several countries cap retail leverage on crypto derivatives or ban them outright; check where each user lives before offering 30x to 100x.
- **Levels are a guide, not a promise.** A level that mattered on Hyperliquid may not hold on Aster.

## Open items

- **Reduce-only exits: documented, untested.** Aster's V3 doc (https://github.com/asterdex/api-docs, `V3(Recommended)/EN/aster-finance-futures-api-v3.md`, "Place Strategy Order", sub-order fields) lists `reduceOnly` ("Reduce-only flag") and `closePosition` ("Close-position flag") as optional STRING fields of each OTOCO sub-order; "Update Strategy Order" lists both too. So `ASTER_EXIT_REDUCE_ONLY=true` adds `reduceOnly: "true"` to both exits in one-way mode (never in hedge mode, where the plain order doc forbids it). It defaults to `false` because no live Set has carried it, and a refusal would block every Set. Try it on one $10 Set.
- **Watcher, unproven live.** Reading an OTOCO sub-order back with `GET /fapi/v3/order` by `origClientOrderId`, and the reconnect loop over hours. First run: `npx tsx scripts/watch.ts --dry` and read `logs/watch.jsonl`.
- Still unproven: `POST /fapi/v3/updateStrategyOrder` resizing working exits, and cancelling one sub-order by `origClientOrderId`. Both need a partial fill or a hand close.
- Aster's V3 doc lists `builder` and `feeRate` only on the strategy order endpoint, which is what live Sets use. Adding them to a plain `POST /fapi/v3/order` is done because Blackboard's guide asks for it, but that table does not list them, and the doc says unlisted parameters are rejected.
- Patient needs liquidation prices near the price. With the wider set (171 traders on 2026-11-16) a Sell found a short cluster 4.15% above the price, but a Buy found no long liquidations within 5% below, so a Patient Buy fell back to Nearby. Hyperliquid's public liquidation feed would add more.
- Proven live 2026-11-19 (one $10 ETH Set at 30x): signing with `nonce`, `user` and `signer`; OTOCO with entry filled 0.166 at 1,805.73, take-profit 1,900.12 and stop 1,758.19 placed by Aster, every order event carrying our client order ids plus `si` (strategyId) and `ss` (sub id). Aster's gateway needs `firstDrivenId: "0"` and `secondDrivenId: "0"` on the entry leg, although the doc marks them optional.
- Before the fill, trial mode has no leverage brackets (a signed call), so it assumes a 0.5% maintenance margin rate (rule `risk.assumedMaintenanceRate`). Live mode reads the real brackets.
