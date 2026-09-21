import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { DispatchService } from "../apps/control-plane/src/dispatch/dispatch-service.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";
import type { DispatchExecutionAdapter } from "../apps/control-plane/src/dispatch/dispatch-types.ts";

// Optional cross-repository contract test. Set HERMES_SOURCE_ROOT in CI when
// checking out both repositories; a missing checkout is explicitly skipped.
const hermesRoot = process.env.HERMES_SOURCE_ROOT;
test("real Hermes Python boundary consumes CP HTTP prepare/commit/result and safely replays", {
  skip: !hermesRoot ? "HERMES_SOURCE_ROOT not configured" : false,
  timeout: 20_000,
}, async () => {
  assert.ok(existsSync(resolve(hermesRoot!, "services/hermes_runtime/pre_reasoning.py")), "configured Hermes checkout missing");
  const directory = await mkdtemp(join(tmpdir(), "cascade-cross-repo-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events);
  const workers = new WorkerService(db);
  const artifacts = new ArtifactStorage(directory);
  const settings = new SettingsService(db);
  const health = new HealthMonitor(db, events);
  health.seed();
  let executions = 0;
  const adapter: DispatchExecutionAdapter = {
    operationId: "service.health_check", descriptorHash: "sha256:fixture", supportsOperationDedup: true,
    async execute(action) {
      executions += 1;
      return { schemaVersion: 1, status: "HEALTHY", observedAt: new Date().toISOString(), sourceRef: "fixture-health", serviceRef: String(action.parameters.service_ref), message: null };
    },
  };
  const dispatch = new DispatchService(db, { enabled: true, adapters: [adapter] });
  const coordinator = { closeWorker() {}, handleUpgrade() {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts, settings, health, events, dispatch, assetRoot: directory });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    const script = `
import json, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from services.hermes_runtime.clients import ControlPlaneClient
from services.hermes_runtime.ledger import DurableLedger
from services.hermes_runtime.pre_reasoning import PreReasoningDispatcher, PreReasoningInput, render_service_health
client = ControlPlaneClient(sys.argv[2])
ledger = DurableLedger(Path(sys.argv[3]) / "hermes.db")
dispatcher = PreReasoningDispatcher(ledger, client, enabled=lambda: True)
for channel in ("telegram", "web"):
    incoming = PreReasoningInput(channel=channel, conversation_ref=channel+":owner", event_ref="event-1", subject_ref="owner", ingress_key=channel+":owner:event-1", text="ContextHub status", session_revision=1, standalone=True, pending_interaction=False, authenticated=True, received_at="2026-09-21T01:00:00Z")
    accepted = dispatcher.handle(incoming)
    assert accepted["invoke_hermes"] is False, accepted
    assert accepted["disposition"] == "CASCADE", accepted
    state = None
    for _ in range(100):
        state = client.dispatch_request(incoming.ingress_key, "owner")
        if (state.get("operation") or {}).get("status") == "SUCCEEDED":
            break
        time.sleep(.01)
    assert state["operation"]["status"] == "SUCCEEDED", state
    rendered = render_service_health(state["operation"]["result"], accepted["delivery_metadata"])
    assert "contexthub" in rendered["text"].lower(), rendered
    assert rendered["metadata"]["conversation_ref"] == incoming.conversation_ref, rendered
    replay = dispatcher.handle(incoming)
    assert replay["invoke_hermes"] is False, replay
fallback = dispatcher.handle(PreReasoningInput(channel="telegram", conversation_ref="telegram:owner", event_ref="event-complex", subject_ref="owner", ingress_key="telegram:owner:event-complex", text="幫我分析 ContextHub 為什麼一直 restart", session_revision=1, standalone=True, pending_interaction=False, authenticated=True, received_at="2026-09-21T01:00:00Z"))
assert fallback["invoke_hermes"] is True, fallback
print(json.dumps({"channels": 2, "rendered": 2, "safe_replays": 2, "complex_fallback": True}))
`;
    const child = spawn(process.env.PYTHON ?? "python3", ["-c", script, resolve(hermesRoot!), `http://127.0.0.1:${port}`, directory], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const code = await new Promise<number | null>((done, reject) => { child.on("error", reject); child.on("close", done); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).rendered, 2);
    assert.equal(executions, 2, "channel replay must not execute again");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
