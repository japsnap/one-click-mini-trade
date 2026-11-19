/**
 * Read-only account check (sends no order, changes no setting).
 * Run: npx tsx scripts/check-account.ts
 * Prints: whether the keys sign, the signer address matches ASTER_SIGNER, position mode,
 * USDT balance, every open position, and open orders on BTCUSDT and ETHUSDT.
 * Never prints a key.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
const cfg = loadConfig(process.env);
if (!cfg.credentials) { console.log("credentials: not set"); process.exit(1); }
const s = privateKeySigner(cfg.credentials.privateKey);
console.log(`signer key matches ASTER_SIGNER: ${s.address.toLowerCase() === cfg.credentials.signer.toLowerCase()}`);
console.log(`user ${cfg.credentials.user.slice(0, 6)}...${cfg.credentials.user.slice(-4)}  signer ${cfg.credentials.signer.slice(0, 6)}...${cfg.credentials.signer.slice(-4)}`);
const c = new AsterClient({ baseUrl: cfg.baseUrl, auth: { user: cfg.credentials.user, signer: cfg.credentials.signer, sign: s.sign }, builder: cfg.builder ?? undefined });
const hedge = await c.isHedgeMode();
console.log(`position mode: ${hedge ? "hedge" : "one-way"}`);
const bal = (await c.balance()) as Array<Record<string, unknown>>;
for (const r of bal) if (Number(r.balance) !== 0 || Number(r.availableBalance) !== 0) console.log(`balance ${r.asset}: wallet ${r.balance} available ${r.availableBalance} crossUnPnl ${r.crossUnPnl}`);
const pos = (await c.positionRisk()) as Array<Record<string, unknown>>;
const open = pos.filter((p) => Number(p.positionAmt) !== 0);
console.log(`open positions: ${open.length}`);
for (const p of open) console.log(`  ${p.symbol} ${p.positionSide} amt ${p.positionAmt} entry ${p.entryPrice} mark ${p.markPrice} liq ${p.liquidationPrice} lev ${p.leverage} ${p.marginType} isoMargin ${p.isolatedMargin} uPnl ${p.unRealizedProfit}`);
for (const sym of ["BTCUSDT", "ETHUSDT"]) {
  const lev = pos.find((p) => p.symbol === sym);
  const oo = (await c.openOrders(sym)) as Array<Record<string, unknown>>;
  console.log(`${sym}: leverage ${lev?.leverage ?? "?"} marginType ${lev?.marginType ?? "?"} open orders ${oo.length}`);
  for (const o of oo) console.log(`  ${o.type} ${o.side} ${o.origQty} @ ${o.price} stop ${o.stopPrice} cid ${o.clientOrderId}`);
}
