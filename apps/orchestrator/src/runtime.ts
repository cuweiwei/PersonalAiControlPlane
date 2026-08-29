import { uuidv7 } from "../../../packages/crypto/src/index.ts";
import { boundedExponentialBackoff } from "../../../packages/scheduler/src/index.ts";
import { parseGoalCreateInput, type GoalRecord, type PlanInput, type SideEffectClass, type TaskState } from "../../../packages/contracts/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";
import { OutboxStore, enqueueOutbox, type OutboxRecord } from "./outbox.ts";
import { PlanService } from "./plan-service.ts";
import { ReconciliationService, type ReconciliationRecord, type ReconciliationStatus } from "./reconciliation.ts";
import { ScheduleService } from "./schedule-service.ts";
import { TaskEngine, type AttemptBinding } from "./task-engine.ts";
import { ApprovalService, type ApprovalBounds } from "./approval-service.ts";

export type RuntimeTask = {
  id: string;
  goalId: string;
  planRevision: number;
  type: string;
  title: string;
  state: TaskState;
  sideEffectClass: SideEffectClass;
  definition: Record<string, unknown>;
  capabilityRequirements: Record<string, unknown>[];
  budget: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  idempotencyKey: string | null;
  stateVersion: number;
};

export type PlannerPort = {
  createPlan(goal: GoalRecord): Promise<PlanInput>;
};

export type ExecutionRequest = {
  task: RuntimeTask;
  attemptId: string;
  operationId: string;
  fencingToken: number;
  leaseId: string;
  planDigest: string;
  policyVersion: number;
  approval?: { requestId: string; grantId: string; expiresAt: number; boundedScope: ApprovalBounds };
};

export type ExecutionResult =
  | { status: "SUCCEEDED"; result: Record<string, unknown>; evidence: Record<string, unknown> }
  | {
      status: "UNCERTAIN";
      provider: string;
      operationKind: string;
      externalOperationId: string | null;
      expectedResource: Record<string, unknown>;
      lastObservedState: string;
      reconciliationStrategy: string;
    };

export type ExecutionPort = {
  supports(task: RuntimeTask): boolean;
  approvalRequest?(task: RuntimeTask): { requiredScope: ApprovalBounds; risk?: Record<string, unknown>; channelLimits?: Record<string, unknown> } | undefined;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  verify(request: ExecutionRequest & { result: Record<string, unknown> }): Promise<{ ok: boolean; evidence: Record<string, unknown> }>;
};

export type ReconciliationPort = {
  observe(record: ReconciliationRecord): Promise<{
    state: string;
    status: ReconciliationStatus;
    externalOperationId?: string | null;
    evidence?: Record<string, unknown>;
  }>;
};

type RuntimeTaskRow = {
  id: string;
  goal_id: string;
  plan_revision: number;
  type: string;
  title: string;
  state: TaskState;
  side_effect_class: SideEffectClass;
  definition_json: string;
  capability_requirements_json: string;
  budget_json: string;
  sandbox_json: string;
  idempotency_key: string | null;
  state_version: number;
};

type DispatchPayload = {
  taskId: string;
  attemptId: string;
  leaseId: string;
  fencingToken: number;
  operationId: string;
};

function safeRuntimeError(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_.:-]{3,100}$/.test(error.message)) return error.message;
  return "BACKGROUND_HANDLER_FAILED";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`INVALID_${field.toUpperCase()}`);
  return value;
}

export class OutboxDispatcher {
  private readonly store: OutboxStore;
  private readonly handlers: ReadonlyMap<string, (record: OutboxRecord) => Promise<void>>;
  private readonly maxAttempts: number;

  constructor(store: OutboxStore, handlers: ReadonlyMap<string, (record: OutboxRecord) => Promise<void>>, maxAttempts = 10) {
    this.store = store;
    this.handlers = handlers;
    this.maxAttempts = maxAttempts;
  }

  async dispatchOnce(limit = 20): Promise<number> {
    if (this.handlers.size === 0) return 0;
    const records = this.store.claimForTopics([...this.handlers.keys()], limit);
    for (const record of records) {
      const handler = this.handlers.get(record.topic)!;
      try {
        await handler(record);
        this.store.markDelivered(record.id, record.claimToken);
      } catch (error) {
        const retryMs = boundedExponentialBackoff(record.attemptCount, 1_000, 120_000, () => 0);
        this.store.markFailed(record.id, record.claimToken, safeRuntimeError(error), retryMs, this.maxAttempts);
      }
    }
    return records.length;
  }
}

