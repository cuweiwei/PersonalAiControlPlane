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
  return { id: row.id, source: row.source, sourceRef: parseJson(row.source_ref_json, null), correlationId: row.correlation_id, groupId: row.group_id, parentTaskId: row.parent_task_id, title: row.title, taskType: row.task_type, purpose: row.purpose ?? "USER", instruction: row.instruction, context: parseJson(row.context_json), payload: parseJson(row.payload_json), execution, preferenceSnapshot: parseJson(row.preference_snapshot_json, null), inputArtifactIds, priority: row.priority >= 80 ? "high" : row.priority <= 20 ? "low" : "normal", status: row.status, currentAttemptId: row.current_attempt_id, currentRunId: row.current_run_id, revision: Number(row.revision ?? 1), createdSeq: row.created_seq ?? null, timeoutSeconds: row.timeout_seconds, maxAttempts: row.max_attempts, attemptCount: row.attempt_count, result: parseJson(row.result_summary_json, null), failure: row.failure_code ? { code: row.failure_code, message: row.failure_message } : null, createdAt: iso(row.created_at), assignedAt: iso(row.assigned_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), updatedAt: iso(row.updated_at) };
}

export type TaskServiceOptions = { callbackPath?: string; callbackEnabled?: boolean };
export type TaskListFilters = { status?: string; workerId?: string; taskType?: string; search?: string; workspaceId?: string; purpose?: string; createdFrom?: number; createdTo?: number; finishedFrom?: number; finishedTo?: number; sort?: "created_desc" | "created_asc" | "finished_desc"; limit?: number; cursor?: string };

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
    const id = uuidv7(now); const runId = uuidv7(now + 1);
    let preferenceSnapshot: Record<string, unknown> | null = null;
    if (input.execution.preferenceId) {
      const preference = this.db.one<TaskRow>("SELECT * FROM model_preferences WHERE id = ? AND deleted_at IS NULL", input.execution.preferenceId);
      if (!preference) throw new Error("PREFERENCE_NOT_FOUND");
      preferenceSnapshot = { id: preference.id, name: preference.name, taskType: preference.task_type, version: Number(preference.version), targets: parseJson(preference.targets_json, []), allowFallback: Boolean(preference.allow_fallback) };
    }
    this.db.transaction(() => {
      const sequenceRow = this.db.one<{ value_json: string }>("SELECT value_json FROM runtime_metadata WHERE key = 'next_task_seq'");
      const createdSeq = Number(sequenceRow ? JSON.parse(sequenceRow.value_json) : 1);
      this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('next_task_seq', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(createdSeq + 1));
      this.db.run(`INSERT INTO tasks (id, source, correlation_id, group_id, parent_task_id, title, task_type, instruction, context_json, payload_json, execution_json, priority, status, timeout_seconds, max_attempts, created_at, updated_at, created_seq, current_run_id, revision, purpose, source_ref_json, preference_snapshot_json, settings_version, request_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`, id, input.source, input.correlationId ?? null, input.groupId ?? null, input.parentTaskId ?? null, input.title, input.taskType, input.instruction, input.context ? JSON.stringify(input.context) : "{}", JSON.stringify(input.payload), JSON.stringify(input.execution), priorityNumber[input.priority], input.limits.timeoutSeconds, input.limits.maxAttempts, now, now, createdSeq, runId, input.purpose ?? "USER", input.sourceRef ? JSON.stringify(input.sourceRef) : null, preferenceSnapshot ? JSON.stringify(preferenceSnapshot) : null, input.settingsVersion ?? null, JSON.stringify(input));
      this.db.run("INSERT INTO task_runs(id, task_id, run_number, trigger, status, max_attempts, attempts_used, created_at) VALUES (?, ?, 1, 'INITIAL', 'QUEUED', ?, 0, ?)", runId, id, input.limits.maxAttempts, now);
      for (const artifactId of input.inputArtifactIds) {
        if (!this.db.one("SELECT id FROM artifacts WHERE id = ?", artifactId)) throw new Error("ARTIFACT_NOT_FOUND");
        this.db.run("INSERT INTO task_artifacts(task_id, artifact_id, direction) VALUES (?, ?, 'INPUT')", id, artifactId);
      }
      this.appendEvent(id, "TASK_CREATED", null, null, { source: input.source, taskType: input.taskType, runId }, now);
    });
    const row = this.getRow(id)!;
    this.events.publish({ type: "task.updated", taskId: id, status: "QUEUED" });
    return this.publicTask(row);
  }

  getRow(id: string): TaskRow | undefined { return this.db.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id); }
  get(id: string): Record<string, unknown> | undefined { const row = this.getRow(id); return row ? this.publicTask(row) : undefined; }
  list(filters: TaskListFilters = {}): Record<string, unknown>[] { return this.listPage(filters).items as Record<string, unknown>[]; }

  listPage(filters: TaskListFilters = {}): { items: Record<string, unknown>[]; page: Record<string, unknown>; appliedFilters: Record<string, unknown>; observedAt: string } {
    const normalized = { ...filters, search: filters.search?.trim() || undefined, sort: filters.sort ?? "created_desc", limit: Math.min(200, Math.max(1, filters.limit ?? 50)) };
    const cursor = filters.cursor ? decodeCursor(filters.cursor) : undefined;
    const filtersHash = safeHash({ ...normalized, cursor: undefined });
    if (cursor && (cursor.sort !== normalized.sort || cursor.filtersHash !== filtersHash || cursor.listRevision !== this.listRevision())) throw new Error("CURSOR_STALE");
    const conditions: string[] = ["(t.archived_at IS NULL OR t.archived_at = 0)"]; const params: unknown[] = [];
    const statuses = String(filters.status ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (statuses.length) { conditions.push(`t.status IN (${statuses.map(() => "?").join(",")})`); params.push(...statuses); }
    if (filters.workerId) { conditions.push("EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id = t.id AND a.worker_id = ?)"); params.push(filters.workerId); }
    if (filters.taskType) { conditions.push("t.task_type = ?"); params.push(filters.taskType); }
    if (filters.workspaceId) { conditions.push("instr(COALESCE(t.execution_json, ''), ?) > 0"); params.push(filters.workspaceId); }
    if (filters.purpose && filters.purpose !== "ALL") { conditions.push("t.purpose = ?"); params.push(filters.purpose); }
    if (filters.createdFrom !== undefined) { conditions.push("t.created_at >= ?"); params.push(filters.createdFrom); }
    if (filters.createdTo !== undefined) { conditions.push("t.created_at < ?"); params.push(filters.createdTo); }
    if (filters.finishedFrom !== undefined) { conditions.push("t.finished_at >= ?"); params.push(filters.finishedFrom); }
    if (filters.finishedTo !== undefined) { conditions.push("t.finished_at < ?"); params.push(filters.finishedTo); }
    if (normalized.sort === "finished_desc") conditions.push("t.finished_at IS NOT NULL");
    if (normalized.search) { const search = normalized.search.toLowerCase(); conditions.push("(instr(lower(t.title), ?) > 0 OR instr(lower(t.id), ?) > 0 OR instr(lower(COALESCE(t.correlation_id, '')), ?) > 0 OR instr(lower(COALESCE(t.source_ref_json, '')), ?) > 0 OR instr(lower(COALESCE(t.execution_json, '')), ?) > 0)"); params.push(search, search, search, search, search); }
    if (cursor) {
      const operator = normalized.sort === "created_asc" ? ">" : "<";
      const valueColumn = normalized.sort === "finished_desc" ? "COALESCE(t.finished_at, 0)" : normalized.sort === "created_asc" ? "t.created_seq" : "t.created_seq";
      conditions.push(`(${valueColumn} ${operator} ? OR (${valueColumn} = ? AND t.id ${operator} ?))`); params.push(cursor.lastSortValue, cursor.lastSortValue, cursor.lastId);
      conditions.push("t.created_seq <= ?"); params.push(cursor.highWaterCreatedSeq);
    }
    const order = normalized.sort === "created_asc" ? "t.created_seq ASC, t.id ASC" : normalized.sort === "finished_desc" ? "t.finished_at DESC, t.id DESC" : "t.created_seq DESC, t.id DESC";
    const rows = this.db.all<TaskRow>(`SELECT t.* FROM tasks t WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?`, ...params, Number(normalized.limit) + 1);
    const pageRows = rows.slice(0, Number(normalized.limit));
    const last = pageRows.at(-1);
    const lastSortValue = last ? normalized.sort === "finished_desc" ? Number(last.finished_at) : Number(last.created_seq) : null;
    const nextCursor = rows.length > pageRows.length && last ? encodeCursor({ v: 1, sort: normalized.sort, filtersHash, highWaterCreatedSeq: cursor?.highWaterCreatedSeq ?? Number(this.db.one<TaskRow>("SELECT COALESCE(MAX(created_seq), 0) AS value FROM tasks")?.value ?? 0), listRevision: this.listRevision(), lastSortValue: Number(lastSortValue), lastId: String(last.id) }) : null;
    const appliedFilters = { ...normalized, cursor: undefined };
    return { items: pageRows.map((row) => this.publicTask(row)), page: { nextCursor, hasMore: Boolean(nextCursor) }, appliedFilters, observedAt: new Date().toISOString() };
  }

  summary(filters: Omit<TaskListFilters, "cursor" | "limit" | "sort"> = {}): Record<string, unknown> {
    const normalized = { ...filters, search: filters.search?.trim() || undefined };
    const conditions: string[] = ["(archived_at IS NULL OR archived_at = 0)"]; const params: unknown[] = [];
    const statuses = String(filters.status ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (statuses.length) { conditions.push(`status IN (${statuses.map(() => "?").join(",")})`); params.push(...statuses); }
    if (filters.taskType) { conditions.push("task_type = ?"); params.push(filters.taskType); }
    if (filters.purpose && filters.purpose !== "ALL") { conditions.push("purpose = ?"); params.push(filters.purpose); }
    if (filters.createdFrom !== undefined) { conditions.push("created_at >= ?"); params.push(filters.createdFrom); }
    if (filters.createdTo !== undefined) { conditions.push("created_at < ?"); params.push(filters.createdTo); }
    if (filters.finishedFrom !== undefined) { conditions.push("finished_at >= ?"); params.push(filters.finishedFrom); }
    if (filters.finishedTo !== undefined) { conditions.push("finished_at < ?"); params.push(filters.finishedTo); }
    if (filters.search) { const search = filters.search.trim().toLowerCase(); conditions.push("(instr(lower(title), ?) > 0 OR instr(lower(id), ?) > 0 OR instr(lower(COALESCE(correlation_id, '')), ?) > 0 OR instr(lower(COALESCE(source_ref_json, '')), ?) > 0 OR instr(lower(COALESCE(execution_json, '')), ?) > 0)"); params.push(search, search, search, search, search); }
    if (filters.workerId) { conditions.push("EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id = tasks.id AND a.worker_id = ?)"); params.push(filters.workerId); }
    if (filters.workspaceId) { conditions.push("instr(COALESCE(execution_json, ''), ?) > 0"); params.push(filters.workspaceId); }
    const rows = this.db.all<{ status: string; count: number }>(`SELECT status, COUNT(*) AS count FROM tasks WHERE ${conditions.join(" AND ")} GROUP BY status`, ...params);
    const countsByStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return { countsByStatus, total: rows.reduce((sum, row) => sum + Number(row.count), 0), observedAt: new Date().toISOString(), appliedFilters: { ...normalized, cursor: undefined, limit: undefined, sort: undefined } };
  }

  detail(id: string): Record<string, unknown> | undefined {
    const task = this.get(id); if (!task) return undefined;
    const attempts = this.db.all<AttemptRow>("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number", id).map((row) => ({ id: row.id, runId: row.run_id, attemptNumber: row.attempt_number, attemptInRun: row.attempt_in_run, workerId: row.worker_id, status: row.status, occupancy: row.occupancy, resolvedExecution: parseJson(row.resolved_execution_json, null), deadlineAt: iso(row.deadline_at), assignedAt: iso(row.assigned_at), acceptedAt: iso(row.accepted_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), failure: row.failure_code ? { code: row.failure_code, message: row.failure_message } : null, result: parseJson(row.result_json, null), lateResult: Boolean(row.is_late_result) }));
    const runs = this.db.all<TaskRow>("SELECT * FROM task_runs WHERE task_id = ? ORDER BY run_number", id).map((row) => ({ id: row.id, runNumber: row.run_number, trigger: row.trigger, status: row.status, maxAttempts: row.max_attempts, attemptsUsed: row.attempts_used, createdAt: iso(row.created_at), finishedAt: iso(row.finished_at), result: parseJson(row.result_json, null), failure: parseJson(row.failure_json, null) }));
    const dispatch = this.db.one<TaskRow>("SELECT * FROM task_dispatch_state WHERE task_id = ?", id);
    const artifacts = this.db.all<TaskRow>("SELECT a.id, a.attempt_id AS attemptId, at.run_id AS runId, COALESCE(a.display_filename, a.filename) AS filename, a.media_type AS mediaType, a.size_bytes AS sizeBytes, a.sha256, COALESCE(a.storage_state, 'AVAILABLE') AS availability, a.preview_kind AS previewKind, ta.direction FROM artifacts a JOIN task_artifacts ta ON ta.artifact_id = a.id LEFT JOIN task_attempts at ON at.id = a.attempt_id WHERE ta.task_id = ?", id);
    return { ...task, currentRun: runs.find((run) => run.id === (task as TaskRow).currentRunId) ?? null, runs, attempts, resolvedExecution: attempts.find((attempt) => attempt.id === (task as TaskRow).currentAttemptId)?.resolvedExecution ?? null, dispatch: dispatch ? { state: dispatch.primary_reason ? "WAITING" : "READY", primaryReason: dispatch.primary_reason, reasons: parseJson(dispatch.reasons_json, []), candidates: parseJson(dispatch.candidates_json, []), blockedSince: iso(dispatch.blocked_since), evaluatedAt: iso(dispatch.evaluated_at), dispatchNotBefore: iso(dispatch.dispatch_not_before) } : null, events: this.eventsFor(id), artifacts };
  }

  eventsFor(id: string, options: { afterEventId?: string; limit?: number } = {}): Record<string, unknown>[] { return this.eventsPage(id, options).items; }
  eventsPage(id: string, options: { afterEventId?: string; limit?: number } = {}): { items: Record<string, unknown>[]; page: { nextCursor: string | null; hasMore: boolean } } { const limit = Math.min(200, Math.max(1, Number(options.limit ?? 200))); const afterRow = options.afterEventId ? this.db.one<TaskRow>("SELECT id FROM task_events WHERE task_id = ? AND event_uuid = ?", id, options.afterEventId) : undefined; if (options.afterEventId && !afterRow) throw new Error("CURSOR_STALE"); const after = afterRow?.id ?? 0; const items: Record<string, unknown>[] = this.db.all<TaskRow>("SELECT event_uuid, event_type, attempt_id, worker_id, payload_json, created_at FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?", id, after, limit + 1).map((row): Record<string, unknown> => ({ eventId: row.event_uuid, type: row.event_type, attemptId: row.attempt_id, workerId: row.worker_id, payload: parseJson(row.payload_json), createdAt: iso(row.created_at) })); const hasMore = items.length > limit; const pageItems = hasMore ? items.slice(0, limit) : items; return { items: pageItems, page: { nextCursor: hasMore ? String(pageItems[pageItems.length - 1]?.eventId ?? "") : null, hasMore } }; }

  assign(taskId: string, workerId: string, now = Date.now(), resolvedExecution?: Record<string, unknown>): { task: Record<string, unknown>; attemptId: string } | undefined {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); if (!task || task.status !== "QUEUED") return undefined;
      const worker = this.db.one<TaskRow>("SELECT * FROM workers WHERE id = ? AND status = 'ONLINE' AND enabled = 1 AND drain = 0 AND removed_at IS NULL", workerId); if (!worker) return undefined;
      const running = this.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ? AND occupancy IN ('RESERVED', 'RUNNING', 'RELEASING')", workerId);
      if (Number(running?.count ?? 0) >= Number(worker.max_concurrency ?? 1)) return undefined;
      const attemptId = uuidv7(now);
      const runId = String(task.current_run_id ?? `legacy-${task.id}`);
      const run = this.db.one<TaskRow>("SELECT * FROM task_runs WHERE id = ? AND task_id = ?", runId, taskId);
      const attemptsUsed = Number(run?.attempts_used ?? 0);
      const maxAttempts = Number(run?.max_attempts ?? task.max_attempts);
      if (attemptsUsed >= maxAttempts) return undefined;
      const attemptNumber = Number(this.db.one<TaskRow>("SELECT COALESCE(MAX(attempt_number), 0) AS value FROM task_attempts WHERE task_id = ?", taskId)?.value ?? 0) + 1;
      const attemptInRun = attemptsUsed + 1;
      const execution = resolvedExecution ?? parseJson(task.execution_json);
      const deadlineAt = now + Number(task.timeout_seconds) * 1_000;
      this.db.run("INSERT INTO task_attempts(id, task_id, attempt_number, worker_id, status, assigned_at, run_id, attempt_in_run, resolved_execution_json, deadline_at, occupancy) VALUES (?, ?, ?, ?, 'OFFERED', ?, ?, ?, ?, ?, 'RESERVED')", attemptId, taskId, attemptNumber, workerId, now, runId, attemptInRun, JSON.stringify(execution), deadlineAt);
      this.db.run("UPDATE tasks SET status = 'ASSIGNED', current_attempt_id = ?, attempt_count = ?, assigned_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND status = 'QUEUED'", attemptId, attemptNumber, now, now, taskId);
      this.db.run("UPDATE task_runs SET status = 'ASSIGNED', attempts_used = ? WHERE id = ?", attemptInRun, runId);
      this.bumpListRevision();
      this.db.run("UPDATE workers SET last_assigned_at = ?, updated_at = ? WHERE id = ?", now, now, workerId);
      this.appendEvent(taskId, "TASK_ASSIGNED", attemptId, workerId, { attemptNumber, attemptInRun, runId, resolvedExecution: execution }, now);
      const updated = this.getRow(taskId)!;
      this.events.publish({ type: "task.updated", taskId, status: "ASSIGNED", workerId, attemptId });
      return { task: this.publicTask(updated), attemptId };
    });
  }

  accept(taskId: string, attemptId: string, workerId: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const attempt = this.currentAttempt(taskId, attemptId, workerId); if (!attempt || attempt.status !== "OFFERED") return false;
      this.db.run("UPDATE task_attempts SET status = 'ACCEPTED', occupancy = 'RUNNING', accepted_at = ? WHERE id = ?", now, attemptId);
      this.appendEvent(taskId, "WORKER_ACCEPTED", attemptId, workerId, {}, now); this.events.publish({ type: "task.updated", taskId, status: "ASSIGNED", workerId, attemptId }); return true;
    });
  }

  started(taskId: string, attemptId: string, workerId: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); const attempt = this.currentAttempt(taskId, attemptId, workerId); if (!task || !attempt || task.status !== "ASSIGNED" || !["OFFERED", "ACCEPTED"].includes(attempt.status)) return false;
      this.db.run("UPDATE task_attempts SET status = 'RUNNING', occupancy = 'RUNNING', started_at = ? WHERE id = ?", now, attemptId);
      this.db.run("UPDATE tasks SET status = 'RUNNING', started_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", now, now, taskId);
      if (attempt.run_id) this.db.run("UPDATE task_runs SET status = 'RUNNING' WHERE id = ?", attempt.run_id);
      this.bumpListRevision();
      this.appendEvent(taskId, "TASK_STARTED", attemptId, workerId, {}, now); this.events.publish({ type: "task.updated", taskId, status: "RUNNING", workerId, attemptId }); return true;
    });
  }

  progress(taskId: string, attemptId: string, workerId: string, payload: Record<string, JsonValue>, now = Date.now()): boolean { return this.appendCurrentEvent(taskId, attemptId, workerId, "TASK_PROGRESS", payload, now); }
  log(taskId: string, attemptId: string, workerId: string, payload: Record<string, JsonValue>, now = Date.now()): boolean { return this.appendCurrentEvent(taskId, attemptId, workerId, "TASK_LOG", payload, now); }

  result(taskId: string, attemptId: string, workerId: string, result: Record<string, JsonValue>, metrics: Record<string, JsonValue> = {}, now = Date.now(), resultManifest?: Record<string, unknown>): "SUCCEEDED" | "LATE" | "IGNORED" {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); const attempt = this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId); if (!task || !attempt) return "IGNORED";
      const normalizedIncomingManifest = task.status === "SUCCEEDED" && task.current_attempt_id === attemptId && resultManifest && Object.keys(resultManifest).length > 0 ? this.normalizeResultManifest(resultManifest, attempt, String(task.task_type), result, metrics) : undefined;
      if (task.current_attempt_id !== attemptId || ["CANCELLED", "SUCCEEDED"].includes(task.status)) {
        const existing = parseJson(attempt.result_json, null);
        const requested = { result, metrics, ...(normalizedIncomingManifest ? { resultManifest: normalizedIncomingManifest } : {}) };
        if (task.status === "SUCCEEDED" && existing && canonicalJson(existing) === canonicalJson(requested)) return "IGNORED";
        this.db.run("UPDATE task_attempts SET is_late_result = 1 WHERE id = ?", attemptId); this.appendEvent(taskId, "LATE_ATTEMPT_RESULT", attemptId, workerId, { result, metrics }, now); this.events.publish({ type: "task.updated", taskId, status: task.status, late: true }); return "LATE";
      }
      if (!["RUNNING", "ACCEPTED"].includes(attempt.status)) return "IGNORED";
      const normalizedManifest = resultManifest && Object.keys(resultManifest).length > 0 ? this.normalizeResultManifest(resultManifest, attempt, String(task.task_type), result, metrics) : undefined;
      const storedResult = { result, metrics, ...(normalizedManifest ? { resultManifest: normalizedManifest } : {}) };
      this.db.run("UPDATE task_attempts SET status = 'SUCCEEDED', occupancy = 'RELEASED', finished_at = ?, result_json = ? WHERE id = ?", now, JSON.stringify(storedResult), attemptId);
      this.db.run("UPDATE tasks SET status = 'SUCCEEDED', result_summary_json = ?, finished_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", JSON.stringify(storedResult), now, now, taskId);
      if (attempt.run_id) this.db.run("UPDATE task_runs SET status = 'SUCCEEDED', finished_at = ?, result_json = ? WHERE id = ?", now, JSON.stringify(storedResult), attempt.run_id);
      this.bumpListRevision();
      this.appendEvent(taskId, "TASK_SUCCEEDED", attemptId, workerId, { result, metrics, ...(normalizedManifest ? { resultManifest: normalizedManifest } : {}) }, now); this.enqueueCallback(taskId, "succeeded", storedResult, workerId, now); this.events.publish({ type: "task.updated", taskId, status: "SUCCEEDED", workerId, attemptId }); return "SUCCEEDED";
    });
  }

  fail(taskId: string, attemptId: string, workerId: string, code: string, message: string, now = Date.now(), requeue = true): "REQUEUED" | "FAILED" | "LATE" | "IGNORED" {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); const attempt = this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId); if (!task || !attempt) return "IGNORED";
      if (task.current_attempt_id !== attemptId || ["CANCELLED", "SUCCEEDED"].includes(task.status)) { this.db.run("UPDATE task_attempts SET is_late_result = 1 WHERE id = ?", attemptId); this.appendEvent(taskId, "LATE_ATTEMPT_RESULT", attemptId, workerId, { code, message }, now); return "LATE"; }
      const run = attempt.run_id ? this.db.one<TaskRow>("SELECT * FROM task_runs WHERE id = ?", attempt.run_id) : undefined;
      const shouldRetry = requeue && Number(run?.attempts_used ?? task.attempt_count) < Number(run?.max_attempts ?? task.max_attempts) && task.status !== "CANCELLED";
      this.db.run("UPDATE task_attempts SET status = ?, occupancy = 'RELEASED', finished_at = ?, failure_code = ?, failure_message = ? WHERE id = ?", shouldRetry ? "LOST" : "FAILED", now, code, message, attemptId);
      const nextStatus = shouldRetry ? "QUEUED" : "FAILED";
      this.db.run("UPDATE tasks SET status = ?, current_attempt_id = ?, failure_code = ?, failure_message = ?, finished_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", nextStatus, shouldRetry ? null : task.current_attempt_id, code, message, shouldRetry ? null : now, now, taskId);
      if (attempt.run_id) this.db.run("UPDATE task_runs SET status = ?, finished_at = ?, failure_json = ? WHERE id = ?", nextStatus, shouldRetry ? null : now, JSON.stringify({ code, message }), attempt.run_id);
      this.bumpListRevision();
      this.appendEvent(taskId, shouldRetry ? "TASK_REQUEUED" : "TASK_FAILED", attemptId, workerId, { code, message }, now);
      if (!shouldRetry) this.enqueueCallback(taskId, "failed", { failure: { code, message } }, workerId, now);
      this.events.publish({ type: "task.updated", taskId, status: nextStatus, workerId, attemptId }); return shouldRetry ? "REQUEUED" : "FAILED";
    });
  }

  cancel(taskId: string, now = Date.now()): Record<string, unknown> | undefined {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); if (!task) return undefined; if (terminalTaskStates.has(task.status)) return this.publicTask(task);
      assertTaskTransition(task.status, "CANCELLED");
      this.db.run("UPDATE tasks SET status = 'CANCELLED', finished_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", now, now, taskId);
      if (task.current_attempt_id) this.db.run("UPDATE task_attempts SET status = 'CANCELLED', occupancy = CASE WHEN status IN ('OFFERED', 'ACCEPTED', 'RUNNING') THEN 'RELEASING' ELSE 'RELEASED' END, cancel_requested_at = ?, finished_at = CASE WHEN status IN ('OFFERED', 'ACCEPTED', 'RUNNING') THEN NULL ELSE ? END WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'LOST')", now, now, task.current_attempt_id);
      if (task.current_run_id) this.db.run("UPDATE task_runs SET status = 'CANCELLED', finished_at = ? WHERE id = ?", now, task.current_run_id);
      this.bumpListRevision();
      this.appendEvent(taskId, "TASK_CANCELLED", task.current_attempt_id, null, {}, now); this.enqueueCallback(taskId, "cancelled", {}, null, now); this.events.publish({ type: "task.updated", taskId, status: "CANCELLED" }); return this.publicTask(this.getRow(taskId)!);
    });
  }

  cancelled(taskId: string, attemptId: string, workerId: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const attempt = this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId);
      if (!attempt || attempt.status !== "CANCELLED") return false;
      this.db.run("UPDATE task_attempts SET occupancy = 'RELEASED', cancel_ack_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND occupancy = 'RELEASING'", now, now, attemptId);
      this.appendEvent(taskId, "TASK_CANCELLED", attemptId, workerId, { acknowledged: true }, now);
      this.events.publish({ type: "task.updated", taskId, status: "CANCELLED", workerId, attemptId });
      return true;
    });
  }

  retry(taskId: string, now = Date.now()): Record<string, unknown> | undefined { return this.retryWithOptions(taskId, {}, now); }

  retryWithOptions(taskId: string, options: { expectedRunId?: string; expectedRevision?: number; idempotencyKey?: string } = {}, now = Date.now()): Record<string, unknown> | undefined {
    const scope = `task:${taskId}:retry`;
    const request = { expectedRunId: options.expectedRunId ?? null, expectedRevision: options.expectedRevision ?? null };
    const requestHash = safeHash(request);
    return this.db.transaction(() => {
      if (options.idempotencyKey) {
        const receipt = this.db.one<TaskRow>("SELECT * FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, options.idempotencyKey);
        if (receipt) {
          if (receipt.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
          return parseJson(receipt.response_json, null) as Record<string, unknown>;
        }
      }
      const task = this.getRow(taskId); if (!task) return undefined;
      if (options.expectedRevision !== undefined && Number(task.revision ?? 1) !== options.expectedRevision) throw new Error("TASK_CHANGED");
      if (options.expectedRunId !== undefined && String(task.current_run_id ?? "") !== options.expectedRunId) throw new Error("TASK_CHANGED");
      if (task.status !== "FAILED") throw new Error("INVALID_TASK_STATE");
      const previousRunId = task.current_run_id;
      const runNumber = Number(this.db.one<TaskRow>("SELECT COALESCE(MAX(run_number), 0) AS value FROM task_runs WHERE task_id = ?", taskId)?.value ?? 0) + 1;
      const runId = uuidv7(now);
      this.db.run("INSERT INTO task_runs(id, task_id, run_number, trigger, status, max_attempts, attempts_used, created_at) VALUES (?, ?, ?, 'MANUAL', 'QUEUED', ?, 0, ?)", runId, taskId, runNumber, task.max_attempts, now);
      this.db.run("UPDATE tasks SET status = 'QUEUED', current_attempt_id = NULL, current_run_id = ?, failure_code = NULL, failure_message = NULL, finished_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?", runId, now, taskId);
      this.bumpListRevision();
      this.appendEvent(taskId, "TASK_REQUEUED", null, null, { manual: true, runId, previousRunId }, now);
      const response = { ...this.publicTask(this.getRow(taskId)!), currentRun: { id: runId, runNumber, trigger: "MANUAL", status: "QUEUED", maxAttempts: Number(task.max_attempts), attemptsUsed: 0, createdAt: iso(now), finishedAt: null, result: null, failure: null }, previousRunId };
      if (options.idempotencyKey) this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 202, ?, ?)", scope, options.idempotencyKey, requestHash, JSON.stringify(response), now);
      this.events.publish({ type: "task.updated", taskId, status: "QUEUED", runId });
      return response;
    });
  }

  loseAttempt(taskId: string, attemptId: string, workerId: string, now = Date.now()): void { this.fail(taskId, attemptId, workerId, "WORKER_DISCONNECTED", "Worker heartbeat exceeded offline threshold.", now, true); }
  expire(now = Date.now()): number {
    const rows = this.db.all<TaskRow>("SELECT t.*, a.id AS active_attempt_id, a.worker_id AS active_worker_id FROM tasks t JOIN task_attempts a ON a.id = t.current_attempt_id WHERE t.status IN ('ASSIGNED', 'RUNNING') AND COALESCE(a.deadline_at, t.updated_at + (t.timeout_seconds * 1000)) < ?", now);
    for (const row of rows) this.fail(row.id, row.active_attempt_id, row.active_worker_id, "TASK_TIMEOUT", "Task execution timeout exceeded.", now, true);
    return rows.length;
  }

  private normalizeResultManifest(input: Record<string, unknown>, attempt: AttemptRow, taskType: string, result: Record<string, JsonValue>, metrics: Record<string, JsonValue>): Record<string, unknown> {
    const execution = parseJson(attempt.resolved_execution_json, {});
    const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
    for (const item of artifacts) {
      const artifactId = item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? (item as Record<string, unknown>).artifact_id ?? "") : "";
      const artifact = artifactId ? this.db.one<TaskRow>("SELECT id, attempt_id, storage_state FROM artifacts WHERE id = ? AND task_id = ?", artifactId, attempt.task_id) : undefined;
      if (!artifact || artifact.attempt_id !== attempt.id || String(artifact.storage_state ?? "AVAILABLE") !== "AVAILABLE") throw new Error("RESULT_ARTIFACT_NOT_READY");
    }
    const executionRecord = execution && typeof execution === "object" ? execution as Record<string, unknown> : {};
    const model = executionRecord.model && typeof executionRecord.model === "object" ? executionRecord.model as Record<string, unknown> : {};
    const target = { worker_id: executionRecord.workerId ?? executionRecord.worker_id ?? null, runtime: executionRecord.runtime ?? null, model_id: model.name ?? executionRecord.model_id ?? null, workspace_id: executionRecord.workspaceId ?? executionRecord.workspace_id ?? null };
    const kindByTaskType: Record<string, string> = { "llm.inference": "TEXT", codex: "CODEX", python: "PYTHON", command: "COMMAND", generic: "GENERIC" };
    const kind = ["TEXT", "CODEX", "PYTHON", "COMMAND", "GENERIC"].includes(String(input.kind)) ? String(input.kind) : kindByTaskType[taskType] ?? "GENERIC";
    const text = typeof input.text === "string" ? input.text : typeof result.text === "string" ? result.text : typeof result.stdout === "string" ? result.stdout : null;
    return { schema_version: 1, kind, summary: typeof input.summary === "string" ? input.summary : text ? text.slice(0, 240) : null, text, format: typeof input.format === "string" ? input.format : "plain", execution: target, changes: input.changes ?? { state: "NOT_PROVIDED", files: [], diff_artifact_id: null, attribution: "UNKNOWN" }, validation: input.validation ?? { state: "NOT_RUN", checks: [] }, artifacts, metrics: input.metrics ?? metrics };
  }
  private currentAttempt(taskId: string, attemptId: string, workerId: string): AttemptRow | undefined { return this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId); }
  private listRevision(): number { const value = this.db.one<{ value_json: string }>("SELECT value_json FROM runtime_metadata WHERE key = 'list_revision'")?.value_json; return Number(value ? JSON.parse(value) : 0); }
  private bumpListRevision(): void { const revision = this.listRevision() + 1; this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('list_revision', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(revision)); }
  private publicTask(row: TaskRow): Record<string, unknown> { const artifacts = this.db.all<{ id: string }>("SELECT artifact_id AS id FROM task_artifacts WHERE task_id = ? AND direction = 'INPUT' ORDER BY artifact_id", row.id); return taskPublic(row, artifacts.map((artifact) => artifact.id)); }
  private appendCurrentEvent(taskId: string, attemptId: string, workerId: string, type: TaskEventName, payload: Record<string, JsonValue>, now: number): boolean { return this.db.transaction(() => { const task = this.getRow(taskId); const attempt = this.currentAttempt(taskId, attemptId, workerId); if (!task || !attempt || task.current_attempt_id !== attemptId || !["ASSIGNED", "RUNNING"].includes(task.status)) return false; this.appendEvent(taskId, type, attemptId, workerId, payload, now); this.events.publish({ type: "task.updated", taskId, status: task.status, workerId, attemptId }); return true; }); }
  private appendEvent(taskId: string, type: TaskEventName, attemptId: string | null, workerId: string | null, payload: Record<string, unknown>, now: number): string { const eventId = uuidv7(now); this.db.run("INSERT INTO task_events(event_uuid, task_id, attempt_id, worker_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", eventId, taskId, attemptId, workerId, type, JSON.stringify(payload), now); return eventId; }
  private enqueueCallback(taskId: string, status: string, result: Record<string, unknown>, workerId: string | null, now: number): void { if (!this.callbackEnabled) return; const eventId = uuidv7(now); const task = this.getRow(taskId); if (!task || String(task.purpose ?? "USER") !== "USER") return; const attempt = task.current_attempt_id ? this.db.one<TaskRow>("SELECT * FROM task_attempts WHERE id = ?", task.current_attempt_id) : undefined; const runId = task.current_run_id ?? attempt?.run_id ?? null; const runNumber = runId ? this.db.one<TaskRow>("SELECT run_number FROM task_runs WHERE id = ?", runId)?.run_number ?? null : null; const artifacts = this.db.all<TaskRow>("SELECT a.id, COALESCE(a.display_filename, a.filename) AS filename FROM artifacts a JOIN task_artifacts ta ON ta.artifact_id = a.id LEFT JOIN task_attempts at ON at.id = a.attempt_id WHERE ta.task_id = ? AND ta.direction = 'OUTPUT' AND (? IS NULL OR at.run_id = ?)", taskId, runId, runId).map((artifact) => ({ id: artifact.id, filename: artifact.filename })); const callbackStatus = status === "succeeded" ? "succeeded" : status; const payload = { event_id: eventId, type: status === "succeeded" ? "task.completed" : `task.${callbackStatus}`, event_version: 1, task_id: taskId, run_id: runId, run_number: runNumber, attempt_id: task.current_attempt_id, correlation_id: task.correlation_id, source_ref: parseJson(task.source_ref_json, null), status: callbackStatus, result: result.result ?? null, result_manifest: result.resultManifest ?? null, metrics: result.metrics ?? null, failure: result.failure ?? null, artifacts, result_url: `/api/v2/tasks/${encodeURIComponent(taskId)}/results?run_id=${encodeURIComponent(String(runId ?? ""))}`, worker: workerId ? { id: workerId } : null }; this.db.run("INSERT INTO callback_outbox(id, event_id, task_id, payload_json, available_at, run_id, event_kind, state, reply_state) VALUES (?, ?, ?, ?, ?, ?, 'TERMINAL', 'PENDING', 'UNKNOWN')", uuidv7(now), eventId, taskId, JSON.stringify(payload), now, runId); }
}

export function hashWorkerToken(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }
export function newWorkerToken(workerId: string): string { return `paiw_${workerId.slice(0, 8)}_${randomBytes(32).toString("base64url")}`; }
export function safeHash(value: unknown): string { return sha256(canonicalJson(value)); }

type TaskCursor = { v: 1; sort: string; filtersHash: string; highWaterCreatedSeq: number; listRevision: number; lastSortValue: number; lastId: string };
function encodeCursor(value: TaskCursor): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decodeCursor(value: string): TaskCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TaskCursor;
    if (parsed.v !== 1 || typeof parsed.sort !== "string" || typeof parsed.filtersHash !== "string" || typeof parsed.lastId !== "string") throw new Error();
    return parsed;
  } catch { throw new Error("CURSOR_STALE"); }
}
