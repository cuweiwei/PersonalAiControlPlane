import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStorage } from "../apps/control-plane/src/artifacts/artifact-storage.ts";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { OrchestrationService } from "../apps/control-plane/src/orchestration/orchestration-service.ts";
import { createControlPlaneServer } from "../apps/control-plane/src/server.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";
import { ResourceScheduler } from "../apps/control-plane/src/scheduler/scheduler.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";
import type { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";
import { parseOrchestrationWorkContract } from "../packages/contracts/src/index.ts";

function workContract(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    origin: { kind: "CODEX", origin_ref: "codex-thread:opaque-1" },
    objective: "Implement the approved feature within the bounded workspace scope.",
    project_ref: "project-1",
    repository_ref: "repo-1",
    phase_ref: "phase-1",
    design_authority: "MAC_LED",
    implementation_owner: "WINDOWS",
    design_refs: ["docs/design.md"],
    base_commit_sha: "a".repeat(40),
    workspace_id: "workspace-1",
    owned_paths: ["src/feature/**"],
    acceptance_criteria: [{ id: "AC-1", text: "The feature follows the approved contract." }],
    required_tests: [{ kind: "COMMAND", command_ref: "approved-test-profile" }, { kind: "CI" }],
    target: { capability: "opencode", runtime: "opencode", preferred_worker_id: null },
    review: { owner: "CODEX", merge_allowed: false },
    resume_policy: "MANUAL_ONLY",
    risk_tier: "MEDIUM",
    ...overrides,
  };
}

function taskContract(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    source: "codex",
    source_intent_ref: "intent-implementation-1",
    task_type: "opencode",
    title: "Implement approved feature",
    description: "Implement the approved feature in the registered workspace.",
    input: { request: "Implement the approved acceptance criteria." },
    requirements: {
      capabilities_all: [{ id: "opencode", contract_version: 1 }],
      runtime: { id: "opencode" },
      workspace_ref: "workspace-1",
    },
    criteria: [],
    execution_timeout_seconds: 300,
    retry_policy: { max_attempts: 1, effect_class: "WORKSPACE_WRITE" },
    ...overrides,
  };
}

test("orchestration Work contract validates owner, workspace scope, and non-merge review", () => {
  const parsed = parseOrchestrationWorkContract(workContract());
  assert.equal(parsed.origin.kind, "CODEX");
  assert.equal(parsed.resume_policy, "MANUAL_ONLY");
  assert.throws(() => parseOrchestrationWorkContract(workContract({ review: { owner: "HERMES", merge_allowed: false } })), /contract.review/);
  assert.throws(() => parseOrchestrationWorkContract(workContract({ owned_paths: ["../outside/**"] })), /workspace-relative/);
});

test("orchestration Work owner ACL, revision CAS, bounded delegation, and idempotency are enforced atomically", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const orchestration = new OrchestrationService(db, tasks);
  try {
    const created = orchestration.createWork(workContract(), "codex:owner", "work-create-1", 10_000);
    assert.equal(created.revision, 1);
    assert.equal(created.deduplicated, false);
    const replayCreate = orchestration.createWork(workContract(), "codex:owner", "work-create-1", 10_001);
    assert.equal(replayCreate.work_id, created.work_id);
    assert.equal(replayCreate.deduplicated, true);
    assert.throws(() => orchestration.createWork(workContract({ objective: "different request" }), "codex:owner", "work-create-1", 10_002), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => orchestration.getWork(String(created.work_id), "hermes:other"), /WORK_OWNER_CONFLICT/);

    const delegated = orchestration.delegateTask(String(created.work_id), taskContract(), "codex:owner", 1, "delegate-1", 10_010);
    assert.equal(delegated.revision, 2);
    assert.equal(delegated.state, "QUEUED");
    assert.equal(delegated.execution_condition, "READY");
    assert.equal(delegated.deduplicated, false);
    const task = tasks.get(String(delegated.task_id)) as Record<string, any>;
    assert.equal(task.workRef.id, created.work_id);
    assert.equal(task.workRef.revision, 1);
    assert.equal(task.workRef.owner, "codex:owner");
    assert.deepEqual(task.payload.orchestration_work.owned_paths, ["src/feature/**"]);
    assert.equal(task.payload.orchestration_work.resume_policy, "MANUAL_ONLY");
    assert.equal(db.one("SELECT condition FROM task_execution_conditions WHERE task_id = ?", delegated.task_id)?.condition, "READY");

    const replayDelegate = orchestration.delegateTask(String(created.work_id), taskContract(), "codex:owner", 1, "delegate-1", 10_011);
    assert.equal(replayDelegate.task_id, delegated.task_id);
    assert.equal(replayDelegate.deduplicated, true);
    assert.throws(() => orchestration.delegateTask(String(created.work_id), taskContract({ title: "different" }), "codex:owner", 1, "delegate-1", 10_012), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => orchestration.delegateTask(String(created.work_id), taskContract(), "codex:owner", 1, "delegate-2", 10_013), /WORK_REVISION_CONFLICT/);

    const work = orchestration.getWork(String(created.work_id), "codex:owner");
    assert.equal(work.revision, 2);
    assert.equal((work.tasks as Array<Record<string, unknown>>).length, 1);
  } finally { db.close(); }
});

