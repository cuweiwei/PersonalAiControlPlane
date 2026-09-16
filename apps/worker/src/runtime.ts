import { randomUUID } from "node:crypto";
import { canonicalJson, sha256, type JsonValue } from "../../../packages/contracts/src/index.ts";
import { WorkerLocalDatabase } from "./local-db.ts";

export type MissionWorkerContext = { authority_epoch: string; mission_id: string; mission_run_id: string; plan_revision: number; step_id: string; execution_generation: number; operation_key: string; retry_safety: string; scope_hash: string | null; workspace_access: "NONE" | "READ" | "WRITE_EXCLUSIVE" };
export type WorkerTaskOffer = { task_id: string; run_id?: string | null; run_number?: number | null; attempt_id: string; attempt_number?: number | null; attempt_in_run?: number | null; fence_epoch?: number; worker_boot_id?: string | null; workspace_id?: string | null; task_type: string; purpose?: string; title?: string; instruction: string; context?: Record<string, JsonValue>; payload?: Record<string, JsonValue>; execution?: Record<string, JsonValue>; limits?: Record<string, JsonValue>; input_artifact_ids?: string[]; mission_context?: MissionWorkerContext };
export type ExecutionEvent = { type: "progress" | "log" | "result" | "artifact"; progress?: Record<string, JsonValue>; log?: Record<string, JsonValue>; result?: Record<string, JsonValue>; metrics?: Record<string, JsonValue>; result_manifest?: Record<string, JsonValue>; resultManifest?: Record<string, JsonValue>; artifact?: Record<string, JsonValue> };
export type WorkerExecutor = { type: string; discover?(): Promise<{ capabilities?: Record<string, JsonValue>[]; models?: Record<string, JsonValue>[] }>; canExecute(task: WorkerTaskOffer): boolean; execute(task: WorkerTaskOffer, context: { emit(event: ExecutionEvent): Promise<void>; signal?: AbortSignal }): AsyncIterable<ExecutionEvent>; cancel?(attemptId: string): Promise<void>; controlSession?(sessionId: string, action: string): Promise<void>; close?(): void | Promise<void> };
export type WorkerTransport = { connect?(onMessage: (message: Record<string, any>) => void, onClose?: (error: Error) => void): Promise<void>; send(message: Record<string, any>): Promise<void> | void; close?(): void; connected?(): boolean; poll?(): Promise<WorkerTaskOffer[]> };
export type WorkerRuntimeOptions = { workerId: string; db: WorkerLocalDatabase; transport: WorkerTransport; executors: WorkerExecutor[]; workspaces?: Record<string, { name: string; path: string }>; clock?: () => number; report?: () => Record<string, JsonValue> };

