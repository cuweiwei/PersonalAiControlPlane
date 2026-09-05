import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { ResourceScheduler } from "../apps/control-plane/src/scheduler/scheduler.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { ModelTestService } from "../apps/control-plane/src/models/model-test-service.ts";
import { ModelPreferenceService } from "../apps/control-plane/src/models/model-preference-service.ts";
import { OnboardingService } from "../apps/control-plane/src/workers/onboarding-service.ts";
import { addWorkspace, readWorkerConfig, writeWorkerConfig } from "../apps/worker/src/config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCreateTaskInput } from "../packages/contracts/src/index.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";

function setup() {
  const db = new ControlPlaneDatabase(":memory:"); const events = new EventHub(); const tasks = new TaskService(db, events); const workers = new WorkerService(db, events); const offers: Array<{ workerId: string; task: Record<string, unknown>; attemptId: string }> = [];
  const coordinator = { isConnected: () => true, offer: (workerId: string, task: Record<string, unknown>, attemptId: string) => { offers.push({ workerId, task, attemptId }); return true; } } as unknown as WorkerCoordinator;
  return { db, events, tasks, workers, offers, scheduler: new ResourceScheduler(db, tasks, workers, coordinator, events) };
}
function genericTask(overrides: Record<string, unknown> = {}) {
  return { source: "hermes", title: "test", taskType: "generic" as const, instruction: "do it", context: {}, payload: {}, execution: { capabilities: ["generic"], runtime: "auto", resources: {} }, limits: { timeoutSeconds: 60, maxAttempts: 2 }, priority: "normal" as const, inputArtifactIds: [], ...overrides };
}
function workerFixture(base: number) {
  const fixture = setup(); const registration = fixture.workers.register({ name: "Worker", registrationSecret: "registration-secret-123456", platform: "linux", hardware: {} }, base); const approved = fixture.workers.approveRegistration(registration.registrationId, "owner", base + 1); fixture.workers.pollRegistration(registration.registrationId, "registration-secret-123456", base + 2); const workerId = String(approved.workerId); fixture.workers.markConnected(workerId, base + 3); return { ...fixture, workerId };
}

test("F01 retry creates a new run and preserves task-wide attempt history", () => {
  const { db, tasks, workers, scheduler, offers, workerId } = workerFixture(1_000); workers.updateCapabilities(workerId, [{ capability: "generic", status: "READY" }], 1_003);
  const task = tasks.create(genericTask(), 1_004); assert.equal(scheduler.tick(1_005), 1); assert.equal(tasks.fail(String(task.id), offers[0].attemptId, workerId, "FAILED", "first", 1_006, false), "FAILED");
  const before = tasks.get(String(task.id))!; const retried = tasks.retryWithOptions(String(task.id), { expectedRunId: String(before.currentRunId), expectedRevision: Number(before.revision), idempotencyKey: "retry-1" }, 1_007)!; assert.notEqual(retried.currentRunId, before.currentRunId); assert.equal(retried.attemptCount, 1);
  assert.deepEqual(tasks.retryWithOptions(String(task.id), { expectedRunId: String(before.currentRunId), expectedRevision: Number(before.revision), idempotencyKey: "retry-1" }, 1_008), retried); assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM task_runs WHERE task_id = ?", task.id)?.count, 2); db.close();
});

test("F02 scheduler stores exact runtime/model target and ignores unavailable runtime", () => {
  const { db, tasks, workers, scheduler, offers, workerId } = workerFixture(2_000); workers.updateCapabilities(workerId, [{ capability: "llm.inference", runtime: "omlx", status: "UNAVAILABLE" }, { capability: "llm.inference", runtime: "ollama", status: "READY" }], 2_003); workers.updateModels(workerId, [{ runtime: "omlx", id: "dead", status: "unavailable" }, { runtime: "ollama", id: "live", status: "ready" }], 2_003);
  const task = tasks.create({ ...genericTask(), taskType: "llm.inference", execution: { capabilities: ["llm.inference"], runtime: "auto", model: { mode: "any" }, resources: {} } }, 2_004); assert.equal(scheduler.tick(2_005), 1); const attempt = db.one<{ resolved_execution_json: string }>("SELECT resolved_execution_json FROM task_attempts WHERE task_id = ?", task.id); assert.deepEqual(JSON.parse(String(attempt?.resolved_execution_json)), { workerId, runtime: "ollama", model: { name: "live", mode: "required" }, workspaceId: null }); assert.equal(offers[0].task.resolvedExecution, undefined); db.close();
});

test("F03 canonical workspace rejects conflicts and preserves the execution value", () => {
  assert.equal(parseCreateTaskInput({ title: "x", task_type: "generic", instruction: "x", context: {}, payload: { workspace_id: "docs" }, execution: { capabilities: ["generic"], workspace_id: "docs" } }).execution.workspaceId, "docs");
  assert.throws(() => parseCreateTaskInput({ title: "x", task_type: "generic", instruction: "x", context: {}, payload: { workspace_id: "docs" }, execution: { capabilities: ["generic"], workspace_id: "other" } }), /WORKSPACE_CONFLICT/);
});

