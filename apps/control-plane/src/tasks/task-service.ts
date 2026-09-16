import { createHash, randomBytes } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { canonicalJson, priorityNumber, sha256, uuidv7, type CreateTaskInput, type JsonValue, type TaskContractV2Input, type TaskEventName, type TaskState } from "../../../../packages/contracts/src/index.ts";
import { assertTaskTransition, terminalTaskStates } from "./task-state-machine.ts";

type TaskRow = Record<string, any>;
type AttemptRow = Record<string, any>;

function parseJson(value: unknown, fallback: unknown = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }
function taskPublic(row: TaskRow, inputArtifactIds: string[] = []): Record<string, unknown> {
  const execution = parseJson(row.execution_json);
  const status = String(row.status);
  const active = row.current_attempt_id ? row.current_attempt_id : null;
  const defaultCertainty = status === "QUEUED" ? "NOT_STARTED" : terminalTaskStates.has(status as TaskState) ? (row.execution_certainty === "UNKNOWN" ? "UNKNOWN" : "TERMINAL_CONFIRMED") : row.execution_certainty ?? "OBSERVED";
  const occupancy = row.occupancy ?? (active ? "HELD" : "RELEASED");
  return { id: row.id, schemaVersion: Number(row.schema_version ?? 1), executionSemantics: row.execution_semantics ?? "legacy", source: row.source, sourceRef: parseJson(row.source_ref_json, null), sourceIntentRef: row.source_intent_ref ?? null, conversationRef: row.conversation_ref ?? row.correlation_id ?? null, correlationId: row.correlation_id ?? null, requestedBy: row.requested_by ?? "owner", workRef: parseJson(row.work_ref_json, null), groupId: row.group_id, parentTaskId: row.parent_task_id, title: row.title, taskType: row.task_type, purpose: row.purpose ?? "USER", ownerKind: row.owner_kind ?? "STANDALONE", missionExecutionId: row.mission_execution_id ?? null, instruction: row.instruction, context: parseJson(row.context_json), payload: parseJson(row.payload_json), execution, requirements: parseJson(row.requirements_json, null), criteria: parseJson(row.criteria_json, []), approvalRef: row.approval_ref ?? null, preferenceSnapshot: parseJson(row.preference_snapshot_json, null), inputArtifactIds, priority: row.priority >= 80 ? "high" : row.priority <= 20 ? "low" : "normal", status, currentAttemptId: row.current_attempt_id, currentRunId: row.current_run_id, revision: Number(row.revision ?? 1), createdSeq: row.created_seq ?? null, timeoutSeconds: row.timeout_seconds, maxAttempts: row.max_attempts, attemptCount: row.attempt_count, queueDeadlineAt: iso(row.queue_deadline_at), executionCertainty: defaultCertainty, waitingReason: row.waiting_reason ?? null, control: { cancel: row.control_cancel ?? "NONE", timeout: row.control_timeout ?? "NOT_EXCEEDED" }, occupancy, effectState: row.effect_state ?? "UNKNOWN", validation: { state: row.validation_state ?? "NOT_REQUESTED", ...(parseJson(row.validation_json, null) ?? {}) }, delivery: { state: row.delivery_state ?? "NOT_REQUESTED", ...(parseJson(row.delivery_json, null) ?? {}) }, result: parseJson(row.result_summary_json, null), failure: row.failure_code ? { code: row.failure_code, message: row.failure_message } : null, progress: parseJson(row.last_progress_json, null), createdAt: iso(row.created_at), assignedAt: iso(row.assigned_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), updatedAt: iso(row.updated_at) };
}

export type TaskArtifactStorage = { exists(path: string): boolean; read(path: string): Uint8Array };
export type TaskServiceOptions = { callbackPath?: string; callbackEnabled?: boolean; artifactStorage?: TaskArtifactStorage };
export type TaskOwnership = { ownerKind: "STANDALONE" | "MISSION"; missionExecutionId?: string | null };
export type TaskListFilters = { status?: string; workerId?: string; taskType?: string; search?: string; workspaceId?: string; purpose?: string; createdFrom?: number; createdTo?: number; finishedFrom?: number; finishedTo?: number; sort?: "created_desc" | "created_asc" | "finished_desc"; limit?: number; cursor?: string };
export type TaskOperationOptions = { expectedRevision?: number; idempotencyKey?: string; principal?: string };

export class TaskService {
  readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly callbackPath: string;
  private readonly callbackEnabled: boolean;
  private readonly artifactStorage?: TaskArtifactStorage;

  constructor(db: ControlPlaneDatabase, events = new EventHub(), options: TaskServiceOptions = {}) {
    this.db = db;
    this.events = events;
    this.callbackPath = options.callbackPath ?? process.env.PAI_HERMES_TASK_EVENT_PATH ?? "/api/internal/control-plane/task-events";
    this.callbackEnabled = options.callbackEnabled ?? true;
    this.artifactStorage = options.artifactStorage;
  }

  create(input: CreateTaskInput, now = Date.now()): Record<string, unknown> {
    const created = this.db.transaction(() => this.createInTx(input, now, { ownerKind: "STANDALONE" }));
    const row = this.getRow(created.id)!;
    this.events.publish({ type: "task.updated", taskId: created.id, status: "QUEUED" });
    return this.publicTask(row);
  }

