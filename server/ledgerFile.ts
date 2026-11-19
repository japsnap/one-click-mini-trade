/**
 * The Set ledger of the demo server's one account, as a JSON file (logs/set-ledger.json).
 * Blackboard keeps one per account in its own database. Shared by server/index.ts and
 * scripts/watch.ts so both read and write the file the same way.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyLedger, type SetLedger } from "../src/core/ledger";
import type { LedgerStore } from "./execute";

/**
 * A missing file is an empty ledger; a corrupt one fails loudly (a silent empty ledger
 * would make every open Set look like a stranger's trade).
 */
export function fileLedgerStore(file: string): LedgerStore {
  return {
    load: async () => {
      const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (text === null) return emptyLedger();
      const l = JSON.parse(text) as SetLedger;
      if (l?.version !== 1 || !Array.isArray(l.sets)) throw new Error(`${file} is not a Set ledger`);
      return l;
    },
    save: async (l) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(l, null, 2));
    },
  };
}
