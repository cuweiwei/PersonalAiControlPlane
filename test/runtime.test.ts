import assert from "node:assert/strict";
import test from "node:test";
import type { GoalRecord, PlanInput } from "../packages/contracts/src/index.ts";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { OutboxStore, enqueueOutbox } from "../apps/orchestrator/src/outbox.ts";
import { OrchestratorRuntime, OutboxDispatcher, type ExecutionPort, type PlannerPort, type RuntimeTask } from "../apps/orchestrator/src/runtime.ts";
import { ScheduleService } from "../apps/orchestrator/src/schedule-service.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";

function planner(taskSideEffect: "READ_ONLY" | "NON_IDEMPOTENT_MUTATION" = "READ_ONLY"): PlannerPort {
  return {
    async createPlan(goal: GoalRecord): Promise<PlanInput> {
      return {
        schemaVersion: 1,
        goalId: goal.id,
        revision: 1,
        intent: goal.intent,
        acceptanceCriteria: [{ id: "accept", description: "verified output", verificationTaskId: `${goal.id}:verify` }],
        tasks: [
          { taskId: `${goal.id}:work`, type: "fake.execute", title: "Execute", required: true, sideEffectClass: taskSideEffect, ...(taskSideEffect === "READ_ONLY" ? {} : { idempotencyKey: `${goal.id}:mutation` }) },
          { taskId: `${goal.id}:verify`, type: "fake.verify", title: "Verify", dependsOn: [`${goal.id}:work`], required: true, sideEffectClass: "READ_ONLY" },
        ],
        createdBy: { kind: "test-planner" },
      };
    },
  };
}

function executor(): ExecutionPort & { effects: Map<string, Record<string, unknown>>; calls: number } {
  const effects = new Map<string, Record<string, unknown>>();
  return {
    effects,
    calls: 0,
    supports(task: RuntimeTask) { return task.type.startsWith("fake."); },
    async execute(request) {
      this.calls += 1;
      const result = effects.get(request.operationId) ?? { operationId: request.operationId, taskId: request.task.id };
      effects.set(request.operationId, result);
      return { status: "SUCCEEDED" as const, result, evidence: { provider: "fake", durable: true } };
    },
    async verify(request) {
      return { ok: request.result.result !== undefined || request.result.operationId !== undefined, evidence: { checked: true } };
    },
  };
}

test("background runtime drives a durable fake goal through planning, dispatch, verification, and completion", async () => {
  let now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  const fakeExecutor = executor();
  const runtime = new OrchestratorRuntime(db, engine, { planner: planner(), executor: fakeExecutor, clock: () => now });
  const created = engine.createGoal({ intent: "finish end to end", source: { kind: "web" }, memoryRequirement: "none" }, "owner", "runtime-goal");
  const goalId = String(created.body.goalId);

  await runtime.runUntilIdle();

  assert.equal(engine.getGoal(goalId)?.status, "COMPLETED");
  assert.deepEqual(engine.listTasks(goalId).map((task) => task.state), ["COMPLETED", "COMPLETED"]);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM attempts")?.count, 2);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE topic IN ('goal.plan.requested', 'task.estimate.requested', 'job.dispatch.requested', 'task.verify.requested') AND delivered_at IS NULL")?.count, 0);
  assert.equal(fakeExecutor.effects.size, 2);
  assert.equal(engine.verifyAuditChain(), true);
  db.close();
});

