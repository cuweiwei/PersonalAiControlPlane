import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { PlanService } from "../apps/orchestrator/src/plan-service.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";
import { parseGoalCreateInput, type GoalCreateInput } from "../packages/contracts/src/index.ts";

function input(intent = "test goal"): GoalCreateInput {
  return {
    intent,
    source: { kind: "web", correlationId: "test-message" },
    scope: ["personal"],
    constraints: { maxMonetaryMicros: 0, allowedWorkers: [], allowDeployment: false },
    memoryRequirement: "none",
  };
}

test("goal admission commits before planning and is idempotent", () => {
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => 1_700_000_000_000);

  const first = engine.createGoal(input(), "owner-1", "goal-key");
  assert.equal(first.status, 202);
  assert.equal(first.replayed, false);
  assert.equal(engine.getGoal(String(first.body.goalId))?.status, "PENDING");
  assert.equal(db.one("SELECT COUNT(*) AS count FROM outbox WHERE topic = 'goal.plan.requested'")?.count, 1);
  assert.equal(engine.verifyAuditChain(), true);

  const replay = engine.createGoal(input(), "owner-1", "goal-key");
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);

  assert.throws(
    () => engine.createGoal(input("different"), "owner-1", "goal-key"),
    (error: Error & { code?: string }) => error.code === "IDEMPOTENCY_CONFLICT",
  );
  db.close();
});

test("task transitions append event and outbox atomically", () => {
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => 1_700_000_000_000);
  const goal = engine.createGoal(input(), "owner-1", "goal-key");
  const goalId = String(goal.body.goalId);
  const plan = { schemaVersion: 1, goalId, revision: 1, tasks: [] };
  db.transaction(() => {
    db.run("INSERT INTO plans(goal_id, revision, plan_json, digest, created_at) VALUES (?, 1, ?, 'sha256:plan', ?)", goalId, JSON.stringify(plan), 1_700_000_000_000);
    db.run("INSERT INTO tasks(id, goal_id, plan_revision, type, title, state, created_at, updated_at) VALUES ('task-1', ?, 1, 'test', 'Test task', 'ESTIMATING', ?, ?)", goalId, 1_700_000_000_000, 1_700_000_000_000);
  });

  const transitioned = engine.transitionTask("task-1", "READY", { type: "STATE_TRANSITION", actor: "test", reason: "estimate complete" }, "ESTIMATING");
  assert.equal(transitioned.state, "READY");
  assert.equal(db.one("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'task-1'")?.count, 1);
  assert.equal(db.one("SELECT COUNT(*) AS count FROM outbox WHERE topic = 'task.updated'")?.count, 1);
  assert.equal(engine.verifyAuditChain(), true);
  assert.throws(
    () => engine.transitionTask("task-1", "RUNNING", { type: "STATE_TRANSITION", actor: "stale" }, "ESTIMATING"),
    (error: Error & { code?: string }) => error.code === "STATE_CONFLICT",
  );
  db.close();
});

test("audit chain detects tampering", () => {
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => 1_700_000_000_000);
  engine.createGoal(input(), "owner-1", "audit-key");
  assert.equal(engine.verifyAuditChain(), true);
  db.run("UPDATE audit_events SET metadata_json = '{\"tampered\":true}' WHERE sequence = 1");
  assert.equal(engine.verifyAuditChain(), false);
  db.close();
});

test("goal cancellation is durable and idempotent by state", () => {
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => 1_700_000_000_000);
  const goal = engine.createGoal(input(), "owner-1", "goal-key");
  const goalId = String(goal.body.goalId);
  assert.equal(engine.requestGoalCancellation(goalId, "owner-1").status, "CANCELLING");
  assert.equal(engine.requestGoalCancellation(goalId, "owner-1").status, "CANCELLING");
  assert.equal(db.one("SELECT COUNT(*) AS count FROM outbox WHERE topic = 'goal.cancel.requested'")?.count, 1);
  db.close();
});

test("goal input rejects unknown fields", () => {
  assert.throws(() => parseGoalCreateInput({ intent: "x", source: { kind: "web" }, unexpected: true }), /not allowed/);
  assert.throws(() => parseGoalCreateInput({ intent: "x", source: { kind: "web", token: "secret" } }), /not allowed/);
});

