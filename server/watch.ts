/**
 * The Set watcher (2026-11-20): closes a Set's exits when its position was closed
 * somewhere else, for example by hand in Blackboard's app.
 *
 * Why it is needed: in one-way mode a Set's exits are plain opposite orders. If the user
 * closes the position by hand, the take-profit and stop stay on the book; when one later
 * triggers it OPENS a new position in the other direction. So the exits must go.
 *
 * The rule (core/ledger.ts uncoveredSets): a live Set whose coin position is 0, or no
 * longer covers the Set's filled quantity, while one of its exits is still working. Seen
 * twice at least graceMs apart (the position moves a moment before the fill event
 * arrives), then both exits are read back from Aster (GET /fapi/v3/order):
 *   - an exit FILLED: the Set closed by its own exit; it is recorded as such and only
 *     the other exit is cancelled;
 *   - otherwise: both exits (and any unfilled entry) are cancelled by client order id and
 *     the Set is marked closed with reason "closed outside the Set". Nothing is ever placed.
 *
 * Two ways to notice, because the stream alone closed itself after a few minutes in the
 * live test of 2026-11-19:
 *   (a) Aster's user data stream: ORDER_TRADE_UPDATE events are recorded in the ledger,
 *       ACCOUNT_UPDATE on a coin with a live Set triggers a check. The listenKey is kept
 *       alive with a PUT every 30 minutes; a closed stream reconnects with backoff.
 *   (b) a poll of positionRisk every 15 s for each coin that has a live Set.
 * Entries the ledger has not seen filled are read back too (catch-up), so a fill missed
 * while nothing was listening still counts.
 *
 * The watcher never resizes exits (updateStrategyOrder is still unproven live). Dry mode
 * works on a copy of the ledger and only reports what it would cancel; it still opens
 * the stream (POST and PUT listenKey, which trade nothing).
 * Every action goes to the log function: logs/watch.jsonl and the console in the server
 * and in scripts/watch.ts.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  activeSets,
  applyOrderUpdate,
  closeSetsOutside,
  filledQty,
  isFinal,
  legOpenQty,
  uncoveredSets,
  type LedgerAction,
  type LedgerLog,
  type SetLedger,
} from "../src/core/ledger";
import { parseOrderTradeUpdate, parsePositionRows, queriedOrderToUpdate, type AsterClient } from "../src/exchange/aster";
import type { SymbolRules } from "../src/core/types";
import { memoryLedgerStore, performCancels, withLedgerLock, type LedgerStore } from "./execute";

/** The part of a WebSocket the watcher uses (Node's global WebSocket fits). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface WatchLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  /** What happened: start, stream, poll, check, catch-up, cancel, would-cancel, closed-outside, closed-by-exit, order-event. */
  event: string;
  message: string;
  symbol?: string;
  setId?: string;
  dry?: boolean;
}

export interface WatcherOptions {
  client: AsterClient;
  store: LedgerStore;
  /** Report only: work on a copy of the ledger, cancel nothing. */
  dry?: boolean;
  log?: (e: WatchLogEntry) => void;
  /** Symbol rules (step size); default the client's cached exchangeInfo read. */
  rulesFor?: (symbol: string) => Promise<SymbolRules>;
  openSocket?: (url: string) => SocketLike;
  /** Default wss://fstream.asterdex.com (V3 doc "User Data Streams"). */
  wsBaseUrl?: string;
  /** Backup poll while a Set is open and its exits are NOT reduce-only. Default 15 s. */
  pollMs?: number;
  /**
   * The Sets' exits are reduce-only (ASTER_EXIT_REDUCE_ONLY=true): an exit can then only
   * shrink a position, never open one, so a late cancel costs nothing and the backup poll
   * slows to slowPollMs. The stream still reacts at once either way.
   */
  reduceOnlyExits?: boolean;
  /** Backup poll when reduceOnlyExits is on. Default 60 s. */
  slowPollMs?: number;
  keepaliveMs?: number;
  graceMs?: number;
  /** Reconnect delay: firstMs, doubled per failed try, at most maxMs. */
  reconnect?: { firstMs: number; maxMs: number };
  now?: () => number;
}

/** Console plus one JSON line per entry in `file` (logs/watch.jsonl). */
export function fileWatchLog(file: string): (e: WatchLogEntry) => void {
  mkdirSync(path.dirname(file), { recursive: true });
  return (e) => {
    appendFileSync(file, JSON.stringify(e) + "\n");
    const line = `[watch]${e.dry ? " [dry]" : ""} ${e.event}${e.symbol ? ` ${e.symbol}` : ""}: ${e.message}`;
    (e.level === "error" ? console.error : e.level === "warn" ? console.warn : console.log)(line);
  };
}

