import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { assertTaskTransition } from "../apps/control-plane/src/tasks/task-state-machine.ts";
import { ResourceScheduler } from "../apps/control-plane/src/scheduler/scheduler.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    source: "hermes",
    title: "Run a local inference",
    taskType: "llm.inference" as const,
    instruction: "Summarize the supplied context.",
    context: { summary: "test" },
    payload: { prompt: "hello" },
    execution: { capabilities: ["llm.inference"], runtime: "ollama", model: { name: "qwen3.5-27b", mode: "required" as const }, resources: {} },
    limits: { timeoutSeconds: 60, maxAttempts: 2 },
    priority: "normal" as const,
    inputArtifactIds: [],
    ...overrides,
  };
}

function setup() {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: true });
  const workers = new WorkerService(db, events);
  const offers: Array<{ workerId: string; task: Record<string, unknown>; attemptId: string }> = [];
  const coordinator = {
    isConnected: () => true,
    offer: (workerId: string, task: Record<string, unknown>, attemptId: string) => { offers.push({ workerId, task, attemptId }); return true; },
  } as unknown as WorkerCoordinator;
  const scheduler = new ResourceScheduler(db, tasks, workers, coordinator, events);
  return { db, tasks, workers, scheduler, offers };
}

test("v2 task state machine rejects invalid transitions", () => {
  assert.doesNotThrow(() => assertTaskTransition("QUEUED", "ASSIGNED"));
  assert.throws(() => assertTaskTransition("SUCCEEDED", "QUEUED"), /INVALID_TASK_STATE/);
});

test("registration approval, capability scheduling, execution fencing, and callback outbox", () => {
  const { db, tasks, workers, scheduler, offers } = setup();
  const now = Date.parse("2026-09-02T00:00:00.000Z");
  const registration = workers.register({ name: "Mac Worker", registrationSecret: "registration-secret-123456", platform: "darwin", hostname: "mac", hardware: {} }, now);
  const approved = workers.approveRegistration(registration.registrationId, "owner", now + 1);
  const enrolled = workers.pollRegistration(registration.registrationId, "registration-secret-123456", now + 2);
  assert.equal(enrolled.status, "approved");
  assert.equal(enrolled.workerId, approved.workerId);
  assert.equal(typeof enrolled.token, "string");
  workers.markConnected(approved.workerId as string, now + 3);
  workers.updateCapabilities(approved.workerId as string, [{ capability: "llm.inference", runtime: "ollama", status: "READY" }], now + 3);
  workers.updateModels(approved.workerId as string, [{ runtime: "ollama", id: "qwen3.5-27b", status: "ready" }], now + 3);

  const created = tasks.create(taskInput(), now + 4);
  assert.equal(created.inputArtifactIds instanceof Array, true);
  assert.equal(scheduler.tick(now + 5), 1);
  assert.equal(offers.length, 1);
  const attemptId = offers[0].attemptId;
  assert.equal(tasks.accept(created.id as string, attemptId, approved.workerId as string, now + 6), true);
  assert.equal(tasks.started(created.id as string, attemptId, approved.workerId as string, now + 7), true);
  assert.equal(tasks.progress(created.id as string, attemptId, approved.workerId as string, { percent: 50 }, now + 8), true);
  assert.equal(tasks.result(created.id as string, attemptId, approved.workerId as string, { text: "done" }, {}, now + 9), "SUCCEEDED");
  assert.equal(tasks.result(created.id as string, attemptId, approved.workerId as string, { text: "late" }, {}, now + 10), "LATE");
  assert.equal(tasks.get(created.id as string)?.status, "SUCCEEDED");
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM callback_outbox WHERE task_id = ?", created.id)?.count, 1);
  assert.equal(tasks.eventsFor(created.id as string).some((event) => event.type === "LATE_ATTEMPT_RESULT"), true);
  db.close();
});

