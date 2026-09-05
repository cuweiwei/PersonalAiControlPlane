import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { TaskService, safeHash } from "../tasks/task-service.ts";
import { WorkerCoordinator } from "../workers/worker-channel.ts";
import { uuidv7 } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;
type Requirement = { capabilities?: string[]; workerId?: string | null; runtime?: string; model?: { name?: string; mode?: string }; resources?: { minRamMb?: number; gpuRequired?: boolean }; workspaceId?: string; preferenceId?: string | null };
type Candidate = Row & { resolvedExecution: Record<string, unknown>; score: { exact: number; preferred: number; preference: number; loaded: number; active: number; headroom: number; lastAssigned: number } };
const READY_CAPABILITY = new Set(["READY", "HEALTHY"]);

function parse(value: unknown, fallback: unknown = {}): any { try { return JSON.parse(String(value ?? JSON.stringify(fallback))); } catch { return fallback; } }

export class ResourceScheduler {
  private readonly db: ControlPlaneDatabase;
  private readonly tasks: TaskService;
  private readonly workers: import("../workers/worker-service.ts").WorkerService;
  private readonly coordinator: WorkerCoordinator;
  private readonly events: EventHub;
  constructor(db: ControlPlaneDatabase, tasks: TaskService, workers: import("../workers/worker-service.ts").WorkerService, coordinator: WorkerCoordinator, events: EventHub) { this.db = db; this.tasks = tasks; this.workers = workers; this.coordinator = coordinator; this.events = events; }

  tick(now = Date.now()): number {
    let assigned = 0;
    const queued = this.db.all<Row>("SELECT t.* FROM tasks t LEFT JOIN task_dispatch_state d ON d.task_id = t.id WHERE t.status = 'QUEUED' AND (t.archived_at IS NULL OR t.archived_at = 0) AND (d.dispatch_not_before IS NULL OR d.dispatch_not_before <= ?) ORDER BY t.priority DESC, t.created_at ASC, t.id ASC", now);
    for (const task of queued) {
      const requirement = parse(task.execution_json) as Requirement;
      const candidates = this.evaluate(task, requirement, now);
      if (candidates.length === 0) continue;
      const selected = this.select(candidates, requirement);
      const assignment = this.tasks.assign(task.id, String(selected.id), now, selected.resolvedExecution);
      if (!assignment) continue;
      assigned += 1;
      this.clearDispatch(task.id);
      this.coordinator.offer(String(selected.id), assignment.task, assignment.attemptId);
    }
    return assigned;
  }

  staleSweep(now = Date.now(), offlineMs = 90_000): number {
    const stale = this.workers.stale(now, offlineMs);
    for (const workerId of stale) {
      const attempts = this.db.all<Row>("SELECT a.id, a.task_id, a.worker_id FROM task_attempts a JOIN tasks t ON t.current_attempt_id = a.id WHERE a.worker_id = ? AND t.status IN ('ASSIGNED', 'RUNNING')", workerId);
      for (const attempt of attempts) this.tasks.loseAttempt(attempt.task_id, attempt.id, attempt.worker_id, now);
    }
    return stale.length;
  }

  expireTasks(now = Date.now()): number { return this.tasks.expire(now); }

