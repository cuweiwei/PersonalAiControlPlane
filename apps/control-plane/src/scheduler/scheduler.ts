import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { TaskService } from "../tasks/task-service.ts";
import { WorkerCoordinator } from "../workers/worker-channel.ts";

type Row = Record<string, any>;
type Requirement = { capabilities?: string[]; workerId?: string | null; runtime?: string; model?: { name?: string; mode?: string }; resources?: { minRamMb?: number; gpuRequired?: boolean }; workspaceId?: string };
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
    const queued = this.db.all<Row>("SELECT * FROM tasks WHERE status = 'QUEUED' ORDER BY priority DESC, created_at ASC, id ASC");
    for (const task of queued) {
      const requirement = parse(task.execution_json) as Requirement;
      const candidates = this.eligible(task, requirement, now);
      if (candidates.length === 0) continue;
      const workerId = this.select(candidates, requirement);
      const assignment = this.tasks.assign(task.id, workerId, now);
      if (!assignment) continue;
      assigned += 1;
      this.coordinator.offer(workerId, assignment.task, assignment.attemptId);
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

  private eligible(task: Row, requirement: Requirement, now: number): Row[] {
    const workers = this.db.all<Row>("SELECT * FROM workers WHERE status = 'ONLINE' AND enabled = 1 AND drain = 0 AND removed_at IS NULL ORDER BY id");
    return workers.filter((worker) => {
      if (requirement.workerId && requirement.workerId !== worker.id) return false;
      if (!this.coordinator.isConnected(worker.id)) return false;
      const active = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND status IN ('OFFERED', 'ACCEPTED', 'RUNNING')", worker.id)?.count ?? 0);
      if (active >= Number(worker.max_concurrency ?? 1)) return false;
      const capabilities = this.db.all<Row>("SELECT * FROM worker_capabilities WHERE worker_id = ? AND status IN ('READY', 'HEALTHY', 'DEGRADED')", worker.id);
      const names = new Set(capabilities.map((item) => String(item.capability)));
      const requiredCapabilities = requirement.capabilities?.length ? requirement.capabilities : [task.task_type];
      if (!requiredCapabilities.every((name) => names.has(name))) return false;
      if (requirement.runtime && requirement.runtime !== "auto" && !capabilities.some((item) => item.runtime === requirement.runtime)) return false;
      const memory = parse(worker.memory_json); const total = Number(memory.totalMb ?? memory.total_mb ?? memory.total ?? 0); const free = Number(memory.freeMb ?? memory.free_mb ?? memory.free ?? total);
      if (Number(requirement.resources?.minRamMb ?? 0) > 0 && Math.max(free, total) < Number(requirement.resources?.minRamMb)) return false;
      if (requirement.resources?.gpuRequired && !parse(worker.gpu_json, null)) return false;
      if (requirement.workspaceId && !capabilities.some((item) => { const descriptor = parse(item.descriptor_json); const ids = descriptor.workspaceIds ?? descriptor.properties?.workspaceIds ?? []; return Array.isArray(ids) && ids.includes(requirement.workspaceId); })) return false;
      const model = requirement.model;
      if (model?.mode === "required" && model.name && !this.hasModel(worker.id, model.name, requirement.runtime)) return false;
      if (model?.mode === "any" && !this.db.one("SELECT id FROM worker_models WHERE worker_id = ? AND status = 'READY'", worker.id)) return false;
      return true;
    });
  }

  private hasModel(workerId: string, name: string, runtime?: string): boolean { return Boolean(this.db.one("SELECT id FROM worker_models WHERE worker_id = ? AND model_id = ? AND status = 'READY' AND (? = 'auto' OR ? IS NULL OR runtime = ?)", workerId, name, runtime ?? "auto", runtime ?? "auto", runtime ?? "auto")); }

  private select(candidates: Row[], requirement: Requirement): string {
    const scored = candidates.map((worker) => {
      const active = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND status IN ('OFFERED', 'ACCEPTED', 'RUNNING')", worker.id)?.count ?? 0);
      const model = requirement.model; const exact = model?.name && this.hasModel(worker.id, model.name, requirement.runtime) ? 100 : 0;
      const runtime = requirement.runtime && requirement.runtime !== "auto" && this.db.one("SELECT id FROM worker_capabilities WHERE worker_id = ? AND runtime = ?", worker.id, requirement.runtime) ? 30 : 0;
      const idle = active === 0 ? 30 : 0; const slots = Math.max(0, Number(worker.max_concurrency ?? 1) - active) * 10;
      const memory = parse(worker.memory_json); const headroom = Math.min(20, Math.max(0, Math.floor(Number(memory.freeMb ?? memory.free_mb ?? 0) / 1024)));
      return { id: String(worker.id), score: exact + runtime + idle + slots + headroom, lastAssigned: Number(worker.last_assigned_at ?? 0) };
    });
    scored.sort((left, right) => right.score - left.score || left.lastAssigned - right.lastAssigned || left.id.localeCompare(right.id));
    this.events.publish({ type: "scheduler.selected", workerId: scored[0].id });
    return scored[0].id;
  }
}