/** A ledger store that reads the real one once and then keeps every change in memory. */
function dryStore(real: LedgerStore): LedgerStore {
  let mem: ReturnType<typeof memoryLedgerStore> | null = null;
  return {
    load: async () => {
      if (!mem) mem = memoryLedgerStore(await real.load());
      return mem.load();
    },
    save: async (l) => {
      if (!mem) mem = memoryLedgerStore(l);
      await mem.save(l);
    },
  };
}

export class SetWatcher {
  private readonly client: AsterClient;
  readonly store: LedgerStore;
  private readonly dry: boolean;
  private readonly out: (e: WatchLogEntry) => void;
  private readonly rulesFor: (symbol: string) => Promise<SymbolRules>;
  private readonly openSocket: (url: string) => SocketLike;
  private readonly wsBaseUrl: string;
  private readonly pollMs: number;
  /** How often the backup poll actually asks Aster: pollMs, or slowPollMs with reduce-only exits. */
  private readonly askEveryMs: number;
  /** When the poll last asked Aster; -Infinity = never. */
  private lastAsked = -Infinity;
  private readonly keepaliveMs: number;
  private readonly graceMs: number;
  private readonly backoff: { firstMs: number; maxMs: number };
  private readonly now: () => number;
  /** First sight of an uncovered Set, by `${symbol}:${setId}`. Kept in memory: a restart only delays. */
  private readonly seen = new Map<string, number>();
  private socket: SocketLike | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private pollFailures = 0;
  /** Counters for tests and the start-up line. */
  readonly stats = { streamOpens: 0, streamCloses: 0, reconnectsScheduled: 0, polls: 0, checks: 0, cancels: 0, wouldCancel: 0, closedOutside: 0 };

  constructor(o: WatcherOptions) {
    this.client = o.client;
    this.dry = o.dry ?? false;
    this.store = this.dry ? dryStore(o.store) : o.store;
    this.out = o.log ?? ((e) => console.log(`[watch] ${e.event}: ${e.message}`));
    this.rulesFor = o.rulesFor ?? ((s) => o.client.getSymbolRules(s));
    this.openSocket = o.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.wsBaseUrl = (o.wsBaseUrl ?? "wss://fstream.asterdex.com").replace(/\/+$/, "");
    this.pollMs = o.pollMs ?? 15_000;
    this.askEveryMs = o.reduceOnlyExits ? (o.slowPollMs ?? 60_000) : this.pollMs;
    this.keepaliveMs = o.keepaliveMs ?? 30 * 60_000;
    this.graceMs = o.graceMs ?? 5_000;
    this.backoff = o.reconnect ?? { firstMs: 1_000, maxMs: 60_000 };
    this.now = o.now ?? Date.now;
  }

  private log(level: WatchLogEntry["level"], event: string, message: string, extra: { symbol?: string; setId?: string } = {}) {
    this.out({ at: new Date(this.now()).toISOString(), level, event, message, ...extra, ...(this.dry ? { dry: true } : {}) });
  }
  private relay(event: string, lines: LedgerLog[], symbol?: string) {
    for (const l of lines) this.log(l.level, event, l.message, { ...(symbol ? { symbol } : {}), ...(l.setId ? { setId: l.setId } : {}) });
  }

  /** Start the stream, the poll and the keepalive. Never throws: failures are logged and retried. */
  async start(): Promise<void> {
    this.stopped = false;
    this.log("info", "start", `watching live Sets: backup poll every ${this.askEveryMs / 1000} s while a Set is open (none while none is)${this.askEveryMs !== this.pollMs ? ", slower because exits are reduce-only" : ""}, stream keepalive every ${this.keepaliveMs / 60_000} min, grace ${this.graceMs / 1000} s${this.dry ? ", dry run: nothing is cancelled" : ""}`);
    await this.pollOnce(true);
    await this.connect();
    this.timers.push(setInterval(() => void this.pollOnce(), this.pollMs));
    this.timers.push(
      setInterval(() => {
        if (!this.socket) return;
        this.client.keepAliveUserStream().then(
          () => this.log("info", "stream", "listenKey kept alive"),
          (e: Error) => this.log("error", "stream", `listenKey keepalive failed: ${e.message}`),
        );
      }, this.keepaliveMs),
    );
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.log("info", "start", "stopped");
  }

