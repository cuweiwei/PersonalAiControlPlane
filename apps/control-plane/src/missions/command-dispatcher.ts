import { randomBytes } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";

type Row = Record<string, any>;

function backoff(attempt: number): number { return [2_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000][Math.min(6, Math.max(0, attempt - 1))]; }

export class MissionCommandDispatcher {
  private readonly db: ControlPlaneDatabase;
  private readonly baseUrl?: string;
  private readonly path: string;

  constructor(db: ControlPlaneDatabase, baseUrl = process.env.PAI_HERMES_OFFICE_URL, path = "/api/internal/office/commands") {
    this.db = db;
    this.baseUrl = baseUrl?.replace(/\/$/, "");
    this.path = path;
  }

  recoverExpiredClaims(now = Date.now()): number {
    const commands = this.db.connection.prepare("UPDATE mission_commands SET transport_state = 'RETRY_WAIT', claim_token = NULL, claim_until = NULL, next_send_at = ?, last_error = 'TRANSPORT_CLAIM_EXPIRED' WHERE transport_state = 'IN_FLIGHT' AND claim_until IS NOT NULL AND claim_until < ?").run(now, now);
    return Number(commands.changes);
  }

  async dispatchOnce(limit = 20, now = Date.now()): Promise<number> {
    const recovered = this.recoverExpiredClaims(now);
    const recoveryMode = this.db.one<Row>("SELECT value_json FROM runtime_metadata WHERE key = 'office_recovery_mode'")?.value_json === "true";
    if (recoveryMode) return recovered;
    if (!this.baseUrl) {
      const result = this.db.connection.prepare("UPDATE mission_commands SET transport_state = 'ATTENTION', last_error = 'HERMES_NOT_CONFIGURED' WHERE transport_state IN ('PENDING', 'RETRY_WAIT')").run();
      return recovered + Number(result.changes);
    }
    const rows = this.db.all<Row>("SELECT * FROM mission_commands WHERE transport_state IN ('PENDING', 'RETRY_WAIT') AND next_send_at <= ? AND (claim_until IS NULL OR claim_until < ?) ORDER BY next_send_at, id LIMIT ?", now, now, limit);
    let count = recovered;
    for (const row of rows) {
      const claimToken = randomBytes(16).toString("hex");
      const claimed = this.db.connection.prepare("UPDATE mission_commands SET transport_state = 'IN_FLIGHT', claim_token = ?, claim_until = ?, delivery_attempts = delivery_attempts + 1 WHERE id = ? AND transport_state IN ('PENDING', 'RETRY_WAIT') AND (claim_until IS NULL OR claim_until < ?)").run(claimToken, now + 30_000, row.id, now);
      if (Number(claimed.changes) !== 1) continue;
      try {
        const response = await fetch(`${this.baseUrl}${this.path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: row.envelope_json, signal: AbortSignal.timeout(5_000) });
        if (response.status === 409) {
          let body: unknown = null;
          try { body = await response.json(); } catch { /* keep the conflict fail-closed */ }
          if (body && typeof body === "object" && (body as Row).status === "duplicate") {
            this.db.run("UPDATE mission_commands SET transport_state = 'ACCEPTED', claim_token = NULL, claim_until = NULL, last_error = NULL WHERE id = ? AND claim_token = ?", row.id, claimToken);
          } else {
            this.db.run("UPDATE mission_commands SET transport_state = 'ATTENTION', claim_token = NULL, claim_until = NULL, last_error = 'COMMAND_CONTENT_CONFLICT' WHERE id = ? AND claim_token = ?", row.id, claimToken);
          }
        } else if (response.status === 202 || response.status === 200) {
          this.db.run("UPDATE mission_commands SET transport_state = 'ACCEPTED', claim_token = NULL, claim_until = NULL, last_error = NULL WHERE id = ? AND claim_token = ?", row.id, claimToken);
        } else if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new Error(`HTTP_${response.status}`);
        } else {
          this.db.run("UPDATE mission_commands SET transport_state = 'ATTENTION', claim_token = NULL, claim_until = NULL, last_error = ? WHERE id = ? AND claim_token = ?", `HTTP_${response.status}`, row.id, claimToken);
        }
      } catch (error) {
        const attempts = Number(row.delivery_attempts ?? 0) + 1;
        const attention = attempts >= 10;
        this.db.run("UPDATE mission_commands SET transport_state = ?, next_send_at = ?, claim_token = NULL, claim_until = NULL, last_error = ? WHERE id = ? AND claim_token = ?", attention ? "ATTENTION" : "RETRY_WAIT", now + backoff(attempts), error instanceof Error ? error.message.slice(0, 200) : "HERMES_TRANSPORT_FAILED", row.id, claimToken);
      }
      count += 1;
    }
    return count;
  }

  status(): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT COUNT(*) AS pending, MIN(next_send_at) AS oldest FROM mission_commands WHERE transport_state IN ('PENDING', 'RETRY_WAIT', 'IN_FLIGHT')");
    const attention = this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_commands WHERE transport_state = 'ATTENTION' OR processing_state IN ('FAILED', 'STALE')");
    return { configured: Boolean(this.baseUrl), pending: Number(row?.pending ?? 0), attention: Number(attention?.count ?? 0), oldestAt: row?.oldest ?? null, baseUrl: this.baseUrl ? "configured" : null };
  }
}
