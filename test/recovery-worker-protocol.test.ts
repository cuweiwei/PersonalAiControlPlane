import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { QuotaPoolService } from "../apps/control-plane/src/recovery/quota-pool-service.ts";
import { RecoveryService } from "../apps/control-plane/src/recovery/recovery-service.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { TaskService } from "../apps/control-plane/src/tasks/task-service.ts";
import { WorkerCoordinator } from "../apps/control-plane/src/workers/worker-channel.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";

async function waitFor(messages: Record<string, any>[], predicate: (message: Record<string, any>) => boolean): Promise<Record<string, any>> {
  for (let index = 0; index < 200; index += 1) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("matching worker protocol message was not received");
}

test("authenticated negotiated Worker can report fenced quota blockers and account-bound observations only", async () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const settings = new SettingsService(db);
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const recovery = new RecoveryService(db);
  const quotaPools = new QuotaPoolService(db);
  const coordinator = new WorkerCoordinator(workers, tasks, events, undefined, settings, recovery, quotaPools);
  const server = createServer();
  server.on("upgrade", (request, socket, head) => coordinator.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const secret = "recovery-protocol-registration-secret";
  const registration = workers.register({ name: "Protocol Worker", registrationSecret: secret, platform: "win32", hardware: {} });
  workers.approveRegistration(registration.registrationId, "test-owner");
  const enrollment = workers.pollRegistration(registration.registrationId, secret);
  const workerId = String(enrollment.workerId);
  const pool = quotaPools.createPool({ provider: "openai", account_fingerprint: `sha256:${"c".repeat(64)}`, identity_state: "OWNER_CONFIRMED" }, "test-owner") as any;
  quotaPools.bindWorker({ poolId: pool.id, workerId, runtime: "opencode", evidence: "OWNER_CONFIRMED" }, "test-owner");
  // Test-only setup of a reviewed deployment profile; SettingsService deliberately
  // rejects enabling these capability flags before external evidence exists.
  db.run("UPDATE settings SET value_json = 'true' WHERE key IN ('opencode_session_adapter_enabled','quota_recovery_engine_enabled')");

  const now = Date.now();
  db.run(`INSERT INTO tasks(id, source, title, task_type, instruction, context_json, payload_json, execution_json, priority, status,
    timeout_seconds, max_attempts, created_at, updated_at, current_attempt_id, execution_semantics, occupancy, effect_state, control_cancel)
    VALUES ('task-wire', 'test', 'Quota task', 'opencode', 'resume same task', '{}', '{}', '{"workspace_id":"workspace-wire"}', 50,
    'RUNNING', 1800, 1, ?, ?, 'attempt-wire', 'platform_v2', 'RUNNING', 'NONE_CONFIRMED', 'NONE')`, now, now);
  db.run(`INSERT INTO task_attempts(id, task_id, attempt_number, worker_id, status, assigned_at, started_at, occupancy, effect_state, fence_epoch, workspace_id)
    VALUES ('attempt-wire', 'task-wire', 1, ?, 'RUNNING', ?, ?, 'RUNNING', 'NONE_CONFIRMED', 3, 'workspace-wire')`, workerId, now, now);
  db.run(`INSERT INTO workspace_locks(workspace_id, lock_mode, attempt_id, fence_epoch, state, acquired_at, updated_at)
    VALUES ('workspace-wire', 'WRITE_EXCLUSIVE', 'attempt-wire', 3, 'HELD', ?, ?)`, now, now);

  const messages: Record<string, any>[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/worker/ws`, { headers: { authorization: `Bearer ${enrollment.token}` } });
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, any>));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocol_version: 2, worker_id: workerId, features: ["native_session_v1", "quota_reporting_v1"] }));
    const hello = await waitFor(messages, (message) => message.type === "hello.ack");
    assert.deepEqual(hello.features.filter((feature: string) => ["native_session_v1", "quota_reporting_v1"].includes(feature)).sort(), ["native_session_v1", "quota_reporting_v1"]);

    socket.send(JSON.stringify({ type: "agent.session.report", task_id: "task-wire", attempt_id: "attempt-wire", runtime: "opencode", native_session_id: "opaque-session-id", workspace_id: "workspace-wire", workspace_fence_epoch: 3, blocker_kind: "WEEKLY", blocker_generation: 1, resume_policy: "INHERIT_WORKER", observed_at: Date.now() }));
    const sessionAck = await waitFor(messages, (message) => message.type === "agent.session.ack");
    assert.equal(sessionAck.state, "WAITING_RESET");
    assert.equal(JSON.stringify(sessionAck).includes("opaque-session-id"), false);
    assert.equal(db.one<any>("SELECT status FROM tasks WHERE id = 'task-wire'")?.status, "RUNNING");

    const sendQuota = (bucket: "FIVE_HOUR" | "WEEKLY") => socket.send(JSON.stringify({ type: "agent.quota.report", runtime: "opencode", observation: { bucket, exhausted: false, used_percent: 20, resets_at: null, observed_at: Date.now(), source: "PROVIDER_USAGE_API", confidence: "HIGH", evidence_hash: `sha256:${bucket === "FIVE_HOUR" ? "d" : "e"}`.padEnd(71, "0") } }));
    sendQuota("FIVE_HOUR");
    const firstQuotaAck = await waitFor(messages, (message) => message.type === "agent.quota.ack");
    assert.equal(firstQuotaAck.quota_ready, false);
    sendQuota("WEEKLY");
    const secondQuotaAck = await waitFor(messages, (message) => message.type === "agent.quota.ack" && message.bucket === "WEEKLY");
    assert.equal(secondQuotaAck.quota_ready, true);
    assert.equal(messages.some((message) => message.type === "agent.resume.request"), false);
    assert.equal(db.one<any>("SELECT COUNT(*) AS count FROM recovery_intents")?.count, 1);
  } finally {
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    coordinator.close();
    db.close();
  }
});

test("quota recovery feature gate rejects blocker reports until both session and quota flags are enabled", async () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const settings = new SettingsService(db);
  const tasks = new TaskService(db, events, { callbackEnabled: false });
  const workers = new WorkerService(db, events);
  const coordinator = new WorkerCoordinator(workers, tasks, events, undefined, settings, new RecoveryService(db), new QuotaPoolService(db));
  // A session adapter flag alone must not activate quota-block persistence.
  db.run("UPDATE settings SET value_json = 'true' WHERE key = 'opencode_session_adapter_enabled'");
  const server = createServer();
  server.on("upgrade", (request, socket, head) => coordinator.handleUpgrade(request, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const secret = "recovery-gate-registration-secret";
  const registration = workers.register({ name: "Gated Worker", registrationSecret: secret, platform: "win32", hardware: {} });
  workers.approveRegistration(registration.registrationId, "test-owner");
  const enrollment = workers.pollRegistration(registration.registrationId, secret);
  const messages: Record<string, any>[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/worker/ws`, { headers: { authorization: `Bearer ${enrollment.token}` } });
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Record<string, any>));
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", protocol_version: 2, worker_id: enrollment.workerId, features: ["native_session_v1", "quota_reporting_v1"] }));
    const hello = await waitFor(messages, (message) => message.type === "hello.ack");
    assert.equal(hello.features.includes("native_session_v1"), true);
    assert.equal(hello.features.includes("quota_reporting_v1"), false);
    socket.send(JSON.stringify({ type: "agent.session.report" }));
    const rejection = await waitFor(messages, (message) => message.type === "error");
    assert.equal(rejection.code, "SESSION_REPORT_UNSUPPORTED");
  } finally {
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    coordinator.close();
    db.close();
  }
});
