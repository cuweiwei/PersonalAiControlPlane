import { createHash } from "node:crypto";
import { canonicalJson, sha256, uuidv7 } from "../../../packages/crypto/src/index.ts";
import { type PlanInput, type PlanTaskInput, type SideEffectClass } from "../../../packages/contracts/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";

const SIDE_EFFECT_CLASSES: readonly SideEffectClass[] = ["NONE", "READ_ONLY", "IDEMPOTENT_MUTATION", "NON_IDEMPOTENT_MUTATION"];

export type PlanValidation = { valid: true; roots: string[] } | { valid: false; errors: string[] };

export function validatePlan(plan: PlanInput): PlanValidation {
  const errors: string[] = [];
  if (plan.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!Number.isInteger(plan.revision) || plan.revision < 1) errors.push("revision must be a positive integer");
  if (typeof plan.goalId !== "string" || plan.goalId.length === 0) errors.push("goalId is required");
  if (typeof plan.intent !== "string" || plan.intent.length === 0) errors.push("intent is required");
  if (!Array.isArray(plan.acceptanceCriteria) || plan.acceptanceCriteria.length === 0) errors.push("at least one acceptance criterion is required");
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    errors.push("at least one task is required");
    return { valid: false, errors };
  }

  const ids = new Set<string>();
  const taskMap = new Map<string, PlanTaskInput>();
  for (const task of plan.tasks) {
    if (!task || typeof task !== "object") {
      errors.push("task must be an object");
      continue;
    }
    if (typeof task.taskId !== "string" || task.taskId.length === 0) errors.push("taskId is required");
    if (typeof task.taskId === "string" && ids.has(task.taskId)) errors.push(`duplicate taskId: ${task.taskId}`);
    if (typeof task.taskId === "string") {
      ids.add(task.taskId);
      taskMap.set(task.taskId, task);
    }
    if (typeof task.type !== "string" || task.type.length === 0) errors.push(`task ${task.taskId ?? "?"} type is required`);
    if (typeof task.title !== "string" || task.title.length === 0) errors.push(`task ${task.taskId ?? "?"} title is required`);
    if (typeof task.required !== "boolean") errors.push(`task ${task.taskId ?? "?"} required must be boolean`);
    if (!SIDE_EFFECT_CLASSES.includes(task.sideEffectClass)) errors.push(`task ${task.taskId ?? "?"} sideEffectClass is invalid`);
    if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || task.dependsOn.some((dependency) => typeof dependency !== "string"))) {
      errors.push(`task ${task.taskId ?? "?"} dependsOn is invalid`);
    }
  }
  for (const task of plan.tasks) {
    if (typeof task.taskId !== "string") continue;
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.taskId) errors.push(`task ${task.taskId} cannot depend on itself`);
      else if (!taskMap.has(dependency)) errors.push(`task ${task.taskId} depends on missing task ${dependency}`);
    }
  }
  for (const criterion of plan.acceptanceCriteria ?? []) {
    if (!criterion || typeof criterion.id !== "string" || typeof criterion.description !== "string" || typeof criterion.verificationTaskId !== "string") {
      errors.push("acceptance criteria require id, description, and verificationTaskId");
    } else if (!taskMap.has(criterion.verificationTaskId)) {
      errors.push(`acceptance criterion ${criterion.id} references missing verification task ${criterion.verificationTaskId}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) {
      errors.push(`task dependency cycle includes ${taskId}`);
      return;
    }
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of taskMap.get(taskId)?.dependsOn ?? []) if (taskMap.has(dependency)) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of taskMap.keys()) visit(taskId);
  const roots = [...taskMap.values()].filter((task) => (task.dependsOn ?? []).length === 0).map((task) => task.taskId);
  if (roots.length === 0) errors.push("plan must contain at least one root task");
  return errors.length > 0 ? { valid: false, errors } : { valid: true, roots };
}

export class PlanService {
  private readonly db: OrchestratorDatabase;
  private readonly clock: () => number;

  constructor(db: OrchestratorDatabase, clock: () => number = Date.now) {
    this.db = db;
    this.clock = clock;
  }

  activate(goalId: string, plan: PlanInput, actor = "planner"): { revision: number; digest: string; roots: string[] } {
    if (plan.goalId !== goalId) throw this.error("PLAN_GOAL_MISMATCH");
    const validation = validatePlan(plan);
    if (!validation.valid) throw this.error(`INVALID_PLAN:${validation.errors.join(";")}`);
    const goal = this.db.one<{ id: string; active_plan_revision: number | null; policy_version: number }>(
      "SELECT id, active_plan_revision, policy_version FROM goals WHERE id = ?",
      goalId,
    );
    if (!goal) throw this.error("GOAL_NOT_FOUND");
    if (goal.active_plan_revision !== null && plan.revision <= goal.active_plan_revision) throw this.error("PLAN_REVISION_CONFLICT");
    const now = this.clock();
    const normalizedPlan = { ...plan, createdAt: plan.createdAt ?? new Date(now).toISOString() };
    const digest = sha256(canonicalJson(normalizedPlan as never));
    const planJson = JSON.stringify(normalizedPlan);
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO plans(goal_id, revision, plan_json, digest, created_at) VALUES (?, ?, ?, ?, ?)",
        goalId,
        plan.revision,
        planJson,
        digest,
        now,
      );
      for (const task of plan.tasks) {
        const state = (task.dependsOn ?? []).length === 0 ? "ESTIMATING" : "PENDING";
        this.db.run(
          `INSERT INTO tasks
           (id, goal_id, plan_revision, type, title, state, priority, required, side_effect_class,
            definition_json, capability_requirements_json, budget_json, sandbox_json, retry_policy_json,
            verification_json, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          task.taskId,
          goalId,
          plan.revision,
          task.type,
          task.title,
          state,
          task.required ? 1 : 0,
          task.sideEffectClass,
          JSON.stringify(task),
          JSON.stringify(task.capabilityRequirements ?? []),
          JSON.stringify(task.budget ?? {}),
          JSON.stringify(task.sandbox ?? {}),
          JSON.stringify(task.retryPolicy ?? {}),
          JSON.stringify(task.verification ?? {}),
          task.idempotencyKey ?? null,
          now,
          now,
        );
        for (const dependency of task.dependsOn ?? []) {
          this.db.run(
            "INSERT INTO task_edges(goal_id, plan_revision, from_task_id, to_task_id) VALUES (?, ?, ?, ?)",
            goalId,
            plan.revision,
            dependency,
            task.taskId,
          );
        }
      }
      this.db.run(
        "UPDATE goals SET status = 'ACTIVE', active_plan_revision = ?, state_version = state_version + 1, updated_at = ? WHERE id = ?",
        plan.revision,
        now,
        goalId,
      );
      this.db.run(
        `INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at)
         VALUES (?, 'plan.activated', 'goal', ?, ?, ?, ?, ?)`,
        uuidv7(now),
        goalId,
        plan.revision,
        `plan.activated:${goalId}:${plan.revision}`,
        JSON.stringify({ goalId, revision: plan.revision, digest, roots: validation.roots }),
        now,
      );
      for (const root of validation.roots) {
        this.db.run(
          `INSERT INTO outbox(id, topic, aggregate_type, aggregate_id, aggregate_version, dedupe_key, payload_json, available_at)
           VALUES (?, 'task.estimate.requested', 'task', ?, 0, ?, ?, ?)`,
          uuidv7(now),
          root,
          `task.estimate.requested:${root}:${plan.revision}`,
          JSON.stringify({ taskId: root, goalId, planRevision: plan.revision }),
          now,
        );
      }
      const auditEventId = uuidv7(now);
      const previous = this.db.one<{ hash: string }>("SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1");
      const auditPayload = {
        eventId: auditEventId,
        actor,
        action: "plan.activated",
        target: `goal:${goalId}`,
        decision: "ALLOW",
        policyVersion: goal.policy_version,
        metadata: { revision: plan.revision, digest, roots: validation.roots },
        previousHash: previous?.hash ?? null,
        occurredAt: now,
      };
      const auditHash = createHash("sha256").update(canonicalJson(auditPayload as never)).digest("hex");
      this.db.run(
        `INSERT INTO audit_events(event_id, actor, action, target, decision, policy_version, metadata_json, previous_hash, hash, occurred_at)
         VALUES (?, ?, 'plan.activated', ?, 'ALLOW', ?, ?,
                 (SELECT hash FROM audit_events ORDER BY sequence DESC LIMIT 1), ?, ?)` ,
        auditEventId,
        actor,
        `goal:${goalId}`,
        goal.policy_version,
        JSON.stringify({ revision: plan.revision, digest, roots: validation.roots }),
        auditHash,
        now,
      );
    });
    return { revision: plan.revision, digest, roots: validation.roots };
  }

  private error(code: string): Error & { code: string } {
    const error = new Error(code) as Error & { code: string };
    error.code = code;
    return error;
  }
}
