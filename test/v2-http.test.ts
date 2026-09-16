import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";

test("unified v2 HTTP API covers enrollment, tasks, artifacts, settings, and health", async () => {
  const previousLegacyIntake = process.env.PAI_LEGACY_TASK_INTAKE_ENABLED;
  process.env.PAI_LEGACY_TASK_INTAKE_ENABLED = "false";
  const directory = await mkdtemp(join(tmpdir(), "pai-control-plane-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const artifacts = new ArtifactStorage(directory);
  const settings = new SettingsService(db);
  const health = new HealthMonitor(db, events);
  health.seed();
  const coordinator = {
    closeWorker: () => {},
    handleUpgrade: () => {},
    isConnected: () => true,
    offer: () => true,
  } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts, settings, health, events, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${(address as { port: number }).port}`;
  const jsonRequest = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { response, body: await response.json() as Record<string, any> };
  };
  try {
    const live = await fetch(`${origin}/healthz`);
    assert.equal(live.status, 200);
    assert.equal((await live.json() as Record<string, any>).service, "personal-ai-control-plane");
    assert.equal((await jsonRequest("/readyz")).response.status, 200);

    const secret = "http-registration-secret-123";
    const registration = await jsonRequest("/api/v2/worker/registration", { method: "POST", body: JSON.stringify({ name: "HTTP Worker", registration_secret: secret, platform: "linux", hardware: {} }) });
    assert.equal(registration.response.status, 202);
    const registrationId = registration.body.registrationId;
    const approved = await jsonRequest(`/api/v2/workers/registrations/${registrationId}/approve`, { method: "POST" });
    assert.equal(approved.response.status, 200);
    const workerId = approved.body.workerId as string;
    const polled = await fetch(`${origin}/api/v2/worker/registration/${registrationId}`, { headers: { "x-registration-secret": secret } });
    const enrollment = await polled.json() as Record<string, any>;
    assert.equal(enrollment.status, "approved");
    assert.equal(typeof enrollment.token, "string");
    const token = enrollment.token as string;
    workers.markConnected(workerId);
    workers.heartbeat(workerId, { system: { os: "linux", architecture: "x64", cpu: 4 }, resources: { memory: { totalMb: 1024, freeMb: 512 } }, execution: { max_concurrency: 2 } });
    workers.updateCapabilities(workerId, [{ capability: "generic", status: "READY" }]);

    const legacyPayload = { source: "hermes", correlation_id: "legacy-http-test", title: "Legacy HTTP task", task_type: "generic", instruction: "run", context: {}, payload: {}, execution: { capabilities: ["generic"], runtime: "auto", resources: {} }, limits: { timeout_seconds: 60, max_attempts: 2 }, priority: "normal", input_artifact_ids: [] };
    const retired = await jsonRequest("/api/v2/tasks", { method: "POST", body: JSON.stringify(legacyPayload) });
    assert.equal(retired.response.status, 410);
    assert.equal(retired.body.error.code, "LEGACY_TASK_INTAKE_DISABLED");
    process.env.PAI_LEGACY_TASK_INTAKE_ENABLED = "true";
    const rollback = await jsonRequest("/api/v2/tasks", { method: "POST", headers: { "idempotency-key": "legacy-http-rollback-1" }, body: JSON.stringify(legacyPayload) });
    assert.equal(rollback.response.status, 202);
    process.env.PAI_LEGACY_TASK_INTAKE_ENABLED = "false";
    const created = await jsonRequest("/api/v2/tasks", { method: "POST", headers: { "idempotency-key": "http-task-v2-1" }, body: JSON.stringify({ schema_version: 2, source: "hermes", idempotency_key: "http-task-v2-1", source_intent_ref: "http-intent-1", conversation_ref: "http-test", title: "HTTP task", task_type: "generic", description: "run", input: {}, requirements: { capabilities_all: [{ id: "generic", contract_version: 2 }] }, criteria: [], execution_timeout_seconds: 60, retry_policy: { max_attempts: 2, effect_class: "READ_ONLY" }, priority: "normal", input_artifact_ids: [] }) });
    assert.equal(created.response.status, 202);
    const taskId = created.body.task_id as string;
    const listing = await jsonRequest("/api/v2/tasks");
    assert.equal(listing.body.items.some((item: Record<string, any>) => item.id === taskId), true);
    const assignment = tasks.assign(taskId, workerId);
    assert.ok(assignment);

    const upload = await fetch(`${origin}/api/v2/worker/tasks/${taskId}/artifacts`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain", "x-artifact-filename": "input.txt" }, body: "hello" });
    assert.equal(upload.status, 201);
    const artifact = await upload.json() as Record<string, any>;
    const download = await fetch(`${origin}/api/v2/worker/artifacts/${artifact.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "hello");
    const workerListing = await jsonRequest("/api/v2/workers");
    assert.equal(workerListing.body.items[0].id, workerId);
    assert.equal(workerListing.body.items[0].connection.state, "ONLINE");
    assert.equal(typeof workerListing.body.items[0].availableActions.remove, "boolean");
    const renamed = await jsonRequest(`/api/v2/workers/${workerId}`, { method: "PATCH", body: JSON.stringify({ name: "HTTP Worker Renamed" }) });
    assert.equal(renamed.body.name, "HTTP Worker Renamed");
    const capabilityId = Number(db.one<{ id: number }>("SELECT id FROM worker_capabilities WHERE worker_id = ?", workerId)?.id);
    const revoked = await jsonRequest(`/api/v2/workers/${workerId}/capabilities/${capabilityId}/revoke`, { method: "POST" });
    assert.equal(revoked.body.capabilities[0].grantStatus, "REVOKED");
    const pending = await jsonRequest("/api/v2/worker/registration", { method: "POST", body: JSON.stringify({ name: "Delete Me", registration_secret: "delete-registration-secret", platform: "linux", hardware: {} }) });
    const deletedRegistration = await jsonRequest(`/api/v2/workers/registrations/${pending.body.registrationId}`, { method: "DELETE" });
    assert.equal(deletedRegistration.body.status, "removed");
    const busy = await jsonRequest(`/api/v2/workers/${workerId}`, { method: "DELETE" });
    assert.equal(busy.response.status, 409);
    const attempt = assignment!.attemptId;
    assert.equal(tasks.fail(taskId, attempt, workerId, "WORKER_DISCONNECTED", "test cleanup", Date.now(), false), "FAILED");
    const removed = await jsonRequest(`/api/v2/workers/${workerId}`, { method: "DELETE" });
    assert.equal(removed.response.status, 200);
    const repeated = await jsonRequest(`/api/v2/workers/${workerId}`, { method: "DELETE" });
    assert.equal(repeated.response.status, 200);
    assert.equal((await jsonRequest("/api/v2/models")).body.items.length, 0);
    const systems = (await jsonRequest("/api/v2/systems")).body.items as Array<Record<string, any>>;
    assert.equal(systems.length, 4);
    assert.deepEqual(systems.map((item) => item.id), ["control-plane", "contexthub", "hermes", "information-radar"]);
    const patched = await jsonRequest("/api/v2/settings", { method: "PATCH", body: JSON.stringify({ default_max_attempts: 3 }) });
    assert.equal(patched.body.default_max_attempts, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
    if (previousLegacyIntake === undefined) delete process.env.PAI_LEGACY_TASK_INTAKE_ENABLED;
    else process.env.PAI_LEGACY_TASK_INTAKE_ENABLED = previousLegacyIntake;
  }
});