  /** Hermes -> Control Plane v2 delegation. This is deliberately a thin adapter over the task domain. */
  delegate(input: TaskContractV2Input, principal = input.requestedBy ?? "owner", now = Date.now()): Record<string, unknown> {
    const operationKey = input.idempotencyKey;
    const requestHash = safeHash({ ...input, requestedBy: principal });
    return this.db.transaction(() => {
      const existing = this.db.one<TaskRow>("SELECT * FROM tasks WHERE requested_by = ? AND idempotency_key = ?", principal, operationKey);
      if (existing) {
        const priorSnapshot = existing.request_snapshot_json ? parseJson(existing.request_snapshot_json, {}) as Record<string, unknown> : {};
        const priorHash = typeof priorSnapshot.requestHash === "string" ? priorSnapshot.requestHash : null;
        if (priorHash && priorHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return { task_id: existing.id, run_id: existing.current_run_id, revision: Number(existing.revision ?? 1), status: existing.status, deduplicated: true, task: this.publicTask(existing) };
      }
      const created = this.createInTx({ ...input, requestedBy: principal, schemaVersion: 2, executionSemantics: "platform_v2" }, now, { ownerKind: "STANDALONE" });
      const row = this.getRow(created.id)!;
      // Keep the request hash in the immutable request snapshot for replay conflict detection.
      this.db.run("UPDATE tasks SET request_snapshot_json = ? WHERE id = ?", JSON.stringify({ ...input, requestedBy: principal, requestHash }), created.id);
      const response = { task_id: created.id, run_id: created.runId, revision: Number(row.revision ?? 1), status: row.status, deduplicated: false, task: this.publicTask(row) };
      this.events.publish({ type: "task.updated", taskId: created.id, status: "QUEUED", revision: 1 });
      return response;
    });
  }

  /** Internal unit-of-work entry. The caller owns the surrounding transaction. */
  createInTx(input: CreateTaskInput, now = Date.now(), ownership: TaskOwnership = { ownerKind: "STANDALONE" }): { id: string; runId: string } {
    const id = uuidv7(now); const runId = uuidv7(now + 1);
    if (ownership.ownerKind === "MISSION" && !ownership.missionExecutionId) throw new Error("MISSION_EXECUTION_REQUIRED");
    if (ownership.ownerKind === "STANDALONE" && ownership.missionExecutionId) throw new Error("INVALID_TASK_OWNERSHIP");
    let preferenceSnapshot: Record<string, unknown> | null = null;
    if (input.execution.preferenceId) {
      const preference = this.db.one<TaskRow>("SELECT * FROM model_preferences WHERE id = ? AND deleted_at IS NULL", input.execution.preferenceId);
      if (!preference) throw new Error("PREFERENCE_NOT_FOUND");
      preferenceSnapshot = { id: preference.id, name: preference.name, taskType: preference.task_type, version: Number(preference.version), targets: parseJson(preference.targets_json, []), allowFallback: Boolean(preference.allow_fallback) };
    }
    const sequenceRow = this.db.one<{ value_json: string }>("SELECT value_json FROM runtime_metadata WHERE key = 'next_task_seq'");
    const createdSeq = Number(sequenceRow ? JSON.parse(sequenceRow.value_json) : 1);
    this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('next_task_seq', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(createdSeq + 1));
    this.db.run(`INSERT INTO tasks (id, source, correlation_id, group_id, parent_task_id, title, task_type, instruction, context_json, payload_json, execution_json, priority, status, timeout_seconds, max_attempts, created_at, updated_at, created_seq, current_run_id, revision, purpose, source_ref_json, preference_snapshot_json, settings_version, request_snapshot_json, owner_kind, mission_execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`, id, input.source, input.correlationId ?? null, input.groupId ?? null, input.parentTaskId ?? null, input.title, input.taskType, input.instruction, input.context ? JSON.stringify(input.context) : "{}", JSON.stringify(input.payload), JSON.stringify(input.execution), priorityNumber[input.priority], input.limits.timeoutSeconds, input.limits.maxAttempts, now, now, createdSeq, runId, input.purpose ?? "USER", input.sourceRef ? JSON.stringify(input.sourceRef) : null, preferenceSnapshot ? JSON.stringify(preferenceSnapshot) : null, input.settingsVersion ?? null, JSON.stringify(input), ownership.ownerKind, ownership.missionExecutionId ?? null);
    if (input.schemaVersion === 2 || input.executionSemantics === "platform_v2") {
      if (!input.idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
      if (!input.sourceIntentRef) throw new Error("MISSING_SOURCE_INTENT_REF");
      this.db.run("UPDATE tasks SET schema_version = 2, execution_semantics = 'platform_v2', requested_by = ?, source_intent_ref = ?, conversation_ref = ?, work_ref_json = ?, requirements_json = ?, criteria_json = ?, idempotency_key = ?, queue_deadline_at = ?, approval_ref = ?, execution_certainty = 'NOT_STARTED', waiting_reason = NULL, control_cancel = 'NONE', control_timeout = 'NOT_EXCEEDED', occupancy = 'RELEASED', effect_state = ?, validation_state = 'NOT_REQUESTED', delivery_state = 'NOT_REQUESTED' WHERE id = ?", input.requestedBy ?? "owner", input.sourceIntentRef, input.conversationRef ?? input.correlationId ?? null, input.workRef ? JSON.stringify(input.workRef) : null, input.requirements ? JSON.stringify(input.requirements) : null, input.criteria ? JSON.stringify(input.criteria) : "[]", input.idempotencyKey, input.queueDeadlineAt ?? null, input.approvalRef ?? null, input.retryPolicy?.effectClass === "READ_ONLY" ? "NONE_CONFIRMED" : "UNKNOWN", id);
    }
    this.db.run("INSERT INTO task_runs(id, task_id, run_number, trigger, status, max_attempts, attempts_used, created_at) VALUES (?, ?, 1, 'INITIAL', 'QUEUED', ?, 0, ?)", runId, id, input.limits.maxAttempts, now);
    for (const artifactId of input.inputArtifactIds) {
      if (!this.db.one("SELECT id FROM artifacts WHERE id = ?", artifactId)) throw new Error("ARTIFACT_NOT_FOUND");
      this.db.run("INSERT INTO task_artifacts(task_id, artifact_id, direction) VALUES (?, ?, 'INPUT')", id, artifactId);
    }
    this.appendEvent(id, "TASK_CREATED", null, null, { source: input.source, taskType: input.taskType, runId }, now);
    return { id, runId };
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
    const attempts = this.db.all<AttemptRow>("SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number", id).map((row) => ({ id: row.id, runId: row.run_id, attemptNumber: row.attempt_number, attemptInRun: row.attempt_in_run, workerId: row.worker_id, status: row.status, occupancy: row.occupancy, fenceEpoch: Number(row.fence_epoch ?? 1), workerBootId: row.worker_boot_id ?? null, workspaceId: row.workspace_id ?? null, stopEvidence: parseJson(row.stop_evidence_json, null), effectState: row.effect_state ?? "UNKNOWN", progress: parseJson(row.last_progress_json, null), progressSequence: Number(row.progress_sequence ?? 0), resolvedExecution: parseJson(row.resolved_execution_json, null), deadlineAt: iso(row.deadline_at), assignedAt: iso(row.assigned_at), acceptedAt: iso(row.accepted_at), startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), failure: row.failure_code ? { code: row.failure_code, message: row.failure_message } : null, result: parseJson(row.result_json, null), lateResult: Boolean(row.is_late_result) }));
    const runs = this.db.all<TaskRow>("SELECT * FROM task_runs WHERE task_id = ? ORDER BY run_number", id).map((row) => ({ id: row.id, runNumber: row.run_number, trigger: row.trigger, status: row.status, maxAttempts: row.max_attempts, attemptsUsed: row.attempts_used, createdAt: iso(row.created_at), finishedAt: iso(row.finished_at), result: parseJson(row.result_json, null), failure: parseJson(row.failure_json, null) }));
    const dispatch = this.db.one<TaskRow>("SELECT * FROM task_dispatch_state WHERE task_id = ?", id);
    const artifacts = this.db.all<TaskRow>("SELECT a.id, a.attempt_id AS attemptId, at.run_id AS runId, COALESCE(a.display_filename, a.filename) AS filename, a.media_type AS mediaType, a.size_bytes AS sizeBytes, a.sha256, COALESCE(a.storage_state, 'AVAILABLE') AS availability, a.preview_kind AS previewKind, ta.direction FROM artifacts a JOIN task_artifacts ta ON ta.artifact_id = a.id LEFT JOIN task_attempts at ON at.id = a.attempt_id WHERE ta.task_id = ?", id);
    return { ...task, currentRun: runs.find((run) => run.id === (task as TaskRow).currentRunId) ?? null, runs, attempts, resolvedExecution: attempts.find((attempt) => attempt.id === (task as TaskRow).currentAttemptId)?.resolvedExecution ?? null, dispatch: dispatch ? { state: dispatch.primary_reason ? "WAITING" : "READY", primaryReason: dispatch.primary_reason, reasons: parseJson(dispatch.reasons_json, []), candidates: parseJson(dispatch.candidates_json, []), blockedSince: iso(dispatch.blocked_since), evaluatedAt: iso(dispatch.evaluated_at), dispatchNotBefore: iso(dispatch.dispatch_not_before) } : null, events: this.eventsFor(id), artifacts };
  }

  eventsFor(id: string, options: { afterEventId?: string; limit?: number } = {}): Record<string, unknown>[] { return this.eventsPage(id, options).items; }
  eventsPage(id: string, options: { afterEventId?: string; limit?: number } = {}): { items: Record<string, unknown>[]; page: { nextCursor: string | null; hasMore: boolean } } { const limit = Math.min(200, Math.max(1, Number(options.limit ?? 200))); const afterRow = options.afterEventId ? this.db.one<TaskRow>("SELECT id FROM task_events WHERE task_id = ? AND event_uuid = ?", id, options.afterEventId) : undefined; if (options.afterEventId && !afterRow) throw new Error("CURSOR_STALE"); const after = afterRow?.id ?? 0; const items: Record<string, unknown>[] = this.db.all<TaskRow>("SELECT event_uuid, event_type, attempt_id, worker_id, payload_json, created_at FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?", id, after, limit + 1).map((row): Record<string, unknown> => ({ eventId: row.event_uuid, type: row.event_type, attemptId: row.attempt_id, workerId: row.worker_id, payload: parseJson(row.payload_json), createdAt: iso(row.created_at) })); const hasMore = items.length > limit; const pageItems = hasMore ? items.slice(0, limit) : items; return { items: pageItems, page: { nextCursor: hasMore ? String(pageItems[pageItems.length - 1]?.eventId ?? "") : null, hasMore } }; }

  async waitTask(taskId: string, afterRevision = 0, timeoutMs = 30_000): Promise<Record<string, unknown> | undefined> {
    const current = this.getRow(taskId);
    if (!current) return undefined;
    const bounded = Math.min(30_000, Math.max(0, Number(timeoutMs)));
    if (Number(current.revision ?? 1) > afterRevision || bounded === 0) return this.detail(taskId);
    return await new Promise<Record<string, unknown>>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(this.detail(taskId) ?? {});
      };
      const unsubscribe = this.events.subscribe((event) => {
        if (event.taskId === taskId && Number((this.getRow(taskId)?.revision ?? 0)) > afterRevision) finish();
      });
      timer = setTimeout(finish, bounded);
      timer.unref?.();
    });
  }

  resultView(taskId: string, runId?: string): Record<string, unknown> | undefined {
    const detail = this.detail(taskId);
    if (!detail) return undefined;
    const selectedRunId = runId ?? String(detail.currentRunId ?? "");
    const run = (detail.runs as TaskRow[]).find((item) => item.id === selectedRunId);
    const stored = run?.result && typeof run.result === "object" ? run.result as TaskRow : null;
    const result = stored && Object.prototype.hasOwnProperty.call(stored, "result") ? stored.result : run?.result ?? null;
    const resultManifest = stored?.resultManifest ?? null;
    const artifacts = (detail.artifacts as TaskRow[]).filter((item) => item.direction === "OUTPUT" && (!selectedRunId || item.runId === selectedRunId)).map((item) => ({ ...item, previewUrl: `/api/v2/artifacts/${encodeURIComponent(String(item.id))}/preview`, downloadUrl: `/api/v2/artifacts/${encodeURIComponent(String(item.id))}/download` }));
    return { state: run?.result ? "AVAILABLE" : run ? "PENDING" : "NOT_APPLICABLE", runId: run?.id ?? (selectedRunId || null), result, metrics: stored?.metrics ?? null, resultManifest, manifest: { artifacts, availability: artifacts.every((item) => String((item as TaskRow).availability ?? "AVAILABLE") === "AVAILABLE") ? "AVAILABLE" : "PARTIAL" }, artifacts };
  }

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
      const v2 = task.execution_semantics === "platform_v2";
      const executionRecord = execution && typeof execution === "object" ? execution as TaskRow : {};
      const workspaceId = String(executionRecord.workspaceId ?? executionRecord.workspace_id ?? "").trim() || null;
      if (v2 && workspaceId) {
        const lock = this.db.one<TaskRow>("SELECT * FROM workspace_locks WHERE workspace_id = ?", workspaceId);
        if (lock && String(lock.state) !== "RELEASED") return undefined;
      }
      const fenceEpoch = Number(this.db.one<TaskRow>("SELECT COALESCE(MAX(fence_epoch), 0) AS value FROM task_attempts WHERE task_id = ?", taskId)?.value ?? 0) + 1;
      const workerMetadata = parseJson(worker.metadata_json, {}) as TaskRow;
      const workerBootId = typeof workerMetadata.boot_id === "string" ? workerMetadata.boot_id : typeof workerMetadata.worker_boot_id === "string" ? workerMetadata.worker_boot_id : null;
      const deadlineAt = now + Number(task.timeout_seconds) * 1_000;
      this.db.run("INSERT INTO task_attempts(id, task_id, attempt_number, worker_id, status, assigned_at, run_id, attempt_in_run, resolved_execution_json, deadline_at, occupancy, fence_epoch, worker_boot_id, workspace_id, lease_expires_at) VALUES (?, ?, ?, ?, 'OFFERED', ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?)", attemptId, taskId, attemptNumber, workerId, now, runId, attemptInRun, JSON.stringify(execution), deadlineAt, fenceEpoch, workerBootId, workspaceId, deadlineAt);
      if (v2 && workspaceId) this.db.run("INSERT INTO workspace_locks(workspace_id, lock_mode, attempt_id, fence_epoch, state, acquired_at, updated_at) VALUES (?, ?, ?, ?, 'HELD', ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET lock_mode = excluded.lock_mode, attempt_id = excluded.attempt_id, fence_epoch = excluded.fence_epoch, state = 'HELD', acquired_at = excluded.acquired_at, released_at = NULL, updated_at = excluded.updated_at", workspaceId, String((task.requirements_json ? parseJson(task.requirements_json, {}) : {})?.workspace_mode ?? "WRITE_EXCLUSIVE"), attemptId, fenceEpoch, now, now);
      this.db.run("UPDATE tasks SET status = 'ASSIGNED', current_attempt_id = ?, attempt_count = ?, assigned_at = ?, updated_at = ?, revision = revision + 1, execution_certainty = CASE WHEN execution_semantics = 'platform_v2' THEN 'OBSERVED' ELSE execution_certainty END, waiting_reason = NULL, occupancy = CASE WHEN execution_semantics = 'platform_v2' THEN 'HELD' ELSE occupancy END WHERE id = ? AND status = 'QUEUED'", attemptId, attemptNumber, now, now, taskId);
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

  result(taskId: string, attemptId: string, workerId: string, result: Record<string, JsonValue>, metrics: Record<string, JsonValue> = {}, now = Date.now(), resultManifest?: Record<string, unknown>, fenceEpoch?: number): "SUCCEEDED" | "LATE" | "IGNORED" {
    return this.db.transaction(() => {
      const task = this.getRow(taskId); const attempt = this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId); if (!task || !attempt) return "IGNORED";
      if (task.execution_semantics === "platform_v2" && fenceEpoch !== undefined && Number(attempt.fence_epoch ?? 1) !== Number(fenceEpoch)) return "IGNORED";
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
      this.db.run("UPDATE task_attempts SET status = 'SUCCEEDED', occupancy = 'RELEASED', finished_at = ?, result_json = ?, effect_state = CASE WHEN effect_state = 'UNKNOWN' THEN 'UNKNOWN' ELSE 'NONE_CONFIRMED' END WHERE id = ?", now, JSON.stringify(storedResult), attemptId);
      const validation = normalizedManifest?.validation && typeof normalizedManifest.validation === "object" ? normalizedManifest.validation as TaskRow : null;
      this.db.run("UPDATE tasks SET status = 'SUCCEEDED', result_summary_json = ?, finished_at = ?, updated_at = ?, revision = revision + 1, execution_certainty = CASE WHEN execution_semantics = 'platform_v2' THEN 'TERMINAL_CONFIRMED' ELSE execution_certainty END, waiting_reason = NULL, occupancy = CASE WHEN execution_semantics = 'platform_v2' THEN 'RELEASED' ELSE occupancy END, validation_state = CASE WHEN ? IS NULL THEN validation_state ELSE COALESCE(?, 'NOT_RUN') END, validation_json = CASE WHEN ? IS NULL THEN validation_json ELSE ? END WHERE id = ?", JSON.stringify(storedResult), now, now, validation ? String(validation.state ?? "NOT_RUN") : null, validation ? String(validation.state ?? "NOT_RUN") : null, validation ? JSON.stringify(validation) : null, validation ? JSON.stringify(validation) : null, taskId);
      this.releaseWorkspaceLock(attempt, now, "RELEASED");
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
      const v2ReconciliationRequired = task.execution_semantics === "platform_v2" && ["WORKER_DISCONNECTED", "TASK_TIMEOUT"].includes(code);
      if (v2ReconciliationRequired) {
        this.db.run("UPDATE task_attempts SET status = 'LOST', occupancy = 'UNKNOWN', finished_at = ?, failure_code = ?, failure_message = ?, effect_state = 'UNKNOWN', stop_evidence_json = COALESCE(stop_evidence_json, ?), lease_expires_at = ? WHERE id = ?", now, code, message, JSON.stringify({ stop_state: "UNKNOWN", children_accounted_for: false, reason: code }), now, attemptId);
        this.db.run("UPDATE tasks SET failure_code = ?, failure_message = ?, updated_at = ?, revision = revision + 1, execution_certainty = 'UNKNOWN', waiting_reason = 'RECONCILIATION_REQUIRED', occupancy = 'UNKNOWN', effect_state = 'UNKNOWN', control_timeout = CASE WHEN ? = 1 THEN 'EXCEEDED' ELSE control_timeout END WHERE id = ?", code, message, now, code === "TASK_TIMEOUT" ? 1 : 0, taskId);
        if (attempt.run_id) this.db.run("UPDATE task_runs SET status = 'UNKNOWN', failure_json = ? WHERE id = ?", JSON.stringify({ code, message, reconciliationRequired: true }), attempt.run_id);
        this.bumpListRevision();
        this.appendEvent(taskId, "TASK_FAILED", attemptId, workerId, { code, message, reconciliationRequired: true }, now);
        this.events.publish({ type: "task.updated", taskId, status: task.status, workerId, attemptId, executionCertainty: "UNKNOWN" });
        return "FAILED";
      }
      const shouldRetry = requeue && Number(run?.attempts_used ?? task.attempt_count) < Number(run?.max_attempts ?? task.max_attempts) && task.status !== "CANCELLED";
      this.db.run("UPDATE task_attempts SET status = ?, occupancy = 'RELEASED', finished_at = ?, failure_code = ?, failure_message = ? WHERE id = ?", shouldRetry ? "LOST" : "FAILED", now, code, message, attemptId);
      const nextStatus = shouldRetry ? "QUEUED" : "FAILED";
      this.db.run("UPDATE tasks SET status = ?, current_attempt_id = ?, failure_code = ?, failure_message = ?, finished_at = ?, updated_at = ?, revision = revision + 1, execution_certainty = CASE WHEN execution_semantics = 'platform_v2' THEN CASE WHEN ? = 1 THEN 'NOT_STARTED' ELSE 'TERMINAL_CONFIRMED' END ELSE execution_certainty END, waiting_reason = NULL, occupancy = CASE WHEN execution_semantics = 'platform_v2' THEN 'RELEASED' ELSE occupancy END WHERE id = ?", nextStatus, shouldRetry ? null : task.current_attempt_id, code, message, shouldRetry ? null : now, now, shouldRetry ? 1 : 0, taskId);
      if (attempt.run_id) this.db.run("UPDATE task_runs SET status = ?, finished_at = ?, failure_json = ? WHERE id = ?", nextStatus, shouldRetry ? null : now, JSON.stringify({ code, message }), attempt.run_id);
      this.releaseWorkspaceLock(attempt, now, "RELEASED");
      this.bumpListRevision();
      this.appendEvent(taskId, shouldRetry ? "TASK_REQUEUED" : "TASK_FAILED", attemptId, workerId, { code, message }, now);
      if (!shouldRetry) this.enqueueCallback(taskId, "failed", { failure: { code, message } }, workerId, now);
      this.events.publish({ type: "task.updated", taskId, status: nextStatus, workerId, attemptId }); return shouldRetry ? "REQUEUED" : "FAILED";
    });
  }

  cancel(taskId: string, now = Date.now(), options: TaskOperationOptions = {}): Record<string, unknown> | undefined {
    const scope = `task:${taskId}:cancel`;
    const requestHash = safeHash({ expectedRevision: options.expectedRevision ?? null });
    return this.db.transaction(() => {
      if (options.idempotencyKey) {
        const receipt = this.db.one<TaskRow>("SELECT * FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, options.idempotencyKey);
        if (receipt) { if (receipt.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return parseJson(receipt.response_json, null) as Record<string, unknown>; }
      }
      const task = this.getRow(taskId); if (!task) return undefined;
      if (options.expectedRevision !== undefined && Number(task.revision ?? 1) !== options.expectedRevision) throw new Error("TASK_CHANGED");
      if (terminalTaskStates.has(task.status)) return this.publicTask(task);
      assertTaskTransition(task.status, "CANCELLED");
      const v2 = task.execution_semantics === "platform_v2";
      const hasAttempt = Boolean(task.current_attempt_id);
      this.db.run("UPDATE tasks SET status = 'CANCELLED', finished_at = ?, updated_at = ?, revision = revision + 1, control_cancel = CASE WHEN execution_semantics = 'platform_v2' THEN 'REQUESTED' ELSE control_cancel END, execution_certainty = CASE WHEN execution_semantics = 'platform_v2' AND ? = 1 THEN 'UNKNOWN' WHEN execution_semantics = 'platform_v2' THEN 'TERMINAL_CONFIRMED' ELSE execution_certainty END, waiting_reason = CASE WHEN execution_semantics = 'platform_v2' AND ? = 1 THEN 'STOP_RECONCILIATION' ELSE waiting_reason END, occupancy = CASE WHEN execution_semantics = 'platform_v2' AND ? = 1 THEN 'RELEASING' WHEN execution_semantics = 'platform_v2' THEN 'RELEASED' ELSE occupancy END WHERE id = ?", now, now, hasAttempt ? 1 : 0, hasAttempt ? 1 : 0, hasAttempt ? 1 : 0, taskId);
      if (task.current_attempt_id) this.db.run("UPDATE task_attempts SET status = 'CANCELLED', occupancy = CASE WHEN status IN ('OFFERED', 'ACCEPTED', 'RUNNING') THEN 'RELEASING' ELSE 'RELEASED' END, cancel_requested_at = ?, finished_at = CASE WHEN status IN ('OFFERED', 'ACCEPTED', 'RUNNING') THEN NULL ELSE ? END WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'LOST')", now, now, task.current_attempt_id);
      if (task.current_run_id) this.db.run("UPDATE task_runs SET status = 'CANCELLED', finished_at = ? WHERE id = ?", now, task.current_run_id);
      this.bumpListRevision();
      this.appendEvent(taskId, "TASK_CANCELLED", task.current_attempt_id, null, { requested: v2 }, now); this.enqueueCallback(taskId, "cancelled", {}, null, now); this.events.publish({ type: "task.updated", taskId, status: "CANCELLED", executionCertainty: hasAttempt ? "UNKNOWN" : "TERMINAL_CONFIRMED" });
      const response = this.publicTask(this.getRow(taskId)!);
      if (options.idempotencyKey) this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 202, ?, ?)", scope, options.idempotencyKey, requestHash, JSON.stringify(response), now);
      return response;
    });
  }

  cancelWithOptions(taskId: string, options: TaskOperationOptions = {}, now = Date.now()): Record<string, unknown> | undefined { return this.cancel(taskId, now, options); }

  cancelled(taskId: string, attemptId: string, workerId: string, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const attempt = this.db.one<AttemptRow>("SELECT a.*, t.owner_kind FROM task_attempts a JOIN tasks t ON t.id = a.task_id WHERE a.id = ? AND a.task_id = ? AND a.worker_id = ?", attemptId, taskId, workerId);
      if (!attempt || attempt.status !== "CANCELLED") return false;
      const evidence = parseJson(attempt.stop_evidence_json, null) as Record<string, any> | null;
      const confirmed = attempt.owner_kind !== "MISSION" || (evidence?.stop_state === "STOPPED" && evidence.children_accounted_for === true);
      const task = this.getRow(taskId);
      this.db.run("UPDATE task_attempts SET occupancy = CASE WHEN ? = 1 THEN 'RELEASED' ELSE 'UNKNOWN' END, cancel_ack_at = CASE WHEN ? = 1 THEN ? ELSE cancel_ack_at END, finished_at = CASE WHEN ? = 1 THEN COALESCE(finished_at, ?) ELSE finished_at END WHERE id = ? AND occupancy IN ('RELEASING', 'UNKNOWN')", confirmed ? 1 : 0, confirmed ? 1 : 0, now, confirmed ? 1 : 0, now, attemptId);
      if (task?.execution_semantics === "platform_v2") {
        this.db.run("UPDATE tasks SET control_cancel = 'ACKNOWLEDGED', execution_certainty = CASE WHEN ? = 1 THEN 'TERMINAL_CONFIRMED' ELSE 'UNKNOWN' END, waiting_reason = CASE WHEN ? = 1 THEN NULL ELSE 'RECONCILIATION_REQUIRED' END, occupancy = CASE WHEN ? = 1 THEN 'RELEASED' ELSE 'UNKNOWN' END, updated_at = ?, revision = revision + 1 WHERE id = ?", confirmed ? 1 : 0, confirmed ? 1 : 0, confirmed ? 1 : 0, now, taskId);
        if (confirmed) this.releaseWorkspaceLock(attempt, now, "RELEASED");
        else this.releaseWorkspaceLock(attempt, now, "UNKNOWN");
      }
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
      if (task.execution_semantics === "platform_v2" && (task.execution_certainty === "UNKNOWN" || ["HELD", "RELEASING", "UNKNOWN"].includes(String(task.occupancy ?? "")))) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
      if (task.status !== "FAILED") throw new Error("INVALID_TASK_STATE");
      const previousRunId = task.current_run_id;
      const runNumber = Number(this.db.one<TaskRow>("SELECT COALESCE(MAX(run_number), 0) AS value FROM task_runs WHERE task_id = ?", taskId)?.value ?? 0) + 1;
      const runId = uuidv7(now);
      this.db.run("INSERT INTO task_runs(id, task_id, run_number, trigger, status, max_attempts, attempts_used, created_at) VALUES (?, ?, ?, 'MANUAL', 'QUEUED', ?, 0, ?)", runId, taskId, runNumber, task.max_attempts, now);
      this.db.run("UPDATE tasks SET status = 'QUEUED', current_attempt_id = NULL, current_run_id = ?, failure_code = NULL, failure_message = NULL, finished_at = NULL, updated_at = ?, revision = revision + 1, execution_certainty = CASE WHEN execution_semantics = 'platform_v2' THEN 'NOT_STARTED' ELSE execution_certainty END, waiting_reason = NULL, control_cancel = CASE WHEN execution_semantics = 'platform_v2' THEN 'NONE' ELSE control_cancel END, control_timeout = CASE WHEN execution_semantics = 'platform_v2' THEN 'NOT_EXCEEDED' ELSE control_timeout END, occupancy = CASE WHEN execution_semantics = 'platform_v2' THEN 'RELEASED' ELSE occupancy END WHERE id = ?", runId, now, taskId);
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

  recordStopReceipt(taskId: string, attemptId: string, workerId: string, receipt: Record<string, unknown>, now = Date.now(), fenceEpoch?: number): Record<string, unknown> {
    return this.db.transaction(() => {
      const task = this.getRow(taskId);
      const attempt = this.db.one<AttemptRow>("SELECT * FROM task_attempts WHERE id = ? AND task_id = ? AND worker_id = ?", attemptId, taskId, workerId);
      if (!task || !attempt || task.current_attempt_id !== attemptId) throw new Error("STALE_EXECUTION");
      if (task.execution_semantics === "platform_v2" && fenceEpoch !== undefined && Number(attempt.fence_epoch ?? 1) !== Number(fenceEpoch)) throw new Error("STALE_EXECUTION");
      const evidence = receipt.evidence && typeof receipt.evidence === "object" ? receipt.evidence as TaskRow : {};
      const stopState = String(receipt.stop_state ?? evidence.stop_state ?? "UNKNOWN");
      const childrenAccounted = evidence.children_accounted_for === true || receipt.children_accounted_for === true;
      const confirmed = stopState === "STOPPED" && childrenAccounted;
      const effectState = ["NONE", "CONFIRMED", "UNKNOWN"].includes(String(receipt.effect_state)) ? String(receipt.effect_state) : "UNKNOWN";
      this.db.run("UPDATE task_attempts SET stop_evidence_json = ?, effect_state = ?, occupancy = ?, cancel_ack_at = CASE WHEN ? = 1 THEN COALESCE(cancel_ack_at, ?) ELSE cancel_ack_at END, finished_at = CASE WHEN ? = 1 THEN COALESCE(finished_at, ?) ELSE finished_at END WHERE id = ?", JSON.stringify({ ...evidence, stop_state: stopState, children_accounted_for: childrenAccounted }), effectState, confirmed ? "RELEASED" : "UNKNOWN", confirmed ? 1 : 0, now, confirmed ? 1 : 0, now, attemptId);
      if (task.execution_semantics === "platform_v2") {
        this.db.run("UPDATE tasks SET execution_certainty = CASE WHEN ? = 1 THEN 'TERMINAL_CONFIRMED' ELSE 'UNKNOWN' END, waiting_reason = CASE WHEN ? = 1 THEN NULL ELSE 'RECONCILIATION_REQUIRED' END, occupancy = CASE WHEN ? = 1 THEN 'RELEASED' ELSE 'UNKNOWN' END, effect_state = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", confirmed ? 1 : 0, confirmed ? 1 : 0, confirmed ? 1 : 0, effectState, now, taskId);
        this.releaseWorkspaceLock(attempt, now, confirmed ? "RELEASED" : "UNKNOWN");
      }
      this.appendEvent(taskId, "TASK_CANCELLED", attemptId, workerId, { stopState, childrenAccountedFor: childrenAccounted, confirmed, effectState }, now);
      this.events.publish({ type: "task.stop.receipt", taskId, attemptId, workerId, stopState, effectState, confirmed });
      return { taskId, attemptId, stopState, effectState, confirmed, executionCertainty: confirmed ? "TERMINAL_CONFIRMED" : "UNKNOWN" };
    });
  }

  private releaseWorkspaceLock(attempt: AttemptRow, now: number, state: "RELEASED" | "UNKNOWN"): void {
    if (!attempt.workspace_id) return;
    this.db.run("UPDATE workspace_locks SET state = ?, released_at = CASE WHEN ? = 'RELEASED' THEN ? ELSE released_at END, updated_at = ? WHERE attempt_id = ?", state, state, now, now, attempt.id);
  }

  private normalizeResultManifest(input: Record<string, unknown>, attempt: AttemptRow, taskType: string, result: Record<string, JsonValue>, metrics: Record<string, JsonValue>): Record<string, unknown> {
    const execution = parseJson(attempt.resolved_execution_json, {});
    const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
    for (const item of artifacts) {
      const artifactId = item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? (item as Record<string, unknown>).artifact_id ?? "") : "";
      const artifact = artifactId ? this.db.one<TaskRow>("SELECT id, attempt_id, storage_state, sha256, storage_path FROM artifacts WHERE id = ? AND task_id = ?", artifactId, attempt.task_id) : undefined;
      if (!artifact || artifact.attempt_id !== attempt.id || String(artifact.storage_state ?? "AVAILABLE") !== "AVAILABLE") throw new Error("RESULT_ARTIFACT_NOT_READY");
      const claimedHash = item && typeof item === "object" ? (item as Record<string, unknown>).sha256 ?? (item as Record<string, unknown>).digest : undefined;
      if (claimedHash !== undefined && (typeof claimedHash !== "string" || claimedHash !== String(artifact.sha256))) throw new Error("ARTIFACT_CONTENT_CONFLICT");
      if (this.artifactStorage) {
        if (!this.artifactStorage.exists(String(artifact.storage_path))) throw new Error("ARTIFACT_MISSING");
        if (sha256(this.artifactStorage.read(String(artifact.storage_path))) !== String(artifact.sha256)) throw new Error("ARTIFACT_CONTENT_CONFLICT");
      }
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
  private appendCurrentEvent(taskId: string, attemptId: string, workerId: string, type: TaskEventName, payload: Record<string, JsonValue>, now: number): boolean { return this.db.transaction(() => { const task = this.getRow(taskId); const attempt = this.currentAttempt(taskId, attemptId, workerId); if (!task || !attempt || task.current_attempt_id !== attemptId || !["ASSIGNED", "RUNNING"].includes(task.status)) return false; if (type === "TASK_PROGRESS") { const sequence = Number(attempt.progress_sequence ?? 0) + 1; this.db.run("UPDATE task_attempts SET progress_sequence = ?, last_progress_json = ? WHERE id = ?", sequence, JSON.stringify(payload), attemptId); this.db.run("UPDATE tasks SET progress_sequence = ?, last_progress_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", sequence, JSON.stringify(payload), now, taskId); } this.appendEvent(taskId, type, attemptId, workerId, payload, now); this.events.publish({ type: "task.updated", taskId, status: task.status, workerId, attemptId, revision: Number(this.getRow(taskId)?.revision ?? task.revision ?? 1) }); return true; }); }
  private appendEvent(taskId: string, type: TaskEventName, attemptId: string | null, workerId: string | null, payload: Record<string, unknown>, now: number): string {
    const eventId = uuidv7(now);
    this.db.run("INSERT INTO task_events(event_uuid, task_id, attempt_id, worker_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", eventId, taskId, attemptId, workerId, type, JSON.stringify(payload), now);
    const task = this.getRow(taskId);
    if (task) {
      const sequence = Number(this.db.one<TaskRow>("SELECT COALESCE(MAX(sequence), 0) AS value FROM task_event_outbox WHERE source = 'control-plane' AND source_epoch = 1 AND task_id = ?", taskId)?.value ?? 0) + 1;
      this.db.run("INSERT INTO task_event_outbox(id, event_id, task_id, source, source_epoch, sequence, subject_revision, payload_json, available_at, created_at) VALUES (?, ?, ?, 'control-plane', 1, ?, ?, ?, ?, ?)", uuidv7(now + sequence), eventId, taskId, sequence, Number(task.revision ?? 1), JSON.stringify({ type, task_id: taskId, attempt_id: attemptId, worker_id: workerId, payload }), now, now);
    }
    return eventId;
  }
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
