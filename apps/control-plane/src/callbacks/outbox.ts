import { randomBytes } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";

type Row = Record<string, any>;
function backoff(attempt: number): number { return [2_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000][Math.min(6, Math.max(0, attempt - 1))]; }
function json(value: unknown, fallback: unknown = null): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }

export class HermesCallbackDispatcher {
  private readonly db: ControlPlaneDatabase;
  private readonly baseUrl?: string;
  private readonly path: string;
  constructor(db: ControlPlaneDatabase, baseUrl = process.env.PAI_HERMES_URL, path = process.env.PAI_HERMES_TASK_EVENT_PATH ?? "/api/internal/control-plane/task-events") { this.db = db; this.baseUrl = baseUrl?.replace(/\/$/, ""); this.path = path; }

  async dispatchOnce(limit = 20, now = Date.now()): Promise<number> {
    if (!this.baseUrl) { const result = this.db.connection.prepare("UPDATE callback_outbox SET state = 'ATTENTION', last_error = 'HERMES_NOT_CONFIGURED' WHERE delivered_at IS NULL AND state IN ('PENDING', 'RETRY_WAIT')").run(); return Number(result.changes); }
    const rows = this.db.all<Row>("SELECT * FROM callback_outbox WHERE delivered_at IS NULL AND state IN ('PENDING', 'RETRY_WAIT') AND available_at <= ? AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY available_at, id LIMIT ?", now, now, limit);
    let count = 0;
    for (const row of rows) {
      const claim = randomBytes(12).toString("hex");
      const claimed = this.db.connection.prepare("UPDATE callback_outbox SET claimed_until = ?, claim_token = ?, state = 'IN_FLIGHT', attempt_count = attempt_count + 1, first_attempt_at = COALESCE(first_attempt_at, ?), last_attempt_at = ? WHERE id = ? AND delivered_at IS NULL AND (claimed_until IS NULL OR claimed_until < ?)").run(now + 60_000, claim, now, now, row.id, now);
      if (Number(claimed.changes) !== 1) continue;
      try {
        const response = await fetch(`${this.baseUrl}${this.path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: row.payload_json, signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        this.db.run("UPDATE callback_outbox SET delivered_at = ?, state = 'DELIVERED', claimed_until = NULL, claim_token = NULL, failure_streak = 0, last_error = NULL WHERE id = ? AND claim_token = ?", now, row.id, claim);
      } catch (error) {
        const failureStreak = Number(row.failure_streak ?? row.attempt_count ?? 0) + 1;
        const permanent = error instanceof Error && /^HTTP_4/.test(error.message);
        const attention = permanent || failureStreak >= 10;
        const next = now + backoff(failureStreak);
        this.db.run("UPDATE callback_outbox SET available_at = ?, state = ?, claimed_until = NULL, claim_token = NULL, failure_streak = ?, last_error = ? WHERE id = ? AND claim_token = ?", next, attention ? "ATTENTION" : "RETRY_WAIT", failureStreak, error instanceof Error ? error.message.slice(0, 200) : "CALLBACK_FAILED", row.id, claim);
      }
      count += 1;
    }
    return count;
  }

  retryDelivery(taskId: string, eventId: string, now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM callback_outbox WHERE task_id = ? AND event_id = ?", taskId, eventId);
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    if (["IN_FLIGHT", "DELIVERED"].includes(String(row.state))) return this.public(row);
    this.db.run("UPDATE callback_outbox SET state = 'PENDING', available_at = ?, failure_streak = 0, last_error = NULL, claimed_until = NULL, claim_token = NULL WHERE id = ?", now, row.id);
    return this.public(this.db.one<Row>("SELECT * FROM callback_outbox WHERE id = ?", row.id)!);
  }

  setReceipt(taskId: string, eventId: string, receipt: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM callback_outbox WHERE task_id = ? AND event_id = ?", taskId, eventId);
    if (!row) throw new Error("DELIVERY_NOT_FOUND");
    const revision = Number(receipt.receipt_revision ?? receipt.receiptRevision ?? 0);
    const current = Number(row.receipt_revision ?? 0);
    if (revision < current) return this.public(row);
    if (revision === current && row.reply_json && JSON.stringify(json(row.reply_json)) !== JSON.stringify(receipt)) throw new Error("RECEIPT_CONFLICT");
    this.db.run("UPDATE callback_outbox SET receipt_revision = ?, reply_state = ?, reply_json = ?, last_error = NULL WHERE id = ?", revision, String(receipt.state ?? "UNKNOWN"), JSON.stringify(receipt), row.id);
    return this.public(this.db.one<Row>("SELECT * FROM callback_outbox WHERE id = ?", row.id)!);
  }

  listForTask(taskId: string): Record<string, unknown>[] { return this.db.all<Row>("SELECT * FROM callback_outbox WHERE task_id = ? ORDER BY id", taskId).map((row) => this.public(row)); }
  pendingCount(): number { return Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM callback_outbox WHERE delivered_at IS NULL")?.count ?? 0); }
  private public(row: Row): Record<string, unknown> { return { eventId: row.event_id, taskId: row.task_id, runId: row.run_id ?? null, state: row.state ?? (row.delivered_at ? "DELIVERED" : "PENDING"), attemptCount: row.attempt_count, failureStreak: row.failure_streak ?? row.attempt_count, availableAt: row.available_at, deliveredAt: row.delivered_at, lastError: row.last_error ?? null, replyState: row.reply_state ?? "UNKNOWN", receiptRevision: Number(row.receipt_revision ?? 0), payload: json(row.payload_json, {}) }; }
}