test("preferred ContextHub memory degrades explicitly while required memory fails closed", async () => {
  let now = 1_700_000_000_000;
  const preferredDb = new OrchestratorDatabase(":memory:");
  const preferredEngine = new TaskEngine(preferredDb, () => now);
  let receivedContext: Record<string, unknown> | undefined;
  const delegate = planner();
  const preferredPlanner: PlannerPort = { async createPlan(goal, context) { receivedContext = context; return delegate.createPlan(goal, context); } };
  const unavailableContextHub = {
    async compileContext() { throw new Error("upstream unavailable"); },
    async proposeCandidate() { throw new Error("unused"); },
    async proposeSuccessor() { throw new Error("unused"); },
    async recordContextOutcome() { throw new Error("unused"); },
    async readChanges() { throw new Error("unused"); },
  };
  const preferred = preferredEngine.createGoal({ intent: "preferred memory", source: { kind: "web" }, memoryRequirement: "preferred" }, "owner", "preferred-memory");
  const preferredRuntime = new OrchestratorRuntime(preferredDb, preferredEngine, { planner: preferredPlanner, executor: executor(), contextHub: unavailableContextHub, clock: () => now });
  await preferredRuntime.runUntilIdle();
  assert.deepEqual(receivedContext, { status: "UNAVAILABLE", reason: "CONTEXT_HUB_UNAVAILABLE" });
  assert.equal(preferredEngine.getGoal(String(preferred.body.goalId))?.status, "COMPLETED");
  preferredDb.close();

  const requiredDb = new OrchestratorDatabase(":memory:");
  const requiredEngine = new TaskEngine(requiredDb, () => now);
  const required = requiredEngine.createGoal({ intent: "required memory", source: { kind: "web" }, memoryRequirement: "required" }, "owner", "required-memory");
  const requiredRuntime = new OrchestratorRuntime(requiredDb, requiredEngine, { planner: planner(), executor: executor(), clock: () => now });
  await requiredRuntime.runCycle();
  assert.equal(requiredEngine.getGoal(String(required.body.goalId))?.status, "PLANNING");
  assert.match(String(requiredDb.one("SELECT last_error FROM outbox WHERE topic = 'goal.plan.requested'")?.last_error), /CONTEXT_HUB_REQUIRED/);
  requiredDb.close();
});

test("runtime leaves missing ports pending and never dispatches a mutation without an action-grant path", async () => {
  const now = 1_700_000_000_000;
  const noPortDb = new OrchestratorDatabase(":memory:");
  const noPortEngine = new TaskEngine(noPortDb, () => now);
  noPortEngine.createGoal({ intent: "stay pending", source: { kind: "web" } }, "owner", "pending");
  const noPortRuntime = new OrchestratorRuntime(noPortDb, noPortEngine, { clock: () => now });
  await noPortRuntime.runUntilIdle();
  assert.equal(noPortDb.one<{ attempt_count: number }>("SELECT attempt_count FROM outbox WHERE topic = 'goal.plan.requested'")?.attempt_count, 0);
  assert.equal(noPortDb.one<{ count: number }>("SELECT COUNT(*) AS count FROM attempts")?.count, 0);
  noPortDb.close();

  const mutationDb = new OrchestratorDatabase(":memory:");
  const mutationEngine = new TaskEngine(mutationDb, () => now);
  const runtime = new OrchestratorRuntime(mutationDb, mutationEngine, { planner: planner("NON_IDEMPOTENT_MUTATION"), executor: executor(), clock: () => now });
  const created = mutationEngine.createGoal({ intent: "mutation", source: { kind: "web" } }, "owner", "mutation");
  await runtime.runUntilIdle();
  assert.equal(mutationEngine.listTasks(String(created.body.goalId)).find((task) => task.id.endsWith(":work"))?.state, "WAITING_APPROVAL");
  assert.equal(mutationDb.one<{ count: number }>("SELECT COUNT(*) AS count FROM attempts")?.count, 0);
  mutationDb.close();
});

test("attempt transitions reject a stale fence without appending an event", async () => {
  const now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  const runtime = new OrchestratorRuntime(db, engine, { planner: planner(), executor: executor(), clock: () => now });
  const created = engine.createGoal({ intent: "fence", source: { kind: "web" } }, "owner", "fence");
  await runtime.runCycle();
  await runtime.runCycle();
  const taskId = `${String(created.body.goalId)}:work`;
  const offer = db.one<{ attempt_id: string; lease_id: string; fencing_token: number }>("SELECT id AS attempt_id, lease_id, fencing_token FROM attempts WHERE task_id = ?", taskId)!;
  const before = db.one<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?", taskId)!.count;
  assert.throws(
    () => engine.transitionTask(taskId, "RUNNING", { type: "STATE_TRANSITION", actor: "stale-worker" }, "DISPATCHED", { attemptId: offer.attempt_id, leaseId: offer.lease_id, fencingToken: offer.fencing_token - 1 }),
    (error: Error & { code?: string }) => error.code === "STALE_FENCE",
  );
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?", taskId)?.count, before);
  db.close();
});