test("worker failure is retried as a new fenced attempt and stale workers requeue work", () => {
  const { db, tasks, workers, scheduler, offers } = setup();
  const base = Date.parse("2026-09-02T01:00:00.000Z");
  const registration = workers.register({ name: "Linux Worker", registrationSecret: "registration-secret-abcdef", platform: "linux", hostname: "linux", hardware: {} }, base);
  const approved = workers.approveRegistration(registration.registrationId, "owner", base + 1);
  workers.pollRegistration(registration.registrationId, "registration-secret-abcdef", base + 2);
  workers.markConnected(approved.workerId as string, base + 3);
  workers.updateCapabilities(approved.workerId as string, [{ capability: "generic", status: "READY" }], base + 3);
  const created = tasks.create(taskInput({ taskType: "generic", execution: { capabilities: ["generic"], runtime: "auto", resources: {} } }), base + 4);
  assert.equal(scheduler.tick(base + 5), 1);
  const first = offers.at(-1)!;
  assert.equal(tasks.fail(created.id as string, first.attemptId, approved.workerId as string, "WORKER_DISCONNECTED", "connection lost", base + 6), "REQUEUED");
  assert.equal(tasks.get(created.id as string)?.status, "QUEUED");
  assert.equal(scheduler.tick(base + 7), 1);
  const second = offers.at(-1)!;
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(tasks.accept(created.id as string, second.attemptId, approved.workerId as string, base + 7), true);
  assert.equal(tasks.started(created.id as string, second.attemptId, approved.workerId as string, base + 7), true);
  assert.equal(tasks.result(created.id as string, second.attemptId, approved.workerId as string, { ok: true }, {}, base + 8), "SUCCEEDED");

  const staleTask = tasks.create(taskInput({ taskType: "generic", execution: { capabilities: ["generic"], runtime: "auto", resources: {} } }), base + 9);
  assert.equal(scheduler.tick(base + 10), 1);
  workers.markDisconnected(approved.workerId as string, base + 11);
  assert.equal(scheduler.staleSweep(base + 90_012, 90_000), 1);
  assert.equal(tasks.get(staleTask.id as string)?.status, "QUEUED");
  db.close();
});

test("worker removal is busy-safe, purges credentials/inventory, and preserves history", () => {
  const { db, tasks, workers, scheduler, offers } = setup();
  const base = Date.parse("2026-09-02T02:00:00.000Z");
  const registration = workers.register({ name: "Purge Worker", registrationSecret: "registration-secret-purge-123", platform: "linux", hostname: "purge", hardware: {} }, base);
  const approved = workers.approveRegistration(registration.registrationId, "owner", base + 1);
  const enrolled = workers.pollRegistration(registration.registrationId, "registration-secret-purge-123", base + 2);
  const workerId = String(approved.workerId);
  workers.markConnected(workerId, base + 3);
  workers.updateCapabilities(workerId, [{ capability: "generic", runtime: "local", status: "READY" }], base + 3);
  workers.updateModels(workerId, [{ runtime: "local", id: "demo", status: "ready" }], base + 3);
  const capabilityId = Number(db.one<{ id: number }>("SELECT id FROM worker_capabilities WHERE worker_id = ?", workerId)?.id);
  db.run("UPDATE worker_capabilities SET grant_status = 'GRANTED' WHERE id = ?", capabilityId);
  workers.updateCapabilities(workerId, [{ capability: "generic", runtime: "local", status: "READY", descriptor: { version: 2 } }], base + 4);
  assert.equal((workers.getWorker(workerId) as any)?.capabilities?.[0]?.grantStatus, "REQUIRES_REVIEW");
  workers.grantCapability(workerId, capabilityId, "owner", base + 4);
  const created = tasks.create(taskInput({ taskType: "generic", execution: { capabilities: ["generic"], runtime: "auto", resources: {} } }), base + 4);
  assert.equal(scheduler.tick(base + 5), 1);
  assert.throws(() => workers.remove(workerId, "owner", base + 6), /WORKER_BUSY/);
  assert.equal(workers.getWorker(workerId)?.enabled, true);
  const attempt = offers[0];
  assert.equal(tasks.fail(created.id as string, attempt.attemptId, workerId, "WORKER_DISCONNECTED", "done", base + 7, false), "FAILED");
  workers.revokeCapability(workerId, capabilityId, "owner", base + 7);
  assert.equal((workers.getWorker(workerId) as any)?.capabilities?.[0]?.grantStatus, "REVOKED");
  const removed = workers.remove(workerId, "owner", base + 8);
  assert.equal(removed.status, "removed");
  assert.equal(workers.listWorkers().some((item) => item.id === workerId), false);
  assert.equal(workers.tokenDisposition(String(enrolled.token)), "removed");
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM worker_tokens WHERE worker_id = ?", workerId)?.count, 0);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM worker_capabilities WHERE worker_id = ?", workerId)?.count, 0);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM worker_models WHERE worker_id = ?", workerId)?.count, 0);
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM task_attempts WHERE worker_id = ?", workerId)?.count, 1);
  assert.equal(workers.verifyAuditChain(), true);
  assert.equal(workers.remove(workerId, "owner", base + 9).alreadyRemoved, true);
  db.close();
});

test("approved enrollment that is not finalized expires and is not listed as a worker", () => {
  const { db, workers } = setup();
  const base = Date.parse("2026-09-02T03:00:00.000Z");
  const registration = workers.register({ name: "Expired Worker", registrationSecret: "registration-secret-expired-123", platform: "linux", hardware: {} }, base);
  const approved = workers.approveRegistration(registration.registrationId, "owner", base + 1);
  workers.expireRegistrations(base + 10 * 60_000 + 2);
  assert.equal(workers.listWorkers().some((item) => item.id === approved.workerId), false);
  assert.equal(workers.listRegistrations(base + 10 * 60_000 + 2)[0].status, "EXPIRED");
  db.close();
});