export type OrchestratorRuntimeOptions = {
  planner?: PlannerPort;
  executor?: ExecutionPort;
  reconciliation?: ReconciliationPort;
  scheduleOwnerId?: string;
  clock?: () => number;
  tickMs?: number;
  maxOutboxAttempts?: number;
};

export class OrchestratorRuntime {
  private readonly db: OrchestratorDatabase;
  private readonly engine: TaskEngine;
  private readonly plannerService: PlanService;
  private readonly scheduleService: ScheduleService;
  private readonly reconciliationService: ReconciliationService;
  private readonly approvalService: ApprovalService;
  private readonly planner?: PlannerPort;
  private readonly executor?: ExecutionPort;
  private readonly reconciliation?: ReconciliationPort;
  private readonly scheduleOwnerId?: string;
  private readonly clock: () => number;
  private readonly tickMs: number;
  private readonly dispatcher: OutboxDispatcher;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(db: OrchestratorDatabase, engine: TaskEngine, options: OrchestratorRuntimeOptions = {}) {
    this.db = db;
    this.engine = engine;
    this.clock = options.clock ?? Date.now;
    this.plannerService = new PlanService(db, this.clock);
    this.scheduleService = new ScheduleService(db, this.clock);
    this.reconciliationService = new ReconciliationService(db, this.clock);
    this.approvalService = new ApprovalService(db, this.clock);
    this.planner = options.planner;
    this.executor = options.executor;
    this.reconciliation = options.reconciliation;
    this.scheduleOwnerId = options.scheduleOwnerId;
    this.tickMs = options.tickMs ?? 1_000;
    const handlers = new Map<string, (record: OutboxRecord) => Promise<void>>();
    if (this.planner) handlers.set("goal.plan.requested", (record) => this.handlePlan(record));
    if (this.executor) {
      handlers.set("task.estimate.requested", (record) => this.handleEstimate(record));
      handlers.set("job.dispatch.requested", (record) => this.handleDispatch(record));
      handlers.set("task.verify.requested", (record) => this.handleVerify(record));
    }
    this.dispatcher = new OutboxDispatcher(new OutboxStore(db, this.clock), handlers, options.maxOutboxAttempts ?? 10);
  }

  isReady(): boolean {
    return Boolean(this.planner && this.executor);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runCycle(); }, this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runUntilIdle(maxCycles = 100): Promise<number> {
    let total = 0;
    for (let index = 0; index < maxCycles; index += 1) {
      const progress = await this.runCycle();
      total += progress;
      if (progress === 0) return total;
    }
    throw new Error("RUNTIME_DID_NOT_QUIESCE");
  }