  evaluate(task: Row, requirement: Requirement, now = Date.now()): Candidate[] {
    const workers = this.db.all<Row>("SELECT * FROM workers WHERE removed_at IS NULL ORDER BY id");
    const candidates: Candidate[] = [];
    const reasons: Array<{ code: string; count: number; message: string }> = [];
    for (const worker of workers) {
      const failure = this.rejectionReason(worker, task, requirement, now);
      if (failure) { reasons.push(failure); continue; }
      const capabilities = this.db.all<Row>("SELECT * FROM worker_capabilities WHERE worker_id = ?", worker.id).filter((item) => READY_CAPABILITY.has(String(item.status)) && !["REVOKED", "REQUIRES_REVIEW"].includes(String(item.grant_status ?? "DISCOVERED")));
      const required = requirement.capabilities?.length ? requirement.capabilities : [task.task_type];
      const preference = requirement.preferenceId ? this.db.one<Row>("SELECT * FROM model_preferences WHERE id = ? AND deleted_at IS NULL", requirement.preferenceId) : undefined;
      const preferenceTargets = preference ? parse(preference.targets_json, []) as Array<Record<string, unknown>> : [];
      const capability = capabilities.find((item) => {
        if (!required.includes(String(item.capability)) || (requirement.runtime && requirement.runtime !== "auto" && String(item.runtime || "") !== requirement.runtime)) return false;
        if (task.task_type !== "llm.inference") return true;
        const runtime = requirement.runtime && requirement.runtime !== "auto" ? requirement.runtime : String(item.runtime || "");
        const models = this.db.all<Row>("SELECT model_id FROM worker_models WHERE worker_id = ? AND present = 1 AND status = 'READY' AND (? = '' OR runtime = ?)", worker.id, runtime, runtime);
        return this.chooseModel(models, requirement.model, worker.id, runtime, preference, preferenceTargets) !== undefined;
      });
      if (!capability) { const hasReadyCapability = capabilities.some((item) => required.includes(String(item.capability))); reasons.push({ code: task.task_type === "llm.inference" && hasReadyCapability ? "MODEL_UNAVAILABLE" : "CAPABILITY_UNAVAILABLE", count: 1, message: task.task_type === "llm.inference" && hasReadyCapability ? "目前沒有符合條件的可用模型" : "目前沒有符合能力的裝置" }); continue; }
      const runtime = requirement.runtime && requirement.runtime !== "auto" ? requirement.runtime : String(capability.runtime || "");
      const models = this.db.all<Row>("SELECT * FROM worker_models WHERE worker_id = ? AND present = 1 AND status = 'READY' AND (? = '' OR runtime = ?)", worker.id, runtime, runtime);
      const model = this.chooseModel(models, requirement.model, worker.id, runtime, preference, preferenceTargets);
      if (task.task_type === "llm.inference" && !model) { reasons.push({ code: requirement.model?.mode === "required" ? "MODEL_UNAVAILABLE" : "RUNTIME_UNAVAILABLE", count: 1, message: requirement.model?.mode === "required" ? "指定模型目前無法使用" : "沒有可用的模型" }); continue; }
      const workspaceId = requirement.workspaceId ?? null;
      if (workspaceId && !this.hasWorkspace(worker.id, workspaceId, capability)) { reasons.push({ code: "WORKSPACE_MISSING", count: 1, message: "此裝置找不到專案" }); continue; }
      const active = this.activeCount(worker.id);
      const memory = parse(worker.memory_json, {});
      const availableMemory = Number(memory.availableForTasksMb ?? memory.available_for_tasks_mb ?? memory.freeMb ?? memory.free_mb);
      const resolvedExecution = { workerId: worker.id, runtime: runtime || null, model: model ? { name: model.model_id, mode: "required" } : null, workspaceId };
      const preferenceIndex = preferenceTargets.findIndex((target) => target.worker_id === worker.id && target.runtime === runtime && target.model_id === model?.model_id);
      candidates.push({ ...worker, resolvedExecution, score: { exact: model && requirement.model?.name === model.model_id ? 1 : 0, preferred: model && requirement.model?.mode === "preferred" && requirement.model.name === model.model_id ? 1 : 0, preference: preferenceIndex >= 0 ? preferenceTargets.length - preferenceIndex : 0, loaded: model && parse(model.metadata_json, {}).loaded === true ? 1 : 0, active, headroom: Number.isFinite(availableMemory) ? availableMemory : 0, lastAssigned: Number(worker.last_assigned_at ?? 0) } });
    }
    this.updateDispatch(task, reasons, now, candidates);
    return candidates;
  }