  // ---------- stream ----------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let key: string;
    try {
      key = await this.client.startUserStream();
    } catch (e) {
      this.log("error", "stream", `could not get a listenKey: ${(e as Error).message}`);
      return this.scheduleReconnect();
    }
    const ws = this.openSocket(`${this.wsBaseUrl}/ws/${key}`);
    this.socket = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.stats.streamOpens++;
      this.log("info", "stream", "user data stream open");
      void this.pollOnce(true); // events may have been missed while it was down
    };
    ws.onmessage = (m) => void this.handleStreamMessage(String(m.data));
    ws.onerror = (e) => this.log("warn", "stream", `stream error ${(e as { message?: string })?.message ?? ""}`.trim());
    ws.onclose = () => {
      if (this.socket !== ws) return; // an old socket we replaced or stopped
      this.socket = null;
      this.stats.streamCloses++;
      this.log("warn", "stream", "user data stream closed; the poll keeps watching");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.backoff.maxMs, this.backoff.firstMs * 2 ** this.attempts);
    this.attempts++;
    this.stats.reconnectsScheduled++;
    this.log("info", "stream", `reconnecting in ${Math.round(delay / 1000)} s (try ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** One message from the user data stream. */
  async handleStreamMessage(text: string): Promise<void> {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.log("error", "stream", `message is not JSON: ${text.slice(0, 120)}`);
    }
    try {
      if (m.e === "listenKeyExpired") {
        this.log("warn", "stream", "listenKey expired; reconnecting with a fresh key");
        this.socket?.close();
        return;
      }
      if (m.e === "ORDER_TRADE_UPDATE") {
        const u = parseOrderTradeUpdate(m);
        if (!u) return;
        const needs = await withLedgerLock(this.store, async () => {
          const ledger = await this.store.load();
          const step = applyOrderUpdate(ledger, u, this.now());
          if (!step.matched) return step.needsReconcile;
          this.relay("order-event", step.log, u.symbol);
          const after = await this.act(step.ledger, step.actions, u.symbol);
          await this.store.save(after);
          return step.needsReconcile;
        });
        if (needs) await this.checkSymbol(u.symbol, "stream");
        return;
      }
      if (m.e === "ACCOUNT_UPDATE") {
        const rows = (((m.a as Record<string, unknown> | undefined)?.P as Array<Record<string, unknown>> | undefined) ?? []).filter((p) => typeof p?.s === "string");
        const ledger = await this.store.load();
        for (const sym of new Set(rows.map((p) => p.s as string))) if (activeSets(ledger, sym).length > 0) await this.checkSymbol(sym, "stream");
      }
    } catch (e) {
      this.log("error", "stream", `could not handle ${String(m.e)}: ${(e as Error).message}`);
    }
  }

  // ---------- poll and the rule ----------

  /**
   * The backup poll: check every coin that has a live Set. The timer ticks every pollMs,
   * but it only asks Aster when a Set is open, and with reduce-only exits only every
   * slowPollMs. force: ask now (start-up, stream reconnect).
   */
  async pollOnce(force = false): Promise<void> {
    try {
      const ledger = await this.store.load();
      const symbols = [...new Set(activeSets(ledger).map((s) => s.symbol))];
      if (symbols.length === 0) return; // no open Set: nothing to ask Aster
      if (!force && this.now() - this.lastAsked < this.askEveryMs) return;
      this.lastAsked = this.now();
      this.stats.polls++;
      for (const s of symbols) await this.checkSymbol(s, "poll");
      this.pollFailures = 0;
    } catch (e) {
      this.pollFailures++;
      this.log("error", "poll", `poll failed (${this.pollFailures} in a row): ${(e as Error).message}`);
      if (this.pollFailures === 3) this.log("error", "poll", "the poll has failed 3 times in a row; hand-closed positions are not being caught");
    }
  }

  /** Apply the rule to one coin. Returns what it cancelled (or, dry, would cancel). */
  async checkSymbol(symbol: string, source: "poll" | "stream"): Promise<{ cancelled: string[]; closedOutside: string[] }> {
    return withLedgerLock(this.store, async () => {
      this.stats.checks++;
      let ledger = await this.store.load();
      const live = activeSets(ledger, symbol);
      if (live.length === 0) {
        for (const k of [...this.seen.keys()]) if (k.startsWith(`${symbol}:`)) this.seen.delete(k);
        return { cancelled: [], closedOutside: [] };
      }
      const rules = await this.rulesFor(symbol);
      const rows = parsePositionRows(await this.client.positionRisk(symbol), symbol);
      ledger = await this.catchUpEntries(ledger, symbol);

      const uncovered = uncoveredSets(ledger, symbol, rows, rules.stepSize);
      const now = this.now();
      const confirmed: string[] = [];
      for (const u of uncovered) {
        const key = `${symbol}:${u.setId}`;
        const first = this.seen.get(key);
        if (first === undefined) {
          this.seen.set(key, now);
          this.log("warn", "check", `position ${u.positionQty} does not cover Set ${u.setId}'s ${u.setsQty} while the Set is still open (${source}); checking again before acting`, { symbol, setId: u.setId });
        } else if (now - first >= this.graceMs) {
          confirmed.push(u.setId);
        }
      }
      for (const k of [...this.seen.keys()]) if (k.startsWith(`${symbol}:`) && !uncovered.some((u) => k === `${symbol}:${u.setId}`)) this.seen.delete(k);

      const cancelled: string[] = [];
      const closedOutside: string[] = [];
      for (const setId of confirmed) {
        this.seen.delete(`${symbol}:${setId}`);
        // Read both exits back: a take-profit or stop that filled means the Set closed by itself.
        const exits = await this.readBackExits(ledger, setId, symbol);
        ledger = exits.ledger;
        const set = ledger.sets.find((s) => s.id === setId)!;
        let actions: LedgerAction[] = exits.actions;
        if (set.status === "closed") {
          this.log("info", "closed-by-exit", `Set ${setId} closed by its own exit (read back from Aster)`, { symbol, setId });
        } else {
          const step = closeSetsOutside(ledger, [setId], now, "closed outside the Set");
          ledger = step.ledger;
          actions = [...actions, ...step.actions];
          this.relay("closed-outside", step.log, symbol);
          closedOutside.push(setId);
          this.stats.closedOutside++;
        }
        cancelled.push(...actions.filter((a) => a.kind === "cancel").map((a) => (a.kind === "cancel" ? a.clientOrderId : "")));
        ledger = await this.act(ledger, actions, symbol);
      }
      await this.store.save(ledger);
      const pos = rows.map((r) => `${r.positionSide} ${r.positionAmt}`).join(", ") || "none";
      this.log(confirmed.length ? "warn" : "info", "check", `[counts] ${source}: live Sets ${live.length}, position ${pos}, uncovered ${uncovered.length}, acted on ${confirmed.length}, ${this.dry ? "would cancel" : "cancelled"} ${cancelled.length}`, { symbol });
      return { cancelled, closedOutside };
    });
  }

  /** Read entries the ledger has not seen finish, so a fill missed while nobody listened counts. */
  private async catchUpEntries(ledger0: SetLedger, symbol: string): Promise<SetLedger> {
    let ledger = ledger0;
    for (const set of activeSets(ledger0, symbol)) {
      for (const leg of set.legs) {
        if (leg.sent === "not-sent" || isFinal(leg.entry)) continue;
        const q = await this.client.queryOrderByClientId(symbol, leg.entry.clientOrderId);
        if (!q) continue;
        const before = filledQty(leg.entry);
        const step = applyOrderUpdate(ledger, queriedOrderToUpdate(q), this.now());
        ledger = step.ledger;
        if (q.executedQty > before) this.log("info", "catch-up", `entry ${leg.entry.clientOrderId} ${q.status}, filled ${q.executedQty} @ ${q.avgPrice} (ledger had ${before})`, { symbol, setId: set.id });
      }
    }
    return ledger;
  }

  /** Read one Set's working exits back from Aster and record what they show. */
  private async readBackExits(ledger0: SetLedger, setId: string, symbol: string): Promise<{ ledger: SetLedger; actions: LedgerAction[] }> {
    let ledger = ledger0;
    const actions: LedgerAction[] = [];
    const set = ledger0.sets.find((s) => s.id === setId);
    for (const leg of set?.legs ?? []) {
      if (!(legOpenQty(leg) > 1e-12)) continue;
      for (const exit of [leg.takeProfit, leg.stop]) {
        if (isFinal(exit)) continue;
        try {
          const q = await this.client.queryOrderByClientId(symbol, exit.clientOrderId);
          if (!q) continue;
          const step = applyOrderUpdate(ledger, queriedOrderToUpdate(q), this.now());
          ledger = step.ledger;
          actions.push(...step.actions.filter((a) => a.kind === "cancel"));
          this.log("info", "check", `exit ${exit.clientOrderId} on Aster: ${q.status}, filled ${q.executedQty}`, { symbol, setId });
        } catch (e) {
          // Unread: cancel it anyway; a cancel of an order already gone answers "unknown order".
          this.log("warn", "check", `could not read exit ${exit.clientOrderId}: ${(e as Error).message}`, { symbol, setId });
        }
      }
    }
    return { ledger, actions };
  }

  /** Perform the ledger's cancels (dry: report them). Never places anything. */
  private async act(ledger: SetLedger, actions: LedgerAction[], symbol: string): Promise<SetLedger> {
    const cancels = actions.filter((a) => a.kind === "cancel");
    if (cancels.length === 0) return ledger;
    if (this.dry) {
      for (const a of cancels) if (a.kind === "cancel") this.log("warn", "would-cancel", `would cancel ${a.clientOrderId} (${a.reason})`, { symbol, setId: a.setId });
      this.stats.wouldCancel += cancels.length;
      return ledger;
    }
    const lines: LedgerLog[] = [];
    const after = await performCancels(this.client, ledger, cancels, lines);
    this.relay("cancel", lines, symbol);
    this.stats.cancels += cancels.length;
    return after;
  }
}