test("orchestration delegation rejects tasks outside the approved target without mutating Work or tasks", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const tasks = new TaskService(db, new EventHub(), { callbackEnabled: false });
  const orchestration = new OrchestrationService(db, tasks);
  try {
    const work = orchestration.createWork(workContract(), "codex:owner", "work-create-bounded", 20_000);
    assert.throws(() => orchestration.delegateTask(String(work.work_id), taskContract({ requirements: {
      capabilities_all: [{ id: "opencode", contract_version: 1 }],
      runtime: { id: "opencode" },
      workspace_ref: "different-workspace",
    } }), "codex:owner", 1, "delegate-out-of-scope", 20_010), /WORK_TASK_OUT_OF_SCOPE/);
    assert.equal(orchestration.getWork(String(work.work_id), "codex:owner").revision, 1);
    assert.equal(db.one("SELECT COUNT(*) AS count FROM tasks")?.count, 0);
  } finally { db.close(); }
});

test("Work controls use revision CAS, pause queued delegation, cancel linked tasks atomically, and never fake native resume", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const tasks = new TaskService(db, new EventHub(), { callbackEnabled: false });
  const orchestration = new OrchestrationService(db, tasks);
  try {
    const work = orchestration.createWork(workContract(), "codex:owner", "control-create", 30_000);
    const paused = orchestration.controlWork(String(work.work_id), "PAUSE", "codex:owner", 1, "pause-1", 30_010);
    assert.equal(paused.status, "PAUSED");
    assert.throws(() => orchestration.delegateTask(String(work.work_id), taskContract(), "codex:owner", 2, "paused-delegate", 30_011), /WORK_PAUSED/);
    assert.throws(() => orchestration.controlWork(String(work.work_id), "MANUAL_RESUME", "codex:owner", 2, "resume-manual", 30_012), /SESSION_CONTROL_UNSUPPORTED/);
    const resumed = orchestration.controlWork(String(work.work_id), "RESUME_WHEN_ELIGIBLE", "codex:owner", 2, "resume-eligible", 30_013);
    assert.equal(resumed.status, "ACTIVE");
    assert.equal(resumed.execution_dispatched, false);

    const delegated = orchestration.delegateTask(String(work.work_id), taskContract(), "codex:owner", 3, "control-delegate", 30_020);
    const cancelled = orchestration.controlWork(String(work.work_id), "CANCEL", "codex:owner", 4, "cancel-work", 30_030);
    assert.equal(cancelled.status, "CANCELLED");
    assert.deepEqual(cancelled.cancelled_task_ids, [delegated.task_id]);
    assert.equal(tasks.get(String(delegated.task_id))?.status, "CANCELLED");
    const replay = orchestration.controlWork(String(work.work_id), "CANCEL", "codex:owner", 4, "cancel-work", 30_031);
    assert.equal(replay.deduplicated, true);
    assert.throws(() => orchestration.getWorkEvents(String(work.work_id), "another-owner"), /WORK_OWNER_CONFLICT/);
    const firstPage = orchestration.getWorkEvents(String(work.work_id), "codex:owner", 0, 2);
    assert.equal((firstPage.items as unknown[]).length, 2);
    assert.equal(firstPage.has_more, true);
    const secondPage = orchestration.getWorkEvents(String(work.work_id), "codex:owner", Number(firstPage.next_cursor), 10);
    assert.ok((secondPage.items as unknown[]).length >= 3);
  } finally { db.close(); }
});

test("paused Work keeps queued Tasks out of ResourceScheduler until explicit unpause", () => {
  const now = 50_000;
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const registration = workers.register({ name: "Work scheduler worker", registrationSecret: "work-scheduler-secret-123", platform: "win32", hardware: {} }, now);
  const workerId = String(workers.approveRegistration(registration.registrationId, "test-owner", now + 1).workerId);
  workers.markConnected(workerId, now + 2);
  workers.updateCapabilities(workerId, [{ capability: "generic", status: "READY", grant_status: "GRANTED", evidence_state: "VERIFIED", verification_ref: "test:verified-generic", descriptor: { properties: { workspaceIds: ["workspace-1"] } } }], now + 3);
  db.run("UPDATE worker_capabilities SET grant_status = 'GRANTED' WHERE worker_id = ? AND capability = 'generic'", workerId);
  workers.setProtocolFeatures(workerId, ["resolved_execution_v1", "task_run_v1", "attempt_fencing_v1", "durable_result_ack_v1", "workspace_lock_v1"], now + 4);
  const offers: string[] = [];
  const coordinator = { isConnected: () => true, offer: (_workerId: string, task: Record<string, any>) => { offers.push(String(task.id)); return true; } } as unknown as WorkerCoordinator;
  const scheduler = new ResourceScheduler(db, tasks, workers, coordinator, events);
  const orchestration = new OrchestrationService(db, tasks);
  try {
    const work = orchestration.createWork(workContract({ workspace_id: "workspace-1", target: { capability: "generic", runtime: "auto", preferred_worker_id: null } }), "codex:owner", "scheduler-work-create", now + 4);
    const task = orchestration.delegateTask(String(work.work_id), taskContract({
      task_type: "generic",
      requirements: { capabilities_all: [{ id: "generic", contract_version: 1 }], runtime: { id: "auto" }, workspace_ref: "workspace-1" },
    }), "codex:owner", 1, "scheduler-work-task", now + 5);
    orchestration.controlWork(String(work.work_id), "PAUSE", "codex:owner", 2, "scheduler-work-pause", now + 6);
    assert.equal(scheduler.tick(now + 7), 0);
    assert.deepEqual(offers, []);
    orchestration.controlWork(String(work.work_id), "RESUME_WHEN_ELIGIBLE", "codex:owner", 3, "scheduler-work-unpause", now + 8);
    assert.equal(scheduler.tick(now + 9), 1, JSON.stringify(db.one("SELECT * FROM task_dispatch_state WHERE task_id = ?", task.task_id)));
    assert.deepEqual(offers, [String(task.task_id)]);
  } finally { db.close(); }
});

