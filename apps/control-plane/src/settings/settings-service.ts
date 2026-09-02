import { ControlPlaneDatabase } from "../db/database.ts";

const DEFAULTS: Record<string, unknown> = { heartbeat_interval_seconds: 30, worker_offline_seconds: 90, registration_enabled: true, default_max_attempts: 2, default_task_timeout_seconds: 1800, task_retention_days: 30, artifact_retention_days: 30, system_health_interval_seconds: 30, scheduler_interval_ms: 1000 };
const ALLOWED = new Set(Object.keys(DEFAULTS));

export class SettingsService {
  private readonly db: ControlPlaneDatabase;
  constructor(db: ControlPlaneDatabase) { this.db = db; }
  get(): Record<string, unknown> { const result: Record<string, unknown> = { ...DEFAULTS }; for (const row of this.db.all<{ key: string; value_json: string }>("SELECT key, value_json FROM settings")) { try { result[row.key] = JSON.parse(row.value_json); } catch { /* ignore corrupt optional setting */ } } return result; }
  patch(values: Record<string, unknown>, now = Date.now()): Record<string, unknown> { for (const [key, value] of Object.entries(values)) { if (!ALLOWED.has(key)) throw new Error("INVALID_SETTINGS"); if (typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("INVALID_SETTINGS"); this.db.run("INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", key, JSON.stringify(value), now); } return this.get(); }
}
