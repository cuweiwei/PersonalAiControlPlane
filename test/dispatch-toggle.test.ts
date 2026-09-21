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
import { DispatchService } from "../apps/control-plane/src/dispatch/dispatch-service.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import { parseDispatchRequest } from "../packages/contracts/src/dispatch.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";

function request() {
  return parseDispatchRequest({
    schema_version: 1,
    request_id: "toggle-request",
    ingress_key: "web:owner:toggle-1",
    source: { channel: "web", conversation_ref: "web:owner", event_ref: "toggle-1" },
    subject_ref: "owner",
    text: "ContextHub status",
    received_at: "2026-09-21T01:00:00Z",
    timezone: "Asia/Taipei",
    locale: "zh-TW",
    context: { session_revision: 1, standalone: true, pending_interaction: false },
    privacy_class: "LOCAL_ONLY",
  });
}

test("CP Settings is the live adaptive dispatch authority and defaults off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-dispatch-toggle-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const settings = new SettingsService(db);
  const health = new HealthMonitor(db, events);
  health.seed();
  const dispatch = new DispatchService(db, {
    enabled: () => Boolean(settings.get().dispatch_enabled),
    semanticEnabled: () => Boolean(settings.get().dispatch_semantic_enabled),
    routingBudgetMs: () => Number(settings.get().dispatch_routing_budget_ms),
    adapters: [],
  });
  const coordinator = { closeWorker() {}, handleUpgrade() {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts: new ArtifactStorage(directory), settings, health, events, dispatch, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { response, body: await response.json() as Record<string, any> };
  };
  try {
    const initial = await call("/api/v2/dispatch/effective");
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.enabled, false);
    assert.equal((await dispatch.prepare(request())).reason, "DISPATCH_DISABLED");

    const enabled = await call("/api/v2/settings", { method: "PATCH", body: JSON.stringify({ dispatch_enabled: true }) });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.values.dispatch_enabled, true);
    assert.equal((await call("/api/v2/dispatch/effective")).body.enabled, true);
    assert.equal((await dispatch.prepare(request())).disposition, "FALLBACK");

    const disabled = await call("/api/v2/settings", { method: "PATCH", body: JSON.stringify({ dispatch_enabled: false }) });
    assert.equal(disabled.response.status, 200);
    assert.equal((await call("/api/v2/dispatch/effective")).body.enabled, false);
    const afterDisable = await dispatch.prepare(parseDispatchRequest({
      schema_version: 1,
      request_id: "toggle-request-2",
      ingress_key: "web:owner:toggle-2",
      source: { channel: "web", conversation_ref: "web:owner", event_ref: "toggle-2" },
      subject_ref: "owner",
      text: "ContextHub status",
      received_at: "2026-09-21T01:00:00Z",
      timezone: "Asia/Taipei",
      locale: "zh-TW",
      context: { session_revision: 1, standalone: true, pending_interaction: false },
      privacy_class: "LOCAL_ONLY",
    }));
    assert.equal(afterDisable.reason, "DISPATCH_DISABLED");

    // The stored setting survives a service reconstruction; restore the
    // release to the required first-deploy state before closing the fixture.
    settings.patch({ dispatch_enabled: false });
    assert.equal(new SettingsService(db).get().dispatch_enabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
