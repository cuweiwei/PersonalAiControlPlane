import { randomBytes } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";

type Row = Record<string, any>;
function backoff(attempt: number): number { return [2_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000][Math.min(6, Math.max(0, attempt - 1))]; }

export class HermesCallbackDispatcher {
  private readonly db: ControlPlaneDatabase;
  private readonly baseUrl?: string;
  private readonly path: string;
  constructor(db: ControlPlaneDatabase, baseUrl = process.env.PAI_HERMES_URL, path = process.env.PAI_HERMES_TASK_EVENT_PATH ?? "/api/internal/control-plane/task-events") { this.db = db; this.baseUrl = baseUrl?.replace(/\/$/, ""); this.path = path; }

  async dispatchOnce(limit = 20, now = Date.now()): Promise<number> {
    if (!this.baseUrl) return 0;
    const rows = this.db.all<Row>("SELECT * FROM callback_outbox WHERE delivered_at IS NULL AND available_at <= ? AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY available_at, id LIMIT ?", now, now, limit);
    let count = 0;
    for (const row of rows) {
      const claim = randomBytes(12).toString("hex");
      const claimed = this.db.connection.prepare("UPDATE callback_outbox SET claimed_until = ?, claim_token = ?, attempt_count = attempt_count + 1 WHERE id = ? AND delivered_at IS NULL AND (claimed_until IS NULL OR claimed_until < ?)").run(now + 60_000, claim, row.id, now);
      if (Number(claimed.changes) !== 1) continue;
      try {
        const response = await fetch(`${this.baseUrl}${this.path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: row.payload_json, signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        this.db.run("UPDATE callback_outbox SET delivered_at = ?, claimed_until = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?", now, row.id, claim);
      } catch (error) {
        const next = now + backoff(Number(row.attempt_count) + 1);
        this.db.run("UPDATE callback_outbox SET available_at = ?, claimed_until = NULL, claim_token = NULL, last_error = ? WHERE id = ? AND claim_token = ?", next, error instanceof Error ? error.message.slice(0, 200) : "CALLBACK_FAILED", row.id, claim);
      }
      count += 1;
    }
    return count;
  }

  pendingCount(): number { return Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM callback_outbox WHERE delivered_at IS NULL")?.count ?? 0); }
}
