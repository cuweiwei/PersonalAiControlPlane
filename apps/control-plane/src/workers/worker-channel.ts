import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { EventHub } from "../events/event-hub.ts";
import { TaskService, safeHash } from "../tasks/task-service.ts";
import { ArtifactStorage } from "../artifacts/artifact-storage.ts";
import { WorkerService } from "./worker-service.ts";
import { SettingsService } from "../settings/settings-service.ts";
import type { ComputerSessionService } from "../computers/computer-session-service.ts";

type JsonRecord = Record<string, any>;
type SocketRecord = { socket: WebSocket; workerId: string; hello: boolean; features: Set<string> };

function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function jsonValue(value: unknown): unknown { try { return JSON.parse(String(value ?? "{}")); } catch { return {}; } }
function messagePayload(value: unknown): JsonRecord { const parsed = typeof value === "string" ? JSON.parse(value) : value; return record(parsed); }
function bearer(request: IncomingMessage): string | undefined { const value = request.headers.authorization; return value?.startsWith("Bearer ") ? value.slice(7) : undefined; }

export class WorkerCoordinator {
  readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly workers: WorkerService;
  private readonly tasks: TaskService;
  private readonly events: EventHub;
  private readonly artifacts?: ArtifactStorage;
  private readonly settings?: SettingsService;
  private computers?: ComputerSessionService;
  private readonly connections = new Map<string, SocketRecord>();

  constructor(workers: WorkerService, tasks: TaskService, events: EventHub, artifacts?: ArtifactStorage, settings?: SettingsService) { this.workers = workers; this.tasks = tasks; this.events = events; this.artifacts = artifacts; this.settings = settings; this.websocketServer.on("connection", (socket: WebSocket, request: IncomingMessage, workerId: string) => this.acceptSocket(socket, request, workerId)); }
  setComputerSessionService(computers: ComputerSessionService): void { this.computers = computers; }

  handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    const token = bearer(request); const worker = token ? this.workers.authenticate(token) : undefined;
    if (!worker) {
      const disposition = this.workers.tokenDisposition(token ?? "");
      const status = disposition === "removed" ? "410 Gone" : disposition === "disabled" ? "403 Forbidden" : "401 Unauthorized";
      const code = disposition === "removed" ? "WORKER_REMOVED" : disposition === "disabled" ? "WORKER_DISABLED" : "INVALID_WORKER_TOKEN";
      const body = JSON.stringify({ error: { code } });
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      socket.destroy();
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (ws) => this.websocketServer.emit("connection", ws, request, worker.id));
  }

  isConnected(workerId: string): boolean { return this.connections.has(workerId); }

  offer(workerId: string, task: Record<string, any>, attemptId: string): boolean {
    const connection = this.connections.get(workerId); if (!connection || !connection.hello || connection.socket.readyState !== 1) return false;
    if (task.taskType === "computer.use" && !connection.features.has("computer_session_v1")) return false;
    if (task.ownerKind === "MISSION" && ["mission_execution_v1", "stop_evidence_v1", "workspace_exclusion_v1"].some((feature) => !connection.features.has(feature))) return false;
    const execution = (task as JsonRecord).resolvedExecution ?? task.execution;
    const currentAttempt = this.tasks.db.one<JsonRecord>("SELECT run_id, attempt_number, attempt_in_run, deadline_at, fence_epoch, worker_boot_id, workspace_id FROM task_attempts WHERE id = ?", attemptId);
    const runNumber = currentAttempt?.run_id ? this.tasks.db.one<JsonRecord>("SELECT run_number FROM task_runs WHERE id = ?", currentAttempt.run_id)?.run_number ?? null : null;
    const remaining = currentAttempt?.deadline_at ? Math.max(0, Math.ceil((Number(currentAttempt.deadline_at) - Date.now()) / 1000)) : Number(task.timeoutSeconds ?? 1800);
    const missionContext = task.ownerKind === "MISSION" && task.missionExecutionId ? this.tasks.db.one<JsonRecord>("SELECT e.generation, e.retry_safety, e.operation_key, s.id AS step_id, p.revision AS plan_revision, r.id AS mission_run_id, r.mission_id, r.authority_epoch, m.scope_json FROM mission_step_executions e JOIN mission_steps s ON s.id = e.step_id JOIN mission_plans p ON p.id = s.plan_id JOIN mission_runs r ON r.id = p.mission_run_id JOIN missions m ON m.id = r.mission_id WHERE e.id = ?", task.missionExecutionId) : undefined;
    connection.socket.send(JSON.stringify({ type: "task.offer", task_id: task.id, run_id: task.currentRunId ?? currentAttempt?.run_id ?? null, run_number: runNumber, attempt_id: attemptId, attempt_number: currentAttempt?.attempt_number ?? null, attempt_in_run: currentAttempt?.attempt_in_run ?? null, fence_epoch: Number(currentAttempt?.fence_epoch ?? 1), worker_boot_id: currentAttempt?.worker_boot_id ?? null, workspace_id: currentAttempt?.workspace_id ?? null, task_type: task.taskType, purpose: task.purpose ?? "USER", title: task.title, instruction: task.instruction, context: task.context, payload: task.payload, execution: { ...(execution ?? {}), worker_id: workerId, workspace_id: execution?.workspaceId ?? execution?.workspace_id ?? null, model: execution?.model ?? null }, limits: { timeout_seconds: task.timeoutSeconds, remaining_seconds: remaining }, input_artifact_ids: task.inputArtifactIds ?? [], ...(missionContext ? { mission_context: { authority_epoch: missionContext.authority_epoch, mission_id: missionContext.mission_id, mission_run_id: missionContext.mission_run_id, plan_revision: Number(missionContext.plan_revision), step_id: missionContext.step_id, execution_generation: Number(missionContext.generation), operation_key: missionContext.operation_key, retry_safety: missionContext.retry_safety, scope_hash: missionContext.scope_json ? safeHash(JSON.parse(String(missionContext.scope_json))) : null, workspace_access: task.taskType === "codex" ? "WRITE_EXCLUSIVE" : "NONE" } } : {}) }));
    return true;
  }

  cancel(workerId: string, taskId: string, attemptId: string): boolean { const connection = this.connections.get(workerId); if (!connection) return false; connection.socket.send(JSON.stringify({ type: "task.cancel", task_id: taskId, attempt_id: attemptId })); return true; }
  computerControl(workerId: string, sessionId: string, action: string): boolean { const connection = this.connections.get(workerId); if (!connection || !connection.hello || !connection.features.has("computer_session_v1")) return false; connection.socket.send(JSON.stringify({ type: "computer.session.control", session_id: sessionId, action })); return true; }
  computerLease(workerId: string, sessionId: string, revision: number, desktopEpoch: number): boolean { const connection = this.connections.get(workerId); if (!connection || !connection.hello || !connection.features.has("computer_session_v1")) return false; connection.socket.send(JSON.stringify({ type: "computer.session.lease", session_id: sessionId, revision, desktop_epoch: desktopEpoch, issued_at: Date.now() })); return true; }
  closeWorker(workerId: string, code = 4001, reason = "worker removed"): void { this.connections.get(workerId)?.socket.close(code, reason); }
  close(): void { for (const connection of this.connections.values()) connection.socket.close(); this.websocketServer.close(); this.connections.clear(); }

  private acceptSocket(socket: WebSocket, _request: IncomingMessage, workerId: string): void {
    const previous = this.connections.get(workerId); previous?.socket.close(4000, "replaced");
    const connection: SocketRecord = { socket, workerId, hello: false, features: new Set() }; this.connections.set(workerId, connection); this.workers.markConnected(workerId);
    const timeout = setTimeout(() => { if (!connection.hello) socket.close(4002, "hello required"); }, 10_000); timeout.unref();
    socket.on("message", (raw) => { void this.handleMessage(connection, raw.toString()); });
    socket.on("close", () => { clearTimeout(timeout); if (this.connections.get(workerId) === connection) { this.connections.delete(workerId); this.workers.markDisconnected(workerId); } });
    socket.on("error", () => { /* close event owns state cleanup */ });
  }

  private async handleMessage(connection: SocketRecord, raw: string): Promise<void> {
    let message: JsonRecord; try { message = messagePayload(raw); } catch { connection.socket.close(4003, "invalid json"); return; }
    const type = String(message.type ?? ""); const workerId = connection.workerId; const taskId = String(message.task_id ?? ""); const attemptId = String(message.attempt_id ?? "");
    if (!connection.hello) {
      if (type !== "hello" || String(message.worker_id ?? "") !== workerId || Number(message.protocol_version) !== 2) { connection.socket.close(4004, "protocol version unsupported"); return; }
      connection.hello = true; const clientFeatures = Array.isArray(message.features) ? message.features.filter((feature): feature is string => typeof feature === "string") : []; this.workers.setProtocolFeatures(workerId, clientFeatures); const priorMetadata = record(jsonValue(this.tasks.db.one<JsonRecord>("SELECT metadata_json FROM workers WHERE id = ?", workerId)?.metadata_json ?? "{}")); if (typeof message.worker_boot_id === "string" && message.worker_boot_id.length <= 200) this.tasks.db.run("UPDATE workers SET metadata_json = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...priorMetadata, worker_boot_id: message.worker_boot_id }), Date.now(), workerId); const effective = this.settings?.getEffective(); const preferences = this.workers.preferences(workerId); const serverFeatures = ["resolved_execution_v1", "task_run_v1", "workspace_inventory_v1", "settings_apply_v1", "availability_v1", "result_manifest_v1", "artifact_ack_v1", "mission_execution_v1", "stop_evidence_v1", "workspace_exclusion_v1", "attempt_fencing_v1", "durable_result_ack_v1", "workspace_lock_v1", "computer_session_v1"]; const negotiated = serverFeatures.filter((feature) => clientFeatures.includes(feature)); connection.features = new Set(negotiated); connection.socket.send(JSON.stringify({ type: "hello.ack", server_version: "2.0.0", heartbeat_interval_seconds: Number(effective?.values.heartbeat_interval_seconds ?? 30), features: negotiated })); if (effective) connection.socket.send(JSON.stringify({ type: "config.apply", settings_version: effective.version, preferences_version: preferences.version, config: { ...effective.values, mode: preferences.mode, idle_threshold_seconds: preferences.idleThresholdSeconds ?? effective.values.idle_threshold_seconds, pause_id: preferences.pause && (preferences.pause as JsonRecord).id ? (preferences.pause as JsonRecord).id : null, pause_until: preferences.pause && (preferences.pause as JsonRecord).until ? (preferences.pause as JsonRecord).until : null, pause_indefinite: Boolean((preferences.pause as JsonRecord | null)?.indefinite) } })); this.flushAssigned(workerId); this.events.publish({ type: "worker.updated", workerId, status: "ONLINE" }); return;
    }
    try {
      if (type === "heartbeat") this.workers.heartbeat(workerId, message, Date.now());
      else if (type === "capabilities.update") this.workers.updateCapabilities(workerId, Array.isArray(message.capabilities) ? message.capabilities : [], Date.now());
      else if (type === "models.update") this.workers.updateModels(workerId, Array.isArray(message.models) ? message.models : [], Date.now());
      else if (type === "inventory.update") { this.workers.updateCapabilities(workerId, Array.isArray(message.capabilities) ? message.capabilities : [], Date.now()); this.workers.updateModels(workerId, Array.isArray(message.models) ? message.models : [], Date.now()); for (const workspace of Array.isArray(message.workspaces) ? message.workspaces : []) { const item = record(workspace); if (typeof item.workspace_id === "string") this.workers.upsertWorkspace(workerId, { workspaceId: item.workspace_id, displayName: typeof item.display_name === "string" ? item.display_name : item.workspace_id, capabilities: Array.isArray(item.capabilities) ? item.capabilities : [], state: typeof item.state === "string" ? item.state : "UNKNOWN", configVersion: Number(item.config_version ?? 0) }, Date.now()); } }
      else if (type === "availability.update") this.workers.updateAvailability(workerId, record(message.availability ?? message), Date.now());
      else if (type === "config.applied") this.workers.recordSettingsApplied(workerId, Number(message.settings_version ?? 0), Number(message.preferences_version ?? 0), String(message.state ?? "UNKNOWN"), Date.now());
      else if (type === "task.accept") this.tasks.accept(taskId, attemptId, workerId);
      else if (type === "task.reject") { const reason = String(message.reason ?? "WORKER_REJECTED"); this.tasks.fail(taskId, attemptId, workerId, reason, "Worker rejected the task offer.", Date.now(), true); const task = this.tasks.db.one<JsonRecord>("SELECT task_type, payload_json FROM tasks WHERE id = ?", taskId); if (task?.task_type === "computer.use") { const payload = jsonValue(task.payload_json) as JsonRecord; const sessionId = typeof payload.session_id === "string" ? payload.session_id : ""; const sequence = Number(payload.sequence); if (sessionId && Number.isInteger(sequence)) this.tasks.db.run("UPDATE computer_operations SET state = 'FAILED', effect_state = 'UNKNOWN', receipt_json = ?, updated_at = ? WHERE session_id = ? AND sequence = ?", JSON.stringify({ code: reason, message: "Worker rejected the task offer." }), Date.now(), sessionId, sequence); } }
      else if (type === "task.started") this.tasks.started(taskId, attemptId, workerId);
      else if (type === "task.progress") this.tasks.progress(taskId, attemptId, workerId, record(message.progress));
      else if (type === "task.log") this.tasks.log(taskId, attemptId, workerId, record(message.log));
      else if (type === "task.artifact") this.storeArtifact(workerId, taskId, attemptId, record(message.artifact), connection.socket);
      else if (type === "task.result") { const result = record(message.result); this.tasks.result(taskId, attemptId, workerId, result, record(message.metrics), Date.now(), record(message.result_manifest ?? message.resultManifest), message.fence_epoch === undefined ? undefined : Number(message.fence_epoch)); const task = this.tasks.db.one<JsonRecord>("SELECT task_type, payload_json FROM tasks WHERE id = ?", taskId); if (task?.task_type === "computer.use") { const payload = jsonValue(task.payload_json) as JsonRecord; const sessionId = typeof payload.session_id === "string" ? payload.session_id : ""; const sequence = Number(payload.sequence); if (sessionId && Number.isInteger(sequence)) this.tasks.db.run("UPDATE computer_operations SET state = 'COMPLETED', effect_state = ?, receipt_json = ?, observation_id = COALESCE(observation_id, (SELECT id FROM computer_observations WHERE session_id = ? AND sequence = ?)), updated_at = ? WHERE session_id = ? AND sequence = ?", String(result.effect_state ?? "UNKNOWN"), JSON.stringify({ result, metrics: record(message.metrics), fenceEpoch: message.fence_epoch ?? null }), sessionId, sequence, Date.now(), sessionId, sequence); } connection.socket.send(JSON.stringify({ type: "task.result.ack", task_id: taskId, attempt_id: attemptId, fence_epoch: message.fence_epoch ?? null })); }
      else if (type === "task.failed") { this.tasks.fail(taskId, attemptId, workerId, String(message.code ?? "WORKER_EXECUTION_FAILED"), String(message.message ?? "Worker execution failed."), Date.now(), message.retryable === true); const task = this.tasks.db.one<JsonRecord>("SELECT task_type, payload_json FROM tasks WHERE id = ?", taskId); if (task?.task_type === "computer.use") { const payload = jsonValue(task.payload_json) as JsonRecord; const sessionId = typeof payload.session_id === "string" ? payload.session_id : ""; const sequence = Number(payload.sequence); if (sessionId && Number.isInteger(sequence)) this.tasks.db.run("UPDATE computer_operations SET state = 'FAILED', effect_state = CASE WHEN effect_state = 'NONE_CONFIRMED' THEN effect_state ELSE 'UNKNOWN' END, receipt_json = ?, updated_at = ? WHERE session_id = ? AND sequence = ?", JSON.stringify({ code: message.code ?? "WORKER_EXECUTION_FAILED", message: message.message ?? null }), Date.now(), sessionId, sequence); } }
      else if (type === "task.stop.receipt") this.recordStopReceipt(taskId, attemptId, workerId, message);
      else if (type === "computer.session.stop.receipt") { const sessionId = String(message.session_id ?? ""); const stopState = message.stop_state === "CONFIRMED" ? "CONFIRMED" : "UNKNOWN"; if (sessionId && this.computers) this.computers.recordStopReceipt(sessionId, workerId, stopState, Date.now()); }
      else if (type === "task.cancelled") this.tasks.cancelled(taskId, attemptId, workerId);
    } catch (error) { connection.socket.send(JSON.stringify({ type: "error", code: error instanceof Error ? error.message : "INTERNAL_ERROR" })); }
  }

  private flushAssigned(workerId: string): void {
    const rows = this.tasks.db.all<JsonRecord>("SELECT t.id, t.current_attempt_id FROM tasks t JOIN task_attempts a ON a.id = t.current_attempt_id WHERE t.status = 'ASSIGNED' AND a.worker_id = ? AND a.status = 'OFFERED'", workerId);
    for (const row of rows) {
      const task = this.tasks.get(String(row.id));
      if (task) this.offer(workerId, task, String(row.current_attempt_id));
    }
  }

  private storeArtifact(workerId: string, taskId: string, attemptId: string, value: JsonRecord, socket: WebSocket): void {
    if (!this.artifacts) throw new Error("ARTIFACT_UNAVAILABLE");
    const row = this.tasks.db.one<JsonRecord>("SELECT t.status, t.current_attempt_id FROM tasks t JOIN task_attempts a ON a.id = t.current_attempt_id WHERE t.id = ? AND a.id = ? AND a.worker_id = ?", taskId, attemptId, workerId);
    if (!row || !["ASSIGNED", "RUNNING"].includes(String(row.status))) throw new Error("ARTIFACT_NOT_FOUND");
    const encoded = typeof value.data_base64 === "string" ? value.data_base64 : "";
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error("INVALID_ARTIFACT_ENCODING");
    const bytes = Buffer.from(encoded, "base64");
    const limit = Math.min(1_073_741_824, Math.max(1, Number(process.env.PAI_MAX_ARTIFACT_BYTES ?? 1_073_741_824)));
    if (bytes.byteLength > limit) throw new Error("REQUEST_TOO_LARGE");
    const mediaTypeRaw = String(value.media_type ?? value.mediaType ?? "application/octet-stream");
    const mediaType = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=._ -]+)*$/.test(mediaTypeRaw) ? mediaTypeRaw.slice(0, 160) : "application/octet-stream";
    const artifactKey = typeof value.artifact_key === "string" ? value.artifact_key.slice(0, 200) : null;
    if (artifactKey) { const prior = this.tasks.db.one<JsonRecord>("SELECT * FROM artifacts WHERE task_id = ? AND attempt_id = ? AND artifact_key = ?", taskId, attemptId, artifactKey); if (prior) { if (String(prior.sha256) !== ArtifactStorage.digest(bytes)) throw new Error("ARTIFACT_CONTENT_CONFLICT"); socket.send(JSON.stringify({ type: "task.artifact.ack", task_id: taskId, attempt_id: attemptId, artifact_id: prior.id, artifact_key: artifactKey, sha256: prior.sha256 })); return; } }
    const artifactTask = this.tasks.db.one<JsonRecord>("SELECT task_type, payload_json FROM tasks WHERE id = ?", taskId);
    if (artifactTask?.task_type === "computer.use" && artifactKey?.startsWith("computer-observation-")) {
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
      const payload = record(jsonValue(artifactTask.payload_json ?? "{}"));
      const sessionId = payload && typeof payload.session_id === "string" ? payload.session_id : "";
      const used = Number(this.tasks.db.one<JsonRecord>("SELECT COALESCE(SUM(a.size_bytes), 0) AS bytes FROM artifacts a JOIN computer_observations o ON o.artifact_id = a.id WHERE o.session_id = ?", sessionId)?.bytes ?? 0);
      if (sessionId && used + bytes.byteLength > 200 * 1024 * 1024) throw new Error("COMPUTER_OBSERVATION_LIMIT");
    }
    const displayFilename = String(value.filename ?? "artifact.bin").slice(0, 240); const stored = this.artifacts.write(taskId, displayFilename, mediaType, bytes);
    const previewKind = mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("markdown") || mediaType.includes("diff") ? "TEXT" : null;
    this.tasks.db.run("INSERT INTO artifacts(id, task_id, attempt_id, filename, media_type, size_bytes, sha256, storage_path, created_at, display_filename, artifact_key, preview_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", stored.id, taskId, attemptId, stored.filename, stored.mediaType, stored.sizeBytes, stored.sha256, stored.storagePath, Date.now(), displayFilename, artifactKey, previewKind);
    this.tasks.db.run("INSERT INTO task_artifacts(task_id, artifact_id, direction) VALUES (?, ?, 'OUTPUT')", taskId, stored.id);
    const task = this.tasks.db.one<JsonRecord>("SELECT task_type, payload_json FROM tasks WHERE id = ?", taskId);
    if (task?.task_type === "computer.use" && artifactKey?.startsWith("computer-observation-")) {
      const payload = jsonValue(task.payload_json) as JsonRecord;
      const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
      const sequence = Number(payload.sequence);
      if (sessionId && Number.isInteger(sequence) && sequence > 0) this.tasks.db.run("INSERT OR IGNORE INTO computer_observations(id, session_id, sequence, target_json, artifact_id, metadata_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", `obs-${stored.id}`, sessionId, sequence, JSON.stringify(payload.target ?? {}), stored.id, JSON.stringify({ operation: payload.operation ?? "observe", taskId }), Date.now() + 86_400_000, Date.now());
    }
    socket.send(JSON.stringify({ type: "task.artifact.ack", task_id: taskId, attempt_id: attemptId, artifact_id: stored.id, artifact_key: artifactKey, sha256: stored.sha256 }));
  }

  private recordStopReceipt(taskId: string, attemptId: string, workerId: string, message: JsonRecord): void {
    this.tasks.recordStopReceipt(taskId, attemptId, workerId, message, Date.now(), message.fence_epoch === undefined ? undefined : Number(message.fence_epoch));
  }
}
