# One-click mini trade: the Set

A **Set** is a leveraged trade opened with one button. On one portrait card the user picks:

- **Direction**: Buy or Sell.
- **Ticket**: $10, $30 or $100. This is the margin and the most the user can lose. There is no stop-loss: the liquidation price is the stop.
- **Leverage**: 30x, 50x or 100x.
- **Take-profit**: Shy (at least 1x the risk), Deserved (at least 2x, the default) or Greedy (at least 4x). The target then moves to the nearest round number or skilled-trader take-profit just beyond that minimum.
- **When**: Now (market order), Nearby (a limit next to skilled traders' resting orders within 0.5%), Patient (a limit inside the heaviest cluster of other traders' liquidation prices 1% to 5% away), or Draw (paint an In band and an Out band on a price strip; the ticket is split into up to 5 orders).

Every limit price is moved at random by up to 0.05% so many Sets never stack on one number. On a winning Set, 5% of the profit goes to Blackboard and 5% to the copied trader; a losing Set pays nothing.

Orders go to **Aster**. Skilled traders' levels come from **Hyperliquid**, because Aster does not publish other users' positions or orders while Hyperliquid's are public. BTC and ETH trade at nearly the same price on both.

![The Set card on live data](docs/set-card-live-2026-11-16.png)

## The four parts, and what Blackboard copies

| Part | Folder | Copy into Blackboard? |
|---|---|---|
| Core maths: entry, nudge, take-profit, liquidation, Draw split, fees, alerts, input checks | `src/core/` | Yes, first and as is. Plain TypeScript, no network, no React, no dependencies. |
| Trader levels from Hyperliquid | `src/levels/hyperliquid.ts` | Yes, on a backend (it downloads a 39 MB leaderboard; keep it off phones). |
| Aster V3 client: EIP-712 signing, orders, builder fields | `src/exchange/aster.ts` | Yes, where the signing key lives. `asterTypedData()` also works with a Privy wallet's signTypedData. |
| The card | `src/components/` (`SetCard.tsx`, `PriceStrip.tsx`, `useSetSession.ts`) | Yes. Pass your own `api` prop (see `src/api/client.ts`) instead of the demo server. Colours and fonts come from `src/theme.ts`. |

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
- **Live.** Only when all three hold: `LIVE_TRADING=true`, the ticket is at most `MAX_LIVE_TICKET_USD` (default $10), and the symbol is BTCUSDT or ETHUSDT. At start the server checks the key belongs to `ASTER_SIGNER` and makes one signed read; if either fails it stops with a message. A live Set: switches the symbol to isolated margin (so the ticket really is the most you can lose), sets the leverage, then sends each entry with its take-profit as one OTO order (the take-profit is placed only once the entry fills).
- **Builder attribution.** Set `ASTER_BUILDER_ADDRESS` and `ASTER_BUILDER_FEE_RATE` (a decimal fraction, for example `0.0001` = 0.01%, at most `0.001`, Blackboard's approval ceiling) to add `builder` and `feeRate` to every signed order.

## Server routes

- `GET /api/price?symbol=BTCUSDT`: the latest Aster price.
- `GET /api/levels?coin=BTC`: skilled traders' resting orders, take-profits and liquidation prices, with counts.
- `POST /api/set/preview`: the full plan (entry, nudged price, quantity, liquidation, take-profit, ratio, expected win and loss, fee split) plus the exact Aster order legs. Body: `{"symbol":"BTCUSDT","side":"buy","ticketUsd":30,"leverage":50,"tpMode":"deserved","entryMode":"now"}`; Draw adds `"draw":{"inBand":{"low":..,"high":..},"outBand":{"low":..,"high":..}}`.
- `POST /api/set/place`: same body; trial or live as above.

## Risk notes

- **No stop-loss, by design.** The liquidation price is the stop. On isolated margin the loss is capped at the ticket; on cross margin it is not, which is why live mode switches to isolated first.
- **The ticket is the maximum loss**, before exchange trading fees and funding.
- **Leverage rules differ by country.** Several countries cap retail leverage on crypto derivatives or ban them outright; check where each user lives before offering 30x to 100x.
- **Levels are a guide, not a promise.** A level that mattered on Hyperliquid may not hold on Aster.

## Open items

- Aster's V3 doc lists `builder` and `feeRate` only on the strategy order endpoint, which is what live Sets use. Adding them to a plain `POST /fapi/v3/order` is done because Blackboard's guide asks for it, but that table does not list them, and the doc says unlisted parameters are rejected. The first live $10 Set will show which holds.
- The doc's two signing examples differ: one signs `nonce` and `signer`, the other `nonce`, `user` and `signer`. This client signs all three (the doc's authentication table). If Aster answers a signature error, set `includeUserInSignedString: false`.
- Patient needs liquidation prices near the price. The top 30 traders on Hyperliquid mostly hold large positions at low leverage, so on 2026-11-16 their nearest BTC liquidation was 16.7% away and Patient fell back to Nearby. A wider trader set or Hyperliquid's public liquidation feed would fill it.
