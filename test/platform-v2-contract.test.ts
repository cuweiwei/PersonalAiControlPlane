import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";
import { parseTaskContractV2Input } from "../packages/contracts/src/index.ts";

function input(key = "hermes-op-1") {
  return parseTaskContractV2Input({
    schema_version: 2,
    source: "hermes",
    idempotency_key: key,
    source_intent_ref: "intent-1",
    conversation_ref: "conversation-1",
    task_type: "codex",
    description: "Inspect the workspace without changing files.",
    input: { question: "status" },
    requirements: { capabilities_all: [{ id: "codex", contract_version: 2 }], workspace_ref: "workspace-1" },
    criteria: [{ id: "criterion-1", kind: "evidence", description: "Return a bounded result." }],
    priority: "normal",
    execution_timeout_seconds: 60,
    retry_policy: { max_attempts: 2, effect_class: "READ_ONLY" },
  }, { timeoutSeconds: 1, maxAttempts: 1 });
}

test("platform v2 delegation is idempotent and projects execution facts separately", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const tasks = new TaskService(db, new EventHub(), { callbackEnabled: false });
  try {
    const first = tasks.delegate(input(), "hermes:owner", 1000);
    const replay = tasks.delegate(input(), "hermes:owner", 1001);
    assert.equal(first.deduplicated, false);
    assert.equal(replay.deduplicated, true);
    assert.equal(first.task_id, replay.task_id);
    const task = tasks.get(String(first.task_id)) as Record<string, any>;
    assert.equal(task.schemaVersion, 2);
    assert.equal(task.executionSemantics, "platform_v2");
    assert.equal(task.executionCertainty, "NOT_STARTED");
    assert.equal(task.validation.state, "NOT_REQUESTED");
    assert.equal(task.delivery.state, "NOT_REQUESTED");
    assert.equal(db.one("SELECT COUNT(*) AS count FROM task_event_outbox WHERE task_id = ?", first.task_id)?.count, 1);
  } finally { db.close(); }
});

test("platform v2 rejects a task type whose typed capability is missing", () => {
  assert.throws(() => parseTaskContractV2Input({
    schema_version: 2,
    source: "hermes",
    idempotency_key: "hermes-type-mismatch-1",
    source_intent_ref: "intent-type-mismatch-1",
    task_type: "codex",
    description: "This must not be offered to an LLM executor.",
    requirements: {
      capabilities_all: [{ id: "llm.inference", contract_version: 2 }],
      runtime: { id: "ollama" },
      model: { name: "llama3:latest", mode: "required" },
    },
    input: {},
    criteria: [],
    execution_timeout_seconds: 60,
    retry_policy: { max_attempts: 1, effect_class: "READ_ONLY" },
  }), /TASK_TYPE_CAPABILITY_MISMATCH/);
  assert.throws(() => parseTaskContractV2Input({
    schema_version: 2,
    source: "hermes",
    idempotency_key: "hermes-codex-workspace-1",
    source_intent_ref: "intent-codex-workspace-1",
    task_type: "codex",
    description: "Codex needs an explicit workspace.",
    requirements: { capabilities_all: [{ id: "codex", contract_version: 2 }] },
    input: {},
    criteria: [],
    execution_timeout_seconds: 60,
    retry_policy: { max_attempts: 1, effect_class: "READ_ONLY" },
  }), /WORKSPACE_REQUIRED_FOR_CODEX/);
});

test("platform v2 workspace cancellation stays UNKNOWN until stop evidence confirms release", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  try {
    const registration = workers.register({ name: "Fence Worker", registrationSecret: "fence-registration-secret-123", platform: "test", hardware: {} });
    workers.approveRegistration(registration.registrationId);
    const enrollment = workers.pollRegistration(registration.registrationId, "fence-registration-secret-123");
    workers.markConnected(String(enrollment.workerId), 1000);
    const created = tasks.delegate(input("hermes-op-2"), "hermes:owner", 1000);
    const assignment = tasks.assign(String(created.task_id), String(enrollment.workerId), 1001, { workerId: String(enrollment.workerId), runtime: "codex", workspaceId: "workspace-1" });
    assert.ok(assignment);
    const attempt = db.one<Record<string, any>>("SELECT * FROM task_attempts WHERE id = ?", assignment!.attemptId)!;
    assert.equal(attempt.fence_epoch, 1);
    assert.equal(db.one("SELECT state FROM workspace_locks WHERE workspace_id = 'workspace-1'")?.state, "HELD");
    const cancelled = tasks.cancelWithOptions(String(created.task_id), { expectedRevision: Number((tasks.get(String(created.task_id)) as Record<string, any>).revision), idempotencyKey: "cancel-op-2", principal: "hermes:owner" }, 1002)!;
    assert.equal((cancelled as Record<string, any>).executionCertainty, "UNKNOWN");
    assert.equal(db.one("SELECT state FROM workspace_locks WHERE workspace_id = 'workspace-1'")?.state, "HELD");
    tasks.recordStopReceipt(String(created.task_id), assignment!.attemptId, String(enrollment.workerId), { stop_state: "STOPPED", effect_state: "NONE", evidence: { children_accounted_for: true } }, 1003, 1);
    const final = tasks.get(String(created.task_id)) as Record<string, any>;
    assert.equal(final.executionCertainty, "TERMINAL_CONFIRMED");
    assert.equal(final.occupancy, "RELEASED");
    assert.equal(db.one("SELECT state FROM workspace_locks WHERE workspace_id = 'workspace-1'")?.state, "RELEASED");
  } finally { db.close(); }
});

