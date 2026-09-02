import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { HermesCallbackDispatcher } from "../apps/control-plane/src/callbacks/outbox.ts";

test("terminal task result is delivered to the fixed Hermes callback outbox", async () => {
  const received: Record<string, any>[] = [];
  const callbackServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>);
    response.writeHead(204); response.end();
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
  const callbackOrigin = `http://127.0.0.1:${(callbackServer.address() as { port: number }).port}`;
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub(); const tasks = new TaskService(db, events, { callbackEnabled: true }); const workers = new WorkerService(db, events);
  const registration = workers.register({ name: "Callback Worker", registrationSecret: "callback-registration-secret", platform: "test", hardware: {} });
  const approved = workers.approveRegistration(registration.registrationId); const workerId = approved.workerId as string;
  workers.markConnected(workerId); workers.updateCapabilities(workerId, [{ capability: "generic", status: "READY" }]);
  const task = tasks.create({ source: "hermes", title: "callback", taskType: "generic", instruction: "complete", context: {}, payload: {}, execution: { capabilities: ["generic"], runtime: "auto", resources: {} }, limits: { timeoutSeconds: 30, maxAttempts: 1 }, priority: "normal", inputArtifactIds: [] });
  const assignment = tasks.assign(task.id as string, workerId)!;
  tasks.accept(task.id as string, assignment.attemptId, workerId); tasks.started(task.id as string, assignment.attemptId, workerId);
  tasks.result(task.id as string, assignment.attemptId, workerId, { ok: true });
  const dispatcher = new HermesCallbackDispatcher(db, callbackOrigin, "/events");
  assert.equal(dispatcher.pendingCount(), 1);
  assert.equal(await dispatcher.dispatchOnce(), 1);
  assert.equal(dispatcher.pendingCount(), 0);
  assert.equal(received[0].type, "task.completed");
  assert.equal(received[0].task_id, task.id);
  await new Promise<void>((resolve, reject) => callbackServer.close((error) => error ? reject(error) : resolve()));
  db.close();
});
