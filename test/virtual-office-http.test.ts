import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { OfficeService } from "../apps/control-plane/src/office/office-service.ts";
import { MissionService } from "../apps/control-plane/src/missions/mission-service.ts";
import { PlanService } from "../apps/control-plane/src/missions/plan-service.ts";
import { MissionCoordinator } from "../apps/control-plane/src/missions/coordinator.ts";
import { MissionCommandDispatcher } from "../apps/control-plane/src/missions/command-dispatcher.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";

test("Virtual Office HTTP routes expose the seeded office and idempotent intake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-office-http-")); const db = new ControlPlaneDatabase(":memory:"); const events = new EventHub(); const settings = new SettingsService(db); settings.patch({ office_enabled: true }); const tasks = new TaskService(db, events, { callbackEnabled: false }); const workers = new WorkerService(db, events); const artifacts = new ArtifactStorage(directory); const health = new HealthMonitor(db, events); health.seed(); const office = new OfficeService(db, events, settings); const missions = new MissionService(db, events, settings); const plans = new PlanService(db, events, missions);
  const workerCoordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const missionCoordinator = new MissionCoordinator(db, events, tasks, missions, plans, new MissionCommandDispatcher(db, ""));
  const server = createControlPlaneServer({ db, tasks, workers, coordinator: workerCoordinator, missionCoordinator, artifacts, settings, health, events, office, missions, plans, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const jsonRequest = async (path: string, init: RequestInit = {}) => { const response = await fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }); return { response, body: await response.json() as Record<string, any> }; };
  try {
    const offices = await jsonRequest("/api/v2/offices"); assert.equal(offices.response.status, 200); assert.equal(offices.body.items[0].id, "office-1");
    const request = { office_id: "office-1", title: "HTTP Mission", goal: "驗證交辦入口", inputs: [], scope: { workspace_ids: [], capabilities: [], external_effects: [] } };
    const first = await jsonRequest("/api/v2/missions", { method: "POST", headers: { "idempotency-key": "http-mission-key" }, body: JSON.stringify(request) }); const second = await jsonRequest("/api/v2/missions", { method: "POST", headers: { "idempotency-key": "http-mission-key" }, body: JSON.stringify(request) });
    assert.equal(first.response.status, 202); assert.equal(second.response.status, 202); assert.equal(second.body.missionId, first.body.missionId);
    const detail = await jsonRequest(`/api/v2/missions/${first.body.missionId}`); assert.equal(detail.response.status, 200); assert.equal(detail.body.run.phase, "PLANNING"); assert.equal(detail.body.events[0].type, "mission.created");
    const context = await jsonRequest(`/api/v2/internal/office/commands/${first.body.planCommandId}/context`); assert.equal(context.response.status, 200); assert.equal(context.body.commandId, first.body.planCommandId);
  } finally { missionCoordinator.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); db.close(); await rm(directory, { recursive: true, force: true }); }
});