test("platform v2 worker loss keeps the run non-terminal until reconciliation", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  try {
    const registration = workers.register({ name: "Loss Worker", registrationSecret: "loss-registration-secret-123", platform: "test", hardware: {} });
    workers.approveRegistration(registration.registrationId);
    const enrollment = workers.pollRegistration(registration.registrationId, "loss-registration-secret-123");
    const workerId = String(enrollment.workerId);
    workers.markConnected(workerId, 1000);
    const created = tasks.delegate(input("hermes-op-loss-1"), "hermes:owner", 1000);
    const assignment = tasks.assign(String(created.task_id), workerId, 1001, { workerId, runtime: "codex", workspaceId: "workspace-1" });
    assert.ok(assignment);
    assert.equal(tasks.started(String(created.task_id), assignment!.attemptId, workerId, 1002), true);
    assert.equal(tasks.fail(String(created.task_id), assignment!.attemptId, workerId, "WORKER_DISCONNECTED", "connection lost", 1003, false), "FAILED");

    const task = tasks.get(String(created.task_id)) as Record<string, any>;
    const attempt = db.one<Record<string, any>>("SELECT * FROM task_attempts WHERE id = ?", assignment!.attemptId)!;
    const run = db.one<Record<string, any>>("SELECT * FROM task_runs WHERE id = ?", created.run_id)!;
    assert.equal(task.status, "RUNNING");
    assert.equal(task.executionCertainty, "UNKNOWN");
    assert.equal(task.waitingReason, "RECONCILIATION_REQUIRED");
    assert.equal(attempt.status, "LOST");
    assert.equal(attempt.occupancy, "UNKNOWN");
    assert.equal(run.status, "RUNNING");
    assert.deepEqual(JSON.parse(String(run.failure_json)), { code: "WORKER_DISCONNECTED", message: "connection lost", reconciliationRequired: true });
  } finally { db.close(); }
});

test("platform v2 wait returns after a revision change", async () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  try {
    const created = tasks.delegate(input("hermes-op-3"), "hermes:owner", 2000);
    const initial = tasks.get(String(created.task_id)) as Record<string, any>;
    const registration = workers.register({ name: "Wait Worker", registrationSecret: "wait-registration-secret-123", platform: "test", hardware: {} });
    workers.approveRegistration(registration.registrationId);
    const enrollment = workers.pollRegistration(registration.registrationId, "wait-registration-secret-123");
    workers.markConnected(String(enrollment.workerId), 2000);
    const waiting = tasks.waitTask(String(created.task_id), Number(initial.revision), 1000);
    setTimeout(() => tasks.assign(String(created.task_id), String(enrollment.workerId), 2001), 5);
    const result = await waiting;
    assert.ok(Number((result as Record<string, any>).revision) > Number(initial.revision));
  } finally { db.close(); }
});

test("platform v2 HTTP and MCP adapters share the Task domain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-platform-v2-http-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const settings = new SettingsService(db);
  const health = new HealthMonitor(db, events); health.seed();
  const coordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true, cancel: () => true } as unknown as WorkerCoordinator;
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts: new ArtifactStorage(directory), settings, health, events, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const payload = { schema_version: 2, source: "hermes", idempotency_key: "http-v2-1", source_intent_ref: "http-intent-1", task_type: "generic", description: "HTTP v2 task", requirements: { capabilities_all: [{ id: "generic", contract_version: 2 }] }, input: { value: 1 }, criteria: [], execution_timeout_seconds: 60, retry_policy: { max_attempts: 1, effect_class: "READ_ONLY" } };
  const jsonRequest = async (path: string, init: RequestInit = {}) => { const response = await fetch(`${origin}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }); return { response, body: await response.json() as Record<string, any> }; };
  try {
    const created = await jsonRequest("/api/v2/tasks", { method: "POST", headers: { "idempotency-key": "http-v2-1", "x-actor": "hermes:http" }, body: JSON.stringify(payload) });
    assert.equal(created.response.status, 202);
    assert.equal(created.body.deduplicated, false);
    const replay = await jsonRequest("/api/v2/tasks", { method: "POST", headers: { "idempotency-key": "http-v2-1", "x-actor": "hermes:http" }, body: JSON.stringify(payload) });
    assert.equal(replay.body.deduplicated, true);
    const registration = workers.register({ name: "Query Worker", registrationSecret: "query-registration-secret-123", platform: "test", hardware: {} });
    workers.approveRegistration(registration.registrationId);
    const enrollment = workers.pollRegistration(registration.registrationId, "query-registration-secret-123");
    workers.markConnected(String(enrollment.workerId), 1000);
    workers.updateCapabilities(String(enrollment.workerId), [{ capability: "llm.inference", runtime: "ollama", status: "READY", contract_version: 2, evidence_state: "VERIFIED" }], 1000);
    workers.grantCapability(String(enrollment.workerId), String(db.one<Record<string, any>>("SELECT id FROM worker_capabilities WHERE worker_id = ?", enrollment.workerId)!.id), "owner", 1000);
    workers.updateModels(String(enrollment.workerId), [{ runtime: "ollama", id: "llama3:latest", status: "ready" }], 1000);
    const queried = await jsonRequest("/api/v2/capabilities/query", { method: "POST", body: JSON.stringify({ requirements: { capabilities_all: [{ id: "llm.inference", contract_version: 2 }], runtime: { id: "ollama" }, model: { id: "llama3:latest", mode: "required" } } }) });
    assert.equal(queried.response.status, 200);
    assert.deepEqual(queried.body.matched_candidates.map((item: Record<string, any>) => item.worker_id), [enrollment.workerId]);
    const mcp = await jsonRequest("/api/v2/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "control.tasks.get", params: { task_id: created.body.task_id } }) });
    assert.equal(mcp.response.status, 200);
    assert.equal(mcp.body.jsonrpc, "2.0");
    assert.equal(mcp.body.result.id, created.body.task_id);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
