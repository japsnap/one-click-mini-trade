/**
 * Run the Set watcher on its own (server/watch.ts), without the demo server.
 *   npx tsx scripts/watch.ts         live: cancels the exits of a Set whose position was closed elsewhere
 *   npx tsx scripts/watch.ts --dry   report only: says what it would cancel, changes nothing
 * Live needs the three Aster keys in .env and LIVE_TRADING=true. Run one watcher per
 * account: not this script and a live demo server at the same time (both write the ledger).
 * Logs to logs/watch.jsonl and the console. Stop with Ctrl+C.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config";
import { fileLedgerStore } from "../server/ledgerFile";
import { loadRulesFile } from "../server/rules";
import { fileWatchLog, SetWatcher } from "../server/watch";
import { AsterClient, privateKeySigner } from "../src/exchange/aster";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
const dry = process.argv.includes("--dry");
loadRulesFile(process.env, ROOT);
const cfg = loadConfig(process.env);
if (!cfg.credentials) {
  console.error("[watch] ASTER_USER, ASTER_SIGNER and ASTER_SIGNER_PRIVATE_KEY are not set in .env. Stopping.");
  process.exit(1);
}
if (!dry && !cfg.liveTrading) {
  console.error("[watch] LIVE_TRADING is not true, so nothing may be cancelled. Run with --dry, or set LIVE_TRADING=true. Stopping.");
  process.exit(1);
}
const s = privateKeySigner(cfg.credentials.privateKey);
if (s.address.toLowerCase() !== cfg.credentials.signer.toLowerCase()) {
  console.error("[watch] ASTER_SIGNER_PRIVATE_KEY does not belong to ASTER_SIGNER. Stopping.");
  process.exit(1);
}
const client = new AsterClient({ baseUrl: cfg.baseUrl, auth: { user: cfg.credentials.user, signer: cfg.credentials.signer, sign: s.sign } });
const watcher = new SetWatcher({
  client,
  store: fileLedgerStore(path.join(ROOT, "logs", "set-ledger.json")),
  dry,
  reduceOnlyExits: cfg.reduceOnlyExits,
  log: fileWatchLog(path.join(ROOT, "logs", "watch.jsonl")),
});
process.on("SIGINT", () => {
  watcher.stop();
  process.exit(0);
});
await watcher.start();
