import { createHash } from "node:crypto";
import { canonicalJson, uuidv7 } from "../../../packages/crypto/src/index.ts";
import {
  type GoalCreateInput,
  type GoalRecord,
  type GoalState,
  type TaskEvent,
  type TaskState,
} from "../../../packages/contracts/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";

const GOAL_STATUS = "PENDING" as GoalState;

const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  PENDING: ["ESTIMATING", "CANCELLED", "FAILED"],
  ESTIMATING: ["WAITING_APPROVAL", "READY", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["READY", "CANCELLED", "FAILED"],
  READY: ["DISPATCHED", "WAITING_RESOURCE", "WAITING_QUOTA", "WAITING_AUTH", "CANCELLED", "FAILED"],
  DISPATCHED: ["RUNNING", "RESUMING", "READY", "CANCELLED", "FAILED"],
  RUNNING: [
    "CHECKPOINTED",
    "WAITING_RESOURCE",
    "WAITING_QUOTA",
    "WAITING_AUTH",
    "WAITING_RECONCILIATION",
    "VERIFYING",
    "FAILED",
    "CANCELLED",
  ],
  WAITING_RESOURCE: ["READY", "CANCELLED", "FAILED"],
  WAITING_QUOTA: ["READY", "CANCELLED", "FAILED"],
  WAITING_AUTH: ["READY", "CANCELLED", "FAILED"],
  WAITING_RECONCILIATION: ["READY", "VERIFYING", "FAILED", "CANCELLED"],
  CHECKPOINTED: ["READY", "CANCELLED", "FAILED"],
  RESUMING: ["RUNNING", "CHECKPOINTED", "WAITING_RESOURCE", "WAITING_QUOTA", "WAITING_AUTH", "WAITING_RECONCILIATION", "FAILED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "READY", "FAILED", "WAITING_APPROVAL"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

const terminalTaskStates = new Set<TaskState>(["COMPLETED", "FAILED", "CANCELLED"]);

type StoredGoalRow = {
  id: string;
  owner_id: string;
  source_json: string;
  intent: string;
  scope_json: string;
  constraints_json: string;
  memory_requirement: GoalRecord["memoryRequirement"];
  status: GoalState;
  active_plan_revision: number | null;
  state_version: number;
  policy_version: number;
  created_at: number;
  updated_at: number;
};

type StoredTaskRow = {
  id: string;
  goal_id: string;
  plan_revision: number;
  type: string;
  title: string;
  state: TaskState;
  priority: number;
  required: number;
  side_effect_class: string;
  state_version: number;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
};

export type AttemptBinding = {
  attemptId: string;
  leaseId: string;
  fencingToken: number;
};

function requestHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input as never)).digest("hex");
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export class TaskEngine {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;

  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  createGoal(
    input: GoalCreateInput,
    ownerId: string,
    idempotencyKey: string,
  ): { status: number; body: Record<string, unknown>; replayed: boolean } {
    const route = "POST /api/v1/goals";
    const hash = requestHash({ input, ownerId });
    const existing = this.db.one<{ request_hash: string; response_status: number; response_json: string }>(
      "SELECT request_hash, response_status, response_json FROM idempotency_records WHERE actor_id = ? AND route = ? AND key = ?",
      ownerId,
      route,
      idempotencyKey,
    );
    if (existing) {
      if (existing.request_hash !== hash) {
        const error = new Error("IDEMPOTENCY_CONFLICT");
        (error as Error & { code?: string }).code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return { status: existing.response_status, body: JSON.parse(existing.response_json), replayed: true };
    }

    const id = uuidv7(this.clock());
    const createdAt = this.clock();
    const response = {
      goalId: id,
      status: GOAL_STATUS,
      submittedAt: nowIso(createdAt),
      links: {
        self: `/api/v1/goals/${id}`,
        tasks: `/api/v1/goals/${id}/tasks`,
        events: `/api/v1/goals/${id}/events`,
      },
    };

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO goals
         (id, owner_id, source_json, intent, scope_json, constraints_json, memory_requirement,
          status, active_plan_revision, state_version, policy_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?)`,
        id,
        ownerId,
        JSON.stringify(input.source),
        input.intent,
        JSON.stringify(input.scope ?? []),
        JSON.stringify(input.constraints ?? {}),
        input.memoryRequirement ?? "preferred",
        GOAL_STATUS,
        createdAt,
        createdAt,
      );
      this.db.run(
        `INSERT INTO idempotency_records(actor_id, route, key, request_hash, response_status, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ownerId,
        route,
        idempotencyKey,
        hash,
        202,
        JSON.stringify(response),
        createdAt,
      );
      this.db.run(
        `INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at)
         VALUES (?, 'goal.plan.requested', 'goal', ?, 0, ?, ?, ?)`,
        uuidv7(createdAt),
        id,
        `goal.plan.requested:${id}`,
        JSON.stringify({ goalId: id, ownerId, planRequired: true }),
        createdAt,
      );
      this.appendAudit("goal.created", `goal:${id}`, ownerId, "ALLOW", 1, { source: input.source.kind });
    });
    return { status: 202, body: response, replayed: false };
  }

  getGoal(id: string): GoalRecord | undefined {
    const row = this.db.one<StoredGoalRow>("SELECT * FROM goals WHERE id = ?", id);
    return row ? this.goalFromRow(row) : undefined;
  }

  listGoals(ownerId: string, limit = 100): GoalRecord[] {
    return this.db.all<StoredGoalRow>("SELECT * FROM goals WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?", ownerId, limit).map((row) => this.goalFromRow(row));
  }

  beginPlanning(goalId: string): GoalRecord {
    const current = this.getGoal(goalId);
    if (!current) throw this.domainError("GOAL_NOT_FOUND", false);
    if (current.activePlanRevision !== null || current.status === "PLANNING") return current;
    const now = this.clock();
    const changed = this.db.connection.prepare(
      "UPDATE goals SET status = 'PLANNING', state_version = state_version + 1, updated_at = ? WHERE id = ? AND status = 'PENDING'",
    ).run(now, goalId);
    if (Number(changed.changes) !== 1) {
      throw this.domainError("STATE_CONFLICT", false);
    }
    return this.getGoal(goalId)!;
  }

  listTasks(goalId: string): StoredTaskRow[] {
    return this.db.all<StoredTaskRow>("SELECT * FROM tasks WHERE goal_id = ? ORDER BY created_at, id", goalId);
  }

  listPlans(goalId: string): Record<string, unknown>[] {
    return this.db.all("SELECT goal_id, revision, digest, created_at, plan_json FROM plans WHERE goal_id = ? ORDER BY revision", goalId).map((row) => ({ goalId: row.goal_id, revision: row.revision, digest: row.digest, createdAt: nowIso(Number(row.created_at)), plan: JSON.parse(String(row.plan_json)) }));
  }

  retryGoal(goalId: string, actor: string, idempotencyKey: string): { status: number; body: GoalRecord; replayed: boolean } {
    const route = `POST /api/v1/goals/${goalId}/retry`;
    const hash = requestHash({ goalId, actor });
    const existing = this.db.one<{ request_hash: string; response_status: number; response_json: string }>("SELECT request_hash, response_status, response_json FROM idempotency_records WHERE actor_id = ? AND route = ? AND key = ?", actor, route, idempotencyKey);
    if (existing) {
      if (existing.request_hash !== hash) throw this.domainError("IDEMPOTENCY_CONFLICT", false);
      return { status: existing.response_status, body: JSON.parse(existing.response_json), replayed: true };
    }
    const goal = this.getGoal(goalId);
    if (!goal) throw this.domainError("GOAL_NOT_FOUND", false);
    if (goal.status !== "FAILED") throw this.domainError("STATE_CONFLICT", false);
    const failedTasks = this.db.all<{ id: string; error_json: string | null }>("SELECT id, error_json FROM tasks WHERE goal_id = ? AND state = 'FAILED'", goalId);
    if (failedTasks.length === 0) throw this.domainError("STATE_CONFLICT", false);
    for (const task of failedTasks) {
      const errorClass = task.error_json ? (JSON.parse(task.error_json) as { class?: string }).class : undefined;
      if (["POLICY", "UNCERTAIN_SIDE_EFFECT", "PERMANENT"].includes(errorClass ?? "")) throw this.domainError("RETRY_REQUIRES_RECONCILIATION_OR_APPROVAL", false);
    }
    const now = this.clock();
    this.db.transaction(() => {
      this.db.run("UPDATE goals SET status = 'ACTIVE', state_version = state_version + 1, updated_at = ? WHERE id = ? AND status = 'FAILED'", now, goalId);
      for (const task of failedTasks) {
        const current = this.db.one<{ state_version: number; plan_revision: number }>("SELECT state_version, plan_revision FROM tasks WHERE id = ?", task.id)!;
        this.db.run("UPDATE tasks SET state = 'READY', state_version = state_version + 1, ready_at = ?, error_json = NULL, updated_at = ? WHERE id = ? AND state = 'FAILED'", now, now, task.id);
        const sequence = Number(this.db.one<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?", task.id)?.sequence ?? 1);
        const plan = this.db.one<{ digest: string }>("SELECT digest FROM plans WHERE goal_id = ? AND revision = ?", goalId, current.plan_revision);
        this.db.run("INSERT INTO task_events(task_id, sequence, type, previous_state, new_state, actor, plan_digest, policy_version, payload_json, occurred_at) SELECT ?, ?, 'STATE_TRANSITION', 'FAILED', 'READY', ?, ?, g.policy_version, ?, ? FROM goals g WHERE g.id = ?", task.id, sequence, actor, plan?.digest ?? null, JSON.stringify({ reason: "explicit retry" }), now, goalId);
        this.db.run("INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at) VALUES (?, 'task.ready', 'task', ?, ?, ?, ?, ?)", uuidv7(now), task.id, current.state_version + 1, `task.ready:${task.id}:${current.state_version + 1}`, JSON.stringify({ taskId: task.id, goalId }), now);
      }
      const response = this.getGoal(goalId)!;
      this.db.run("INSERT INTO idempotency_records(actor_id, route, key, request_hash, response_status, response_json, created_at) VALUES (?, ?, ?, ?, 202, ?, ?)", actor, route, idempotencyKey, hash, JSON.stringify(response), now);
      this.appendAudit("goal.retry.requested", `goal:${goalId}`, actor, "ALLOW", goal.policyVersion, { taskCount: failedTasks.length });
    });
    return { status: 202, body: this.getGoal(goalId)!, replayed: false };
  }

  listTaskEvents(taskId: string): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence", taskId);
  }

  listGoalEvents(goalId: string): Record<string, unknown>[] {
    return this.db.all(
      `SELECT e.task_id, e.sequence, e.type, e.previous_state, e.new_state, e.actor,
              e.attempt_id, e.plan_digest, e.policy_version, e.payload_json, e.occurred_at
       FROM task_events e JOIN tasks t ON t.id = e.task_id
       WHERE t.goal_id = ? ORDER BY e.occurred_at, e.task_id, e.sequence`,
      goalId,
    );
  }

  requestGoalCancellation(
    goalId: string,
    actor: string,
    idempotencyKey?: string,
  ): GoalRecord | { status: number; body: GoalRecord; replayed: boolean } {
    const route = `POST /api/v1/goals/${goalId}/cancel`;
    const hash = idempotencyKey ? requestHash({ goalId, actor }) : null;
    if (idempotencyKey && hash) {
      const existing = this.db.one<{ request_hash: string; response_status: number; response_json: string }>(
        "SELECT request_hash, response_status, response_json FROM idempotency_records WHERE actor_id = ? AND route = ? AND key = ?",
        actor,
        route,
        idempotencyKey,
      );
      if (existing) {
        if (existing.request_hash !== hash) throw this.domainError("IDEMPOTENCY_CONFLICT", false);
        return { status: existing.response_status, body: JSON.parse(existing.response_json), replayed: true };
      }
    }
    const goal = this.getGoal(goalId);
    if (!goal) throw this.domainError("GOAL_NOT_FOUND", false);
    if (["COMPLETED", "FAILED", "REJECTED", "CANCELLED"].includes(goal.status)) {
      if (idempotencyKey && hash) {
        this.db.transaction(() => {
          this.db.run(
            `INSERT INTO idempotency_records(actor_id, route, key, request_hash, response_status, response_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            actor,
            route,
            idempotencyKey,
            hash,
            202,
            JSON.stringify(goal),
            this.clock(),
          );
        });
      }
      return idempotencyKey ? { status: 202, body: goal, replayed: false } : goal;
    }
    const occurredAt = this.clock();
    this.db.transaction(() => {
      const current = this.db.one<StoredGoalRow>("SELECT * FROM goals WHERE id = ?", goalId);
      if (!current) throw this.domainError("GOAL_NOT_FOUND", false);
      if (current.status !== "CANCELLING" && !["COMPLETED", "FAILED", "REJECTED", "CANCELLED"].includes(current.status)) {
        this.db.run(
          "UPDATE goals SET status = 'CANCELLING', state_version = state_version + 1, updated_at = ? WHERE id = ?",
          occurredAt,
          goalId,
        );
        this.db.run(
          `INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at)
           VALUES (?, 'goal.cancel.requested', 'goal', ?, ?, ?, ?, ?)`,
          uuidv7(occurredAt),
          goalId,
          current.state_version + 1,
          `goal.cancel.requested:${goalId}:${current.state_version + 1}`,
          JSON.stringify({ goalId, actor }),
          occurredAt,
        );
        this.appendAudit("goal.cancel.requested", `goal:${goalId}`, actor, "ALLOW", current.policy_version, {});
      }
      const response = this.getGoal(goalId)!;
      if (idempotencyKey && hash) {
        this.db.run(
          `INSERT INTO idempotency_records(actor_id, route, key, request_hash, response_status, response_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          actor,
          route,
          idempotencyKey,
          hash,
          202,
          JSON.stringify(response),
          occurredAt,
        );
      }
    });
    const response = this.getGoal(goalId)!;
    return idempotencyKey ? { status: 202, body: response, replayed: false } : response;
  }

  transitionTask(
    taskId: string,
    target: TaskState,
    event: TaskEvent,
    expectedState?: TaskState,
    attemptBinding?: AttemptBinding,
  ): StoredTaskRow {
    const current = this.db.one<StoredTaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!current) throw this.domainError("TASK_NOT_FOUND", false);
    if (expectedState && current.state !== expectedState) throw this.domainError("STATE_CONFLICT", false);
    if (!TASK_TRANSITIONS[current.state].includes(target)) throw this.domainError("INVALID_STATE_TRANSITION", false);
    const occurredAt = this.clock();
    const result = this.db.transaction(() => {
      const latest = this.db.one<StoredTaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
      if (!latest || latest.state !== current.state || latest.state_version !== current.state_version) {
        throw this.domainError("STATE_CONFLICT", false);
      }
      const planGuard = this.db.one<{ plan_revision: number; active_plan_revision: number | null }>(
        `SELECT t.plan_revision, g.active_plan_revision
         FROM tasks t JOIN goals g ON g.id = t.goal_id WHERE t.id = ?`,
        taskId,
      );
      if (!planGuard || (planGuard.active_plan_revision !== null && planGuard.active_plan_revision !== planGuard.plan_revision)) {
        throw this.domainError("STALE_PLAN", false);
      }
      const attemptOwned = ["DISPATCHED", "RUNNING", "RESUMING"].includes(latest.state);
      if (attemptOwned && !attemptBinding) throw this.domainError("ATTEMPT_BINDING_REQUIRED", false);
      if (attemptBinding) {
        const binding = this.db.one<{ attempt_state: string; lease_expires_at: number; released_at: number | null }>(
          `SELECT a.state AS attempt_state, l.expires_at AS lease_expires_at, l.released_at
           FROM attempts a JOIN leases l ON l.id = a.lease_id
           WHERE a.id = ? AND a.task_id = ? AND a.lease_id = ? AND a.fencing_token = ?
             AND l.attempt_id = a.id AND l.task_id = a.task_id AND l.fencing_token = a.fencing_token`,
          attemptBinding.attemptId,
          taskId,
          attemptBinding.leaseId,
          attemptBinding.fencingToken,
        );
        if (!binding || binding.released_at !== null || binding.lease_expires_at <= occurredAt) {
          throw this.domainError("STALE_FENCE", false);
        }
      }
      const nextVersion = latest.state_version + 1;
      const sequenceRow = this.db.one<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?",
        taskId,
      );
      const sequence = Number(sequenceRow?.sequence ?? 1);
      this.db.run(
        `UPDATE tasks SET state = ?, state_version = ?, updated_at = ?,
         ready_at = CASE WHEN ? = 'READY' THEN ? ELSE ready_at END,
         cancel_requested_at = CASE WHEN ? = 'CANCELLED' THEN ? ELSE cancel_requested_at END,
         result_json = CASE WHEN ? IN ('VERIFYING', 'COMPLETED') THEN ? ELSE result_json END,
         error_json = CASE WHEN ? = 'FAILED' THEN ? ELSE error_json END
         WHERE id = ?`,
        target,
        nextVersion,
        occurredAt,
        target,
        occurredAt,
        target,
        occurredAt,
        target,
        JSON.stringify(event.evidence ?? {}),
        target,
        JSON.stringify({ reason: event.reason ?? "task failed", evidence: event.evidence ?? {} }),
        taskId,
      );
      if (attemptBinding) {
        const attemptState = target === "RUNNING" || target === "RESUMING"
          ? "RUNNING"
          : target === "VERIFYING"
            ? "SUCCEEDED"
            : target === "READY"
              ? "RETRYABLE"
              : ["FAILED", "CANCELLED"].includes(target)
                ? target
                : null;
        if (attemptState) {
          this.db.run(
            `UPDATE attempts SET state = ?, started_at = CASE WHEN ? = 'RUNNING' THEN COALESCE(started_at, ?) ELSE started_at END,
             ended_at = CASE WHEN ? IN ('SUCCEEDED', 'RETRYABLE', 'FAILED', 'CANCELLED') THEN ? ELSE ended_at END,
             result_class = CASE WHEN ? = 'SUCCEEDED' THEN 'SUCCESS' ELSE result_class END
             WHERE id = ?`,
            attemptState,
            attemptState,
            occurredAt,
            attemptState,
            occurredAt,
            attemptState,
            attemptBinding.attemptId,
          );
        }
        if (["VERIFYING", "WAITING_RECONCILIATION", "READY", "FAILED", "CANCELLED"].includes(target)) {
          this.db.run(
            "UPDATE leases SET released_at = ? WHERE id = ? AND fencing_token = ? AND released_at IS NULL",
            occurredAt,
            attemptBinding.leaseId,
            attemptBinding.fencingToken,
          );
        }
      }
      this.db.run(
        `INSERT INTO task_events
         (task_id, sequence, type, previous_state, new_state, actor, attempt_id, plan_digest, policy_version, payload_json, occurred_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, p.digest, g.policy_version, ?, ?
         FROM tasks t JOIN goals g ON g.id = t.goal_id
         LEFT JOIN plans p ON p.goal_id = t.goal_id AND p.revision = t.plan_revision
         WHERE t.id = ?`,
        taskId,
        sequence,
        event.type,
        latest.state,
        target,
        event.actor,
        attemptBinding?.attemptId ?? null,
        JSON.stringify({ reason: event.reason, evidence: event.evidence ?? {} }),
        occurredAt,
        taskId,
      );
      this.db.run(
        `INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at)
         VALUES (?, 'task.updated', 'task', ?, ?, ?, ?, ?)`,
        uuidv7(occurredAt),
        taskId,
        nextVersion,
        `task.updated:${taskId}:${nextVersion}`,
        JSON.stringify({ taskId, previousState: latest.state, state: target, terminal: terminalTaskStates.has(target) }),
        occurredAt,
      );
      if (terminalTaskStates.has(target)) {
        this.db.run(
          "UPDATE leases SET released_at = ? WHERE task_id = ? AND released_at IS NULL",
          occurredAt,
          taskId,
        );
      }
      return this.db.one<StoredTaskRow>("SELECT * FROM tasks WHERE id = ?", taskId)!;
    });
    return result;
  }

  appendAudit(action: string, target: string, actor: string, decision: string, policyVersion: number, metadata: Record<string, unknown>): void {
    const previous = this.db.one<{ hash: string }>("SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1");
    const eventId = uuidv7(this.clock());
    const occurredAt = this.clock();
    const payload = canonicalJson({ eventId, actor, action, target, decision, policyVersion, metadata, previousHash: previous?.hash ?? null, occurredAt } as never);
    const hash = createHash("sha256").update(payload).digest("hex");
    this.db.run(
      `INSERT INTO audit_events(event_id, actor, action, target, decision, policy_version, metadata_json, previous_hash, hash, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      actor,
      action,
      target,
      decision,
      policyVersion,
      JSON.stringify(metadata),
      previous?.hash ?? null,
      hash,
      occurredAt,
    );
  }

  verifyAuditChain(): boolean {
    let previousHash: string | null = null;
    const events = this.db.all<{
      event_id: string;
      actor: string;
      action: string;
      target: string;
      decision: string;
      policy_version: number;
      metadata_json: string;
      previous_hash: string | null;
      hash: string;
      occurred_at: number;
    }>("SELECT * FROM audit_events ORDER BY sequence");
    for (const event of events) {
      if (event.previous_hash !== previousHash) return false;
      const payload = canonicalJson({
        eventId: event.event_id,
        actor: event.actor,
        action: event.action,
        target: event.target,
        decision: event.decision,
        policyVersion: event.policy_version,
        metadata: JSON.parse(event.metadata_json),
        previousHash: event.previous_hash,
        occurredAt: event.occurred_at,
      } as never);
      const expected = createHash("sha256").update(payload).digest("hex");
      if (expected !== event.hash) return false;
      previousHash = event.hash;
    }
    return true;
  }

  private goalFromRow(row: StoredGoalRow): GoalRecord {
    return {
      id: row.id,
      ownerId: row.owner_id,
      source: JSON.parse(row.source_json),
      intent: row.intent,
      scope: JSON.parse(row.scope_json),
      constraints: JSON.parse(row.constraints_json),
      memoryRequirement: row.memory_requirement,
      status: row.status,
      activePlanRevision: row.active_plan_revision ?? null,
      stateVersion: row.state_version,
      policyVersion: row.policy_version,
      createdAt: nowIso(row.created_at),
      updatedAt: nowIso(row.updated_at),
    };
  }

  private domainError(code: string, retryable: boolean): Error & { code: string; retryable: boolean } {
    const error = new Error(code) as Error & { code: string; retryable: boolean };
    error.code = code;
    error.retryable = retryable;
    return error;
  }
}

export { TASK_TRANSITIONS };