type RunningExecution = { executor: WorkerExecutor; controller: AbortController; workspaceResourceKey?: string };
type HelloWaiter = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function workerError(error: unknown, fallback = "WORKER_TRANSPORT_FAILED"): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export class OutboundWorkerRuntime {
  readonly workerId: string;
  readonly db: WorkerLocalDatabase;
  private readonly transport: WorkerTransport;
  private readonly executors: WorkerExecutor[];
  private readonly clock: () => number;
  private readonly report?: () => Record<string, JsonValue>;
  private readonly workspaces: Record<string, { name: string; path: string }>;
  private readonly running = new Map<string, RunningExecution>();
  private readonly workspaceLocks = new Map<string, string>();
  private readonly workerBootId: string;
  private readonly desktopEpoch: number;
  private readonly negotiatedFeatures = new Set<string>();
  private transportError?: Error;
  private helloWaiter?: HelloWaiter;

  constructor(options: WorkerRuntimeOptions) { this.workerId = options.workerId; this.db = options.db; this.transport = options.transport; this.executors = options.executors; this.workspaces = options.workspaces ?? {}; this.clock = options.clock ?? Date.now; this.report = options.report; this.workerBootId = `${this.workerId}:${this.clock()}`; const stored = (this.db.connection.prepare("SELECT value FROM worker_state WHERE key = 'computer_desktop_epoch'").get() as { value?: string } | undefined)?.value; let previous = 0; let processId = ""; try { const parsed = JSON.parse(String(stored ?? "{}")) as { epoch?: unknown; process_id?: unknown }; previous = Number(parsed.epoch ?? 0); processId = typeof parsed.process_id === "string" ? parsed.process_id : ""; } catch { previous = Number(stored ?? 0); } this.desktopEpoch = Number.isSafeInteger(previous) && previous > 0 ? (processId === RUNTIME_PROCESS_ID ? previous : Math.min(previous + 1, 2_147_483_647)) : 1; this.db.connection.prepare("INSERT INTO worker_state(key, value) VALUES ('computer_desktop_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ epoch: this.desktopEpoch, process_id: RUNTIME_PROCESS_ID })); }
  async connect(): Promise<void> {
    this.transportError = undefined;
    if (this.transport.connect) {
      await this.transport.connect(
        (message) => { void this.handleMessage(message).catch((error) => this.setTransportError(error)); },
        (error) => this.setTransportError(error),
      );
      const hello = this.prepareHelloWaiter();
      await this.sendHello();
      await hello;
    }
    this.ensureTransportHealthy();
    await this.refreshInventory();
    await this.resendPending();
  }
  async pollOnce(): Promise<number> {
    this.ensureTransportHealthy();
    if (this.transport.poll) { const offers = await this.transport.poll(); for (const offer of offers) await this.handleOffer(offer); return offers.length; }
    if (this.transport.connected && !this.transport.connected()) throw new Error("WORKER_DISCONNECTED");
    await this.resendPending();
    return 0;
  }
  async heartbeat(): Promise<void> { await this.transport.send({ type: "heartbeat", worker_id: this.workerId, timestamp: new Date(this.clock()).toISOString(), ...(this.report?.() ?? {}) }); }
  async refreshInventory(): Promise<void> { this.ensureTransportHealthy(); await this.discover(); }
  async handleOffer(offer: WorkerTaskOffer): Promise<void> {
    const existing = this.db.connection.prepare("SELECT * FROM assignments WHERE attempt_id = ?").get(offer.attempt_id) as Record<string, any> | undefined;
    if (existing) { if (existing.status === "COMPLETED") await this.resendResult(offer.attempt_id); return; }
    const missionError = this.validateMissionOffer(offer);
    if (missionError) { await this.transport.send({ type: "task.reject", task_id: offer.task_id, attempt_id: offer.attempt_id, reason: missionError }); return; }
    if (offer.task_type === "computer.use") {
      const sessionId = String(offer.payload?.session_id ?? "");
      const localState = sessionId ? String((this.db.connection.prepare("SELECT value FROM worker_state WHERE key = ?").get(`computer_session:${sessionId}`) as { value?: string } | undefined)?.value ?? "") : "";
      if (["PAUSE", "CLOSE", "REVOKE"].includes(localState)) { await this.transport.send({ type: "task.reject", task_id: offer.task_id, attempt_id: offer.attempt_id, reason: "SESSION_CONTROLLED" }); return; }
      const lease = sessionId ? (() => { try { return JSON.parse(String((this.db.connection.prepare("SELECT value FROM worker_state WHERE key = ?").get(`computer_lease:${sessionId}`) as { value?: string } | undefined)?.value ?? "{}")) as Record<string, any>; } catch { return {}; } })() : {};
      if (!sessionId || Number(lease.received_at ?? 0) < this.clock() - 15_000 || Number(lease.revision ?? 0) !== Number(offer.payload?.session_revision ?? 0) || Number(lease.desktop_epoch ?? 0) !== Number(offer.payload?.desktop_epoch ?? 0)) { await this.transport.send({ type: "task.reject", task_id: offer.task_id, attempt_id: offer.attempt_id, reason: "SESSION_LEASE_EXPIRED" }); return; }
    }
    const targetRuntime = typeof offer.execution?.runtime === "string" ? offer.execution.runtime : undefined;
    const executor = this.executors.find((candidate) => candidate.canExecute(offer) && (!targetRuntime || targetRuntime === "auto" || candidate.type === targetRuntime || candidate.type === offer.task_type));
    const workspaceResourceKey = String(offer.workspace_id ?? offer.execution?.workspace_id ?? offer.execution?.workspaceId ?? "").trim() || undefined;
    if (workspaceResourceKey && this.workspaceLocks.has(workspaceResourceKey)) { await this.transport.send({ type: "task.reject", task_id: offer.task_id, attempt_id: offer.attempt_id, reason: "WORKSPACE_CONFLICT" }); return; }
    this.db.transaction(() => this.db.connection.prepare("INSERT INTO assignments(attempt_id, task_id, task_type, offer_json, fence_epoch, worker_boot_id, workspace_id, lease_expires_at, status, accepted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, ?)").run(offer.attempt_id, offer.task_id, offer.task_type, JSON.stringify(offer), Number(offer.fence_epoch ?? 1), offer.worker_boot_id ?? this.workerBootId, workspaceResourceKey ?? null, offer.limits?.remaining_seconds ? this.clock() + Number(offer.limits.remaining_seconds) * 1000 : null, this.clock(), this.clock()));
    await this.transport.send({ type: "task.accept", task_id: offer.task_id, attempt_id: offer.attempt_id, fence_epoch: offer.fence_epoch ?? 1, worker_boot_id: offer.worker_boot_id ?? this.workerBootId });
    if (!executor) { await this.fail(offer, "EXECUTOR_UNAVAILABLE", "No enabled executor can handle this task type.", true); return; }
    const controller = new AbortController();
    if (workspaceResourceKey) this.workspaceLocks.set(workspaceResourceKey, offer.attempt_id);
    this.running.set(offer.attempt_id, { executor, controller, workspaceResourceKey });
    this.db.connection.prepare("UPDATE assignments SET status = 'RUNNING', updated_at = ? WHERE attempt_id = ? AND status = 'ACCEPTED'").run(this.clock(), offer.attempt_id);
    if (this.isCancelled(offer.attempt_id)) { controller.abort(); this.releaseWorkspace(workspaceResourceKey, offer.attempt_id); this.running.delete(offer.attempt_id); return; }
    this.db.connection.prepare("INSERT INTO process_registry(attempt_id, pid, process_identity, started_at, workspace_resource_key, state, updated_at) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?) ON CONFLICT(attempt_id) DO UPDATE SET process_identity = excluded.process_identity, state = 'RUNNING', updated_at = excluded.updated_at").run(offer.attempt_id, null, `${this.workerId}:${offer.attempt_id}`, this.clock(), workspaceResourceKey ?? null, this.clock());
    if (offer.task_type === "computer.use") {
      try { this.prepareComputerOperation(offer); } catch (error) { const code = error instanceof Error ? error.message : "INVALID_COMPUTER_OPERATION"; await this.fail(offer, code, "Computer operation journal rejected the attempt.", false); this.releaseWorkspace(workspaceResourceKey, offer.attempt_id); this.running.delete(offer.attempt_id); return; }
    }
    await this.transport.send({ type: "task.started", task_id: offer.task_id, attempt_id: offer.attempt_id, fence_epoch: offer.fence_epoch ?? 1 });
    try {
      for await (const event of executor.execute(offer, { emit: (item) => this.emit(offer, item), signal: controller.signal })) {
        if (this.isCancelled(offer.attempt_id)) break;
        await this.emit(offer, event);
        if (event.type === "result" && !this.isCancelled(offer.attempt_id)) await this.complete(offer, event.result ?? {}, event.metrics ?? {}, event.result_manifest ?? event.resultManifest);
      }
      const state = this.db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get(offer.attempt_id) as { status: string } | undefined;
      if (state?.status === "RUNNING") await this.complete(offer, {}, {});
    } catch (error) { const code = error instanceof Error ? error.message : "EXECUTION_FAILED"; await this.fail(offer, code, "Worker executor failed.", isInfrastructureFailure(code)); }
    finally { this.db.connection.prepare("UPDATE process_registry SET state = CASE WHEN state = 'RUNNING' THEN 'FINISHED' ELSE state END, updated_at = ? WHERE attempt_id = ?").run(this.clock(), offer.attempt_id); this.releaseWorkspace(workspaceResourceKey, offer.attempt_id); this.running.delete(offer.attempt_id); }
  }

  async handleCancel(message: { task_id: string; attempt_id: string }): Promise<void> {
    const running = this.running.get(message.attempt_id);
    running?.controller.abort();
    try { await running?.executor.cancel?.(message.attempt_id); } catch { /* cancellation is best effort; the DB fence is authoritative */ }
    finally {
      this.db.connection.prepare("UPDATE assignments SET status = 'CANCELLED', updated_at = ? WHERE attempt_id = ? AND status IN ('ACCEPTED', 'RUNNING')").run(this.clock(), message.attempt_id);
      const stored = this.db.connection.prepare("SELECT offer_json FROM assignments WHERE attempt_id = ?").get(message.attempt_id) as { offer_json?: string } | undefined;
      const offer = stored?.offer_json ? JSON.parse(stored.offer_json) as WorkerTaskOffer : undefined;
      this.db.connection.prepare("UPDATE process_registry SET state = 'UNKNOWN', updated_at = ? WHERE attempt_id = ? AND state = 'RUNNING'").run(this.clock(), message.attempt_id);
      await this.transport.send({ type: "task.stop.receipt", task_id: message.task_id, attempt_id: message.attempt_id, fence_epoch: offer?.fence_epoch ?? 1, ...(offer?.mission_context ? { mission_context: offer.mission_context } : {}), stop_state: "UNKNOWN", effect_state: "UNKNOWN", evidence: { observed_at: new Date(this.clock()).toISOString(), process_identity: null, children_accounted_for: false, reason: "executor_cancel_is_not_physical_stop_proof" } });
      await this.transport.send({ type: "task.cancelled", task_id: message.task_id, attempt_id: message.attempt_id, fence_epoch: offer?.fence_epoch ?? 1 });
    }
  }
  close(): void { for (const executor of this.executors) { try { void executor.close?.(); } catch { /* executor cleanup is best effort during shutdown */ } } this.transport.close?.(); }

  private async handleMessage(message: Record<string, any>): Promise<void> {
    if (message.type === "hello.ack") { this.negotiatedFeatures.clear(); for (const feature of Array.isArray(message.features) ? message.features : []) if (typeof feature === "string") this.negotiatedFeatures.add(feature); this.helloWaiter?.resolve(); return; }
    if (message.type === "error") { const error = new Error(String(message.code ?? "WORKER_REMOTE_ERROR")); this.helloWaiter?.reject(error); this.setTransportError(error); return; }
    if (message.type === "task.offer") await this.handleOffer(message as WorkerTaskOffer);
    else if (message.type === "task.cancel") await this.handleCancel(message as { task_id: string; attempt_id: string });
    else if (message.type === "computer.session.control") await this.handleComputerSessionControl(String(message.session_id ?? ""), String(message.action ?? ""));
    else if (message.type === "computer.session.lease") this.handleComputerSessionLease(message);
    else if (message.type === "config.apply") await this.applyConfig(message);
    else if (message.type === "task.result.ack") this.db.connection.prepare("UPDATE results SET status = 'DELIVERED', delivered_at = ? WHERE attempt_id = ?").run(this.clock(), message.attempt_id);
  }
  private async sendHello(): Promise<void> { await this.transport.send({ type: "hello", protocol_version: 2, worker_id: this.workerId, worker_boot_id: this.workerBootId, agent_version: "2.0.0", features: ["resolved_execution_v1", "task_run_v1", "workspace_inventory_v1", "settings_apply_v1", "availability_v1", "result_manifest_v1", "artifact_ack_v1", "mission_execution_v1", "stop_evidence_v1", "workspace_exclusion_v1", "attempt_fencing_v1", "durable_result_ack_v1", "workspace_lock_v1", "computer_session_v1"] }); }
  private async applyConfig(message: Record<string, any>): Promise<void> {
    const settingsVersion = Number(message.settings_version ?? 0); const preferencesVersion = Number(message.preferences_version ?? 0); const config = message.config;
    if (!Number.isInteger(settingsVersion) || settingsVersion < 0 || !config || typeof config !== "object" || Array.isArray(config)) { await this.transport.send({ type: "config.applied", worker_id: this.workerId, settings_version: settingsVersion, preferences_version: preferencesVersion, state: "FAILED", error_code: "INVALID_CONFIG" }); return; }
    try {
      this.db.transaction(() => {
        const current = this.db.connection.prepare("SELECT value FROM worker_state WHERE key = 'settings_snapshot'").get() as { value?: string } | undefined;
        const currentVersion = Number(current?.value ? JSON.parse(current.value).settings_version ?? 0 : 0);
        if (settingsVersion >= currentVersion) this.db.connection.prepare("INSERT INTO worker_state(key, value) VALUES ('settings_snapshot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ settings_version: settingsVersion, preferences_version: preferencesVersion, config }));
      });
      await this.transport.send({ type: "config.applied", worker_id: this.workerId, settings_version: settingsVersion, preferences_version: preferencesVersion, state: "APPLIED" });
    } catch { await this.transport.send({ type: "config.applied", worker_id: this.workerId, settings_version: settingsVersion, preferences_version: preferencesVersion, state: "FAILED", error_code: "CONFIG_SAVE_FAILED" }); }
  }
  private prepareHelloWaiter(): Promise<void> {
    let resolveWaiter!: () => void;
    let rejectWaiter!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { resolveWaiter = resolve; rejectWaiter = reject; });
    this.helloWaiter = { promise, resolve: resolveWaiter, reject: rejectWaiter };
    const timer = setTimeout(() => rejectWaiter(new Error("WORKER_HELLO_TIMEOUT")), 10_000);
    void promise.then(() => { clearTimeout(timer); if (this.helloWaiter?.promise === promise) this.helloWaiter = undefined; }, () => { clearTimeout(timer); if (this.helloWaiter?.promise === promise) this.helloWaiter = undefined; });
    return promise;
  }
  private async discover(): Promise<void> {
    const capabilities: Record<string, JsonValue>[] = [];
    const models: Record<string, JsonValue>[] = [];
    const observedAt = this.clock();
    for (const executor of this.executors) { const found = await executor.discover?.(); if (found?.capabilities) capabilities.push(...found.capabilities.map((item) => ({ ...item, ...(item.capability === "computer.use" ? { desktop_epoch: this.desktopEpoch, desktop_kind: "desktop", display_id: "primary" } : {}), contract_version: Number(item.contract_version ?? item.contractVersion ?? 2), evidence_state: item.evidence_state ?? item.evidenceState ?? (item.capability === "computer.use" ? "ADVERTISED" : "VERIFIED"), verification_expires_at: (item.evidence_state ?? item.evidenceState) === "VERIFIED" || item.capability !== "computer.use" ? observedAt + 30_000 : null, verification_ref: (item.evidence_state ?? item.evidenceState) === "VERIFIED" || item.capability !== "computer.use" ? `worker:${this.workerId}:${observedAt}` : null }))); if (found?.models) models.push(...found.models); }
    await this.transport.send({ type: "capabilities.update", worker_id: this.workerId, capabilities });
    if (Object.keys(this.workspaces).length > 0) await this.transport.send({ type: "inventory.update", worker_id: this.workerId, capabilities, models, workspaces: Object.entries(this.workspaces).map(([workspace_id, value]) => ({ workspace_id, display_name: value.name, state: "READY", capabilities: ["codex", "python"], config_version: 1 })) });
    await this.transport.send({ type: "models.update", worker_id: this.workerId, models });
  }
  private async emit(offer: WorkerTaskOffer, event: ExecutionEvent): Promise<void> { if (this.isCancelled(offer.attempt_id)) return; const mission = offer.mission_context ? { mission_context: offer.mission_context } : {}; const fence = { fence_epoch: offer.fence_epoch ?? 1 }; if (event.type === "progress") await this.transport.send({ type: "task.progress", task_id: offer.task_id, attempt_id: offer.attempt_id, ...fence, ...mission, progress: event.progress ?? {} }); else if (event.type === "log") await this.transport.send({ type: "task.log", task_id: offer.task_id, attempt_id: offer.attempt_id, ...fence, ...mission, log: event.log ?? {} }); else if (event.type === "artifact") await this.transport.send({ type: "task.artifact", task_id: offer.task_id, attempt_id: offer.attempt_id, ...fence, ...mission, artifact: event.artifact ?? {} }); }
  private async complete(offer: WorkerTaskOffer, result: Record<string, JsonValue>, metrics: Record<string, JsonValue>, resultManifest?: Record<string, JsonValue>): Promise<void> {
    const receiptResult = offer.task_type === "computer.use" ? {
      ...result,
      task_id: offer.task_id,
      attempt_id: offer.attempt_id,
      run_id: offer.run_id ?? null,
      session_id: offer.payload?.session_id ?? null,
      sequence: Number(offer.payload?.sequence ?? result.sequence ?? 0),
      request_hash: sha256(canonicalJson({ sessionId: offer.payload?.session_id ?? null, sequence: Number(offer.payload?.sequence ?? 0), operation: offer.payload?.operation ?? null, target: offer.payload?.target ?? null, arguments: offer.payload?.arguments ?? null, observationId: offer.payload?.observation_id ?? offer.payload?.observationId ?? null })),
      desktop_epoch: Number(offer.payload?.desktop_epoch ?? result.desktop_epoch ?? 0),
      finished_at: new Date(this.clock()).toISOString(),
      effect_state: result.effect_state ?? "UNKNOWN",
    } : result;
    const payload = { result: receiptResult, metrics, resultManifest: resultManifest ?? defaultResultManifest(offer, receiptResult, metrics) };
    const completed = this.db.transaction(() => {
      const state = this.db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get(offer.attempt_id) as { status?: string } | undefined;
      if (state?.status !== "RUNNING") return false;
      this.db.connection.prepare("INSERT INTO results(attempt_id, task_id, result_json, status, created_at) VALUES (?, ?, ?, 'PENDING', ?) ON CONFLICT(attempt_id) DO UPDATE SET result_json = excluded.result_json, status = 'PENDING'").run(offer.attempt_id, offer.task_id, JSON.stringify(payload), this.clock());
      this.db.connection.prepare("UPDATE assignments SET status = 'COMPLETED', updated_at = ? WHERE attempt_id = ? AND status = 'RUNNING'").run(this.clock(), offer.attempt_id);
      return true;
    });
    if (completed) {
      if (offer.task_type === "computer.use") this.db.connection.prepare("UPDATE computer_operations SET state = 'COMPLETED', effect_state = ?, receipt_json = ?, updated_at = ? WHERE attempt_id = ?").run(String(receiptResult.effect_state ?? "UNKNOWN"), JSON.stringify(receiptResult), this.clock(), offer.attempt_id);
      await this.resendResult(offer.attempt_id);
    }
  }
  private async resendResult(attemptId: string): Promise<void> { const row = this.db.connection.prepare("SELECT * FROM results WHERE attempt_id = ? AND status = 'PENDING'").get(attemptId) as Record<string, any> | undefined; if (!row) return; const offer = this.db.connection.prepare("SELECT * FROM assignments WHERE attempt_id = ?").get(attemptId) as Record<string, any> | undefined; if (!offer) return; const parsed = JSON.parse(row.result_json); const task = JSON.parse(offer.offer_json) as WorkerTaskOffer; await this.transport.send({ type: "task.result", task_id: task.task_id, attempt_id: attemptId, fence_epoch: Number(offer.fence_epoch ?? task.fence_epoch ?? 1), ...(task.mission_context ? { mission_context: task.mission_context } : {}), result: parsed.result, metrics: parsed.metrics, result_manifest: parsed.resultManifest }); }
  private async resendPending(): Promise<void> { const rows = this.db.connection.prepare("SELECT attempt_id FROM results WHERE status = 'PENDING' ORDER BY created_at").all() as Array<{ attempt_id: string }>; for (const row of rows) await this.resendResult(row.attempt_id); }
  private async fail(offer: WorkerTaskOffer, code: string, message: string, retryable: boolean): Promise<void> {
    const failed = this.db.connection.prepare("UPDATE assignments SET status = 'FAILED', updated_at = ? WHERE attempt_id = ? AND status IN ('ACCEPTED', 'RUNNING')").run(this.clock(), offer.attempt_id);
    if (Number(failed.changes) > 0) { if (offer.task_type === "computer.use") this.db.connection.prepare("UPDATE computer_operations SET state = 'FAILED', effect_state = CASE WHEN effect_state = 'NONE_CONFIRMED' THEN effect_state ELSE 'UNKNOWN' END, updated_at = ? WHERE attempt_id = ?").run(this.clock(), offer.attempt_id); await this.transport.send({ type: "task.failed", task_id: offer.task_id, attempt_id: offer.attempt_id, fence_epoch: offer.fence_epoch ?? 1, code, message, retryable }); }
  }
  private isCancelled(attemptId: string): boolean { return (this.db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get(attemptId) as { status?: string } | undefined)?.status === "CANCELLED"; }
  private setTransportError(error: unknown): void { this.transportError ??= workerError(error); this.helloWaiter?.reject(this.transportError); }
  private ensureTransportHealthy(): void { if (this.transportError) throw this.transportError; }
  private validateMissionOffer(offer: WorkerTaskOffer): string | undefined {
    if (offer.purpose !== "MISSION") return undefined;
    const context = offer.mission_context;
    if (!context || !context.authority_epoch || !context.mission_id || !context.mission_run_id || !context.step_id || !context.operation_key || !Number.isInteger(context.plan_revision) || !Number.isInteger(context.execution_generation)) return "INVALID_MISSION_CONTEXT";
    if (context.workspace_access === "WRITE_EXCLUSIVE" && !String(offer.execution?.workspace_id ?? offer.execution?.workspaceId ?? "")) return "WORKSPACE_MISSING";
    if (this.transport.connect && ["mission_execution_v1", "stop_evidence_v1", "workspace_exclusion_v1"].some((feature) => !this.negotiatedFeatures.has(feature))) return "WORKER_UPDATE_REQUIRED";
    return undefined;
  }
  private releaseWorkspace(resourceKey: string | undefined, attemptId: string): void { if (resourceKey && this.workspaceLocks.get(resourceKey) === attemptId) this.workspaceLocks.delete(resourceKey); }
  private prepareComputerOperation(offer: WorkerTaskOffer): void {
    const payload = offer.payload ?? {};
    const session = payload.session && typeof payload.session === "object" ? payload.session as Record<string, any> : {};
    const sessionId = String(payload.session_id ?? ""); const sequence = Number(payload.sequence); const operation = String(payload.operation ?? "");
    if (!sessionId || !Number.isInteger(sequence) || sequence < 1) throw new Error("INVALID_COMPUTER_OPERATION");
    const requestHash = sha256(canonicalJson({ sessionId, sequence, operation, target: payload.target ?? null, arguments: payload.arguments ?? null }));
    const now = this.clock();
    this.db.transaction(() => {
      const prior = this.db.connection.prepare("SELECT request_hash, state FROM computer_operations WHERE session_id = ? AND sequence = ?").get(sessionId, sequence) as { request_hash?: string; state?: string } | undefined;
      if (prior && prior.request_hash !== requestHash) throw new Error("OPERATION_SEQUENCE_CONFLICT");
      if (prior) throw new Error("OPERATION_ALREADY_EXISTS");
      this.db.connection.prepare("INSERT INTO computer_operations(operation_id, session_id, sequence, attempt_id, operation, request_hash, state, effect_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'INVOKING', ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET state = 'INVOKING', updated_at = excluded.updated_at").run(`${sessionId}:${sequence}`, sessionId, sequence, offer.attempt_id, operation, requestHash, READ_ONLY_OPERATIONS.has(operation) ? "NONE_CONFIRMED" : "UNKNOWN", now, now);
    });
    // Keep the authorization snapshot immutable for this attempt. The executor
    // validates it again immediately before invoking the driver.
    void session;
  }
  private async handleComputerSessionControl(sessionId: string, action: string): Promise<void> {
    if (!sessionId || !["pause", "resume", "close", "revoke"].includes(action)) return;
    this.db.connection.prepare("INSERT INTO worker_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`computer_session:${sessionId}`, action.toUpperCase());
    if (["close", "revoke"].includes(action)) {
      let stopState: "CONFIRMED" | "UNKNOWN" = "CONFIRMED";
      for (const executor of this.executors) { try { await executor.controlSession?.(sessionId, action); } catch { stopState = "UNKNOWN"; /* stop evidence remains unknown until CP reconciliation */ } }
      await this.transport.send({ type: "computer.session.stop.receipt", worker_id: this.workerId, session_id: sessionId, action, stop_state: stopState, timestamp: new Date(this.clock()).toISOString() });
    }
    if (["pause", "close", "revoke"].includes(action)) {
      const rows = this.db.connection.prepare("SELECT attempt_id, task_id, offer_json FROM assignments WHERE status IN ('ACCEPTED','RUNNING')").all() as Array<{ attempt_id: string; task_id: string; offer_json: string }>;
      for (const row of rows) { try { const offer = JSON.parse(row.offer_json) as WorkerTaskOffer; if (String(offer.payload?.session_id ?? "") === sessionId) await this.handleCancel({ task_id: row.task_id, attempt_id: row.attempt_id }); } catch { /* preserve the durable assignment for reconciliation */ } }
    }
  }
  private handleComputerSessionLease(message: Record<string, any>): void {
    const sessionId = String(message.session_id ?? ""); const revision = Number(message.revision); const desktopEpoch = Number(message.desktop_epoch);
    if (!sessionId || !Number.isInteger(revision) || revision < 1 || !Number.isInteger(desktopEpoch) || desktopEpoch < 1) return;
    this.db.connection.prepare("INSERT INTO worker_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`computer_lease:${sessionId}`, JSON.stringify({ revision, desktop_epoch: desktopEpoch, received_at: this.clock() }));
  }
}

const READ_ONLY_OPERATIONS = new Set(["observe", "list_windows"]);
const RUNTIME_PROCESS_ID = randomUUID();

function isInfrastructureFailure(code: string): boolean {
  return code === "EXECUTOR_UNAVAILABLE" || code === "WORKER_DISCONNECTED" || code === "WORKER_TRANSPORT_FAILED" || code.endsWith("_TIMEOUT") || code.endsWith("_UNAVAILABLE") || /^\w+_HTTP_5\d\d$/.test(code) || code === "fetch failed";
}

function defaultResultManifest(offer: WorkerTaskOffer, result: Record<string, JsonValue>, metrics: Record<string, JsonValue>): Record<string, JsonValue> {
  const execution = offer.execution ?? {};
  const model = execution.model && typeof execution.model === "object" ? (execution.model as Record<string, JsonValue>) : {};
  const text = typeof result.text === "string" ? result.text : typeof result.stdout === "string" ? result.stdout : null;
  const kind = ({ "llm.inference": "TEXT", codex: "CODEX", python: "PYTHON", command: "COMMAND", "computer.use": "COMPUTER_USE", generic: "GENERIC" } as Record<string, string>)[offer.task_type] ?? "GENERIC";
  return {
    schema_version: 1,
    kind,
    summary: text ? text.slice(0, 240) : null,
    text,
    format: "plain",
    execution: { worker_id: offer.execution?.worker_id ?? null, runtime: execution.runtime ?? null, model_id: model.name ?? null, workspace_id: execution.workspace_id ?? execution.workspaceId ?? null },
    changes: { state: "NOT_PROVIDED", files: [], diff_artifact_id: null, attribution: "UNKNOWN" },
    validation: { state: "NOT_RUN", checks: [] },
    artifacts: [],
    metrics,
  };
}
