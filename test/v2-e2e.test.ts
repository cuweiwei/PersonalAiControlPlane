import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";
import { ResourceScheduler } from "../apps/control-plane/src/scheduler/scheduler.ts";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";

async function waitFor(messages: Record<string, any>[], type: string): Promise<Record<string, any>> {
  for (let index = 0; index < 100; index += 1) {
    const found = messages.find((message) => message.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`message ${type} was not received`);
}

async function waitForMessage(messages: Record<string, any>[], predicate: (message: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let index = 0; index < 100; index += 1) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("matching message was not received");
}

test("canonical v2 flow enrolls a worker, dispatches over WS, and records result", async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "pai-v2-e2e-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const artifacts = new ArtifactStorage(artifactDirectory);
  const tasks = new TaskService(db, events, { callbackEnabled: false, artifactStorage: artifacts });
  const workers = new WorkerService(db, events);
  const coordinator = new WorkerCoordinator(workers, tasks, events, artifacts);
  const scheduler = new ResourceScheduler(db, tasks, workers, coordinator, events);
  const health = new HealthMonitor(db, events); health.seed();
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts, settings: new SettingsService(db), health, events, assetRoot: artifactDirectory });
  server.on("upgrade", (request, socket, head) => { coordinator.handleUpgrade(request, socket, head); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const registration = workers.register({ name: "E2E Worker", registrationSecret: "e2e-registration-secret-123", platform: "test", hardware: {} });
  workers.approveRegistration(registration.registrationId);
  const enrollment = workers.pollRegistration(registration.registrationId, "e2e-registration-secret-123");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/worker/ws`, { headers: { authorization: `Bearer ${enrollment.token}` } });
  const messages: Record<string, any>[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, any>));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocol_version: 2, worker_id: enrollment.workerId }));
    await waitFor(messages, "hello.ack");
    socket.send(JSON.stringify({ type: "capabilities.update", capabilities: [{ capability: "generic", status: "READY" }] }));
    for (let index = 0; index < 100; index += 1) { if (db.one("SELECT id FROM worker_capabilities WHERE worker_id = ?", enrollment.workerId)) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const task = tasks.create({ source: "hermes", title: "E2E task", taskType: "generic", instruction: "execute", context: {}, payload: {}, execution: { capabilities: ["generic"], runtime: "auto", resources: {} }, limits: { timeoutSeconds: 60, maxAttempts: 1 }, priority: "normal", inputArtifactIds: [] });
    assert.equal(scheduler.tick(), 1);
    const offer = await waitFor(messages, "task.offer");
    socket.send(JSON.stringify({ type: "task.accept", task_id: task.id, attempt_id: offer.attempt_id }));
    socket.send(JSON.stringify({ type: "task.started", task_id: task.id, attempt_id: offer.attempt_id }));
    socket.send(JSON.stringify({ type: "task.artifact", task_id: task.id, attempt_id: offer.attempt_id, artifact: { artifact_key: "output.v1", filename: "output.txt", media_type: "text/plain", data_base64: Buffer.from("worker output").toString("base64") } }));
    const artifactAck = await waitFor(messages, "task.artifact.ack");
    assert.equal(typeof artifactAck.artifact_id, "string");
    assert.equal(db.one("SELECT id FROM artifacts WHERE id = ?", artifactAck.artifact_id)?.id, artifactAck.artifact_id);
    socket.send(JSON.stringify({ type: "task.result", task_id: task.id, attempt_id: offer.attempt_id, result: { ok: true }, metrics: {}, result_manifest: { kind: "GENERIC", changes: { state: "OBSERVED", files: ["output.txt"], diff_artifact_key: "output.v1", attribution: "WORKER_OBSERVED" }, validation: { state: "FAILED", checks: [{ id: "test", actual: 1 }] }, artifacts: [{ artifact_key: "output.v1" }] } }));
    await waitFor(messages, "task.result.ack");
    for (let index = 0; index < 100; index += 1) { if (tasks.get(task.id as string)?.status === "SUCCEEDED") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(tasks.get(task.id as string)?.status, "SUCCEEDED");
    const manifest = (tasks.get(task.id as string)?.result as Record<string, any>)?.resultManifest;
    assert.equal(manifest.changes.diff_artifact_id, artifactAck.artifact_id);
    assert.equal(manifest.artifacts[0].id, artifactAck.artifact_id);
    assert.equal(manifest.validation.state, "FAILED");
  } finally {
    socket.close();
    coordinator.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("result manifest rejects missing and corrupt output artifacts before task success", async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "pai-v2-artifact-integrity-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const artifacts = new ArtifactStorage(artifactDirectory);
  const tasks = new TaskService(db, events, { callbackEnabled: false, artifactStorage: artifacts });
  const workers = new WorkerService(db, events);
  const coordinator = new WorkerCoordinator(workers, tasks, events, artifacts);
  const scheduler = new ResourceScheduler(db, tasks, workers, coordinator, events);
  const health = new HealthMonitor(db, events); health.seed();
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts, settings: new SettingsService(db), health, events, assetRoot: artifactDirectory });
  server.on("upgrade", (request, socket, head) => { coordinator.handleUpgrade(request, socket, head); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const registration = workers.register({ name: "Artifact Integrity Worker", registrationSecret: "artifact-integrity-secret-123", platform: "test", hardware: {} });
  workers.approveRegistration(registration.registrationId);
  const enrollment = workers.pollRegistration(registration.registrationId, "artifact-integrity-secret-123");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/worker/ws`, { headers: { authorization: `Bearer ${enrollment.token}` } });
  const messages: Record<string, any>[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, any>));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocol_version: 2, worker_id: enrollment.workerId }));
    await waitFor(messages, "hello.ack");
    socket.send(JSON.stringify({ type: "capabilities.update", capabilities: [{ capability: "generic", status: "READY" }] }));
    for (let index = 0; index < 100; index += 1) { if (db.one("SELECT id FROM worker_capabilities WHERE worker_id = ?", enrollment.workerId)) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const task = tasks.create({ source: "hermes", title: "Artifact integrity", taskType: "generic", instruction: "produce an artifact", context: {}, payload: {}, execution: { capabilities: ["generic"], runtime: "auto", resources: {} }, limits: { timeoutSeconds: 60, maxAttempts: 1 }, priority: "normal", inputArtifactIds: [] });
    assert.equal(scheduler.tick(), 1);
    const offer = await waitFor(messages, "task.offer");
    socket.send(JSON.stringify({ type: "task.accept", task_id: task.id, attempt_id: offer.attempt_id }));
    socket.send(JSON.stringify({ type: "task.started", task_id: task.id, attempt_id: offer.attempt_id }));
    socket.send(JSON.stringify({ type: "task.artifact", task_id: task.id, attempt_id: offer.attempt_id, artifact: { filename: "output.txt", media_type: "text/plain", data_base64: Buffer.from("artifact-v1").toString("base64") } }));
    const artifactAck = await waitFor(messages, "task.artifact.ack");
    const artifact = db.one<Record<string, any>>("SELECT * FROM artifacts WHERE id = ?", artifactAck.artifact_id)!;
    const originalHash = String(artifact.sha256);
    await unlink(String(artifact.storage_path));
    socket.send(JSON.stringify({ type: "task.result", task_id: task.id, attempt_id: offer.attempt_id, result: { text: "artifact" }, metrics: {}, result_manifest: { kind: "GENERIC", artifacts: [{ id: artifact.id, sha256: originalHash }] } }));
    await waitForMessage(messages, (message) => message.type === "error" && message.code === "ARTIFACT_MISSING");
    assert.equal(tasks.get(String(task.id))?.status, "RUNNING");
    await writeFile(String(artifact.storage_path), "artifact-v1");
    await writeFile(String(artifact.storage_path), "artifact-corrupted");
    socket.send(JSON.stringify({ type: "task.result", task_id: task.id, attempt_id: offer.attempt_id, result: { text: "artifact" }, metrics: {}, result_manifest: { kind: "GENERIC", artifacts: [{ id: artifact.id, sha256: originalHash }] } }));
    await waitForMessage(messages, (message) => message.type === "error" && message.code === "ARTIFACT_CONTENT_CONFLICT");
    assert.equal(tasks.get(String(task.id))?.status, "RUNNING");
    await writeFile(String(artifact.storage_path), "artifact-v1");
    socket.send(JSON.stringify({ type: "task.result", task_id: task.id, attempt_id: offer.attempt_id, result: { text: "artifact" }, metrics: {}, result_manifest: { kind: "GENERIC", artifacts: [{ id: artifact.id, sha256: "sha256:" + "0".repeat(64) }] } }));
    await waitForMessage(messages, (message) => message.type === "error" && message.code === "ARTIFACT_CONTENT_CONFLICT" && messages.filter((item) => item.type === "error" && item.code === "ARTIFACT_CONTENT_CONFLICT").length >= 2);
    assert.equal(tasks.get(String(task.id))?.status, "RUNNING");
    socket.send(JSON.stringify({ type: "task.result", task_id: task.id, attempt_id: offer.attempt_id, result: { text: "artifact" }, metrics: {}, result_manifest: { kind: "GENERIC", artifacts: [{ id: artifact.id, sha256: originalHash }] } }));
    await waitForMessage(messages, (message) => message.type === "task.result.ack" && message.attempt_id === offer.attempt_id);
    for (let index = 0; index < 100; index += 1) { if (tasks.get(String(task.id))?.status === "SUCCEEDED") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(tasks.get(String(task.id))?.status, "SUCCEEDED");
  } finally {
    socket.close();
    coordinator.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});