test("lease reaper retries read-only work but quarantines uncertain non-idempotent effects", async () => {
  let now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  db.run("INSERT INTO goals(id, owner_id, source_json, intent, scope_json, constraints_json, memory_requirement, status, active_plan_revision, state_version, policy_version, created_at, updated_at) VALUES ('g', 'o', '{}', 'x', '[]', '{}', 'none', 'ACTIVE', 1, 0, 1, ?, ?)", now, now);
  db.run("INSERT INTO plans(goal_id, revision, plan_json, digest, created_at) VALUES ('g', 1, '{}', 'sha256:p', ?)", now);
  for (const [id, sideEffect] of [["read", "READ_ONLY"], ["mutation", "NON_IDEMPOTENT_MUTATION"]] as const) {
    db.run("INSERT INTO tasks(id, goal_id, plan_revision, type, title, state, required, side_effect_class, state_version, fencing_counter, created_at, updated_at) VALUES (?, 'g', 1, 'fake.execute', ?, 'RUNNING', 1, ?, 1, 1, ?, ?)", id, id, sideEffect, now, now);
    db.run("INSERT INTO attempts(id, task_id, generation, state, lease_id, fencing_token, started_at) VALUES (?, ?, 1, 'RUNNING', ?, 1, ?)", `${id}-attempt`, id, `${id}-lease`, now);
    db.run("INSERT INTO leases(id, resource_type, resource_id, task_id, attempt_id, fencing_token, issued_at, expires_at) VALUES (?, 'executor', ?, ?, ?, 1, ?, ?)", `${id}-lease`, id, id, `${id}-attempt`, now, now + 10);
  }
  now += 11;
  const runtime = new OrchestratorRuntime(db, new TaskEngine(db, () => now), { clock: () => now });
  await runtime.runCycle();
  assert.equal(db.one<{ state: string }>("SELECT state FROM tasks WHERE id = 'read'")?.state, "READY");
  assert.equal(db.one<{ state: string }>("SELECT state FROM tasks WHERE id = 'mutation'")?.state, "WAITING_RECONCILIATION");
  assert.equal(db.one<{ state: string }>("SELECT state FROM attempts WHERE id = 'mutation-attempt'")?.state, "EXPIRED");
  db.close();
});

test("outbox retries are reclaimable, deduplicated by operation id, and eventually dead-lettered", async () => {
  let now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  const store = new OutboxStore(db, () => now);
  enqueueOutbox(db, "fake.command", "fake", "x", 1, "fake:x", { operationId: "op-1" }, now);
  const effects = new Set<string>();
  let calls = 0;
  const dispatcher = new OutboxDispatcher(store, new Map([["fake.command", async (record) => {
    calls += 1;
    effects.add(String(record.payload.operationId));
    throw new Error("FAKE_UNAVAILABLE");
  }]]), 2);
  await dispatcher.dispatchOnce();
  now += 1_001;
  await dispatcher.dispatchOnce();
  assert.equal(calls, 2);
  assert.equal(effects.size, 1);
  assert.ok(db.one("SELECT dead_lettered_at FROM outbox WHERE dedupe_key = 'fake:x'")?.dead_lettered_at);
  assert.equal(store.claimForTopics(["fake.command"]).length, 0);
  db.close();
});

test("runtime schedule tick uses a stable firing key and normal goal admission", async () => {
  const now = 1_700_000_000_000;
  const db = new OrchestratorDatabase(":memory:");
  const schedules = new ScheduleService(db, () => now);
  schedules.create({ name: "runtime", timezone: "Asia/Taipei", recurrence: { kind: "interval", everyMs: 60_000, templateRevision: 1 }, nextRunAt: now, misfirePolicy: "RUN_ONCE", goalTemplate: { intent: "scheduled", memoryRequirement: "none" } });
  const runtime = new OrchestratorRuntime(db, new TaskEngine(db, () => now), { scheduleOwnerId: "owner", clock: () => now });
  await runtime.runCycle();
  await runtime.runCycle();
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM schedule_firings")?.count, 1);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM goals WHERE json_extract(source_json, '$.kind') = 'schedule'")?.count, 1);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE topic = 'goal.plan.requested'")?.count, 1);
  db.close();
});