test("acceptance is owner-scoped, evidence-backed, criteria-complete, and durably replayable", () => {
  const db = new ControlPlaneDatabase(":memory:");
  const tasks = new TaskService(db, new EventHub(), { callbackEnabled: false });
  const orchestration = new OrchestrationService(db, tasks);
  try {
    const work = orchestration.createWork(workContract(), "codex:owner", "accept-create", 40_000);
    const delegated = orchestration.delegateTask(String(work.work_id), taskContract(), "codex:owner", 1, "accept-delegate", 40_010);
    db.run("UPDATE tasks SET status = 'SUCCEEDED', finished_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", 40_020, 40_020, delegated.task_id);
    const acceptance = { decision: "ACCEPTED", evidence_refs: ["artifact:sha256:abc", "ci:run-42"], accepted_criteria: ["AC-1"], task_id: delegated.task_id, pr_ref: "https://example.invalid/pull/42" };
    const result = orchestration.recordAcceptance(String(work.work_id), acceptance, "codex:owner", 2, "accept-1", 40_030);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.review_state, "ACCEPTED");
    const replay = orchestration.recordAcceptance(String(work.work_id), acceptance, "codex:owner", 2, "accept-1", 40_031);
    assert.equal(replay.deduplicated, true);
    const view = orchestration.getWork(String(work.work_id), "codex:owner");
    assert.equal(view.status, "COMPLETED");
    assert.equal((view.review_handoffs as Array<Record<string, unknown>>)[0].review_state, "ACCEPTED");
    assert.equal((orchestration.getWorkEvents(String(work.work_id), "codex:owner").items as Array<Record<string, unknown>>).at(-1)?.type, "WORK_ACCEPTANCE_RECORDED");
    assert.throws(() => orchestration.recordAcceptance(String(work.work_id), acceptance, "other-owner", 3, "accept-other", 40_032), /WORK_OWNER_CONFLICT/);
  } finally { db.close(); }
});

test("orchestration HTTP writes stay fail-closed while the gateway capability is disabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-orchestration-gate-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const settings = new SettingsService(db);
  const health = new HealthMonitor(db, events);
  health.seed();
  const coordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const orchestration = new OrchestrationService(db, tasks);
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts: new ArtifactStorage(directory), settings, health, events, orchestration, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${origin}/api/v2/orchestration/works`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor": "codex:owner", "idempotency-key": "http-work-1" },
      body: JSON.stringify(workContract()),
    });
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "ORCHESTRATION_DISABLED");
    assert.equal(db.one("SELECT COUNT(*) AS count FROM orchestration_works")?.count, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("orchestration MCP tool adapter uses the same gated Work domain service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pai-orchestration-mcp-"));
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const settings = new SettingsService(db);
  db.run("UPDATE settings SET value_json = 'true' WHERE key = 'orchestration_gateway_enabled'");
  const health = new HealthMonitor(db, events);
  health.seed();
  const coordinator = { closeWorker: () => {}, handleUpgrade: () => {}, isConnected: () => true, offer: () => true } as unknown as WorkerCoordinator;
  const orchestration = new OrchestrationService(db, tasks);
  const server = createControlPlaneServer({ db, tasks, workers, coordinator, artifacts: new ArtifactStorage(directory), settings, health, events, orchestration, assetRoot: directory });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const response = await fetch(`${origin}/api/v2/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor": "codex:mcp-owner" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "rpc-1", method: "pai_submit_work", params: { contract: workContract(), idempotency_key: "mcp-create-1" } }),
    });
    const rpc = await response.json() as Record<string, any>;
    assert.equal(response.status, 200);
    assert.equal(rpc.result.revision, 1);
    assert.equal(rpc.result.status, "OPEN");
    assert.equal(db.one("SELECT owner_principal FROM orchestration_works WHERE id = ?", rpc.result.work_id)?.owner_principal, "codex:mcp-owner");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
