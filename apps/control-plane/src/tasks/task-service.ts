import { createHash, randomBytes } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { canonicalJson, priorityNumber, sha256, uuidv7, type CreateTaskInput, type JsonValue, type TaskEventName, type TaskState } from "../../../../packages/contracts/src/index.ts";
import { assertTaskTransition, terminalTaskStates } from "./task-state-machine.ts";

type TaskRow = Record<string, any>;
type AttemptRow = Record<string, any>;

function parseJson(value: unknown, fallback: unknown = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }
function taskPublic(row: TaskRow, inputArtifactIds: string[] = []): Record<string, unknown> {
  const execution = parseJson(row.execution_json);
  return { id: row.id, source: row.source, correlationId: row.correlation_id, groupId: row.group_id, parentTaskId: row.parent_task_id, title: row.title, taskType: row.task_type, instruction: row.instruction, context: parseJson(row.context_json), payload: parseJson(row.payload_json), execution, inputArtifactIds, priority: row.priority >= 80 ? "high" : row.priority <= 20 ? "low" : "normal", status: row.status, currentAttemptId: row.current_attempt_id, timeoutSeconds: row.timeout_seconds, maxAttempts: row.max_attempts, attemptCount: row.attempt_count, result: parseJson(row.result_summary_json, null), failure: row.failure_code ? { code: row.failure_code, message: row.failure_message } : null, createdAt: iso(row.created_at), assignedAt: iso(row.assigned_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), updatedAt: iso(row.updated_at) };
}

export type TaskServiceOptions = { callbackPath?: string; callbackEnabled?: boolean };

export class TaskService {
  readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly callbackPath: string;
  private readonly callbackEnabled: boolean;

  constructor(db: ControlPlaneDatabase, events = new EventHub(), options: TaskServiceOptions = {}) {
    this.db = db;
    this.events = events;
    this.callbackPath = options.callbackPath ?? process.env.PAI_HERMES_TASK_EVENT_PATH ?? "/api/internal/control-plane/task-events";
    this.callbackEnabled = options.callbackEnabled ?? true;
  }

  create(input: CreateTaskInput, now = Date.now()): Record<string, unknown> {
    const id = uuidv7(now);
    this.db.transaction(() => {
      this.db.run(`INSERT INTO tasks (id, source, correlation_id, group_id, parent_task_id, title, task_type, instruction, context_json, payload_json, execution_json, priority, status, timeout_seconds, max_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`, id, input.source, input.correlationId ?? null, input.groupId ?? null, input.parentTaskId ?? null, input.title, input.taskType, input.instruction, JSON.stringify(input.context), JSON.stringify(input.payload), JSON.stringify(input.execution), priorityNumber[input.priority], input.limits.timeoutSeconds, input.limits.maxAttempts, now, now);
      for (const artifactId of input.inputArtifactIds) {
        if (!this.db.one("SELECT id FROM artifacts WHERE id = ?", artifactId)) throw new Error("ARTIFACT_NOT_FOUND");
        this.db.run("INSERT INTO task_artifacts(task_id, artifact_id, direction) VALUES (?, ?, 'INPUT')", id, artifactId);
      }
      this.appendEvent(id, "TASK_CREATED", null, null, { source: input.source, taskType: input.taskType }, now);
    });
    const row = this.getRow(id)!;
    this.events.publish({ type: "task.updated", taskId: id, status: "QUEUED" });
    return this.publicTask(row);
  }

