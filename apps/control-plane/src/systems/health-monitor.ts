import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";

type Row = Record<string, any>;
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }

export class HealthMonitor {
  private readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  constructor(db: ControlPlaneDatabase, events: EventHub) { this.db = db; this.events = events; }
  seed(): void {
    const systems = [
      { id: "hermes", name: "Hermes", type: "assistant", baseUrl: process.env.PAI_HERMES_URL ?? "http://hermes-agent:9119", healthPath: process.env.PAI_HERMES_HEALTH_PATH ?? "/api/health" },
      { id: "contexthub", name: "ContextHub", type: "memory", baseUrl: process.env.PAI_CONTEXTHUB_URL ?? "http://contexthub:8787", healthPath: process.env.PAI_CONTEXTHUB_HEALTH_PATH ?? "/health" },
    ];
    for (const system of systems) this.db.run("INSERT INTO systems(id, name, type, base_url, health_path, enabled) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, base_url = excluded.base_url, health_path = excluded.health_path", system.id, system.name, system.type, system.baseUrl, system.healthPath);
  }
  async checkOnce(now = Date.now()): Promise<number> { const systems = this.db.all<Row>("SELECT * FROM systems WHERE enabled = 1"); for (const system of systems) { const started = Date.now(); let status = "OFFLINE"; let message = "health check failed"; try { const response = await fetch(`${String(system.base_url).replace(/\/$/, "")}${system.health_path}`, { signal: AbortSignal.timeout(2_000) }); status = response.ok ? "HEALTHY" : "DEGRADED"; message = `HTTP_${response.status}`; } catch (error) { message = error instanceof Error ? error.message.slice(0, 120) : "HEALTH_CHECK_FAILED"; } this.db.run("INSERT INTO system_health(system_id, status, latency_ms, message, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(system_id) DO UPDATE SET status = excluded.status, latency_ms = excluded.latency_ms, message = excluded.message, checked_at = excluded.checked_at", system.id, status, Date.now() - started, message, now); this.events.publish({ type: "system.updated", systemId: system.id, status }); } return systems.length; }
  list(selfReady: boolean): Record<string, unknown>[] { const external = this.db.all<Row>("SELECT s.*, h.status, h.latency_ms, h.message, h.checked_at FROM systems s LEFT JOIN system_health h ON h.system_id = s.id ORDER BY s.id").map((row) => ({ id: row.id, name: row.name, type: row.type, baseUrl: row.base_url, healthPath: row.health_path, status: row.status ?? "UNKNOWN", latencyMs: row.latency_ms ?? null, message: row.message ?? null, checkedAt: iso(row.checked_at) })); return [{ id: "control-plane", name: "PersonalAiControlPlane", type: "control-plane", status: selfReady ? "HEALTHY" : "DEGRADED", latencyMs: 0, checkedAt: new Date().toISOString() }, ...external]; }
}
