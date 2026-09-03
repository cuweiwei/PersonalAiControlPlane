import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { newWorkerToken, hashWorkerToken } from "../tasks/task-service.ts";
import { canonicalJson, uuidv7, type JsonValue } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;
function json(value: unknown, fallback: any = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }
function safeTokenHash(value: string): string { return hashWorkerToken(value); }
function sameSecret(actual: string, expected: string): boolean { const a = Buffer.from(safeTokenHash(actual)); const b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function boundedString(value: unknown, maximum = 120): string | null { return typeof value === "string" && value.length <= maximum ? value : null; }
function boundedNumber(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null { const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null; }
function boundedJson(value: unknown, maximum = 16_384): any { try { const encoded = JSON.stringify(value); return encoded.length <= maximum ? JSON.parse(encoded) : {}; } catch { return {}; } }
function safeGpu(value: unknown): Record<string, unknown> | null {
  const item = record(value); if (Object.keys(item).length === 0) return null;
  return { model: boundedString(item.model ?? item.name, 120), memoryMb: boundedNumber(item.memoryMb ?? item.memory_mb, 0, 4_194_304), utilizationPercent: boundedNumber(item.utilizationPercent ?? item.utilization_percent, 0, 100) };
}
function safeEvidence(value: unknown): Record<string, unknown> {
  const item = record(value); return { source: boundedString(item.source, 120), digest: boundedString(item.digest ?? item.sha256, 200), checkedAt: boundedString(item.checkedAt ?? item.checked_at, 40), version: boundedString(item.version, 120) };
}
function safeHardware(value: unknown): Record<string, unknown> {
  const item = record(value); const cpu = Array.isArray(item.cpu) ? item.cpu.slice(0, 32).map((entry) => boundedString(entry, 160)).filter(Boolean) : boundedString(item.cpu, 160);
  return { cpu, memoryMb: boundedNumber(item.memory_mb ?? item.memoryMb, 0, 4_194_304), architecture: boundedString(item.architecture, 40), os: boundedString(item.os, 40) };
}
function safeModelMetadata(value: unknown): Record<string, unknown> {
  const item = record(value); return { family: boundedString(item.family, 80), quantization: boundedString(item.quantization, 80), parameterCount: boundedNumber(item.parameterCount ?? item.parameter_count, 0, 1_000_000_000_000), source: boundedString(item.source ?? item.source_type, 160), loaded: typeof item.loaded === "boolean" ? item.loaded : null, loading: typeof item.loading === "boolean" ? item.loading : null, memoryMb: boundedNumber(item.memoryMb ?? item.memory_mb, 0, 4_194_304) };
}
function safeDescriptor(value: unknown): Record<string, unknown> {
  const item = record(value); const properties = record(item.properties ?? item.descriptor);
  return {
    capability: boundedString(item.capability ?? item.kind, 120), runtime: boundedString(item.runtime, 120), runtimeVersion: boundedString(item.runtime_version ?? item.runtimeVersion, 80), version: boundedString(item.version, 80),
    status: boundedString(item.status, 32), maxConcurrency: boundedNumber(item.max_concurrency ?? item.maxConcurrency, 1, 256),
    properties: { workspaceIds: Array.isArray(properties.workspaceIds) ? properties.workspaceIds.slice(0, 100).map((id) => boundedString(id, 200)).filter(Boolean) : [] },
  };
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function heartbeatProjection(report: Record<string, any>): { system: Record<string, any>; resources: Record<string, any>; execution: Record<string, any>; metadata: Record<string, any>; agentVersion: string | null } {
  const system = record(report.system ?? report.hardware);
  const resources = record(report.resources);
  const cpu = record(resources.cpu ?? system.cpu);
  const memory = record(resources.memory ?? system.memory);
  const gpu = resources.gpu ?? system.gpu;
  const maxConcurrency = Math.max(1, Math.min(256, Math.floor(boundedNumber(record(report.execution).max_concurrency ?? report.maxConcurrency, 1, 256) ?? 1)));
  return {
    system: {
      os: boundedString(system.os, 40),
      architecture: boundedString(system.architecture, 40),
      cpuCount: boundedNumber(system.cpu ?? system.cpu_count, 0, 512),
    },
    resources: {
      cpu: { usagePercent: boundedNumber(cpu.usagePercent ?? cpu.usage_percent, 0, 100) },
      memory: { totalMb: boundedNumber(memory.totalMb ?? memory.total_mb, 0, 4_194_304), freeMb: boundedNumber(memory.freeMb ?? memory.free_mb, 0, 4_194_304) },
      gpu: safeGpu(gpu),
    },
    execution: { runningTasks: Math.floor(boundedNumber(record(report.execution).running_tasks ?? record(report.execution).runningTasks, 0, 256) ?? 0), maxConcurrency },
    metadata: {
      transport: boundedString(record(report.connection).transport ?? report.transport, 20),
      fallback: boundedString(record(report.connection).fallback ?? report.fallback, 20),
      runtime: boundedString(report.runtime, 40),
    },
    agentVersion: boundedString(report.agent_version ?? report.agentVersion, 80),
  };
}

export type RegistrationResult = { registrationId: string; status: "pending" };

export class WorkerService {
  readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly pendingTokens = new Map<string, string>();

  constructor(db: ControlPlaneDatabase, events = new EventHub()) { this.db = db; this.events = events; }

  register(input: { name: string; registrationSecret: string; platform: string; hostname?: string; agentVersion?: string; hardware: Record<string, JsonValue> }, now = Date.now()): RegistrationResult {
    if (input.registrationSecret.length < 16) throw new Error("REGISTRATION_SECRET_TOO_SHORT");
    const id = uuidv7(now);
    this.db.run("INSERT INTO worker_registration_requests(id, name, registration_secret_hash, platform, hostname, agent_version, hardware_json, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)", id, input.name, safeTokenHash(input.registrationSecret), input.platform, input.hostname ?? null, input.agentVersion ?? null, JSON.stringify(safeHardware(input.hardware)), now + 10 * 60_000, now);
    this.appendAudit("worker", "worker.registration.created", null, { registrationId: id, name: input.name, platform: input.platform }, now);
    this.events.publish({ type: "registration.created", registrationId: id });
    return { registrationId: id, status: "pending" };
  }

  pollRegistration(id: string, secret: string, now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM worker_registration_requests WHERE id = ?", id);
    if (!row || !sameSecret(secret, String(row.registration_secret_hash))) throw new Error("REGISTRATION_NOT_FOUND");
    if (["PENDING", "APPROVED"].includes(String(row.status)) && !row.finalized_at && Number(row.expires_at) <= now) {
      this.expireRegistrationRow(row, now);
      row.status = "EXPIRED";
    }
    const phase = row.status === "PENDING" ? "PENDING" : row.status === "APPROVED" ? (row.finalized_at ? "REGISTERED" : "OWNER_APPROVED") : String(row.status);
    const response: Record<string, unknown> = { registrationId: id, status: String(row.status).toLowerCase(), phase, expiresAt: iso(row.expires_at) };
    if (row.status === "APPROVED") {
      response.workerId = row.worker_id;
      const token = this.pendingTokens.get(id);
      if (token) {
        response.token = token;
        this.pendingTokens.delete(id);
        this.db.run("UPDATE worker_registration_requests SET registration_secret_hash = '', finalized_at = ? WHERE id = ?", now, id);
        response.phase = "REGISTERED";
      }
    }
    return response;
  }

  listRegistrations(now = Date.now()): Record<string, unknown>[] {
    this.expireRegistrations(now);
    return this.db.all<Row>("SELECT * FROM worker_registration_requests ORDER BY created_at DESC").map((row) => ({ id: row.id, name: row.name, platform: row.platform, hostname: row.hostname, agentVersion: row.agent_version, hardware: json(row.hardware_json), status: row.status, phase: row.status === "PENDING" ? "PENDING" : row.status === "APPROVED" ? (row.finalized_at ? "REGISTERED" : "OWNER_APPROVED") : row.status, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at), decidedAt: iso(row.decided_at), workerId: row.worker_id, removable: !row.finalized_at }));
  }

  approveRegistration(id: string, actor = "owner", now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM worker_registration_requests WHERE id = ?", id);
    if (!row) throw new Error("REGISTRATION_NOT_FOUND");
    if (row.status !== "PENDING" || Number(row.expires_at) <= now) throw new Error("INVALID_REGISTRATION_STATE");
    const workerId = uuidv7(now); const token = newWorkerToken(workerId);
    this.db.transaction(() => {
      this.db.run("INSERT INTO workers(id, name, platform, hostname, status, enabled, agent_version, metadata_json, credential_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'OFFLINE', 1, ?, ?, ?, ?, ?)", workerId, row.name, row.platform, row.hostname, row.agent_version, JSON.stringify({ hardware: safeHardware(json(row.hardware_json)) }), now + 90 * 24 * 60 * 60_000, now, now);
      this.db.run("INSERT INTO worker_tokens(worker_id, token_hash, created_at) VALUES (?, ?, ?)", workerId, safeTokenHash(token), now);
      this.db.run("UPDATE worker_registration_requests SET status = 'APPROVED', decided_at = ?, decided_by = ?, worker_id = ? WHERE id = ? AND status = 'PENDING'", now, actor, workerId, id);
    });
    this.pendingTokens.set(id, token);
    this.appendAudit(actor, "worker.registration.approved", workerId, { registrationId: id }, now);
    this.events.publish({ type: "worker.updated", workerId, status: "OFFLINE" });
    return { id, status: "approved", workerId, expiresAt: iso(row.expires_at) };
  }

  rejectRegistration(id: string, actor = "owner", now = Date.now()): void {
    const result = this.db.connection.prepare("UPDATE worker_registration_requests SET status = 'REJECTED', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'").run(now, actor, id);
    if (Number(result.changes) !== 1) throw new Error("INVALID_REGISTRATION_STATE");
    this.appendAudit(actor, "worker.registration.rejected", null, { registrationId: id }, now);
    this.events.publish({ type: "registration.updated", registrationId: id, status: "rejected" });
  }

  authenticate(token: string): Row | undefined {
    if (!token || token.length < 20) return undefined;
    const rows = this.db.all<Row>("SELECT w.* , t.token_hash, t.revoked_at FROM workers w JOIN worker_tokens t ON t.worker_id = w.id WHERE t.revoked_at IS NULL AND w.removed_at IS NULL");
    return rows.find((row) => sameSecret(token, String(row.token_hash)) && Number(row.enabled) === 1 && row.status !== "DISABLED");
  }

  tokenDisposition(token: string): "removed" | "disabled" | "invalid" {
    if (!token || token.length < 20) return "invalid";
    const rows = this.db.all<Row>("SELECT w.removed_at, w.enabled, w.status, t.token_hash, t.revoked_at FROM workers w JOIN worker_tokens t ON t.worker_id = w.id");
    const row = rows.find((candidate) => sameSecret(token, String(candidate.token_hash)));
    if (row) {
      if (row.removed_at !== null && row.removed_at !== undefined) return "removed";
      if (Number(row.enabled) !== 1 || row.status === "DISABLED" || (row.revoked_at !== null && row.revoked_at !== undefined)) return "disabled";
    }
    const tombstone = this.db.all<Row>("SELECT fingerprint_digest FROM worker_purge_tombstones").find((candidate) => sameSecret(token, String(candidate.fingerprint_digest)));
    return tombstone ? "removed" : "invalid";
  }

  markConnected(workerId: string, now = Date.now()): void { this.db.run("UPDATE workers SET status = 'ONLINE', last_connected_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL AND enabled = 1", now, now, workerId); this.events.publish({ type: "worker.updated", workerId, status: "ONLINE" }); }
  markDisconnected(workerId: string, now = Date.now()): void { this.db.run("UPDATE workers SET status = 'OFFLINE', last_disconnected_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL", now, now, workerId); this.events.publish({ type: "worker.updated", workerId, status: "OFFLINE" }); }

  heartbeat(workerId: string, report: Record<string, any>, now = Date.now()): void {
    const projection = heartbeatProjection(report);
    const priorMetadata = record(json(this.db.one<Row>("SELECT metadata_json FROM workers WHERE id = ?", workerId)?.metadata_json));
    const existing = { hardware: safeHardware(priorMetadata.hardware) };
    this.db.transaction(() => {
      this.db.run("UPDATE workers SET status = CASE WHEN enabled = 1 AND removed_at IS NULL THEN 'ONLINE' ELSE status END, cpu_json = ?, memory_json = ?, gpu_json = ?, max_concurrency = ?, last_error_code = ?, metadata_json = ?, agent_version = COALESCE(?, agent_version), last_heartbeat_at = ?, updated_at = ? WHERE id = ?", JSON.stringify(projection.resources.cpu), JSON.stringify(projection.resources.memory), JSON.stringify(projection.resources.gpu), projection.execution.maxConcurrency, boundedString(report.error_code ?? report.errorCode, 120), JSON.stringify({ ...existing, system: projection.system, execution: projection.execution, ...projection.metadata }), projection.agentVersion, now, now, workerId);
      const providers = Array.isArray(report.providers) ? report.providers.slice(0, 32) : [];
      for (const raw of providers) {
        const item = record(raw); const provider = boundedString(item.provider ?? item.name, 80); if (!provider) continue;
        const requested = String(item.evidence_level ?? item.evidenceLevel ?? "implemented_local");
        const evidenceLevel = ["implemented_local", "ci_verified", "live_verified", "provider_verified"].includes(requested) ? requested : "implemented_local";
        const safeLevel = provider.toLowerCase().includes("codex") && evidenceLevel === "provider_verified" ? "implemented_local" : evidenceLevel;
        this.db.run("INSERT INTO worker_providers(worker_id, provider, evidence_level, provider_verified, evidence_json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id, provider) DO UPDATE SET evidence_level = excluded.evidence_level, provider_verified = excluded.provider_verified, evidence_json = excluded.evidence_json, updated_at = excluded.updated_at", workerId, provider, safeLevel, safeLevel === "provider_verified" ? 1 : 0, JSON.stringify(safeEvidence(item.evidence ?? item.metadata ?? {})), now);
      }
    });
    this.events.publish({ type: "worker.updated", workerId, status: "ONLINE" });
  }

  updateCapabilities(workerId: string, values: Record<string, any>[], now = Date.now()): void {
    const incoming = values.slice(0, 100).map((value) => {
      const capability = String(value.capability ?? value.kind ?? "");
      // SQLite UNIQUE permits multiple NULLs; use an empty string for an
      // unspecified runtime so repeated heartbeats replace the same row.
      const runtime = value.runtime === undefined ? "" : String(value.runtime);
      const descriptor = value.descriptor && typeof value.descriptor === "object" ? value.descriptor : value;
      return { value, capability, runtime, descriptor: safeDescriptor(descriptor) };
    }).filter((item) => item.capability.length > 0 && item.capability.length <= 120 && (item.runtime === null || item.runtime.length <= 120));
    this.db.transaction(() => {
      const existing = this.db.all<Row>("SELECT capability, runtime FROM worker_capabilities WHERE worker_id = ?", workerId);
      for (const row of existing) if (!incoming.some((item) => item.capability === row.capability && item.runtime === (row.runtime ?? null))) this.db.run("DELETE FROM worker_capabilities WHERE worker_id = ? AND capability = ? AND runtime IS ?", workerId, row.capability, row.runtime ?? null);
      for (const item of incoming) {
        const value = item.value;
        const maxConcurrency = Math.max(1, Math.min(256, Math.floor(boundedNumber(value.max_concurrency ?? value.maxConcurrency, 1, 256) ?? 1)));
        const status = ["READY", "HEALTHY", "DEGRADED", "UNAVAILABLE"].includes(String(value.status ?? "READY").toUpperCase()) ? String(value.status ?? "READY").toUpperCase() : "UNAVAILABLE";
        const descriptorIdentity = { ...item.descriptor }; delete descriptorIdentity.status;
        const descriptorHash = digest(descriptorIdentity);
        const prior = this.db.one<Row>("SELECT grant_status, descriptor_hash FROM worker_capabilities WHERE worker_id = ? AND capability = ? AND runtime IS ?", workerId, item.capability, item.runtime);
        const descriptorChanged = prior?.descriptor_hash && prior.descriptor_hash !== descriptorHash;
        const grantStatus = descriptorChanged && prior.grant_status === "GRANTED" ? "REQUIRES_REVIEW" : String(prior?.grant_status ?? "DISCOVERED");
        this.db.run("INSERT INTO worker_capabilities(worker_id, capability, runtime, runtime_version, max_concurrency, descriptor_json, descriptor_hash, grant_status, superseded_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id, capability, runtime) DO UPDATE SET runtime_version = excluded.runtime_version, max_concurrency = excluded.max_concurrency, descriptor_json = excluded.descriptor_json, descriptor_hash = excluded.descriptor_hash, grant_status = excluded.grant_status, superseded_at = excluded.superseded_at, status = excluded.status, updated_at = excluded.updated_at", workerId, item.capability, item.runtime, boundedString(value.runtime_version ?? value.runtimeVersion, 80), maxConcurrency, JSON.stringify(item.descriptor), descriptorHash, grantStatus, descriptorChanged ? now : null, status, now);
      }
    });
    this.events.publish({ type: "worker.updated", workerId });
  }

  updateModels(workerId: string, values: Record<string, any>[], now = Date.now()): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM worker_models WHERE worker_id = ?", workerId);
      for (const value of values.slice(0, 500)) {
        const modelId = String(value.id ?? value.model_id ?? value.model ?? ""); if (!modelId) continue;
        if (modelId.length > 200) continue;
        const status = ["READY", "LOADING", "UNAVAILABLE"].includes(String(value.status ?? "ready").toUpperCase()) ? String(value.status ?? "ready").toUpperCase() : "UNAVAILABLE";
        this.db.run("INSERT INTO worker_models(worker_id, runtime, model_id, display_name, status, context_length, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", workerId, boundedString(value.runtime ?? value.provider ?? "unknown", 120) ?? "unknown", modelId, boundedString(value.display_name ?? value.displayName ?? modelId, 240) ?? modelId, status, boundedNumber(value.context_length ?? value.contextLength, 0, 10_000_000), JSON.stringify(safeModelMetadata(value.metadata ?? {})), now);
      }
    });
    this.events.publish({ type: "model.updated", workerId });
  }

  listWorkers(now = Date.now()): Record<string, unknown>[] { return this.db.all<Row>("SELECT * FROM workers WHERE removed_at IS NULL ORDER BY name, id").map((row) => this.publicWorker(row, now)); }
  getWorker(id: string, now = Date.now()): Record<string, unknown> | undefined { const row = this.db.one<Row>("SELECT * FROM workers WHERE id = ? AND removed_at IS NULL", id); return row ? this.publicWorker(row, now) : undefined; }
  listModels(): Record<string, unknown>[] { return this.db.all<Row>("SELECT m.*, w.name AS worker_name, w.status AS worker_status FROM worker_models m JOIN workers w ON w.id = m.worker_id WHERE w.removed_at IS NULL ORDER BY w.name, m.runtime, m.model_id").map((row) => ({ workerId: row.worker_id, worker: row.worker_name, workerStatus: row.worker_status, runtime: row.runtime, model: row.model_id, displayName: row.display_name, status: row.status, contextLength: row.context_length, metadata: json(row.metadata_json) })); }

  setEnabled(id: string, enabled: boolean, actor = "owner", now = Date.now()): void { const result = this.db.connection.prepare("UPDATE workers SET enabled = ?, status = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL").run(enabled ? 1 : 0, enabled ? "OFFLINE" : "DISABLED", now, id); if (Number(result.changes) !== 1) throw new Error("WORKER_NOT_FOUND"); this.appendAudit(actor, enabled ? "worker.enabled" : "worker.disabled", id, {}, now); this.events.publish({ type: "worker.updated", workerId: id, status: enabled ? "OFFLINE" : "DISABLED" }); }
  setDrain(id: string, drain: boolean, actor = "owner", now = Date.now()): void { const result = this.db.connection.prepare("UPDATE workers SET drain = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL").run(drain ? 1 : 0, now, id); if (Number(result.changes) !== 1) throw new Error("WORKER_NOT_FOUND"); this.appendAudit(actor, drain ? "worker.drained" : "worker.resumed", id, {}, now); this.events.publish({ type: "worker.updated", workerId: id, drain }); }
  rename(id: string, name: string, actor = "owner", now = Date.now()): void {
    const normalized = name.trim();
    if (!normalized || normalized.length > 200) throw new Error("INVALID_WORKER_NAME");
    const result = this.db.connection.prepare("UPDATE workers SET name = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL").run(normalized, now, id);
    if (Number(result.changes) !== 1) throw new Error("WORKER_NOT_FOUND");
    this.appendAudit(actor, "worker.renamed", id, { name: normalized }, now);
    this.events.publish({ type: "worker.updated", workerId: id, name: normalized });
  }
  revokeCapability(id: string, capabilityId: string | number, actor = "owner", now = Date.now()): void {
    const result = this.db.connection.prepare("UPDATE worker_capabilities SET grant_status = 'REVOKED', status = 'UNAVAILABLE', updated_at = ? WHERE worker_id = ? AND id = ?").run(now, id, capabilityId);
    if (Number(result.changes) !== 1) throw new Error("CAPABILITY_NOT_FOUND");
    this.appendAudit(actor, "worker.capability.revoked", id, { capabilityId }, now);
    this.events.publish({ type: "worker.updated", workerId: id });
  }
  grantCapability(id: string, capabilityId: string | number, actor = "owner", now = Date.now()): void {
    const result = this.db.connection.prepare("UPDATE worker_capabilities SET grant_status = 'GRANTED', superseded_at = NULL, updated_at = ? WHERE worker_id = ? AND id = ? AND status <> 'UNAVAILABLE'").run(now, id, capabilityId);
    if (Number(result.changes) !== 1) throw new Error("CAPABILITY_NOT_FOUND");
    this.appendAudit(actor, "worker.capability.granted", id, { capabilityId }, now);
    this.events.publish({ type: "worker.updated", workerId: id });
  }
  remove(id: string, actor = "owner", now = Date.now()): { workerId: string; status: "removed"; alreadyRemoved?: boolean } {
    const row = this.db.one<Row>("SELECT * FROM workers WHERE id = ?", id);
    if (!row) {
      if (this.db.one("SELECT worker_id FROM worker_purge_tombstones WHERE worker_id = ?", id)) return { workerId: id, status: "removed", alreadyRemoved: true };
      throw new Error("WORKER_NOT_FOUND");
    }
    if (row.removed_at !== null && row.removed_at !== undefined) return { workerId: id, status: "removed", alreadyRemoved: true };
    const active = this.db.one<Row>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND status IN ('OFFERED', 'ACCEPTED', 'RUNNING')", id);
    if (Number(active?.count ?? 0) > 0) throw new Error("WORKER_BUSY");
    const token = this.db.one<Row>("SELECT token_hash FROM worker_tokens WHERE worker_id = ?", id)?.token_hash;
    this.db.transaction(() => {
      const fingerprint = String(token ?? digest({ workerId: id, removedAt: now }));
      this.db.run("INSERT OR IGNORE INTO worker_purge_tombstones(worker_id, registration_id, fingerprint_digest, removed_at, removed_by) VALUES (?, ?, ?, ?, ?)", id, this.db.one<Row>("SELECT id FROM worker_registration_requests WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1", id)?.id ?? null, fingerprint, now, actor);
      this.db.run("DELETE FROM worker_tokens WHERE worker_id = ?", id);
      this.db.run("DELETE FROM worker_capabilities WHERE worker_id = ?", id);
      this.db.run("DELETE FROM worker_models WHERE worker_id = ?", id);
      this.db.run("DELETE FROM worker_providers WHERE worker_id = ?", id);
      this.db.run("DELETE FROM worker_registration_requests WHERE worker_id = ?", id);
      this.db.run("UPDATE workers SET enabled = 0, status = 'DISABLED', drain = 0, removed_at = ?, cpu_json = NULL, memory_json = NULL, gpu_json = NULL, metadata_json = '{}', agent_version = NULL, last_error_code = NULL, updated_at = ? WHERE id = ? AND removed_at IS NULL", now, now, id);
      this.appendAudit(actor, "worker.removed", id, { fingerprintDigest: fingerprint }, now);
    });
    this.events.publish({ type: "worker.updated", workerId: id, status: "REMOVED", removed: true });
    return { workerId: id, status: "removed" };
  }

  removeRegistration(id: string, actor = "owner", now = Date.now()): { registrationId: string; status: "removed"; alreadyRemoved?: boolean } {
    const row = this.db.one<Row>("SELECT * FROM worker_registration_requests WHERE id = ?", id);
    if (!row) {
      if (this.db.one("SELECT registration_id FROM worker_enrollment_tombstones WHERE registration_id = ?", id)) return { registrationId: id, status: "removed", alreadyRemoved: true };
      throw new Error("REGISTRATION_NOT_FOUND");
    }
    if (row.finalized_at) throw new Error("REGISTRATION_ALREADY_FINALIZED");
    this.db.transaction(() => {
      if (row.worker_id) {
        const worker = this.db.one<Row>("SELECT * FROM workers WHERE id = ?", row.worker_id);
        const active = this.db.one<Row>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND status IN ('OFFERED', 'ACCEPTED', 'RUNNING')", row.worker_id);
        if (Number(active?.count ?? 0) > 0) throw new Error("WORKER_BUSY");
        const token = this.db.one<Row>("SELECT token_hash FROM worker_tokens WHERE worker_id = ?", row.worker_id)?.token_hash;
        if (worker && !worker.removed_at) this.db.run("INSERT OR IGNORE INTO worker_purge_tombstones(worker_id, registration_id, fingerprint_digest, removed_at, removed_by) VALUES (?, ?, ?, ?, ?)", row.worker_id, id, String(token ?? digest({ workerId: row.worker_id, removedAt: now })), now, actor);
        this.db.run("DELETE FROM worker_tokens WHERE worker_id = ?", row.worker_id);
        this.db.run("DELETE FROM worker_capabilities WHERE worker_id = ?", row.worker_id);
        this.db.run("DELETE FROM worker_models WHERE worker_id = ?", row.worker_id);
        this.db.run("DELETE FROM worker_providers WHERE worker_id = ?", row.worker_id);
        this.db.run("UPDATE workers SET enabled = 0, status = 'DISABLED', removed_at = COALESCE(removed_at, ?), updated_at = ? WHERE id = ?", now, now, row.worker_id);
      }
      this.db.run("INSERT OR IGNORE INTO worker_enrollment_tombstones(registration_id, fingerprint_digest, removed_at, removed_by) VALUES (?, ?, ?, ?)", id, String(row.registration_secret_hash ?? digest({ registrationId: id })), now, actor);
      this.db.run("DELETE FROM worker_registration_requests WHERE id = ?", id);
      this.appendAudit(actor, "worker.registration.removed", row.worker_id ?? null, { registrationId: id }, now);
    });
    this.events.publish({ type: "registration.updated", registrationId: id, status: "removed" });
    return { registrationId: id, status: "removed" };
  }

  stale(now = Date.now(), offlineMs = 90_000): string[] { const cutoff = now - offlineMs; const rows = this.db.all<Row>("SELECT id FROM workers WHERE enabled = 1 AND removed_at IS NULL AND ((status = 'ONLINE' AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)) OR (status = 'OFFLINE' AND last_disconnected_at IS NOT NULL AND last_disconnected_at < ?))", cutoff, cutoff); for (const row of rows) this.markDisconnected(row.id, now); return rows.map((row) => String(row.id)); }
  expireRegistrations(now = Date.now()): void {
    const rows = this.db.all<Row>("SELECT * FROM worker_registration_requests WHERE status IN ('PENDING', 'APPROVED') AND finalized_at IS NULL AND expires_at <= ?", now);
    for (const row of rows) this.expireRegistrationRow(row, now);
  }

  verifyAuditChain(): boolean {
    let previous = "";
    for (const row of this.db.all<Row>("SELECT * FROM audit_events ORDER BY id")) {
      if (String(row.previous_hash ?? "") !== previous) return false;
      const expected = digest({ actor: row.actor, action: row.action, workerId: row.worker_id ?? null, payload: json(row.payload_json), previousHash: previous, createdAt: row.created_at });
      if (String(row.event_hash) !== expected) return false;
      previous = expected;
    }
    return true;
  }

  private expireRegistrationRow(row: Row, now: number): void {
    this.db.transaction(() => {
      this.db.run("UPDATE worker_registration_requests SET status = 'EXPIRED' WHERE id = ? AND finalized_at IS NULL AND status IN ('PENDING', 'APPROVED')", row.id);
      if (row.worker_id) {
        const token = this.db.one<Row>("SELECT token_hash FROM worker_tokens WHERE worker_id = ?", row.worker_id)?.token_hash;
        this.db.run("INSERT OR IGNORE INTO worker_purge_tombstones(worker_id, registration_id, fingerprint_digest, removed_at, removed_by) VALUES (?, ?, ?, ?, ?)", row.worker_id, row.id, String(token ?? digest({ workerId: row.worker_id, expiredAt: now })), now, "system");
        this.db.run("DELETE FROM worker_tokens WHERE worker_id = ?", row.worker_id);
        this.db.run("DELETE FROM worker_capabilities WHERE worker_id = ?", row.worker_id);
        this.db.run("DELETE FROM worker_models WHERE worker_id = ?", row.worker_id);
        this.db.run("DELETE FROM worker_providers WHERE worker_id = ?", row.worker_id);
        this.db.run("UPDATE workers SET enabled = 0, status = 'DISABLED', removed_at = COALESCE(removed_at, ?), updated_at = ? WHERE id = ?", now, now, row.worker_id);
        this.pendingTokens.delete(String(row.id));
      }
      this.appendAudit("system", "worker.registration.expired", row.worker_id ?? null, { registrationId: row.id }, now);
    });
    this.events.publish({ type: "registration.updated", registrationId: row.id, status: "expired" });
  }

  private appendAudit(actor: string, action: string, workerId: string | null, payload: Record<string, unknown>, now: number): void {
    const previousHash = String(this.db.one<Row>("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1")?.event_hash ?? "");
    const eventHash = digest({ actor, action, workerId, payload, previousHash, createdAt: now });
    this.db.run("INSERT INTO audit_events(event_uuid, actor, action, worker_id, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uuidv7(now), actor, action, workerId, JSON.stringify(payload), previousHash, eventHash, now);
  }

  private publicWorker(row: Row, now: number): Record<string, unknown> {
    const capabilities = this.db.all<Row>("SELECT id, capability, runtime, runtime_version AS runtimeVersion, max_concurrency AS maxConcurrency, descriptor_json AS descriptor, descriptor_hash AS descriptorHash, grant_status AS grantStatus, superseded_at AS supersededAt, status FROM worker_capabilities WHERE worker_id = ? ORDER BY capability, runtime", row.id).map((item) => ({ ...item, runtime: item.runtime || null, descriptor: json(item.descriptor), supersededAt: iso(item.supersededAt) }));
    const models = this.db.all<Row>("SELECT runtime, model_id AS model, display_name AS displayName, status, context_length AS contextLength, metadata_json AS metadata FROM worker_models WHERE worker_id = ? ORDER BY runtime, model_id", row.id).map((item) => ({ ...item, metadata: json(item.metadata) }));
    const active = this.db.one<Row>("SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running, SUM(CASE WHEN status = 'OFFERED' THEN 1 ELSE 0 END) AS offered FROM task_attempts WHERE worker_id = ? AND status IN ('OFFERED', 'ACCEPTED', 'RUNNING')", row.id);
    const activeCount = Number(active?.count ?? 0);
    const runningCount = Number(active?.running ?? 0);
    const offeredCount = Number(active?.offered ?? 0);
    const heartbeatAgeSeconds = row.last_heartbeat_at ? Math.max(0, Math.floor((now - Number(row.last_heartbeat_at)) / 1000)) : null;
    const connectionState = row.removed_at ? "REMOVED" : !row.last_heartbeat_at ? "NO_HEARTBEAT" : heartbeatAgeSeconds! > 90 ? "STALE" : row.status === "ONLINE" ? "ONLINE" : "STALE";
    const connectionReason = connectionState === "STALE" ? "heartbeat 超過 90 秒" : connectionState === "NO_HEARTBEAT" ? "尚未收到 heartbeat" : null;
    const maxConcurrency = Math.max(1, Number(row.max_concurrency ?? 1));
    let dispatchState = "READY"; let dispatchReason: string | null = null;
    if (!row.enabled || row.status === "DISABLED") { dispatchState = "BLOCKED"; dispatchReason = "Worker 已停用"; }
    else if (row.drain) { dispatchState = activeCount > 0 ? "DRAINING" : "DRAINED"; dispatchReason = activeCount > 0 ? "等待現有工作完成" : "已停止接收新工作"; }
    else if (connectionState !== "ONLINE") { dispatchState = "BLOCKED"; dispatchReason = connectionReason; }
    else if (capabilities.length === 0 || !capabilities.some((capability: Row) => ["READY", "HEALTHY", "DEGRADED"].includes(String(capability.status)) && !["REVOKED", "REQUIRES_REVIEW"].includes(String(capability.grantStatus)))) { dispatchState = "BLOCKED"; dispatchReason = "尚未有可派工 capability"; }
    else if (activeCount >= maxConcurrency) { dispatchState = "BLOCKED"; dispatchReason = "已達最大併發數"; }
    const credential = this.db.one<Row>("SELECT created_at AS createdAt, revoked_at AS revokedAt FROM worker_tokens WHERE worker_id = ?", row.id);
    const credentialState = !credential ? "REMOVED" : credential.revokedAt ? "REVOKED" : row.credential_expires_at && Number(row.credential_expires_at) <= now ? "EXPIRED" : "ACTIVE";
    const providers = this.db.all<Row>("SELECT provider, evidence_level AS evidenceLevel, provider_verified AS providerVerified, evidence_json AS evidence, updated_at AS updatedAt FROM worker_providers WHERE worker_id = ? ORDER BY provider", row.id).map((item) => ({ ...item, providerVerified: Boolean(item.providerVerified), evidence: json(item.evidence), updatedAt: iso(item.updatedAt) }));
    const wakeConfigured = Boolean(process.env.PAI_WAKE_ADAPTER_URL);
    const availableActions = {
      enable: !Boolean(row.enabled),
      disable: Boolean(row.enabled),
      drain: Boolean(row.enabled) && !Boolean(row.drain),
      resume: Boolean(row.enabled) && Boolean(row.drain),
      remove: activeCount === 0,
      wake: wakeConfigured,
      wakeReason: wakeConfigured ? null : "未設定 Wake adapter",
    };
    return {
      id: row.id, name: row.name, platform: row.platform, hostname: row.hostname, status: row.status, enabled: Boolean(row.enabled), drain: Boolean(row.drain), drainState: dispatchState, agentVersion: row.agent_version,
      cpu: json(row.cpu_json, null), memory: json(row.memory_json, null), gpu: json(row.gpu_json, null), metadata: json(row.metadata_json), maxConcurrency, runningTasks: runningCount,
      lastHeartbeatAt: iso(row.last_heartbeat_at), heartbeatAgeSeconds, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), capabilities, models,
      connection: { state: connectionState, heartbeatAgeSeconds, lastHeartbeatAt: iso(row.last_heartbeat_at), reason: connectionReason },
      dispatch: { state: dispatchState, reason: dispatchReason, maxConcurrency },
      activity: { activeAttempts: activeCount, runningAttempts: runningCount, queuedOffers: offeredCount, liveReservations: 0, maxConcurrency },
      credential: { state: credentialState, createdAt: iso(credential?.createdAt), expiresAt: iso(row.credential_expires_at), revokedAt: iso(credential?.revokedAt) },
      providers,
      diagnostics: { cpu: json(row.cpu_json, null), memory: json(row.memory_json, null), gpu: json(row.gpu_json, null), lastErrorCode: row.last_error_code ?? null },
      availableActions,
    };
  }
}
