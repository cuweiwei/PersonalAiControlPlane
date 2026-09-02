import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { newWorkerToken, hashWorkerToken } from "../tasks/task-service.ts";
import { uuidv7, type JsonValue } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;
function json(value: unknown, fallback: any = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }
function safeTokenHash(value: string): string { return hashWorkerToken(value); }
function sameSecret(actual: string, expected: string): boolean { const a = Buffer.from(safeTokenHash(actual)); const b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }

export type RegistrationResult = { registrationId: string; status: "pending" };

export class WorkerService {
  readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly pendingTokens = new Map<string, string>();

  constructor(db: ControlPlaneDatabase, events = new EventHub()) { this.db = db; this.events = events; }

  register(input: { name: string; registrationSecret: string; platform: string; hostname?: string; agentVersion?: string; hardware: Record<string, JsonValue> }, now = Date.now()): RegistrationResult {
    if (input.registrationSecret.length < 16) throw new Error("REGISTRATION_SECRET_TOO_SHORT");
    const id = uuidv7(now);
    this.db.run("INSERT INTO worker_registration_requests(id, name, registration_secret_hash, platform, hostname, agent_version, hardware_json, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)", id, input.name, safeTokenHash(input.registrationSecret), input.platform, input.hostname ?? null, input.agentVersion ?? null, JSON.stringify(input.hardware), now + 10 * 60_000, now);
    this.events.publish({ type: "registration.created", registrationId: id });
    return { registrationId: id, status: "pending" };
  }

  pollRegistration(id: string, secret: string, now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM worker_registration_requests WHERE id = ?", id);
    if (!row || !sameSecret(secret, String(row.registration_secret_hash))) throw new Error("REGISTRATION_NOT_FOUND");
    if (row.status === "PENDING" && Number(row.expires_at) <= now) { this.db.run("UPDATE worker_registration_requests SET status = 'EXPIRED' WHERE id = ?", id); row.status = "EXPIRED"; }
    const response: Record<string, unknown> = { registrationId: id, status: String(row.status).toLowerCase(), expiresAt: iso(row.expires_at) };
    if (row.status === "APPROVED") {
      response.workerId = row.worker_id;
      const token = this.pendingTokens.get(id);
      if (token) { response.token = token; this.pendingTokens.delete(id); this.db.run("UPDATE worker_registration_requests SET registration_secret_hash = '' WHERE id = ?", id); }
    }
    return response;
  }

