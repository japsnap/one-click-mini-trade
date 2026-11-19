/**
 * Listen to Aster's user data stream and append every event to logs/stream.jsonl.
 * Read-only: POST /fapi/v3/listenKey (returns the account's active key if one exists, so it
 * never disturbs Blackboard's own stream), PUT every 30 min to keep it alive, never DELETE.
 * Run: npx tsx scripts/listen-stream.ts [minutes, default 120]
 */
import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";
import { AsterClient, privateKeySigner, parseOrderTradeUpdate } from "../src/exchange/aster";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try { process.loadEnvFile(path.join(ROOT, ".env")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
const cfg = loadConfig(process.env);
if (!cfg.credentials) throw new Error("credentials not set");
const s = privateKeySigner(cfg.credentials.privateKey);
const c = new AsterClient({ baseUrl: cfg.baseUrl, auth: { user: cfg.credentials.user, signer: cfg.credentials.signer, sign: s.sign } });
const minutes = Number(process.argv[2] ?? 120);
const out = path.join(ROOT, "logs", "stream.jsonl");
mkdirSync(path.dirname(out), { recursive: true });
const { listenKey } = (await c.signed("POST", "/fapi/v3/listenKey", [])) as { listenKey: string };
const ws = new WebSocket(`wss://fstream.asterdex.com/ws/${listenKey}`);
ws.onopen = () => console.log(`[stream] open, logging to ${out} for ${minutes} min`);
ws.onmessage = (m) => {
  const raw = JSON.parse(String(m.data));
  let parsed: unknown = null;
  try { parsed = parseOrderTradeUpdate(raw); } catch (e) { parsed = { parseError: (e as Error).message }; }
  appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), raw, parsed }) + "\n");
  if (raw.e === "ORDER_TRADE_UPDATE") console.log(`[stream] ${raw.o?.s} ${raw.o?.c} ${raw.o?.o} ${raw.o?.X} filled ${raw.o?.z}`);
  else console.log(`[stream] ${raw.e}`);
};
ws.onerror = (e) => console.error(`[stream] error ${(e as ErrorEvent).message ?? ""}`);
ws.onclose = () => { console.log("[stream] closed"); process.exit(0); };
const keep = setInterval(() => c.signed("PUT", "/fapi/v3/listenKey", []).catch((e) => console.error(`[stream] keepalive failed ${e.message}`)), 30 * 60_000);
setTimeout(() => { clearInterval(keep); ws.close(); }, minutes * 60_000);