  private rejectionReason(worker: Row, task: Row, requirement: Requirement, now: number): { code: string; count: number; message: string } | null {
    if (requirement.workerId && requirement.workerId !== worker.id) return { code: "WORKER_OFFLINE", count: 1, message: "指定裝置目前無法使用" };
    if (!worker.enabled || worker.status === "DISABLED") return { code: "WORKER_DISABLED", count: 1, message: "裝置已停用" };
    if (worker.drain) return { code: "PAUSED", count: 1, message: "裝置已停止接收新工作" };
    if (!this.coordinator.isConnected(String(worker.id)) || worker.status !== "ONLINE") return { code: "WORKER_OFFLINE", count: 1, message: "等待指定裝置重新連線" };
    const preferences = this.db.one<Row>("SELECT * FROM worker_preferences WHERE worker_id = ?", worker.id);
    const features = parse(worker.protocol_features_json, []);
    if (Array.isArray(features) && features.length > 0) {
      const requiredFeatures = new Set(["resolved_execution_v1", "task_run_v1"]);
      if (task.task_type === "codex") requiredFeatures.add("workspace_inventory_v1");
      if (preferences && (preferences.mode === "IDLE_ONLY" || preferences.pause_id || Number(preferences.pause_indefinite ?? 0) === 1)) { requiredFeatures.add("availability_v1"); requiredFeatures.add("settings_apply_v1"); }
      if ([...requiredFeatures].some((feature) => !features.includes(feature))) return { code: "WORKER_UPDATE_REQUIRED", count: 1, message: "Worker 需要更新才能執行此工作" };
    }
    if (preferences?.pause_id || Number(preferences?.pause_indefinite ?? 0) === 1 || (preferences?.pause_until && Number(preferences.pause_until) > now)) return { code: "PAUSED", count: 1, message: "裝置已暫停接收新工作" };
    if (String(preferences?.mode ?? "NORMAL") === "IDLE_ONLY") {
      const availability = parse(worker.availability_json, null);
      const idleThreshold = Math.max(60, Number(preferences?.idle_threshold_seconds ?? 600));
      const idleSeconds = Number(availability?.idle_seconds ?? availability?.idleSeconds);
      const observedAt = Number(availability?.observed_at ?? availability?.observedAt ?? 0);
      const fresh = observedAt > 0 && now - observedAt <= 30_000;
      if (!availability || availability.supported !== true || !fresh || now - observedAt > 15_000 || (availability.can_accept !== true && availability.canAccept !== true) || !Number.isFinite(idleSeconds) || idleSeconds < idleThreshold) return { code: "IDLE_REQUIRED", count: 1, message: "等待個人電腦閒置" };
    }
    if (this.activeCount(worker.id) >= Math.max(1, Number(worker.max_concurrency ?? 1))) return { code: "CAPACITY_BUSY", count: 1, message: "等待其他工作完成" };
    const requiredMemory = Number(requirement.resources?.minRamMb ?? 0);
    if (requiredMemory > 0) {
      const memory = parse(worker.memory_json, {});
      const available = Number(memory.availableForTasksMb ?? memory.available_for_tasks_mb ?? memory.freeMb ?? memory.free_mb);
      if (!Number.isFinite(available)) return { code: "RESOURCE_UNKNOWN", count: 1, message: "裝置尚未回報可用資源" };
      if (available < requiredMemory) return { code: "INSUFFICIENT_RESOURCES", count: 1, message: "候選裝置可用資源不足" };
    }
    if (requirement.resources?.gpuRequired && !parse(worker.gpu_json, null)) return { code: "INSUFFICIENT_RESOURCES", count: 1, message: "未取得 GPU 可用性證據" };
    return null;
  }

  private chooseModel(models: Row[], requirement?: { name?: string; mode?: string }, workerId?: string, runtime?: string, preference?: Row, targets: Array<Record<string, unknown>> = []): Row | undefined {
    if (!models.length) return undefined;
    if (requirement?.mode === "required") return models.find((model) => model.model_id === requirement.name);
    if (preference && workerId && runtime) {
      const candidates = targets.map((target, index) => ({ target, index })).filter(({ target }) => target.worker_id === workerId && target.runtime === runtime && models.some((model) => model.model_id === target.model_id));
      if (candidates.length === 0) return undefined;
      if (Number(preference.allow_fallback) === 0 && candidates[0].index !== 0) return undefined;
      const selected = candidates[0]; return models.find((model) => model.model_id === selected.target.model_id);
    }
    if (requirement?.mode === "preferred" && requirement.name) return models.find((model) => model.model_id === requirement.name) ?? models[0];
    return models[0];
  }

  private hasWorkspace(workerId: string, workspaceId: string, capability: Row): boolean {
    if (this.db.one("SELECT workspace_id FROM worker_workspaces WHERE worker_id = ? AND workspace_id = ? AND state = 'READY'", workerId, workspaceId)) return true;
    const descriptor = parse(capability.descriptor_json, {}); const ids = descriptor.workspaceIds ?? descriptor.properties?.workspaceIds;
    return Array.isArray(ids) && ids.includes(workspaceId);
  }

