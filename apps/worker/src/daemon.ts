import { OutboundWorkerRuntime, type WorkerCapabilityAdapter } from "./runtime.ts";

export type WorkerDaemonOptions = { runtime: OutboundWorkerRuntime; pollIntervalMs?: number; heartbeatIntervalMs?: number; onError?: (error: unknown) => void };

export class WorkerDaemon {
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeatAt = 0;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly options: WorkerDaemonOptions;
  constructor(options: WorkerDaemonOptions) {
    this.options = options;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.options.runtime.pollOnce();
      const now = Date.now();
      if (now - this.heartbeatAt >= this.heartbeatIntervalMs) { await this.options.runtime.heartbeat(); this.heartbeatAt = now; }
    } catch (error) { this.options.onError?.(error); }
    if (this.running) this.timer = setTimeout(() => void this.tick(), this.pollIntervalMs);
  }
}

export function unavailableCodexAdapter(descriptor: WorkerCapabilityAdapter["descriptor"], capabilityId = "codex.execute"): WorkerCapabilityAdapter {
  return { capabilityId, descriptor, async probe() { return "UNHEALTHY"; }, async execute() { return { outcome: "FAILED", result: { code: "CODEX_ADAPTER_NOT_CONFIGURED" } }; } };
}
