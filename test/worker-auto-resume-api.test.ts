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

test("worker and global Auto Resume preferences are versioned, idempotent, and correctly projected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-auto-resume-api-"));
  const db = new ControlPlaneDatabase(":memory:"); const events = new EventHub(); const settings = new SettingsService(db);
  const workers = new WorkerService(db, events, () => ({ defaultEnabled: Boolean(settings.get().auto_resume_default_enabled), emergencyStop: Boolean(settings.get().auto_resume_emergency_stop) }));
  const tasks = new TaskService(db, events, { callbackEnabled: false }); const artifacts = new ArtifactStorage(directory); const health = new HealthMonitor(db, events); health.seed();
  const coordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts, settings, health, events, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { response, body: await response.json() as Record<string, any> };
  };
  try {
    const registration = await call("/api/v2/worker/registration", { method: "POST", body: JSON.stringify({ name: "Policy Worker", registration_secret: "policy-worker-secret-123", platform: "win32", hardware: {} }) });
    const approved = await call(`/api/v2/workers/registrations/${registration.body.registrationId}/approve`, { method: "POST" });
    const workerId = String(approved.body.workerId);
    const initial = await call(`/api/v2/workers/${workerId}`);
    assert.equal(initial.body.preferences.autoResume.effective, true);
    assert.equal(initial.body.preferences.autoResume.source, "GLOBAL_DEFAULT");
    assert.equal(initial.body.preferences.autoResume.runtimeSupport, "UNSUPPORTED");

    const offBody = JSON.stringify({ auto_resume_override: false });
    const offHeaders = { "if-match": "worker-preferences-0", "idempotency-key": "policy-worker-off-1" };
    const off = await call(`/api/v2/workers/${workerId}/preferences`, { method: "PATCH", headers: offHeaders, body: offBody });
    assert.equal(off.response.status, 200);
    assert.equal(off.body.desired.autoResume.effective, false);
    assert.equal(off.body.applied.state, "PENDING");
    const replay = await call(`/api/v2/workers/${workerId}/preferences`, { method: "PATCH", headers: offHeaders, body: offBody });
    assert.equal(replay.response.status, 200);
    assert.deepEqual(replay.body, off.body);
    const collision = await call(`/api/v2/workers/${workerId}/preferences`, { method: "PATCH", headers: offHeaders, body: JSON.stringify({ auto_resume_override: true }) });
    assert.equal(collision.response.status, 409);

    const effective = await call("/api/v2/settings/effective");
    const globalOff = await call("/api/v2/settings", { method: "PATCH", headers: { "if-match": effective.response.headers.get("etag")!, "idempotency-key": "policy-global-off-1" }, body: JSON.stringify({ auto_resume_default_enabled: false }) });
    assert.equal(globalOff.response.status, 200);
    assert.equal(globalOff.body.auto_resume_default_enabled, false);
    assert.equal((await call(`/api/v2/workers/${workerId}`)).body.preferences.autoResume.effective, false);

    const inherit = await call(`/api/v2/workers/${workerId}/preferences`, { method: "PATCH", headers: { "if-match": "worker-preferences-1", "idempotency-key": "policy-worker-inherit-1" }, body: JSON.stringify({ auto_resume_override: null }) });
    assert.equal(inherit.body.desired.autoResume.override, null);
    assert.equal(inherit.body.desired.autoResume.source, "GLOBAL_DEFAULT");
    assert.equal(inherit.body.desired.autoResume.effective, false);
    const on = await call(`/api/v2/workers/${workerId}/preferences`, { method: "PATCH", headers: { "if-match": "worker-preferences-2", "idempotency-key": "policy-worker-on-1" }, body: JSON.stringify({ auto_resume_override: true }) });
    assert.equal(on.body.desired.autoResume.source, "WORKER_OVERRIDE");
    assert.equal(on.body.desired.autoResume.effective, true);
    assert.equal(on.body.desired.autoResume.automaticResumeEligible, false);

    const stale = await call(`/api/v2/workers/${workerId}/preferences`, { method: "PATCH", headers: { "if-match": "worker-preferences-2", "idempotency-key": "policy-worker-stale-1" }, body: JSON.stringify({ auto_resume_override: false }) });
    assert.equal(stale.response.status, 409);
    assert.equal(workers.verifyAuditChain(), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close(); await rm(directory, { recursive: true, force: true });
  }
});