  getRow(id: string): TaskRow | undefined { return this.db.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id); }
  get(id: string): Record<string, unknown> | undefined { const row = this.getRow(id); return row ? this.publicTask(row) : undefined; }
  list(filters: { status?: string; workerId?: string; taskType?: string; search?: string; limit?: number } = {}): Record<string, unknown>[] {
    const conditions: string[] = []; const params: unknown[] = [];
    if (filters.status) { conditions.push("t.status = ?"); params.push(filters.status); }
    if (filters.workerId) { conditions.push("EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id = t.id AND a.worker_id = ?)"); params.push(filters.workerId); }
    if (filters.taskType) { conditions.push("t.task_type = ?"); params.push(filters.taskType); }
    if (filters.search) { conditions.push("(t.title LIKE ? OR t.id LIKE ? OR t.correlation_id LIKE ?)"); const q = `%${filters.search}%`; params.push(q, q, q); }
    const limit = Math.min(500, Math.max(1, filters.limit ?? 100));
    return this.db.all<TaskRow>(`SELECT t.* FROM tasks t ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY t.priority DESC, t.created_at ASC, t.id ASC LIMIT ?`, ...params, limit).map((row) => this.publicTask(row));
  }

  detail(id: string): Record<string, unknown> | undefined {
    const task = this.get(id); if (!task) return undefined;
    const attempts = this.db.all<AttemptRow>("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number", id).map((row) => ({ id: row.id, attemptNumber: row.attempt_number, workerId: row.worker_id, status: row.status, assignedAt: iso(row.assigned_at), acceptedAt: iso(row.accepted_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), failure: row.failure_code ? { code: row.failure_code, message: row.failure_message } : null, result: parseJson(row.result_json, null), lateResult: Boolean(row.is_late_result) }));
    return { ...task, attempts, events: this.eventsFor(id), artifacts: this.db.all("SELECT a.id, a.filename, a.media_type AS mediaType, a.size_bytes AS sizeBytes, a.sha256, ta.direction FROM artifacts a JOIN task_artifacts ta ON ta.artifact_id = a.id WHERE ta.task_id = ?", id) };
  }

  eventsFor(id: string): Record<string, unknown>[] { return this.db.all<TaskRow>("SELECT event_uuid AS eventId, event_type AS type, attempt_id AS attemptId, worker_id AS workerId, payload_json AS payload, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY id", id).map((row) => ({ ...row, payload: parseJson(row.payload), createdAt: iso(row.createdAt) })); }

  assign(taskId: string, workerId: string, now = Date.now()): { task: Record<string, unknown>; attemptId: string } | undefined {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); if (!task || task.status !== "QUEUED") return undefined;
      const worker = this.db.one<TaskRow>("SELECT * FROM workers WHERE id = ? AND status = 'ONLINE' AND enabled = 1 AND drain = 0 AND removed_at IS NULL", workerId); if (!worker) return undefined;
      const running = this.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND status IN ('OFFERED', 'ACCEPTED', 'RUNNING')", workerId);
      if (Number(running?.count ?? 0) >= Number(worker.max_concurrency ?? 1)) return undefined;
      const attemptId = uuidv7(now);
      const attemptNumber = Number(task.attempt_count) + 1;
      this.db.run("INSERT INTO task_attempts(id, task_id, attempt_number, worker_id, status, assigned_at) VALUES (?, ?, ?, ?, 'OFFERED', ?)", attemptId, taskId, attemptNumber, workerId, now);
      this.db.run("UPDATE tasks SET status = 'ASSIGNED', current_attempt_id = ?, attempt_count = ?, assigned_at = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'", attemptId, attemptNumber, now, now, taskId);
      this.db.run("UPDATE workers SET last_assigned_at = ?, updated_at = ? WHERE id = ?", now, now, workerId);
      this.appendEvent(taskId, "TASK_ASSIGNED", attemptId, workerId, { attemptNumber }, now);
      const updated = this.getRow(taskId)!;
      this.events.publish({ type: "task.updated", taskId, status: "ASSIGNED", workerId, attemptId });
      return { task: this.publicTask(updated), attemptId };
    });
  }

  accept(taskId: string, attemptId: string, workerId: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const attempt = this.currentAttempt(taskId, attemptId, workerId); if (!attempt || attempt.status !== "OFFERED") return false;
      this.db.run("UPDATE task_attempts SET status = 'ACCEPTED', accepted_at = ? WHERE id = ?", now, attemptId);
      this.appendEvent(taskId, "WORKER_ACCEPTED", attemptId, workerId, {}, now); this.events.publish({ type: "task.updated", taskId, status: "ASSIGNED", workerId, attemptId }); return true;
    });
  }

  started(taskId: string, attemptId: string, workerId: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); const attempt = this.currentAttempt(taskId, attemptId, workerId); if (!task || !attempt || task.status !== "ASSIGNED" || !["OFFERED", "ACCEPTED"].includes(attempt.status)) return false;
      this.db.run("UPDATE task_attempts SET status = 'RUNNING', started_at = ? WHERE id = ?", now, attemptId);
      this.db.run("UPDATE tasks SET status = 'RUNNING', started_at = ?, updated_at = ? WHERE id = ?", now, now, taskId);
      this.appendEvent(taskId, "TASK_STARTED", attemptId, workerId, {}, now); this.events.publish({ type: "task.updated", taskId, status: "RUNNING", workerId, attemptId }); return true;
    });
  }

  progress(taskId: string, attemptId: string, workerId: string, payload: Record<string, JsonValue>, now = Date.now()): boolean { return this.appendCurrentEvent(taskId, attemptId, workerId, "TASK_PROGRESS", payload, now); }
  log(taskId: string, attemptId: string, workerId: string, payload: Record<string, JsonValue>, now = Date.now()): boolean { return this.appendCurrentEvent(taskId, attemptId, workerId, "TASK_LOG", payload, now); }

  result(taskId: string, attemptId: string, workerId: string, result: Record<string, JsonValue>, metrics: Record<string, JsonValue> = {}, now = Date.now()): "SUCCEEDED" | "LATE" | "IGNORED" {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); const attempt = this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId); if (!task || !attempt) return "IGNORED";
      if (task.current_attempt_id !== attemptId || ["CANCELLED", "SUCCEEDED"].includes(task.status)) {
        this.db.run("UPDATE task_attempts SET is_late_result = 1 WHERE id = ?", attemptId); this.appendEvent(taskId, "LATE_ATTEMPT_RESULT", attemptId, workerId, { result, metrics }, now); this.events.publish({ type: "task.updated", taskId, status: task.status, late: true }); return "LATE";
      }
      if (!["RUNNING", "ACCEPTED"].includes(attempt.status)) return "IGNORED";
      this.db.run("UPDATE task_attempts SET status = 'SUCCEEDED', finished_at = ?, result_json = ? WHERE id = ?", now, JSON.stringify({ result, metrics }), attemptId);
      this.db.run("UPDATE tasks SET status = 'SUCCEEDED', result_summary_json = ?, finished_at = ?, updated_at = ? WHERE id = ?", JSON.stringify({ result, metrics }), now, now, taskId);
      this.appendEvent(taskId, "TASK_SUCCEEDED", attemptId, workerId, { result, metrics }, now); this.enqueueCallback(taskId, "succeeded", { result, metrics }, workerId, now); this.events.publish({ type: "task.updated", taskId, status: "SUCCEEDED", workerId, attemptId }); return "SUCCEEDED";
    });
  }

  fail(taskId: string, attemptId: string, workerId: string, code: string, message: string, now = Date.now(), requeue = true): "REQUEUED" | "FAILED" | "LATE" | "IGNORED" {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); const attempt = this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId); if (!task || !attempt) return "IGNORED";
      if (task.current_attempt_id !== attemptId || ["CANCELLED", "SUCCEEDED"].includes(task.status)) { this.db.run("UPDATE task_attempts SET is_late_result = 1 WHERE id = ?", attemptId); this.appendEvent(taskId, "LATE_ATTEMPT_RESULT", attemptId, workerId, { code, message }, now); return "LATE"; }
      const shouldRetry = requeue && Number(task.attempt_count) < Number(task.max_attempts) && task.status !== "CANCELLED";
      this.db.run("UPDATE task_attempts SET status = ?, finished_at = ?, failure_code = ?, failure_message = ? WHERE id = ?", shouldRetry ? "LOST" : "FAILED", now, code, message, attemptId);
      const nextStatus = shouldRetry ? "QUEUED" : "FAILED";
      this.db.run("UPDATE tasks SET status = ?, current_attempt_id = ?, failure_code = ?, failure_message = ?, finished_at = ?, updated_at = ? WHERE id = ?", nextStatus, shouldRetry ? null : task.current_attempt_id, code, message, shouldRetry ? null : now, now, taskId);
      this.appendEvent(taskId, shouldRetry ? "TASK_REQUEUED" : "TASK_FAILED", attemptId, workerId, { code, message }, now);
      if (!shouldRetry) this.enqueueCallback(taskId, "failed", { failure: { code, message } }, workerId, now);
      this.events.publish({ type: "task.updated", taskId, status: nextStatus, workerId, attemptId }); return shouldRetry ? "REQUEUED" : "FAILED";
    });
  }

  cancel(taskId: string, now = Date.now()): Record<string, unknown> | undefined {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); if (!task) return undefined; if (terminalTaskStates.has(task.status)) return this.publicTask(task);
      assertTaskTransition(task.status, "CANCELLED");
      this.db.run("UPDATE tasks SET status = 'CANCELLED', finished_at = ?, updated_at = ? WHERE id = ?", now, now, taskId);
      if (task.current_attempt_id) this.db.run("UPDATE task_attempts SET status = 'CANCELLED', finished_at = ? WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'LOST')", now, task.current_attempt_id);
      this.appendEvent(taskId, "TASK_CANCELLED", task.current_attempt_id, null, {}, now); this.enqueueCallback(taskId, "cancelled", {}, null, now); this.events.publish({ type: "task.updated", taskId, status: "CANCELLED" }); return this.publicTask(this.getRow(taskId)!);
    });
  }

  retry(taskId: string, now = Date.now()): Record<string, unknown> | undefined {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); if (!task) return undefined; if (task.status !== "FAILED") throw new Error("INVALID_TASK_STATE");
      this.db.run("UPDATE tasks SET status = 'QUEUED', current_attempt_id = NULL, attempt_count = 0, failure_code = NULL, failure_message = NULL, finished_at = NULL, updated_at = ? WHERE id = ?", now, taskId);
      this.appendEvent(taskId, "TASK_REQUEUED", null, null, { manual: true }, now); this.events.publish({ type: "task.updated", taskId, status: "QUEUED" }); return this.publicTask(this.getRow(taskId)!);
    });
  }

  loseAttempt(taskId: string, attemptId: string, workerId: string, now = Date.now()): void { this.fail(taskId, attemptId, workerId, "WORKER_DISCONNECTED", "Worker heartbeat exceeded offline threshold.", now, true); }
  expire(now = Date.now()): number {
    const rows = this.db.all<TaskRow>("SELECT t.*, a.id AS active_attempt_id, a.worker_id AS active_worker_id FROM tasks t JOIN task_attempts a ON a.id = t.current_attempt_id WHERE t.status IN ('ASSIGNED', 'RUNNING') AND t.updated_at + (t.timeout_seconds * 1000) < ?", now);
    for (const row of rows) this.fail(row.id, row.active_attempt_id, row.active_worker_id, "TASK_TIMEOUT", "Task execution timeout exceeded.", now, true);
    return rows.length;
  }

  private currentAttempt(taskId: string, attemptId: string, workerId: string): AttemptRow | undefined { return this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId); }
  private publicTask(row: TaskRow): Record<string, unknown> { const artifacts = this.db.all<{ id: string }>("SELECT artifact_id AS id FROM task_artifacts WHERE task_id = ? AND direction = 'INPUT' ORDER BY artifact_id", row.id); return taskPublic(row, artifacts.map((artifact) => artifact.id)); }
  private appendCurrentEvent(taskId: string, attemptId: string, workerId: string, type: TaskEventName, payload: Record<string, JsonValue>, now: number): boolean { return this.db.transaction(() => { const task = this.getRow(taskId); const attempt = this.currentAttempt(taskId, attemptId, workerId); if (!task || !attempt || task.current_attempt_id !== attemptId || !["ASSIGNED", "RUNNING"].includes(task.status)) return false; this.appendEvent(taskId, type, attemptId, workerId, payload, now); this.events.publish({ type: "task.updated", taskId, status: task.status, workerId, attemptId }); return true; }); }
  private appendEvent(taskId: string, type: TaskEventName, attemptId: string | null, workerId: string | null, payload: Record<string, unknown>, now: number): string { const eventId = uuidv7(now); this.db.run("INSERT INTO task_events(event_uuid, task_id, attempt_id, worker_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", eventId, taskId, attemptId, workerId, type, JSON.stringify(payload), now); return eventId; }
  private enqueueCallback(taskId: string, status: string, result: Record<string, unknown>, workerId: string | null, now: number): void { if (!this.callbackEnabled) return; const eventId = uuidv7(now); const task = this.getRow(taskId); if (!task) return; const callbackStatus = status === "succeeded" ? "succeeded" : status; const payload = { event_id: eventId, type: status === "succeeded" ? "task.completed" : `task.${callbackStatus}`, task_id: taskId, correlation_id: task.correlation_id, status: callbackStatus, result: result.result ?? null, metrics: result.metrics ?? null, failure: result.failure ?? null, worker: workerId ? { id: workerId } : null }; this.db.run("INSERT INTO callback_outbox(id, event_id, task_id, payload_json, available_at) VALUES (?, ?, ?, ?, ?)", uuidv7(now), eventId, taskId, JSON.stringify(payload), now); }
}

export function hashWorkerToken(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
export function newWorkerToken(workerId: string): string { return `paiw_${workerId.slice(0, 8)}_${randomBytes(32).toString("base64url")}`; }
export function safeHash(value: unknown): string { return sha256(canonicalJson(value)); }
