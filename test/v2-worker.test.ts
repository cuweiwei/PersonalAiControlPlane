import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerLocalDatabase } from "../apps/worker/src/local-db.ts";
import { OutboundWorkerRuntime, type WorkerTaskOffer } from "../apps/worker/src/runtime.ts";

const offer: WorkerTaskOffer = {
  task_id: "task-1",
  attempt_id: "attempt-1",
  task_type: "generic",
  instruction: "do the test",
  payload: {},
  execution: { capabilities: ["generic"] },
  limits: { timeout_seconds: 30 },
};

test("worker persists assignment before accept and resends durable result until acknowledged", async () => {
  const db = new WorkerLocalDatabase(":memory:");
  const sent: Record<string, any>[] = [];
  let receive: ((message: Record<string, any>) => void) | undefined;
  const transport = {
    connect: async (onMessage: (message: Record<string, any>) => void) => { receive = onMessage; },
    send: async (message: Record<string, any>) => { sent.push(message); },
  };
  const executor = {
    type: "generic",
    canExecute: () => true,
    async *execute() { yield { type: "progress" as const, progress: { phase: "test" } }; yield { type: "result" as const, result: { ok: true }, metrics: { duration_ms: 1 } }; },
  };
  const runtime = new OutboundWorkerRuntime({ workerId: "worker-1", db, transport, executors: [executor] });
  await runtime.connect();
  await runtime.handleOffer(offer);
  assert.equal(db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get(offer.attempt_id)?.status, "COMPLETED");
  assert.equal(db.connection.prepare("SELECT status FROM results WHERE attempt_id = ?").get(offer.attempt_id)?.status, "PENDING");
  assert.deepEqual(sent.map((item) => item.type), ["hello", "task.accept", "task.started", "task.progress", "task.result"]);
  await runtime.handleOffer(offer);
  assert.equal(sent.at(-1)?.type, "task.result");
  receive!({ type: "task.result.ack", attempt_id: offer.attempt_id });
  assert.equal(db.connection.prepare("SELECT status FROM results WHERE attempt_id = ?").get(offer.attempt_id)?.status, "DELIVERED");
  db.close();
});

test("worker rejects an offer when no executor is enabled", async () => {
  const db = new WorkerLocalDatabase(":memory:");
  const sent: Record<string, any>[] = [];
  const runtime = new OutboundWorkerRuntime({ workerId: "worker-2", db, transport: { send: (message) => { sent.push(message); } }, executors: [] });
  await runtime.handleOffer({ ...offer, attempt_id: "attempt-2", task_id: "task-2" });
  assert.equal(db.connection.prepare("SELECT status FROM assignments WHERE attempt_id = ?").get("attempt-2")?.status, "FAILED");
  assert.equal(sent.at(-1)?.type, "task.failed");
  db.close();
});

test("worker restart reloads an unacknowledged result from local SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-worker-restart-"));
  const path = join(directory, "worker.db");
  const firstDb = new WorkerLocalDatabase(path);
  const firstTransport = { send: async () => {} };
  const firstRuntime = new OutboundWorkerRuntime({ workerId: "worker-restart", db: firstDb, transport: firstTransport, executors: [{ type: "generic", canExecute: () => true, async *execute() { yield { type: "result" as const, result: { persisted: true } }; } }] });
  await firstRuntime.handleOffer({ ...offer, task_id: "restart-task", attempt_id: "restart-attempt" });
  firstDb.close();
  const sent: Record<string, any>[] = [];
  const secondDb = new WorkerLocalDatabase(path);
  const secondRuntime = new OutboundWorkerRuntime({ workerId: "worker-restart", db: secondDb, transport: { send: (message) => { sent.push(message); } }, executors: [] });
  await secondRuntime.connect();
  assert.equal(sent.some((message) => message.type === "task.result" && message.attempt_id === "restart-attempt"), true);
  secondDb.close();
  await rm(directory, { recursive: true, force: true });
});
