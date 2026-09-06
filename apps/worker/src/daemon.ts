import { OutboundWorkerRuntime } from "./runtime.ts";

export type WorkerDaemonOptions = { runtime?: OutboundWorkerRuntime; createRuntime?: () => Promise<OutboundWorkerRuntime | undefined>; beforePoll?: () => Promise<boolean | void>; isTerminal?: () => boolean; pollIntervalMs?: number; heartbeatIntervalMs?: number; onError?: (error: unknown) => void };

export class WorkerDaemon {
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeatAt = 0;
  private running = false;
  private stopped?: () => void;
  private lifecycleHandle?: ReturnType<typeof setInterval>;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly options: WorkerDaemonOptions;
  private runtime?: OutboundWorkerRuntime;
  constructor(options: WorkerDaemonOptions) {
    this.options = options;
    if (!options.runtime && !options.createRuntime) throw new Error("worker daemon requires a runtime or runtime factory");
    this.runtime = options.runtime;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    // Keep the CLI resident even while enrollment/network work is between ticks.
    this.lifecycleHandle = setInterval(() => undefined, 60_000);
    void this.tick();
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.lifecycleHandle) clearInterval(this.lifecycleHandle);
    this.lifecycleHandle = undefined;
    this.runtime?.close();
    this.runtime = undefined;
    const resolve = this.stopped;
    this.stopped = undefined;
    resolve?.();
  }
  async wait(): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => { this.stopped = resolve; });
  }
  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      if (this.options.isTerminal?.()) { this.stop(); return; }
      if (!this.runtime && this.options.createRuntime) {
        const created = await this.options.createRuntime();
        if (!this.running) { created?.close(); return; }
        this.runtime = created;
        if (this.runtime) await this.runtime.connect();
      }
      if (!this.runtime) {
        if (this.running) this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
        return;
      }
      if (this.options.beforePoll && (await this.options.beforePoll()) === false) {
        this.runtime.close();
        this.runtime = undefined;
        if (this.running) this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
        return;
      }
      await this.runtime.pollOnce();
      const now = Date.now();
      if (now - this.heartbeatAt >= this.heartbeatIntervalMs) { await this.runtime.refreshInventory(); await this.runtime.heartbeat(); this.heartbeatAt = now; }
    } catch (error) {
      if (error instanceof Error && (error.name === "WorkerTransportError" || error.message.includes("worker WebSocket") || error.message.includes("WORKER_"))) {
        this.runtime?.close();
        this.runtime = undefined;
      }
      if (this.running) this.options.onError?.(error);
    }
    if (this.running) this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
  }
}