  private activeCount(workerId: string): number { return Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND occupancy IN ('RESERVED', 'RUNNING', 'RELEASING')", workerId)?.count ?? 0); }

  private select(candidates: Candidate[], requirement: Requirement): Candidate {
    const sorted = [...candidates].sort((left, right) => right.score.exact - left.score.exact || right.score.preferred - left.score.preferred || right.score.preference - left.score.preference || right.score.loaded - left.score.loaded || left.score.active - right.score.active || right.score.headroom - left.score.headroom || left.score.lastAssigned - right.score.lastAssigned || String(left.id).localeCompare(String(right.id)) || String(left.resolvedExecution.runtime).localeCompare(String(right.resolvedExecution.runtime)));
    this.events.publish({ type: "scheduler.selected", workerId: sorted[0].id, runtime: sorted[0].resolvedExecution.runtime, model: sorted[0].resolvedExecution.model });
    return sorted[0];
  }

  private updateDispatch(task: Row, failures: Array<{ code: string; count: number; message: string }>, now: number, candidates: Candidate[] = []): void {
    if (failures.length === 0) {
      if (candidates.length > 0) {
        if (this.db.one("SELECT task_id FROM task_dispatch_state WHERE task_id = ?", task.id)) this.db.run("DELETE FROM task_dispatch_state WHERE task_id = ?", task.id);
        return;
      }
      failures = [{ code: "NO_CANDIDATE", count: 1, message: "目前沒有符合條件的執行裝置" }];
    }
    const grouped = new Map<string, { code: string; count: number; message: string }>();
    for (const failure of failures) grouped.set(failure.code, { ...failure, count: (grouped.get(failure.code)?.count ?? 0) + failure.count });
    const reasons = [...grouped.values()]; const priority = ["WORKER_UPDATE_REQUIRED", "WORKER_DISABLED", "WORKER_OFFLINE", "WORKSPACE_MISSING", "CAPABILITY_UNAVAILABLE", "RUNTIME_UNAVAILABLE", "MODEL_UNAVAILABLE", "RESOURCE_UNKNOWN", "INSUFFICIENT_RESOURCES", "PAUSED", "IDLE_REQUIRED", "CAPACITY_BUSY", "NO_CANDIDATE"];
    reasons.sort((left, right) => priority.indexOf(left.code) - priority.indexOf(right.code));
    const primary = reasons[0]; const hash = safeHash({ primary: primary.code, reasons: reasons.map(({ code, count }) => ({ code, count })) });
    const previous = this.db.one<Row>("SELECT * FROM task_dispatch_state WHERE task_id = ?", task.id);
    const blockedSince = previous?.blocked_since ?? now;
    const candidateSummary = candidates.map((candidate) => ({ workerId: candidate.id, runtime: candidate.resolvedExecution.runtime, model: candidate.resolvedExecution.model, workspaceId: candidate.resolvedExecution.workspaceId }));
    this.db.run("INSERT INTO task_dispatch_state(task_id, run_id, primary_reason, reasons_json, candidates_json, reason_hash, blocked_since, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET run_id = excluded.run_id, primary_reason = excluded.primary_reason, reasons_json = excluded.reasons_json, candidates_json = excluded.candidates_json, reason_hash = excluded.reason_hash, blocked_since = excluded.blocked_since, evaluated_at = excluded.evaluated_at", task.id, task.current_run_id ?? null, primary.code, JSON.stringify(reasons), JSON.stringify(candidateSummary), hash, blockedSince, now);
    if (previous?.reason_hash !== hash) {
      this.db.run("INSERT INTO task_events(event_uuid, task_id, event_type, payload_json, created_at) VALUES (?, ?, 'TASK_DISPATCH_CHANGED', ?, ?)", uuidv7(now), task.id, JSON.stringify({ primaryReason: primary.code, reasons }), now);
      this.events.publish({ type: "task.updated", taskId: task.id, dispatchReason: primary.code });
    }
  }

  private clearDispatch(taskId: string): void { this.db.run("DELETE FROM task_dispatch_state WHERE task_id = ?", taskId); }
}
