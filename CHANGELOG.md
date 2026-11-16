# Changelog

## 2026-11-16 (product rules update)
- Card: Buy/Sell, ticket $10/$30/$100 (default $10), leverage 30x or 50x (default 30x). Take-profit mode (default Deserved) and when to enter (default Nearby) moved into an options sheet opened from one summary row that shows target, win and max loss. 100x stays as an advanced choice in the sheet. When Patient or Nearby falls back, the card says so.
- Stop: every Set now has a reduce-only stop-market at 85% of the way to liquidation, with builder fields; the take-profit ratio is measured against it. Live Sets go out as one OTOCO order (entry, take-profit, stop). Liquidation before the fill uses Aster's leverage brackets in live mode, else an assumed 0.5% maintenance rate (with no rate at all, 85% of the distance could land beyond the real liquidation at 100x). After the fill, `reconcileStop()` moves the stop to 85% of Aster's own liquidation price.
- Nearby: picks among the 3 heaviest 0.05%-wide bands of skilled traders' orders 0.05% to 0.5% away, weighted by dollars, then a random price inside the band, then the usual nudge.
- Take-profit: aims just in front of the heaviest wall of resting orders between the minimum and 1.5 times it (Aster's public order book plus Hyperliquid traders' orders), moved by up to 0.03%, never below the minimum; round numbers are the fallback.
- Patient: window 0.5% to 5% (was 1% to 5%); positions read from about 200 Hyperliquid traders (top 50 by monthly profit plus top 150 by monthly volume) with a request budget under Hyperliquid's limit and a 60-second cache; counts are logged.
- One injected random source for every pick (seedable); 104 tests; live read-only smoke on Aster and Hyperliquid in trial mode.

## 2026-11-16
- First build of the Set MVP: pure core (entry, nudge, take-profit, liquidation, Draw split, fees, alerts, input checks), Hyperliquid level source, Aster V3 client with EIP-712 signing and builder fields, demo signing server (trial by default), and the portrait Set card in Blackboard's style. 66 tests; live read-only smoke on Aster and Hyperliquid.