test("P04 model test batch runs cases serially and does not create Hermes callbacks", () => {
  const base = 3_000; const { db, tasks, workers, scheduler, offers, workerId } = workerFixture(base); workers.updateCapabilities(workerId, [{ capability: "llm.inference", runtime: "ollama", status: "READY" }], base + 3); workers.updateModels(workerId, [{ runtime: "ollama", id: "demo", status: "ready" }, { runtime: "ollama", id: "demo-2", status: "ready" }], base + 3);
  const modelTests = new ModelTestService(db, tasks);
  const batch = modelTests.create({ template_id: "short-summary-v1", template_version: 1, input_text: "same input", targets: [{ worker_id: workerId, runtime: "ollama", model_id: "demo" }, { worker_id: workerId, runtime: "ollama", model_id: "demo-2" }] }, "model-test-1", base + 4) as any;
  assert.equal(batch.cases.length, 2);
  assert.equal(scheduler.tick(base + 5), 1);
  const first = offers[0];
  assert.equal(tasks.accept(String(batch.cases[0].taskId), first.attemptId, workerId, base + 6), true);
  assert.equal(tasks.started(String(batch.cases[0].taskId), first.attemptId, workerId, base + 7), true);
  assert.equal(tasks.result(String(batch.cases[0].taskId), first.attemptId, workerId, { text: "ok" }, {}, base + 8), "SUCCEEDED");
  const next = modelTests.get(String(batch.id), base + 9)! as any;
  assert.equal(next.cases.length, 2);
  assert.equal(next.cases[0].state, "SUCCEEDED");
  assert.equal(next.cases[1].state, "QUEUED");
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM callback_outbox WHERE task_id IN (SELECT task_id FROM model_test_cases WHERE batch_id = ?)", batch.id)?.count, 0);
  db.close();
});

test("P05 onboarding links approved enrollment and reports facts", () => {
  const base = 4_000; const { db, workers } = setup(); const onboarding = new OnboardingService(db); const flow = onboarding.create("linux", ["llm.inference"], base); const registration = workers.register({ name: "Onboarded", registrationSecret: "registration-secret-onboard-123", platform: "linux", onboardingId: String(flow.id), hardware: {} }, base + 1); const approved = workers.approveRegistration(registration.registrationId, "owner", base + 2); const result = onboarding.get(String(flow.id))! as any; assert.equal(result.registrationId, registration.registrationId); assert.equal(result.workerId, approved.workerId); assert.equal(result.facts.registration, true); db.close();
});

test("P06 pause validation, expiry, and idle-only preference are versioned", () => {
  const base = 5_000; const { db, workers, workerId } = workerFixture(base); const first = workers.updatePreferences(workerId, { mode: "IDLE_ONLY", pause: { kind: "TIMED", durationSeconds: 60 } }, undefined, base + 4) as any; assert.equal(first.mode, "IDLE_ONLY"); assert.throws(() => workers.updatePreferences(workerId, { pause: { kind: "TIMED", durationSeconds: 59 } }, first.version, base + 5), /INVALID_WORKER_PREFERENCE/); assert.equal(workers.expirePauses(base + 65_000), 1); assert.equal((workers.preferences(workerId) as any).pause, null); db.close();
});

test("model preference snapshots are immutable on the task", () => {
  const { db, tasks } = setup(); const preferences = new ModelPreferenceService(db); const preference = preferences.create({ name: "摘要優先", task_type: "llm.inference", targets: [{ worker_id: "worker-a", runtime: "ollama", model_id: "demo" }], allow_fallback: false }, "preference-1", 6_000) as any; const task = tasks.create({ ...genericTask(), taskType: "llm.inference", execution: { capabilities: ["llm.inference"], runtime: "auto", preferenceId: preference.id, model: { mode: "any" }, resources: {} } }, 6_001); preferences.update(String(preference.id), { name: "已更新" }, 1, 6_002); assert.equal((tasks.get(String(task.id)) as any).preferenceSnapshot.version, 1); db.close();
});

test("P05 worker config saves atomically and validates workspace identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "pai-worker-config-")); const path = join(directory, "worker-config.json"); writeWorkerConfig(path, { version: 1, executors: { codex: { enabled: true } }, workspaces: {} }); const updated = addWorkspace(path, "docs-project", "文件專案", process.cwd()); writeWorkerConfig(path, updated); const saved = readWorkerConfig(path); assert.equal(saved.executors.codex?.enabled, true); assert.equal(saved.workspaces["docs-project"]?.name, "文件專案"); assert.throws(() => addWorkspace(path, "docs-project", "重複", process.cwd()), /WORKSPACE_ALREADY_EXISTS/);
});
