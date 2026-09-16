import { ControlPlaneDatabase } from "../db/database.ts";
import { safeHash } from "../tasks/task-service.ts";
import { uuidv7, type CreateTaskInput } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;
const READ_ONLY = new Set(["observe", "list_windows"]);
const OPERATIONS = new Set(["observe", "list_windows", "click", "move", "drag", "scroll", "type_text", "press_key", "hotkey", "launch_app", "focus_window"]);
const STATES = new Set(["PENDING_APPROVAL", "OPENING", "ACTIVE", "PAUSED", "CLOSING", "CLOSED", "REVOKED", "EXPIRED", "FAILED"]);

function object(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function parse(value: unknown, fallback: any = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }
function text(value: unknown, max: number): string { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function publicSession(row: Row): Record<string, unknown> {
  const scope = parse(row.scope_json); const model = parse(row.model_json);
  return { id: row.id, principal: row.principal, workRef: parse(row.work_ref_json, null), workerId: row.worker_id, desktopId: row.desktop_id, desktopEpoch: Number(row.desktop_epoch), descriptorHash: row.descriptor_hash, scope, model, state: row.state, revision: Number(row.revision), expiresAt: iso(row.expires_at), idleExpiresAt: iso(row.idle_expires_at), maxActions: Number(row.max_actions), actionCount: Number(row.action_count), stopState: row.stop_state, createdAt: iso(row.created_at), approvedAt: iso(row.approved_at), closedAt: iso(row.closed_at), updatedAt: iso(row.updated_at) };
}

export type ComputerSessionCreate = {
  principal: string;
  workRef?: Record<string, unknown> | null;
  workerId: string;
  desktopId?: string;
  desktopKind?: "desktop" | "window";
  displayId?: string;
  allowedOperations?: string[];
  allowedApps?: string[];
  captureScope?: "window" | "desktop";
  deliveryModes?: string[];
  model?: { provider: string; id: string; dataPolicy?: string };
  durationSeconds?: number;
  idleSeconds?: number;
  maxActions?: number;
};

export class ComputerSessionService {
  readonly db: ControlPlaneDatabase;
  private readonly controller?: { computerControl(workerId: string, sessionId: string, action: string): boolean; computerLease?(workerId: string, sessionId: string, revision: number, desktopEpoch: number): boolean };
  constructor(db: ControlPlaneDatabase, controller?: { computerControl(workerId: string, sessionId: string, action: string): boolean; computerLease?(workerId: string, sessionId: string, revision: number, desktopEpoch: number): boolean }) { this.db = db; this.controller = controller; }

  listComputers(now = Date.now()): Record<string, unknown>[] {
    const workers = this.db.all<Row>("SELECT id, name, platform, hostname, status, enabled, drain, last_heartbeat_at, metadata_json FROM workers WHERE removed_at IS NULL ORDER BY name, id");
    return workers.map((worker) => {
      const capabilities = this.db.all<Row>("SELECT capability, runtime, status, grant_status, evidence_state, contract_version, descriptor_json, descriptor_hash, verification_expires_at FROM worker_capabilities WHERE worker_id = ? AND superseded_at IS NULL AND capability = 'computer.use'", worker.id).map((item) => ({ capability: item.capability, runtime: item.runtime || null, status: item.status, grantStatus: item.grant_status, evidenceState: item.evidence_state, contractVersion: Number(item.contract_version ?? 1), descriptor: parse(item.descriptor_json), descriptorHash: item.descriptor_hash, verificationExpiresAt: iso(item.verification_expires_at) }));
      const desktops = this.db.all<Row>("SELECT * FROM computer_desktops WHERE worker_id = ? ORDER BY desktop_id", worker.id).map((item) => ({ desktopId: item.desktop_id, kind: item.desktop_kind, displayId: item.display_id, desktopEpoch: Number(item.desktop_epoch), state: item.state, permissions: parse(item.permissions_json), driverVersion: item.driver_version, descriptorHash: item.descriptor_hash, updatedAt: iso(item.updated_at) }));
      const advertisedDesktops = desktops.length > 0 ? desktops : capabilities.length > 0 ? [{ desktopId: "primary", kind: "desktop", displayId: "primary", desktopEpoch: 1, state: "UNKNOWN", permissions: {}, driverVersion: null, descriptorHash: capabilities[0].descriptorHash, updatedAt: null }] : [];
      const active = this.db.one<Row>("SELECT id, state, expires_at FROM computer_sessions WHERE worker_id = ? AND state IN ('OPENING','ACTIVE','PAUSED','CLOSING') ORDER BY created_at DESC LIMIT 1", worker.id);
      return { workerId: worker.id, name: worker.name, platform: worker.platform, hostname: worker.hostname, status: worker.status, online: worker.status === "ONLINE" && Number(worker.enabled) === 1 && Number(worker.drain) === 0, capabilities, desktops: advertisedDesktops, activeSession: active ? { id: active.id, state: active.state, expiresAt: iso(active.expires_at) } : null, observedAt: iso(now) };
    });
  }

  get(id: string, now = Date.now()): Record<string, unknown> | undefined {
    const row = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ?", id); if (!row) return undefined;
    if (["PENDING_APPROVAL", "OPENING", "ACTIVE", "PAUSED"].includes(String(row.state)) && (Number(row.expires_at) <= now || Number(row.idle_expires_at) <= now)) this.expire(id, now);
    const current = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ?", id); if (!current) return undefined;
    const result = publicSession(current) as Row;
    result.lock = this.db.one<Row>("SELECT state, stop_state, acquired_at, released_at, updated_at FROM computer_resource_locks WHERE session_id = ?", id) ?? null;
    result.operations = this.db.all<Row>("SELECT id, sequence, task_id AS taskId, operation, state, effect_state AS effectState, observation_id AS observationId, receipt_json AS receipt, created_at AS createdAt, updated_at AS updatedAt FROM computer_operations WHERE session_id = ? ORDER BY sequence", id).map((item) => ({ ...item, receipt: parse(item.receipt, null), createdAt: iso(item.createdAt), updatedAt: iso(item.updatedAt) }));
    result.observations = this.db.all<Row>("SELECT o.id, o.sequence, o.target_json AS target, o.artifact_id AS artifactId, a.sha256 AS sha256, a.media_type AS mediaType, a.size_bytes AS sizeBytes, o.metadata_json AS metadata, o.expires_at AS expiresAt, o.created_at AS createdAt FROM computer_observations o LEFT JOIN artifacts a ON a.id = o.artifact_id WHERE o.session_id = ? ORDER BY o.sequence", id).map((item) => ({ ...item, target: parse(item.target), metadata: parse(item.metadata), sizeBytes: item.sizeBytes === null || item.sizeBytes === undefined ? null : Number(item.sizeBytes), expiresAt: iso(item.expiresAt), createdAt: iso(item.createdAt) }));
    return result;
  }

  create(input: ComputerSessionCreate, idempotencyKey: string, now = Date.now()): Record<string, unknown> {
    if (!idempotencyKey || idempotencyKey.length > 240) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const requestHash = safeHash(input); const scope = "computer-session-create";
    const prior = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return parse(prior.response_json); }
    const worker = this.db.one<Row>("SELECT id, status, enabled, drain FROM workers WHERE id = ? AND removed_at IS NULL", input.workerId); if (!worker) throw new Error("WORKER_NOT_FOUND");
    const capability = this.db.one<Row>("SELECT * FROM worker_capabilities WHERE worker_id = ? AND capability = 'computer.use' AND runtime = 'cua-driver' AND superseded_at IS NULL", input.workerId);
    if (!capability || !["READY", "HEALTHY"].includes(String(capability.status)) || String(capability.grant_status) !== "GRANTED" || String(capability.evidence_state) !== "VERIFIED" || (capability.verification_expires_at && Number(capability.verification_expires_at) <= now)) throw new Error("COMPUTER_CAPABILITY_UNAVAILABLE");
    const descriptor = parse(capability.descriptor_json); const descriptorHash = String(capability.descriptor_hash ?? safeHash(descriptor));
    const desktopId = text(input.desktopId, 120) || "primary"; const desktopKind = input.desktopKind ?? (input.captureScope === "desktop" ? "desktop" : "window");
    if (!(["desktop", "window"] as string[]).includes(desktopKind)) throw new Error("INVALID_DESKTOP_KIND");
    const existingDesktop = this.db.one<Row>("SELECT * FROM computer_desktops WHERE worker_id = ? AND desktop_id = ?", input.workerId, desktopId);
    if (existingDesktop && existingDesktop.desktop_kind !== desktopKind) throw new Error("DESKTOP_KIND_CONFLICT");
    if (!existingDesktop) this.db.run("INSERT INTO computer_desktops(worker_id, desktop_id, desktop_kind, display_id, desktop_epoch, state, permissions_json, driver_version, descriptor_hash, metadata_json, updated_at) VALUES (?, ?, ?, ?, 1, 'READY', '{}', ?, ?, '{}', ?)", input.workerId, desktopId, desktopKind, input.displayId ?? (desktopKind === "desktop" ? "primary" : null), descriptor.runtime_version ?? descriptor.runtimeVersion ?? descriptor.driver_version ?? descriptor.driverVersion ?? null, descriptorHash, now);
    const desktop = this.db.one<Row>("SELECT * FROM computer_desktops WHERE worker_id = ? AND desktop_id = ?", input.workerId, desktopId)!;
    const allowedOperations = (input.allowedOperations?.length ? input.allowedOperations : ["observe", "list_windows", "click", "move", "drag", "scroll", "type_text", "press_key", "hotkey", "launch_app", "focus_window"]).map(String).filter((item, index, list) => OPERATIONS.has(item) && list.indexOf(item) === index);
    if (!allowedOperations.length) throw new Error("INVALID_OPERATION_SCOPE");
    const captureScope = input.captureScope ?? (desktopKind === "desktop" ? "desktop" : "window");
    if (!["window", "desktop"].includes(captureScope)) throw new Error("INVALID_CAPTURE_SCOPE");
    if (captureScope === "desktop" && desktopKind !== "desktop") throw new Error("CAPTURE_SCOPE_MISMATCH");
    const duration = Number(input.durationSeconds ?? 900); const idle = Number(input.idleSeconds ?? 120); const maxActions = Number(input.maxActions ?? 100);
    if (!Number.isInteger(duration) || duration < 30 || duration > 900) throw new Error("INVALID_SESSION_DURATION");
    if (!Number.isInteger(idle) || idle < 30 || idle > duration) throw new Error("INVALID_SESSION_IDLE");
    if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new Error("INVALID_SESSION_ACTION_LIMIT");
    const deliveryModes = (input.deliveryModes ?? ["background"]).map(String).filter((item) => ["background", "foreground"].includes(item));
    if (!deliveryModes.length) throw new Error("INVALID_DELIVERY_MODE");
    const scopeValue = { allowed_operations: allowedOperations, allowed_apps: (input.allowedApps ?? []).map(String).filter((item) => item.length > 0 && item.length <= 200).slice(0, 50), capture_scope: captureScope, delivery_modes: deliveryModes, scope_hash: "" };
    scopeValue.scope_hash = safeHash({ ...scopeValue });
    const model = input.model && text(input.model.provider, 100) && text(input.model.id, 200) ? { provider: text(input.model.provider, 100), id: text(input.model.id, 200), data_policy: text(input.model.dataPolicy, 200) || null } : null;
    const id = uuidv7(now); const result = { id, state: "PENDING_APPROVAL", revision: 1, scopeHash: scopeValue.scope_hash, expiresAt: new Date(now + duration * 1000).toISOString() };
    this.db.transaction(() => {
      this.db.run("INSERT INTO computer_sessions(id, principal, work_ref_json, worker_id, desktop_id, desktop_epoch, descriptor_hash, scope_json, model_json, state, revision, expires_at, idle_expires_at, max_actions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', 1, ?, ?, ?, ?, ?)", id, text(input.principal, 120) || "owner", input.workRef ? JSON.stringify(input.workRef) : null, input.workerId, desktopId, Number(desktop.desktop_epoch), descriptorHash, JSON.stringify(scopeValue), JSON.stringify(model), now + duration * 1000, now + idle * 1000, maxActions, now, now);
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at, retain_until) VALUES (?, ?, ?, 201, ?, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now, now + 86_400_000);
    });
    return result;
  }

  approve(id: string, scopeHash: string, actor = "owner", now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ?", id); if (!row) throw new Error("COMPUTER_SESSION_NOT_FOUND"); if (row.state !== "PENDING_APPROVAL") throw new Error("INVALID_SESSION_STATE");
    this.assertPrincipal(row, actor);
    const scope = parse(row.scope_json); if (!scopeHash || scopeHash !== scope.scope_hash) throw new Error("SCOPE_HASH_MISMATCH");
    if (Number(row.expires_at) <= now) throw new Error("SESSION_EXPIRED");
    const lock = this.db.one<Row>("SELECT * FROM computer_resource_locks WHERE worker_id = ? AND desktop_id = ?", row.worker_id, row.desktop_id); if (lock && lock.state !== "RELEASED") throw new Error("DESKTOP_BUSY");
    this.db.transaction(() => { if (lock) this.db.run("UPDATE computer_resource_locks SET session_id = ?, desktop_epoch = ?, state = 'HELD', stop_state = 'UNKNOWN', acquired_at = ?, released_at = NULL, updated_at = ? WHERE worker_id = ? AND desktop_id = ? AND state = 'RELEASED'", id, row.desktop_epoch, now, now, row.worker_id, row.desktop_id); else this.db.run("INSERT INTO computer_resource_locks(worker_id, desktop_id, session_id, desktop_epoch, state, stop_state, acquired_at, updated_at) VALUES (?, ?, ?, ?, 'HELD', 'UNKNOWN', ?, ?)", row.worker_id, row.desktop_id, id, row.desktop_epoch, now, now); this.db.run("UPDATE computer_sessions SET state = 'ACTIVE', revision = revision + 1, approved_at = ?, idle_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'PENDING_APPROVAL'", now, Math.min(Number(row.expires_at), now + 120_000), now, id); });
    this.controller?.computerLease?.(String(row.worker_id), id, Number(row.revision) + 1, Number(row.desktop_epoch));
    this.audit(actor, "computer.session.approved", id, { scopeHash }, now); return this.get(id, now)!;
  }

  control(id: string, action: "pause" | "resume" | "close" | "revoke", expectedRevision: number, actor = "owner", now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ?", id); if (!row) throw new Error("COMPUTER_SESSION_NOT_FOUND"); if (Number(row.revision) !== expectedRevision) throw new Error("SESSION_CHANGED");
    this.assertPrincipal(row, actor);
    const currentState = String(row.state);
    const allowedTransitions: Record<string, string[]> = { pause: ["ACTIVE"], resume: ["PAUSED"], close: ["OPENING", "ACTIVE", "PAUSED"], revoke: ["PENDING_APPROVAL", "OPENING", "ACTIVE", "PAUSED", "CLOSING"] };
    if (!allowedTransitions[action]?.includes(currentState)) throw new Error("INVALID_SESSION_STATE");
    const transitions: Record<string, string> = { pause: "PAUSED", resume: "ACTIVE", close: "CLOSING", revoke: "REVOKED" }; const next = transitions[action]; if (!next || !STATES.has(next)) throw new Error("INVALID_SESSION_ACTION");
    if (action === "resume" && Number(row.expires_at) <= now) throw new Error("SESSION_EXPIRED");
    this.db.transaction(() => { this.db.run("UPDATE computer_sessions SET state = ?, revision = revision + 1, stop_state = ?, closed_at = CASE WHEN ? IN ('CLOSING','REVOKED') THEN ? ELSE closed_at END, updated_at = ? WHERE id = ? AND revision = ?", next, ["close", "revoke"].includes(action) ? "UNKNOWN" : row.stop_state, next, now, now, id, expectedRevision); if (["close", "revoke"].includes(action)) this.db.run("UPDATE computer_resource_locks SET state = 'UNKNOWN', stop_state = 'UNKNOWN', updated_at = ? WHERE session_id = ? AND state != 'RELEASED'", now, id); });
    this.controller?.computerControl(String(row.worker_id), id, action);
    this.audit(actor, `computer.session.${action}`, id, {}, now); return this.get(id, now)!;
  }

  renewLeases(now = Date.now()): number {
    const stale = this.db.all<Row>("SELECT id FROM computer_sessions WHERE state IN ('ACTIVE','PAUSED') AND (expires_at <= ? OR idle_expires_at <= ?)", now, now);
    for (const row of stale) this.expire(String(row.id), now);
    const rows = this.db.all<Row>("SELECT s.id, s.worker_id, s.revision, s.desktop_epoch, l.desktop_id FROM computer_sessions s JOIN computer_resource_locks l ON l.session_id = s.id WHERE s.state IN ('ACTIVE','PAUSED') AND l.state = 'HELD' AND s.expires_at > ?", now);
    for (const row of rows) {
      this.db.run("UPDATE computer_resource_locks SET updated_at = ? WHERE worker_id = ? AND desktop_id = ? AND session_id = ? AND state = 'HELD'", now, row.worker_id, row.desktop_id, row.id);
      this.controller?.computerLease?.(String(row.worker_id), String(row.id), Number(row.revision), Number(row.desktop_epoch));
    }
    return rows.length;
  }

  reconcileOperation(sessionId: string, sequence: number, observationId: string, actor = "owner", now = Date.now()): Record<string, unknown> {
    const operation = this.db.one<Row>("SELECT * FROM computer_operations WHERE session_id = ? AND sequence = ?", sessionId, sequence); if (!operation) throw new Error("OPERATION_NOT_FOUND");
    const session = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ?", sessionId); if (!session) throw new Error("COMPUTER_SESSION_NOT_FOUND"); this.assertPrincipal(session, actor);
    const observation = this.db.one<Row>("SELECT * FROM computer_observations WHERE id = ? AND session_id = ?", observationId, sessionId); if (!observation) throw new Error("OBSERVATION_NOT_FOUND");
    if (Number(observation.sequence) <= Number(sequence) || Number(observation.expires_at) <= now) throw new Error("OBSERVATION_STALE");
    this.db.run("UPDATE computer_operations SET effect_state = 'CONFIRMED', receipt_json = ?, updated_at = ? WHERE session_id = ? AND sequence = ? AND effect_state = 'UNKNOWN'", JSON.stringify({ reconciled: true, observationId }), now, sessionId, sequence);
    this.audit(actor, "computer.operation.reconciled", sessionId, { sequence, observationId }, now);
    return { sessionId, sequence, observationId, effectState: "CONFIRMED" };
  }

  recordStopReceipt(sessionId: string, workerId: string, stopState: "CONFIRMED" | "UNKNOWN", now = Date.now()): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ? AND worker_id = ?", sessionId, workerId); if (!row) throw new Error("COMPUTER_SESSION_NOT_FOUND");
    this.db.transaction(() => {
      if (stopState === "CONFIRMED") {
        this.db.run("UPDATE computer_sessions SET state = CASE WHEN state = 'REVOKED' THEN 'REVOKED' ELSE 'CLOSED' END, stop_state = 'CONFIRMED', closed_at = COALESCE(closed_at, ?), updated_at = ? WHERE id = ? AND state IN ('CLOSING','REVOKED')", now, now, sessionId);
        this.db.run("UPDATE computer_resource_locks SET state = 'RELEASED', stop_state = 'CONFIRMED', released_at = ?, updated_at = ? WHERE session_id = ? AND state IN ('UNKNOWN','RELEASING','HELD')", now, now, sessionId);
      } else {
        this.db.run("UPDATE computer_sessions SET stop_state = 'UNKNOWN', updated_at = ? WHERE id = ?", now, sessionId);
        this.db.run("UPDATE computer_resource_locks SET state = 'UNKNOWN', stop_state = 'UNKNOWN', updated_at = ? WHERE session_id = ? AND state != 'RELEASED'", now, sessionId);
      }
    });
    this.audit("worker", "computer.session.stop.receipt", sessionId, { workerId, stopState }, now);
    return this.get(sessionId, now)!;
  }

  prepareTask(input: CreateTaskInput, actor = "owner", now = Date.now()): CreateTaskInput {
    if (input.taskType !== "computer.use") return input;
    const payload = object(input.payload); const sessionId = text(payload.session_id ?? payload.sessionId, 200); if (!sessionId) throw new Error("SESSION_REQUIRED");
    const row = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ?", sessionId); if (!row) throw new Error("COMPUTER_SESSION_NOT_FOUND"); if (row.state !== "ACTIVE") throw new Error("SESSION_NOT_ACTIVE"); if (Number(row.expires_at) <= now || Number(row.idle_expires_at) <= now) throw new Error("SESSION_EXPIRED");
    const desktop = this.db.one<Row>("SELECT desktop_epoch FROM computer_desktops WHERE worker_id = ? AND desktop_id = ?", row.worker_id, row.desktop_id); if (desktop && Number(desktop.desktop_epoch) !== Number(row.desktop_epoch)) { this.invalidateForDesktopChange(sessionId, now); throw new Error("DESKTOP_CHANGED"); }
    const operation = text(payload.operation, 40); if (!OPERATIONS.has(operation)) throw new Error("CUA_OPERATION_UNSUPPORTED"); const scope = parse(row.scope_json); if (!scope.allowed_operations?.includes(operation)) throw new Error("SESSION_SCOPE_DENIED");
    const approvalRef = text(payload.approval_ref ?? payload.approvalRef, 500); const sensitive = payload.sensitive === true || payload.requires_approval === true || payload.requiresApproval === true; if (sensitive && !approvalRef) throw new Error("APPROVAL_REQUIRED");
    const revision = Number(payload.session_revision ?? payload.sessionRevision ?? row.revision); if (revision !== Number(row.revision)) throw new Error("SESSION_CHANGED"); const desktopEpoch = Number(payload.desktop_epoch ?? payload.desktopEpoch ?? row.desktop_epoch); if (desktopEpoch !== Number(row.desktop_epoch)) throw new Error("DESKTOP_CHANGED");
    const sequence = Number(payload.sequence); if (!Number.isInteger(sequence) || sequence < 1 || sequence > 10_000) throw new Error("INVALID_OPERATION_SEQUENCE"); const priorOperation = this.db.one<Row>("SELECT request_hash FROM computer_operations WHERE session_id = ? AND sequence = ?", sessionId, sequence); const latestSequence = Number(this.db.one<Row>("SELECT COALESCE(MAX(sequence), 0) AS value FROM computer_operations WHERE session_id = ?", sessionId)?.value ?? 0); if (!priorOperation && sequence !== latestSequence + 1) throw new Error("INVALID_OPERATION_SEQUENCE"); if (!READ_ONLY.has(operation) && Number(row.action_count) >= Number(row.max_actions)) throw new Error("SESSION_ACTION_LIMIT");
    if (!READ_ONLY.has(operation) && this.db.one<Row>("SELECT id FROM computer_operations WHERE session_id = ? AND effect_state = 'UNKNOWN' LIMIT 1", sessionId)) throw new Error("ACTION_EFFECT_UNKNOWN");
    if (!READ_ONLY.has(operation)) {
      const observationId = text(payload.observation_id ?? payload.observationId, 200); if (!observationId) throw new Error("OBSERVATION_REQUIRED");
      const observation = this.db.one<Row>("SELECT * FROM computer_observations WHERE id = ? AND session_id = ?", observationId, sessionId); if (!observation) throw new Error("OBSERVATION_NOT_FOUND"); if (Number(observation.expires_at) <= now || now - Number(observation.created_at) > 10_000) throw new Error("OBSERVATION_STALE");
    }
    const session = { state: row.state, expires_at: Number(row.expires_at), allowed_operations: scope.allowed_operations, allowed_apps: scope.allowed_apps, capture_scope: scope.capture_scope, delivery_modes: scope.delivery_modes, desktop_epoch: Number(row.desktop_epoch) };
    const execution = { ...input.execution, capabilities: ["computer.use"], workerId: row.worker_id, runtime: "cua-driver" };
    return { ...input, requestedBy: actor, execution, payload: { ...payload, session_id: sessionId, session_revision: Number(row.revision), desktop_epoch: Number(row.desktop_epoch), session } };
  }

  recordOperation(sessionId: string, taskId: string, payload: Record<string, unknown>, now = Date.now()): void {
    const row = this.db.one<Row>("SELECT * FROM computer_sessions WHERE id = ?", sessionId); if (!row) throw new Error("COMPUTER_SESSION_NOT_FOUND"); const sequence = Number(payload.sequence); const observationId = text(payload.observation_id ?? payload.observationId, 200) || null; const requestHash = safeHash({ sessionId, sequence, operation: payload.operation ?? null, target: payload.target ?? null, arguments: payload.arguments ?? null, observationId }); const existing = this.db.one<Row>("SELECT request_hash FROM computer_operations WHERE session_id = ? AND sequence = ?", sessionId, sequence); if (existing) { if (existing.request_hash !== requestHash) throw new Error("OPERATION_SEQUENCE_CONFLICT"); return; }
    this.db.transaction(() => { this.db.run("INSERT INTO computer_operations(id, session_id, sequence, task_id, operation, request_hash, state, effect_state, observation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?, ?)", uuidv7(now), sessionId, sequence, taskId, String(payload.operation), requestHash, READ_ONLY.has(String(payload.operation)) ? "NONE_CONFIRMED" : "UNKNOWN", observationId, now, now); if (!READ_ONLY.has(String(payload.operation))) this.db.run("UPDATE computer_sessions SET action_count = action_count + 1, idle_expires_at = MIN(expires_at, ?), updated_at = ? WHERE id = ?", now + 120_000, now, sessionId); });
  }

  expireObservationArtifacts(now = Date.now()): string[] {
    const rows = this.db.all<Row>("SELECT a.id, a.storage_path FROM computer_observations o JOIN artifacts a ON a.id = o.artifact_id WHERE o.expires_at <= ? AND COALESCE(a.storage_state, 'AVAILABLE') = 'AVAILABLE'", now);
    if (rows.length) this.db.transaction(() => { for (const row of rows) this.db.run("UPDATE artifacts SET storage_state = 'EXPIRED' WHERE id = ? AND COALESCE(storage_state, 'AVAILABLE') = 'AVAILABLE'", row.id); });
    return rows.map((row) => String(row.storage_path)).filter(Boolean);
  }

  private expire(id: string, now: number): void { this.db.transaction(() => { this.db.run("UPDATE computer_sessions SET state = 'EXPIRED', revision = revision + 1, updated_at = ? WHERE id = ? AND state IN ('PENDING_APPROVAL','OPENING','ACTIVE','PAUSED')", now, id); this.db.run("UPDATE computer_resource_locks SET state = 'UNKNOWN', stop_state = 'UNKNOWN', updated_at = ? WHERE session_id = ? AND state != 'RELEASED'", now, id); }); }
  private invalidateForDesktopChange(id: string, now: number): void { this.db.transaction(() => { this.db.run("UPDATE computer_sessions SET state = 'FAILED', revision = revision + 1, stop_state = 'UNKNOWN', updated_at = ? WHERE id = ? AND state = 'ACTIVE'", now, id); this.db.run("UPDATE computer_resource_locks SET state = 'UNKNOWN', stop_state = 'UNKNOWN', updated_at = ? WHERE session_id = ? AND state != 'RELEASED'", now, id); }); }
  private assertPrincipal(row: Row, actor: string): void { if (String(row.principal ?? "owner") !== String(actor || "owner")) throw new Error("SESSION_ACCESS_DENIED"); }
  private audit(actor: string, action: string, sessionId: string, payload: Record<string, unknown>, now: number): void { const previous = String(this.db.one<Row>("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1")?.event_hash ?? ""); const workerId = this.db.one<Row>("SELECT worker_id FROM computer_sessions WHERE id = ?", sessionId)?.worker_id ?? null; const eventHash = safeHash({ previous, actor, action, sessionId, payload, now }); this.db.run("INSERT INTO audit_events(event_uuid, actor, action, worker_id, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uuidv7(now), actor, action, workerId, JSON.stringify(payload), previous, eventHash, now); }
}