test("durable goal survives an orchestrator restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "pai-restart-"));
  const databasePath = join(directory, "orchestrator.db");
  const firstDb = new OrchestratorDatabase(databasePath);
  const firstEngine = new TaskEngine(firstDb, () => 1_700_000_000_000);
  const created = firstEngine.createGoal(input("survive restart"), "owner-1", "restart-key");
  const goalId = String(created.body.goalId);
  firstDb.close();

  const secondDb = new OrchestratorDatabase(databasePath);
  const secondEngine = new TaskEngine(secondDb);
  assert.equal(secondEngine.getGoal(goalId)?.intent, "survive restart");
  assert.equal(secondDb.one("SELECT COUNT(*) AS count FROM outbox WHERE dedupe_key = ?", `goal.plan.requested:${goalId}`)?.count, 1);
  secondDb.close();
});

test("plan activation validates the DAG and materializes dependency states", () => {
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => 1_700_000_000_000);
  const planner = new PlanService(db, () => 1_700_000_000_000);
  const created = engine.createGoal(input("plan goal"), "owner-1", "plan-key");
  const goalId = String(created.body.goalId);
  const result = planner.activate(goalId, {
    schemaVersion: 1,
    goalId,
    revision: 1,
    intent: "plan goal",
    acceptanceCriteria: [{ id: "verify", description: "the plan is materialized", verificationTaskId: "verify-task" }],
    tasks: [
      { taskId: "root-task", type: "read", title: "Read", required: true, sideEffectClass: "READ_ONLY" },
      { taskId: "verify-task", type: "verify", title: "Verify", dependsOn: ["root-task"], required: true, sideEffectClass: "NONE" },
    ],
  });
  assert.equal(result.roots[0], "root-task");
  assert.equal(engine.getGoal(goalId)?.status, "ACTIVE");
  assert.equal(engine.getGoal(goalId)?.activePlanRevision, 1);
  const states = Object.fromEntries(engine.listTasks(goalId).map((task) => [task.id, task.state]));
  assert.deepEqual(states, { "root-task": "ESTIMATING", "verify-task": "PENDING" });
  assert.equal(db.one("SELECT COUNT(*) AS count FROM outbox WHERE topic = 'task.estimate.requested'")?.count, 1);
  assert.equal(engine.verifyAuditChain(), true);
  db.close();
});

test("plan activation rejects dependency cycles before writing", () => {
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => 1_700_000_000_000);
  const planner = new PlanService(db, () => 1_700_000_000_000);
  const created = engine.createGoal(input("cycle goal"), "owner-1", "cycle-key");
  const goalId = String(created.body.goalId);
  assert.throws(() => planner.activate(goalId, {
    schemaVersion: 1,
    goalId,
    revision: 1,
    intent: "cycle goal",
    acceptanceCriteria: [{ id: "verify", description: "verify", verificationTaskId: "a" }],
    tasks: [
      { taskId: "a", type: "a", title: "A", dependsOn: ["b"], required: true, sideEffectClass: "NONE" },
      { taskId: "b", type: "b", title: "B", dependsOn: ["a"], required: true, sideEffectClass: "NONE" },
    ],
  }), /INVALID_PLAN/);
  assert.equal(db.one("SELECT COUNT(*) AS count FROM plans")?.count, 0);
  db.close();
});

test("recoverable failed goals can be explicitly retried with durable idempotency", () => {
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => 1_700_000_000_000);
  const goal = engine.createGoal({ intent: "retry me", source: { kind: "web" } }, "owner", "retry-goal");
  const planService = new PlanService(db, () => 1_700_000_000_000);
  planService.activate(goal.body.goalId as string, { schemaVersion: 1, goalId: goal.body.goalId as string, revision: 1, intent: "retry me", acceptanceCriteria: [{ id: "done", description: "done", verificationTaskId: "task" }], tasks: [{ taskId: "task", type: "test", title: "test", required: true, sideEffectClass: "READ_ONLY" }] });
  engine.transitionTask("task", "FAILED", { type: "STATE_TRANSITION", actor: "worker", reason: "temporary" }, "ESTIMATING");
  db.run("UPDATE goals SET status = 'FAILED' WHERE id = ?", goal.body.goalId);
  const retried = engine.retryGoal(goal.body.goalId as string, "owner", "retry-1");
  assert.equal(retried.body.status, "ACTIVE");
  assert.equal(engine.listTasks(goal.body.goalId as string)[0].state, "READY");
  assert.equal(engine.retryGoal(goal.body.goalId as string, "owner", "retry-1").replayed, true);
  db.close();
});