  listRegistrations(now = Date.now()): Record<string, unknown>[] {
    this.expireRegistrations(now);
    return this.db.all<Row>("SELECT * FROM worker_registration_requests ORDER BY created_at DESC").map((row) => ({ id: row.id, name: row.name, platform: row.platform, hostname: row.hostname, agentVersion: row.agent_version, hardware: json(row.hardware_json), status: row.status, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), decidedAt: iso(row.decided_at), workerId: row.worker_id }));
  }

  approveRegistration(id: string, actor = "owner", now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM worker_registration_requests WHERE id = ?", id);
    if (!row) throw new Error("REGISTRATION_NOT_FOUND");
    if (row.status !== "PENDING" || Number(row.expires_at) <= now) throw new Error("INVALID_REGISTRATION_STATE");
    const workerId = uuidv7(now); const token = newWorkerToken(workerId);
    this.db.transaction(() => {
      this.db.run("INSERT INTO workers(id, name, platform, hostname, status, enabled, agent_version, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'OFFLINE', 1, ?, ?, ?, ?)", workerId, row.name, row.platform, row.hostname, row.agent_version, JSON.stringify({ hardware: json(row.hardware_json) }), now, now);
      this.db.run("INSERT INTO worker_tokens(worker_id, token_hash, created_at) VALUES (?, ?, ?)", workerId, safeTokenHash(token), now);
      this.db.run("UPDATE worker_registration_requests SET status = 'APPROVED', decided_at = ?, decided_by = ?, worker_id = ? WHERE id = ? AND status = 'PENDING'", now, actor, workerId, id);
    });
    this.pendingTokens.set(id, token);
    this.events.publish({ type: "worker.updated", workerId, status: "OFFLINE" });
    return { id, status: "approved", workerId, expiresAt: iso(row.expires_at) };
  }

  rejectRegistration(id: string, actor = "owner", now = Date.now()): void {
    const result = this.db.connection.prepare("UPDATE worker_registration_requests SET status = 'REJECTED', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'").run(now, actor, id);
    if (Number(result.changes) !== 1) throw new Error("INVALID_REGISTRATION_STATE");
    this.events.publish({ type: "registration.updated", registrationId: id, status: "rejected" });
  }

  authenticate(token: string): Row | undefined {
    if (!token || token.length < 20) return undefined;
    const rows = this.db.all<Row>("SELECT w.* , t.token_hash, t.revoked_at FROM workers w JOIN worker_tokens t ON t.worker_id = w.id WHERE t.revoked_at IS NULL AND w.removed_at IS NULL");
    return rows.find((row) => sameSecret(token, String(row.token_hash)) && Number(row.enabled) === 1 && row.status !== "DISABLED");
  }

  markConnected(workerId: string, now = Date.now()): void { this.db.run("UPDATE workers SET status = 'ONLINE', last_connected_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL AND enabled = 1", now, now, workerId); this.events.publish({ type: "worker.updated", workerId, status: "ONLINE" }); }
  markDisconnected(workerId: string, now = Date.now()): void { this.db.run("UPDATE workers SET status = 'OFFLINE', last_disconnected_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL", now, now, workerId); this.events.publish({ type: "worker.updated", workerId, status: "OFFLINE" }); }

  heartbeat(workerId: string, report: Record<string, any>, now = Date.now()): void {
    const resources = report.resources ?? {}; const system = report.system ?? report.hardware ?? {};
    const memory = resources.memory ?? (resources.memory_total_mb !== undefined || resources.memory_free_mb !== undefined ? { totalMb: resources.memory_total_mb, freeMb: resources.memory_free_mb } : system.memory);
    this.db.run("UPDATE workers SET status = CASE WHEN enabled = 1 AND removed_at IS NULL THEN 'ONLINE' ELSE status END, cpu_json = ?, memory_json = ?, gpu_json = ?, max_concurrency = ?, metadata_json = ?, agent_version = COALESCE(?, agent_version), last_heartbeat_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(resources.cpu ?? system.cpu ?? null), JSON.stringify(memory ?? null), JSON.stringify(resources.gpu ?? system.gpu ?? null), Number(report.execution?.max_concurrency ?? report.maxConcurrency ?? 1), JSON.stringify({ ...json(this.db.one<Row>("SELECT metadata_json FROM workers WHERE id = ?", workerId)?.metadata_json), ...report }), report.agent_version ?? report.agentVersion ?? null, now, now, workerId);
    this.events.publish({ type: "worker.updated", workerId, status: "ONLINE" });
  }

  updateCapabilities(workerId: string, values: Record<string, any>[], now = Date.now()): void {
    this.db.transaction(() => {
      for (const value of values) {
        const capability = String(value.capability ?? value.kind ?? ""); if (!capability) continue;
        const runtime = value.runtime === undefined ? null : String(value.runtime);
        const descriptor = value.descriptor && typeof value.descriptor === "object" ? value.descriptor : value;
        this.db.run("INSERT INTO worker_capabilities(worker_id, capability, runtime, runtime_version, max_concurrency, descriptor_json, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id, capability, runtime) DO UPDATE SET runtime_version = excluded.runtime_version, max_concurrency = excluded.max_concurrency, descriptor_json = excluded.descriptor_json, status = excluded.status, updated_at = excluded.updated_at", workerId, capability, runtime, value.runtime_version ?? value.runtimeVersion ?? null, Number(value.max_concurrency ?? value.maxConcurrency ?? 1), JSON.stringify(descriptor), String(value.status ?? "READY"), now);
      }
    });
    this.events.publish({ type: "worker.updated", workerId });
  }

  updateModels(workerId: string, values: Record<string, any>[], now = Date.now()): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM worker_models WHERE worker_id = ?", workerId);
      for (const value of values) {
        const modelId = String(value.id ?? value.model_id ?? value.model ?? ""); if (!modelId) continue;
        this.db.run("INSERT INTO worker_models(worker_id, runtime, model_id, display_name, status, context_length, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", workerId, String(value.runtime ?? value.provider ?? "unknown"), modelId, value.display_name ?? value.displayName ?? modelId, String(value.status ?? "ready").toUpperCase(), value.context_length ?? value.contextLength ?? null, JSON.stringify(value.metadata ?? {}), now);
      }
    });
    this.events.publish({ type: "model.updated", workerId });
  }

  listWorkers(now = Date.now()): Record<string, unknown>[] { return this.db.all<Row>("SELECT * FROM workers ORDER BY name, id").map((row) => this.publicWorker(row, now)); }
  getWorker(id: string, now = Date.now()): Record<string, unknown> | undefined { const row = this.db.one<Row>("SELECT * FROM workers WHERE id = ?", id); return row ? this.publicWorker(row, now) : undefined; }
  listModels(): Record<string, unknown>[] { return this.db.all<Row>("SELECT m.*, w.name AS worker_name, w.status AS worker_status FROM worker_models m JOIN workers w ON w.id = m.worker_id ORDER BY w.name, m.runtime, m.model_id").map((row) => ({ workerId: row.worker_id, worker: row.worker_name, workerStatus: row.worker_status, runtime: row.runtime, model: row.model_id, displayName: row.display_name, status: row.status, contextLength: row.context_length, metadata: json(row.metadata_json) })); }

  setEnabled(id: string, enabled: boolean, now = Date.now()): void { const result = this.db.connection.prepare("UPDATE workers SET enabled = ?, status = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL").run(enabled ? 1 : 0, enabled ? "OFFLINE" : "DISABLED", now, id); if (Number(result.changes) !== 1) throw new Error("WORKER_NOT_FOUND"); this.events.publish({ type: "worker.updated", workerId: id, status: enabled ? "OFFLINE" : "DISABLED" }); }
  setDrain(id: string, drain: boolean, now = Date.now()): void { const result = this.db.connection.prepare("UPDATE workers SET drain = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL").run(drain ? 1 : 0, now, id); if (Number(result.changes) !== 1) throw new Error("WORKER_NOT_FOUND"); this.events.publish({ type: "worker.updated", workerId: id, drain }); }
  remove(id: string, now = Date.now()): void { const result = this.db.connection.prepare("UPDATE workers SET enabled = 0, status = 'DISABLED', removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL").run(now, now, id); if (Number(result.changes) !== 1) throw new Error("WORKER_NOT_FOUND"); this.db.run("UPDATE worker_tokens SET revoked_at = ? WHERE worker_id = ? AND revoked_at IS NULL", now, id); this.events.publish({ type: "worker.updated", workerId: id, status: "DISABLED", removed: true }); }

  stale(now = Date.now(), offlineMs = 90_000): string[] { const cutoff = now - offlineMs; const rows = this.db.all<Row>("SELECT id FROM workers WHERE enabled = 1 AND removed_at IS NULL AND ((status = 'ONLINE' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)) OR (status = 'OFFLINE' AND last_disconnected_at IS NOT NULL AND last_disconnected_at < ?))", cutoff, cutoff); for (const row of rows) this.markDisconnected(row.id, now); return rows.map((row) => String(row.id)); }
  expireRegistrations(now = Date.now()): void { this.db.run("UPDATE worker_registration_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ?", now); }

  private publicWorker(row: Row, now: number): Record<string, unknown> {
    const capabilities = this.db.all<Row>("SELECT capability, runtime, runtime_version AS runtimeVersion, max_concurrency AS maxConcurrency, descriptor_json AS descriptor, status FROM worker_capabilities WHERE worker_id = ? ORDER BY capability", row.id).map((item) => ({ ...item, descriptor: json(item.descriptor) }));
    const models = this.db.all<Row>("SELECT runtime, model_id AS model, display_name AS displayName, status, context_length AS contextLength, metadata_json AS metadata FROM worker_models WHERE worker_id = ? ORDER BY runtime, model_id", row.id).map((item) => ({ ...item, metadata: json(item.metadata) }));
    const active = this.db.one<Row>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND status IN ('OFFERED', 'ACCEPTED', 'RUNNING')", row.id);
    return { id: row.id, name: row.name, platform: row.platform, hostname: row.hostname, status: row.status, enabled: Boolean(row.enabled), drain: Boolean(row.drain), drainState: row.drain ? "DRAINING" : "RUNNABLE", agentVersion: row.agent_version, cpu: json(row.cpu_json, null), memory: json(row.memory_json, null), gpu: json(row.gpu_json, null), metadata: json(row.metadata_json), maxConcurrency: row.max_concurrency, runningTasks: Number(active?.count ?? 0), lastHeartbeatAt: iso(row.last_heartbeat_at), heartbeatAgeSeconds: row.last_heartbeat_at ? Math.max(0, Math.floor((now - Number(row.last_heartbeat_at)) / 1000)) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), capabilities, models };
  }
}
