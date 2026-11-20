/**
 * A FAKE clock for tests of timed background work (the liquidation map, Sets_Rules.md A10).
 * `sleep(ms)` resolves only when the test moves time past it with `advance`, in time order,
 * so paced requests can be counted per fake second. `now()` is the fake time in ms.
 * Not a test file (no .test.ts): imported by tests/hyperliquid.test.ts and tests/server.test.ts.
 */
export class FakeClock {
  t = 0;
  private timers: Array<{ at: number; resolve: () => void }> = [];

  now = (): number => this.t;

  sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), resolve });
    });

  /** Let every promise chain that is not waiting on the clock run to its next wait. */
  async flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }

  /** Move time forward by ms, waking each sleeper at its own time. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await this.flush();
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.resolve();
    }
    this.t = end;
    await this.flush();
  }
}