  async runCycle(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let progress = 0;
      progress += await this.dispatcher.dispatchOnce();
      progress += this.promoteApprovedTasks();
      progress += this.promoteDependencies();
      progress += this.dispatchReadyTask();
      progress += this.reapExpiredAttempts();
      progress += await this.reconcileOpenOperations();
      progress += this.projectGoalStates();
      progress += this.evaluateSchedules();
      return progress;
    } finally {
      this.running = false;
    }
  }

  private async handlePlan(record: OutboxRecord): Promise<void> {
    const goalId = requiredString(record.payload.goalId, "goal_id");
    const existing = this.engine.getGoal(goalId);
    if (!existing) throw new Error("GOAL_NOT_FOUND");
    if (existing.activePlanRevision !== null) return;
    const goal = this.engine.beginPlanning(goalId);
    const plan = await this.planner!.createPlan(goal);
    this.plannerService.activate(goalId, plan, "background-planner");
  }

  private async handleEstimate(record: OutboxRecord): Promise<void> {
    const taskId = requiredString(record.payload.taskId, "task_id");
    const task = this.getTask(taskId);
    if (!task) throw new Error("TASK_NOT_FOUND");
    if (["IDEMPOTENT_MUTATION", "NON_IDEMPOTENT_MUTATION"].includes(task.sideEffectClass)) {
      if (task.state === "ESTIMATING") {
        this.engine.transitionTask(task.id, "WAITING_APPROVAL", { type: "STATE_TRANSITION", actor: "background-estimator", reason: "mutation requires a bounded action grant" }, "ESTIMATING");
      } else if (task.state !== "WAITING_APPROVAL") return;
      const authority = this.taskAuthority(task.id);
      const existing = this.db.one("SELECT id FROM approval_requests WHERE task_id = ? AND plan_digest = ? AND policy_version = ? ORDER BY created_at DESC LIMIT 1", task.id, authority.digest, authority.policyVersion);
      if (existing) return;
      const request = this.executor?.approvalRequest?.(task);
      if (!request) throw new Error("APPROVAL_ROUTE_UNAVAILABLE");
      this.approvalService.createRequest({ goalId: task.goalId, taskId: task.id, planDigest: authority.digest, policyVersion: authority.policyVersion, requiredScope: request.requiredScope, risk: request.risk, channelLimits: request.channelLimits, expiresAt: this.clock() + 15 * 60_000, correlationId: `task:${task.id}:plan:${task.planRevision}` });
      return;
    }
    if (task.state !== "ESTIMATING") return;
    if (!this.executor!.supports(task)) throw new Error("EXECUTION_CAPABILITY_UNAVAILABLE");
    this.engine.transitionTask(task.id, "READY", { type: "STATE_TRANSITION", actor: "background-estimator", reason: "safe execution route is available" }, "ESTIMATING");
  }

  private async handleDispatch(record: OutboxRecord): Promise<void> {
    const payload = this.dispatchPayload(record.payload);
    let task = this.getTask(payload.taskId);
    if (!task) throw new Error("TASK_NOT_FOUND");
    const binding: AttemptBinding = { attemptId: payload.attemptId, leaseId: payload.leaseId, fencingToken: payload.fencingToken };
    if (["COMPLETED", "FAILED", "CANCELLED", "VERIFYING", "WAITING_RECONCILIATION"].includes(task.state)) return;
    if (task.state === "DISPATCHED") {
      this.engine.transitionTask(task.id, "RUNNING", { type: "STATE_TRANSITION", actor: "background-executor", reason: "offer accepted" }, "DISPATCHED", binding);
      task = this.getTask(task.id)!;
    }
    if (task.state !== "RUNNING") throw new Error("STATE_CONFLICT");
    if (!this.executor!.supports(task)) throw new Error("EXECUTION_CAPABILITY_UNAVAILABLE");
    const executionRequest = this.executionRequest(task, payload);
    const result = await this.executor!.execute(executionRequest);
    if (result.status === "UNCERTAIN") {
      this.reconciliationService.start({
        taskId: task.id,
        attemptId: payload.attemptId,
        provider: result.provider,
        operationKind: result.operationKind,
        idempotencyKey: payload.operationId,
        externalOperationId: result.externalOperationId,
        expectedResource: result.expectedResource,
        startedAt: this.clock(),
        lastObservedState: result.lastObservedState,
        reconciliationStrategy: result.reconciliationStrategy,
        request: task.definition,
      });
      this.engine.transitionTask(task.id, "WAITING_RECONCILIATION", { type: "EVIDENCE", actor: "background-executor", reason: "external effect is uncertain" }, "RUNNING", binding);
      return;
    }
    const verifying = this.engine.transitionTask(task.id, "VERIFYING", {
      type: "RESULT",
      actor: "background-executor",
      reason: "execution returned",
      evidence: { result: result.result, execution: result.evidence },
    }, "RUNNING", binding);
    enqueueOutbox(this.db, "task.verify.requested", "task", task.id, verifying.state_version, `task.verify.requested:${task.id}:${verifying.state_version}`, { ...payload }, this.clock());
  }

  private async handleVerify(record: OutboxRecord): Promise<void> {
    const payload = this.dispatchPayload(record.payload);
    const task = this.getTask(payload.taskId);
    if (!task) throw new Error("TASK_NOT_FOUND");
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.state)) return;
    if (task.state !== "VERIFYING") throw new Error("STATE_CONFLICT");
    if (!this.executor!.supports(task)) throw new Error("EXECUTION_CAPABILITY_UNAVAILABLE");
    const stored = this.db.one<{ result_json: string | null }>("SELECT result_json FROM tasks WHERE id = ?", task.id);
    const result = stored?.result_json ? JSON.parse(stored.result_json) as Record<string, unknown> : {};
    const verification = await this.executor!.verify({ ...this.executionRequest(task, payload), result });
    if (!verification.ok) {
      this.engine.transitionTask(task.id, "FAILED", { type: "RESULT", actor: "background-verifier", reason: "verification failed", evidence: verification.evidence }, "VERIFYING");
      return;
    }
    this.engine.transitionTask(task.id, "COMPLETED", { type: "RESULT", actor: "background-verifier", reason: "verification passed", evidence: { result, verification: verification.evidence } }, "VERIFYING");
  }

  private promoteDependencies(): number {
    const rows = this.db.all<{ id: string; goal_id: string; plan_revision: number }>(
      `SELECT t.id, t.goal_id, t.plan_revision FROM tasks t JOIN goals g ON g.id = t.goal_id
       WHERE t.state = 'PENDING' AND g.active_plan_revision = t.plan_revision
         AND NOT EXISTS (
           SELECT 1 FROM task_edges e JOIN tasks dependency ON dependency.id = e.from_task_id
           WHERE e.to_task_id = t.id AND dependency.state <> 'COMPLETED'
         )
       ORDER BY t.created_at, t.id`,
    );
    for (const row of rows) {
      const task = this.engine.transitionTask(row.id, "ESTIMATING", { type: "STATE_TRANSITION", actor: "dependency-reconciler", reason: "all dependencies completed" }, "PENDING");
      enqueueOutbox(this.db, "task.estimate.requested", "task", row.id, task.state_version, `task.estimate.requested:${row.id}:${row.plan_revision}`, { taskId: row.id, goalId: row.goal_id, planRevision: row.plan_revision }, this.clock());
    }
    return rows.length;
  }

  private promoteApprovedTasks(): number {
    const rows = this.db.all<{ id: string }>("SELECT id FROM tasks WHERE state = 'WAITING_APPROVAL' ORDER BY updated_at, id");
    let changed = 0;
    for (const row of rows) {
      const task = this.getTask(row.id);
      if (!task || !this.activeApproval(task)) continue;
      this.engine.transitionTask(task.id, "READY", { type: "STATE_TRANSITION", actor: "approval-reconciler", reason: "bounded approval grant is active" }, "WAITING_APPROVAL");
      changed += 1;
    }
    return changed;
  }

  private dispatchReadyTask(): number {
    if (!this.executor) return 0;
    const rows = this.db.all<RuntimeTaskRow>(
      `SELECT t.* FROM tasks t JOIN goals g ON g.id = t.goal_id
       WHERE t.state = 'READY' AND g.status = 'ACTIVE' AND g.active_plan_revision = t.plan_revision
         AND t.cancel_requested_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM task_edges e JOIN tasks dependency ON dependency.id = e.from_task_id
           WHERE e.to_task_id = t.id AND dependency.state <> 'COMPLETED'
         )
       ORDER BY t.priority, t.ready_at, t.id`,
    );
    const row = rows.find((candidate) => this.executor!.supports(this.fromTaskRow(candidate)));
    if (!row) return 0;
    const task = this.fromTaskRow(row);
    if (!["NONE", "READ_ONLY"].includes(task.sideEffectClass) && !this.activeApproval(task)) return 0;
    const now = this.clock();
    this.db.transaction(() => {
      const current = this.db.one<RuntimeTaskRow>("SELECT * FROM tasks WHERE id = ? AND state = 'READY'", task.id);
      if (!current) throw new Error("STATE_CONFLICT");
      const generation = Number(this.db.one<{ generation: number }>("SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM attempts WHERE task_id = ?", task.id)?.generation ?? 1);
      const attemptId = uuidv7(now);
      const leaseId = uuidv7(now);
      const fencingToken = Number(this.db.one<{ fencing_counter: number }>("SELECT fencing_counter FROM tasks WHERE id = ?", task.id)?.fencing_counter ?? 0) + 1;
      const operationId = task.idempotencyKey ?? `attempt:${attemptId}`;
      this.db.run("UPDATE tasks SET state = 'DISPATCHED', state_version = state_version + 1, fencing_counter = ?, updated_at = ? WHERE id = ? AND state = 'READY'", fencingToken, now, task.id);
      this.db.run("INSERT INTO attempts(id, task_id, generation, state, lease_id, fencing_token, started_at) VALUES (?, ?, ?, 'OFFERED', ?, ?, ?)", attemptId, task.id, generation, leaseId, fencingToken, now);
      this.db.run("INSERT INTO leases(id, resource_type, resource_id, task_id, attempt_id, fencing_token, issued_at, expires_at) VALUES (?, 'executor', ?, ?, ?, ?, ?, ?)", leaseId, `executor:${task.type}`, task.id, attemptId, fencingToken, now, now + 15_000);
      const sequence = Number(this.db.one<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?", task.id)?.sequence ?? 1);
      const nextVersion = current.state_version + 1;
      this.db.run(
        `INSERT INTO task_events(task_id, sequence, type, previous_state, new_state, actor, attempt_id, plan_digest, policy_version, payload_json, occurred_at)
         SELECT ?, ?, 'STATE_TRANSITION', 'READY', 'DISPATCHED', 'background-scheduler', ?, p.digest, g.policy_version, '{}', ?
         FROM tasks t JOIN goals g ON g.id = t.goal_id JOIN plans p ON p.goal_id = t.goal_id AND p.revision = t.plan_revision WHERE t.id = ?`,
        task.id,
        sequence,
        attemptId,
        now,
        task.id,
      );
      enqueueOutbox(this.db, "job.dispatch.requested", "task", task.id, nextVersion, `job.dispatch.requested:${task.id}:${attemptId}`, { taskId: task.id, attemptId, leaseId, fencingToken, operationId }, now);
    });
    return 1;
  }

  private reapExpiredAttempts(): number {
    const rows = this.db.all<{ id: string }>("SELECT id FROM leases WHERE released_at IS NULL AND expires_at <= ? ORDER BY expires_at, id", this.clock());
    for (const row of rows) this.expireAttempt(row.id);
    return rows.length;
  }

  private expireAttempt(leaseId: string): void {
    const now = this.clock();
    this.db.transaction(() => {
      const row = this.db.one<{ task_id: string; attempt_id: string | null; fencing_token: number; state: TaskState; state_version: number; side_effect_class: SideEffectClass; idempotency_key: string | null }>(
        `SELECT l.task_id, l.attempt_id, l.fencing_token, t.state, t.state_version, t.side_effect_class, t.idempotency_key
         FROM leases l JOIN tasks t ON t.id = l.task_id
         WHERE l.id = ? AND l.released_at IS NULL AND l.expires_at <= ?`,
        leaseId,
        now,
      );
      if (!row) return;
      this.db.run("UPDATE leases SET released_at = ? WHERE id = ? AND released_at IS NULL", now, leaseId);
      if (row.attempt_id) this.db.run("UPDATE attempts SET state = 'EXPIRED', ended_at = ? WHERE id = ?", now, row.attempt_id);
      if (!["DISPATCHED", "RUNNING", "RESUMING"].includes(row.state)) return;
      const safelyRetryable = row.state === "DISPATCHED" || ["NONE", "READ_ONLY"].includes(row.side_effect_class) || row.side_effect_class === "IDEMPOTENT_MUTATION" && Boolean(row.idempotency_key);
      const target: TaskState = safelyRetryable ? "READY" : "WAITING_RECONCILIATION";
      const nextVersion = row.state_version + 1;
      this.db.run("UPDATE tasks SET state = ?, state_version = ?, ready_at = CASE WHEN ? = 'READY' THEN ? ELSE ready_at END, updated_at = ? WHERE id = ?", target, nextVersion, target, now, now, row.task_id);
      const sequence = Number(this.db.one<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?", row.task_id)?.sequence ?? 1);
      this.db.run(
        `INSERT INTO task_events(task_id, sequence, type, previous_state, new_state, actor, attempt_id, plan_digest, policy_version, payload_json, occurred_at)
         SELECT ?, ?, 'STATE_TRANSITION', ?, ?, 'lease-reaper', ?, p.digest, g.policy_version, ?, ?
         FROM tasks t JOIN goals g ON g.id = t.goal_id LEFT JOIN plans p ON p.goal_id = t.goal_id AND p.revision = t.plan_revision WHERE t.id = ?`,
        row.task_id,
        sequence,
        row.state,
        target,
        row.attempt_id,
        JSON.stringify({ reason: "attempt lease expired", fencingToken: row.fencing_token }),
        now,
        row.task_id,
      );
      enqueueOutbox(this.db, "task.updated", "task", row.task_id, nextVersion, `task.updated:${row.task_id}:${nextVersion}`, { taskId: row.task_id, previousState: row.state, state: target, terminal: false }, now);
    });
  }

  private async reconcileOpenOperations(): Promise<number> {
    if (!this.reconciliation) return 0;
    const rows = this.db.all<{ id: string }>("SELECT id FROM reconciliation_records WHERE status IN ('OPEN', 'UNKNOWN') ORDER BY last_observed_at, id LIMIT 20");
    for (const row of rows) {
      const record = this.reconciliationService.get(row.id)!;
      const observed = await this.reconciliation.observe(record);
      const updated = this.reconciliationService.observe(record.id, observed.state, observed.status, observed.externalOperationId);
      const task = this.getTask(record.taskId);
      if (!task || task.state !== "WAITING_RECONCILIATION") continue;
      if (updated.status === "CONFIRMED") {
        const verifying = this.engine.transitionTask(task.id, "VERIFYING", { type: "EVIDENCE", actor: "reconciliation-loop", reason: "external effect confirmed", evidence: observed.evidence ?? {} }, "WAITING_RECONCILIATION");
        const attempt = record.attemptId ? this.db.one<{ lease_id: string | null; fencing_token: number | null }>("SELECT lease_id, fencing_token FROM attempts WHERE id = ?", record.attemptId) : undefined;
        if (record.attemptId && attempt?.lease_id && attempt.fencing_token !== null) {
          enqueueOutbox(this.db, "task.verify.requested", "task", task.id, verifying.state_version, `task.verify.requested:${task.id}:${verifying.state_version}`, { taskId: task.id, attemptId: record.attemptId, leaseId: attempt.lease_id, fencingToken: attempt.fencing_token, operationId: record.idempotencyKey }, this.clock());
        }
      } else if (updated.status === "ABSENT") {
        this.engine.transitionTask(task.id, "READY", { type: "EVIDENCE", actor: "reconciliation-loop", reason: "external effect absent and safe to retry", evidence: observed.evidence ?? {} }, "WAITING_RECONCILIATION");
      } else if (updated.status === "FAILED") {
        this.engine.transitionTask(task.id, "FAILED", { type: "EVIDENCE", actor: "reconciliation-loop", reason: "reconciliation failed", evidence: observed.evidence ?? {} }, "WAITING_RECONCILIATION");
      }
    }
    return rows.length;
  }

  private projectGoalStates(): number {
    const goals = this.db.all<{ id: string; status: string }>("SELECT id, status FROM goals WHERE active_plan_revision IS NOT NULL AND status NOT IN ('COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED')");
    let changed = 0;
    for (const goal of goals) {
      const counts = this.db.one<{ required_count: number; completed_count: number; failed_count: number; terminal_count: number; verifying_count: number }>(
        `SELECT COUNT(*) AS required_count,
          SUM(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
          SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN state IN ('COMPLETED', 'FAILED', 'CANCELLED') THEN 1 ELSE 0 END) AS terminal_count,
          SUM(CASE WHEN state IN ('VERIFYING', 'COMPLETED') THEN 1 ELSE 0 END) AS verifying_count
         FROM tasks WHERE goal_id = ? AND required = 1 AND plan_revision = (SELECT active_plan_revision FROM goals WHERE id = ?)`,
        goal.id,
        goal.id,
      );
      if (!counts || counts.required_count === 0) continue;
      let target = goal.status;
      if (goal.status === "CANCELLING" && counts.terminal_count === counts.required_count) target = "CANCELLED";
      else if (counts.failed_count > 0) target = "FAILED";
      else if (counts.completed_count === counts.required_count) target = "COMPLETED";
      else if (counts.verifying_count === counts.required_count) target = "VERIFYING";
      else if (goal.status !== "CANCELLING") target = "ACTIVE";
      if (target !== goal.status) {
        const now = this.clock();
        this.db.transaction(() => {
          const update = this.db.connection.prepare("UPDATE goals SET status = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND status = ?").run(target, now, goal.id, goal.status);
          if (Number(update.changes) !== 1) return;
          const version = Number(this.db.one<{ state_version: number }>("SELECT state_version FROM goals WHERE id = ?", goal.id)?.state_version ?? 0);
          enqueueOutbox(this.db, "goal.updated", "goal", goal.id, version, `goal.updated:${goal.id}:${version}`, { goalId: goal.id, previousStatus: goal.status, status: target }, now);
          changed += 1;
        });
      }
    }
    return changed;
  }

  private evaluateSchedules(): number {
    if (!this.scheduleOwnerId) return 0;
    return this.scheduleService.evaluateDue((template, dedupeKey) => {
      const intent = requiredString(template.intent, "schedule_intent");
      const input = parseGoalCreateInput({
        intent,
        source: { kind: "schedule", correlationId: dedupeKey },
        scope: Array.isArray(template.scope) ? template.scope.filter((value): value is string => typeof value === "string") : [],
        constraints: typeof template.constraints === "object" && template.constraints !== null ? template.constraints : {},
        memoryRequirement: ["required", "preferred", "none"].includes(String(template.memoryRequirement)) ? template.memoryRequirement : "preferred",
      });
      const created = this.engine.createGoal(input, this.scheduleOwnerId!, dedupeKey);
      return String(created.body.goalId);
    }, this.clock()).length;
  }

  private getTask(id: string): RuntimeTask | undefined {
    const row = this.db.one<RuntimeTaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    return row ? this.fromTaskRow(row) : undefined;
  }

  private fromTaskRow(row: RuntimeTaskRow): RuntimeTask {
    return {
      id: row.id,
      goalId: row.goal_id,
      planRevision: row.plan_revision,
      type: row.type,
      title: row.title,
      state: row.state,
      sideEffectClass: row.side_effect_class,
      definition: JSON.parse(row.definition_json),
      capabilityRequirements: JSON.parse(row.capability_requirements_json),
      budget: JSON.parse(row.budget_json),
      sandbox: JSON.parse(row.sandbox_json),
      idempotencyKey: row.idempotency_key,
      stateVersion: row.state_version,
    };
  }

  private dispatchPayload(payload: Record<string, unknown>): DispatchPayload {
    const fencingToken = Number(payload.fencingToken);
    if (!Number.isInteger(fencingToken) || fencingToken < 1) throw new Error("INVALID_FENCING_TOKEN");
    return {
      taskId: requiredString(payload.taskId, "task_id"),
      attemptId: requiredString(payload.attemptId, "attempt_id"),
      leaseId: requiredString(payload.leaseId, "lease_id"),
      fencingToken,
      operationId: requiredString(payload.operationId, "operation_id"),
    };
  }

  private executionRequest(task: RuntimeTask, payload: DispatchPayload): ExecutionRequest {
    const authority = this.taskAuthority(task.id);
    const approval = this.activeApproval(task);
    if (!["NONE", "READ_ONLY"].includes(task.sideEffectClass) && !approval) throw new Error("APPROVAL_GRANT_UNAVAILABLE");
    return { task, attemptId: payload.attemptId, operationId: payload.operationId, fencingToken: payload.fencingToken, leaseId: payload.leaseId, planDigest: authority.digest, policyVersion: authority.policyVersion, ...(approval ? { approval } : {}) };
  }

  private taskAuthority(taskId: string): { digest: string; policyVersion: number } {
    const authority = this.db.one<{ digest: string; policy_version: number }>(
      `SELECT p.digest, g.policy_version FROM tasks t JOIN goals g ON g.id = t.goal_id
       JOIN plans p ON p.goal_id = t.goal_id AND p.revision = t.plan_revision WHERE t.id = ?`,
      taskId,
    );
    if (!authority) throw new Error("EXECUTION_AUTHORITY_UNAVAILABLE");
    return { digest: authority.digest, policyVersion: authority.policy_version };
  }

  private activeApproval(task: RuntimeTask): ExecutionRequest["approval"] | undefined {
    const authority = this.taskAuthority(task.id);
    const row = this.db.one<{ request_id: string; grant_id: string; expires_at: number; bounded_scope_json: string }>(
      `SELECT r.id AS request_id, ag.id AS grant_id, ag.expires_at, ag.bounded_scope_json
       FROM approval_requests r JOIN approval_grants ag ON ag.request_id = r.id
       WHERE r.task_id = ? AND r.status = 'APPROVED' AND r.plan_digest = ? AND r.policy_version = ?
         AND ag.revoked_at IS NULL AND ag.expires_at > ?
       ORDER BY ag.issued_at DESC LIMIT 1`,
      task.id,
      authority.digest,
      authority.policyVersion,
      this.clock(),
    );
    return row ? { requestId: row.request_id, grantId: row.grant_id, expiresAt: row.expires_at, boundedScope: JSON.parse(row.bounded_scope_json) as ApprovalBounds } : undefined;
  }
}
