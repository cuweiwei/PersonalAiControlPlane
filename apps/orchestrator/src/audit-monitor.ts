import type { OrchestratorDatabase } from "./db.ts";
import type { TaskEngine } from "./task-engine.ts";

export type AuditHealth = {
  ok: boolean;
  verifiedAt: number | null;
  eventCount: number;
  durationMs: number | null;
};

/**
 * Audit verification is intentionally complete, but it must not run on every
 * readiness probe. The monitor keeps the last fail-closed result and refreshes
 * it periodically in a single-flight timer.
 */
export class AuditIntegrityMonitor {
  private readonly db: OrchestratorDatabase;
  private readonly engine: TaskEngine;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private state: AuditHealth = { ok: false, verifiedAt: null, eventCount: 0, durationMs: null };

  constructor(db: OrchestratorDatabase, engine: TaskEngine, intervalMs = 5 * 60_000, clock: () => number = Date.now) {
    this.db = db;
    this.engine = engine;
    if (!Number.isInteger(intervalMs) || intervalMs < 10_000) throw new Error("audit verification interval must be at least 10000ms");
    this.intervalMs = intervalMs;
    this.clock = clock;
  }

  start(): void {
    if (this.timer) return;
    this.verifyNow();
    this.timer = setInterval(() => this.verifyNow(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  verifyNow(): AuditHealth {
    if (this.running) return this.state;
    this.running = true;
    const started = this.clock();
    try {
      const ok = this.engine.verifyAuditChain();
      const eventCount = Number(this.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM audit_events")?.count ?? 0);
      this.state = { ok, verifiedAt: this.clock(), eventCount, durationMs: Math.max(0, this.clock() - started) };
    } catch {
      this.state = { ok: false, verifiedAt: this.clock(), eventCount: 0, durationMs: Math.max(0, this.clock() - started) };
    } finally {
      this.running = false;
    }
    return this.state;
  }

  health(): AuditHealth {
    return { ...this.state };
  }
}
