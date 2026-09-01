import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { ArchiveDatabase } from "../apps/archive/src/db.ts";
import { ArchiveService, type NormalizedEnvelope } from "../apps/archive/src/service.ts";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { ApprovalService, type ApprovalBounds } from "../apps/orchestrator/src/approval-service.ts";
import { createHttpServer } from "../apps/orchestrator/src/http.ts";
import { PlanService } from "../apps/orchestrator/src/plan-service.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";
import { canonicalJson, sha256 } from "../packages/crypto/src/index.ts";

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const db = new OrchestratorDatabase(":memory:");
  const server = createHttpServer({ db, engine: new TaskEngine(db), allowUnauthenticated: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}

test("health and goal API expose durable admission", async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health/ready`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /pai_http_requests_total\{method="GET"\} [1-9]\d*/);

    const payload = {
      intent: "Run a local test",
      source: { kind: "web" },
      memoryRequirement: "none",
    };
    const created = await fetch(`${baseUrl}/api/v1/goals`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-goal-1" },
      body: JSON.stringify(payload),
    });
    assert.equal(created.status, 202);
    const body = await created.json();
    assert.equal(body.status, "PENDING");

    const replay = await fetch(`${baseUrl}/api/v1/goals`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "http-goal-1" },
      body: JSON.stringify(payload),
    });
    assert.equal(replay.status, 202);
    assert.equal(replay.headers.get("x-idempotent-replay"), "true");

    const read = await fetch(`${baseUrl}${body.links.self}`);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).status, "PENDING");
    const hidden = await fetch(`${baseUrl}${body.links.self}`, { headers: { "x-pai-dev-owner-id": "different-owner" } });
    assert.equal(hidden.status, 404);

    const cancel = await fetch(`${baseUrl}${body.links.self}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": "cancel-1" },
    });
    assert.equal(cancel.status, 202);
    assert.equal((await cancel.json()).status, "CANCELLING");
    const cancelReplay = await fetch(`${baseUrl}${body.links.self}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": "cancel-1" },
    });
    assert.equal(cancelReplay.status, 202);
    assert.equal(cancelReplay.headers.get("x-idempotent-replay"), "true");
    const plans = await fetch(`${baseUrl}${body.links.self}/plans`);
    assert.equal(plans.status, 200);
    const connectors = await fetch(`${baseUrl}/api/v1/connectors`);
    assert.equal(connectors.status, 200);
    const conversations = await fetch(`${baseUrl}/api/v1/conversations`);
    assert.equal(conversations.status, 503);
    const schedule = await fetch(`${baseUrl}/api/v1/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "http-test", timezone: "Asia/Taipei", recurrence: { kind: "interval", everyMs: 60_000, templateRevision: 1 }, nextRunAt: Date.now() + 60_000, misfirePolicy: "SKIP", goalTemplate: { intent: "scheduled", source: { kind: "schedule" }, memoryRequirement: "none" } }),
    });
    assert.equal(schedule.status, 201);
    const scheduleBody = await schedule.json();
    const paused = await fetch(`${baseUrl}/api/v1/schedules/${scheduleBody.id}/pause`, { method: "POST" });
    assert.equal(paused.status, 200);
    const manual = await fetch(`${baseUrl}/api/v1/schedules/${scheduleBody.id}/run`, { method: "POST" });
    assert.equal(manual.status, 202);
    assert.equal((await manual.json()).scheduleId, scheduleBody.id);
    const providers = await fetch(`${baseUrl}/api/v1/compute/providers`);
    assert.equal(providers.status, 200);
    const events = await fetch(`${baseUrl}/api/v1/events`);
    assert.equal(events.status, 200);
  });
});

test("production-style auth rejection is fail-closed", async () => {
  await withServer(async (baseUrl) => {
    const db = new OrchestratorDatabase(":memory:");
    const server = createHttpServer({ db, engine: new TaskEngine(db), allowUnauthenticated: false });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      const readiness = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
      assert.equal(readiness.status, 503);
      assert.equal((await readiness.json()).identity, "not_ready");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/goals`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "auth-test" },
        body: JSON.stringify({ intent: "should reject", source: { kind: "web" } }),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "AUTH_REQUIRED");
      const forwarded = await fetch(`http://127.0.0.1:${address.port}/api/v1/goals`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "auth-forwarded", "x-pai-verified": "1", "x-pai-owner-id": "owner-from-gateway", "x-pai-session-id": "session-db-id", "x-pai-auth-time": "1700000000000" },
        body: JSON.stringify({ intent: "forwarded request", source: { kind: "web" } }),
      });
      assert.equal(forwarded.status, 202);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  });
});

test("compatibility profile reports unavailable runtime as not required", async () => {
  const db = new OrchestratorDatabase(":memory:");
  const server = createHttpServer({ db, engine: new TaskEngine(db), allowUnauthenticated: false, identityReady: true, runtimeReady: false, runtimeRequired: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    const readiness = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.equal(readiness.status, 200);
    assert.equal((await readiness.json()).runtime, "not_required");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("connected Conversation Archive exposes owner read projections", async () => {
  const db = new OrchestratorDatabase(":memory:");
  const archiveDb = new ArchiveDatabase(":memory:");
  const archive = new ArchiveService(archiveDb, () => 1_700_000_000_000);
  const unsigned = { schemaVersion: 1 as const, source: "web", externalAccountHandle: "credential://provider-session/web/owner", conversation: { externalId: "thread-1", title: "Test", scope: ["personal"] }, message: { externalId: "message-1", revision: "1", role: "user", sentAt: "2026-08-28T00:00:00.000Z", content: { format: "text/plain", text: "hello" } }, provenance: { connectorId: "web" } };
  const envelope: NormalizedEnvelope = { ...unsigned, checksum: sha256(canonicalJson(unsigned as never)) };
  const inserted = archive.ingest(envelope, { globalDays: null });
  const server = createHttpServer({ db, engine: new TaskEngine(db), allowUnauthenticated: true, archiveService: archive });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const list = await fetch(`http://127.0.0.1:${address.port}/api/v1/conversations`);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.items[0].id, inserted.conversationId);
    assert.equal(listBody.items[0].messageCount, 1);
    const detail = await fetch(`http://127.0.0.1:${address.port}/api/v1/conversations/${inserted.conversationId}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.messages[0].content.text, "hello");
    assert.equal(detailBody.messages[0].expiresAt, null);
    const exportRequest = await fetch(`http://127.0.0.1:${address.port}/api/v1/conversations/${inserted.conversationId}/export`, { method: "POST", headers: { "idempotency-key": "export-http-1" } });
    assert.equal(exportRequest.status, 202);
    const exportBody = await exportRequest.json();
    const exportJob = await fetch(`http://127.0.0.1:${address.port}${exportBody.links.self}`);
    assert.equal(exportJob.status, 200);
    assert.equal((await exportJob.json()).status, "REQUESTED");
    const unsteppedDelete = await fetch(`http://127.0.0.1:${address.port}/api/v1/conversations/${inserted.conversationId}`, { method: "DELETE", headers: { "content-type": "application/json", "idempotency-key": "delete-http-1" }, body: JSON.stringify({ reason: "owner deletion", blockFuture: true }) });
    assert.equal(unsteppedDelete.status, 403);
    assert.equal((await unsteppedDelete.json()).error.code, "STEP_UP_REQUIRED");
    const deleteRequest = await fetch(`http://127.0.0.1:${address.port}/api/v1/conversations/${inserted.conversationId}`, { method: "DELETE", headers: { "content-type": "application/json", "idempotency-key": "delete-http-1", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ reason: "owner deletion", blockFuture: true }) });
    assert.equal(deleteRequest.status, 202);
    const deleteBody = await deleteRequest.json();
    assert.equal((await (await fetch(`http://127.0.0.1:${address.port}${deleteBody.links.self}`)).json()).status, "REQUESTED");
    const missing = await fetch(`http://127.0.0.1:${address.port}/api/v1/conversations/missing`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "CONVERSATION_NOT_FOUND");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    archiveDb.close();
    db.close();
  }
});

test("approval decision API is owner-scoped and emits a bounded grant", async () => {
  const now = Date.now();
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  const approval = new ApprovalService(db, () => now);
  const goal = engine.createGoal({ intent: "approval api", source: { kind: "web" }, memoryRequirement: "none" }, "owner", "approval-api-goal");
  const scope: ApprovalBounds = { actions: ["read"], resources: ["repo"], capabilityIds: ["cap"], workers: ["worker"], filesystemRoots: ["/repo"], networkDestinations: ["none"], recipients: ["owner"], mergeMode: "none", deploymentMode: "none", budget: { tokens: 100 } };
  const request = approval.createRequest({ goalId: String(goal.body.goalId), planDigest: "sha256:plan", policyVersion: 1, requiredScope: scope, expiresAt: now + 60_000 });
  const server = createHttpServer({ db, engine, approvalService: approval, allowUnauthenticated: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const headers = { "content-type": "application/json", "x-pai-dev-owner-id": "owner" };
    const hidden = await fetch(`http://127.0.0.1:${address.port}/api/v1/approvals/${request.id}`, { headers: { "x-pai-dev-owner-id": "other-owner" } });
    assert.equal(hidden.status, 404);
    const unstepped = await fetch(`http://127.0.0.1:${address.port}/api/v1/approvals/${request.id}/decision`, { method: "POST", headers, body: JSON.stringify({ decision: "APPROVE", approvedBounds: scope }) });
    assert.equal(unstepped.status, 403);
    assert.equal((await unstepped.json()).error.code, "STEP_UP_REQUIRED");
    const unknown = await fetch(`http://127.0.0.1:${address.port}/api/v1/approvals/${request.id}/decision`, { method: "POST", headers: { ...headers, "x-pai-auth-time": String(now) }, body: JSON.stringify({ decision: "APPROVE", approvedBounds: scope, signedGrant: "client-supplied" }) });
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, "INVALID_DECISION");
    const decision = await fetch(`http://127.0.0.1:${address.port}/api/v1/approvals/${request.id}/decision`, { method: "POST", headers: { ...headers, "x-pai-auth-time": String(now) }, body: JSON.stringify({ decision: "APPROVE", approvedBounds: scope }) });
    assert.equal(decision.status, 200);
    assert.equal((await decision.json()).request.status, "APPROVED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("owner management API exposes safe projections and keeps external adapters fail-closed", async () => {
  const now = Date.now();
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  db.run("INSERT INTO workers(id, identity_subject, name, platform, trust_state, protocol_min, protocol_max, wake_policy_json, drain_state, metadata_json, created_at, updated_at) VALUES ('worker-1', 'workload:worker-1', 'Mac worker', 'macOS', 'TRUSTED', '1.0', '1.0', '{}', 'RUNNABLE', '{}', ?, ?)", now, now);
  db.run("INSERT INTO capabilities(id, worker_id, kind, version, descriptor_hash, descriptor_json, discovered_state, grant_state, health, created_at, updated_at) VALUES ('cap-1', 'worker-1', 'codex.execute', '1.0', 'sha256:descriptor', '{}', 'DISCOVERED', 'REVIEW_REQUIRED', 'HEALTHY', ?, ?)", now, now);
  db.run("INSERT INTO providers(id, class, adapter, worker_id, status, descriptor_json, evidence_json, updated_at) VALUES ('provider-1', 'codex-subscription', 'disabled', 'worker-1', 'DISABLED', '{}', '{}', ?)", now);
  db.run("INSERT INTO quota_observations(id, provider_id, account_handle, window, used_json, remaining_json, confidence, source, observed_at) VALUES ('quota-1', 'provider-1', 'credential://provider-session/codex/owner', 'rolling', '{}', '{\"tokens\":100}', 'LOW', 'historical', ?)", now);
  db.run("INSERT INTO credential_handles(id, alias, storage_class, adapter, purpose, scopes_json, health, updated_at) VALUES ('credential-1', 'codex-owner', 'provider-session', 'codex', 'execution', '[]', 'UNKNOWN', ?)", now);
  db.run("INSERT INTO connector_runs(id, connector, source_account_handle, state, counters_json, created_at, updated_at) VALUES ('connector-1', 'ContextHub', 'credential://service/context-hub', 'DISABLED', '{}', ?, ?)", now, now);
  const server = createHttpServer({ db, engine, allowUnauthenticated: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const worker = await fetch(`${baseUrl}/api/v1/workers/worker-1`);
    assert.equal(worker.status, 200);
    const workerBody = await worker.json() as { capabilities: Array<{ grantState: string }>; connection: { state: string }; dispatch: { state: string; reason: string }; availableActions: { wake: boolean; purge: boolean } };
    assert.equal(workerBody.capabilities[0].grantState, "REVIEW_REQUIRED");
    assert.equal(workerBody.connection.state, "NO_HEARTBEAT");
    assert.equal(workerBody.dispatch.state, "BLOCKED");
    assert.equal(workerBody.dispatch.reason, "NO_HEALTHY_GRANTED_CAPABILITY");
    assert.equal(workerBody.availableActions.wake, false);
    assert.equal(workerBody.availableActions.purge, true);
    const wake = await fetch(`${baseUrl}/api/v1/workers/worker-1/wake`, { method: "POST" });
    assert.equal(wake.status, 503);
    assert.equal((await wake.json()).error.code, "WAKE_ADAPTER_NOT_CONFIGURED");
    const grant = await fetch(`${baseUrl}/api/v1/workers/worker-1/capabilities/cap-1/grant`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(now) }, body: JSON.stringify({ descriptorHash: "sha256:descriptor" }) });
    assert.equal(grant.status, 200);
    assert.equal((await grant.json()).grantState, "GRANTED");
    const drained = await fetch(`${baseUrl}/api/v1/workers/worker-1/drain`, { method: "POST" });
    assert.equal(drained.status, 202);
    assert.equal((await drained.json()).drainState, "DRAINED");
    const resumed = await fetch(`${baseUrl}/api/v1/workers/worker-1/resume`, { method: "POST", headers: { "x-pai-auth-time": String(now) } });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).drainState, "RUNNABLE");
    const renamed = await fetch(`${baseUrl}/api/v1/workers/worker-1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed worker" }) });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).name, "Renamed worker");
    const revokedCapability = await fetch(`${baseUrl}/api/v1/workers/worker-1/capabilities/cap-1/revoke`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(now) }, body: JSON.stringify({ descriptorHash: "sha256:descriptor" }) });
    assert.equal(revokedCapability.status, 200);
    const unsteppedDelete = await fetch(`${baseUrl}/api/v1/workers/worker-1`, { method: "DELETE" });
    assert.equal(unsteppedDelete.status, 403);
    assert.equal((await unsteppedDelete.json()).error.code, "STEP_UP_REQUIRED");
    const deleted = await fetch(`${baseUrl}/api/v1/workers/worker-1`, { method: "DELETE", headers: { "x-pai-auth-time": String(now) } });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).retention, "historical-task-and-audit-evidence-preserved");
    const retained = await fetch(`${baseUrl}/api/v1/workers/worker-1`);
    assert.equal(retained.status, 404);
    const repeatedDelete = await fetch(`${baseUrl}/api/v1/workers/worker-1`, { method: "DELETE", headers: { "x-pai-auth-time": String(now) } });
    assert.equal(repeatedDelete.status, 200);
    assert.equal((await repeatedDelete.json()).alreadyPurged, true);
    assert.equal(db.one("SELECT id FROM providers WHERE id = 'provider-1'"), undefined);
    assert.equal(db.one("SELECT id FROM quota_observations WHERE id = 'quota-1'"), undefined);

    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const enrollmentResponse = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem, deviceSummary: { name: "Laptop", platform: "macOS" } }) });
    assert.equal(enrollmentResponse.status, 202);
    const enrollment = await enrollmentResponse.json();
    assert.equal(typeof enrollment.challenge, "string");
    assert.notEqual(db.one<{ challenge_hash: string }>("SELECT challenge_hash FROM worker_enrollment_requests WHERE id = ?", enrollment.id)?.challenge_hash, enrollment.challenge);
    const enrollmentList = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests`);
    assert.equal(enrollmentList.status, 200);
    assert.equal((await enrollmentList.json()).items[0].id, enrollment.id);
    const secondKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    const secondEnrollment = await (await fetch(`${baseUrl}/api/v1/workers/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem: secondKey, deviceSummary: { name: "Cancelled Laptop", platform: "macOS" } }) })).json();
    const cancelled = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${secondEnrollment.id}`, { method: "DELETE", headers: { "x-pai-auth-time": String(now) } });
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json()).deleted, true);
    const approved = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${enrollment.id}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(now) }, body: JSON.stringify({ fingerprint: enrollment.fingerprint }) });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).next, "AWAITING_WORKER_PROOF");
    const approvedList = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests?status=APPROVED`);
    assert.equal((await approvedList.json()).items[0].status, "APPROVED");

    const policy = await fetch(`${baseUrl}/api/v1/policies`, { method: "PATCH", headers: { "content-type": "application/json", "x-pai-auth-time": String(now) }, body: JSON.stringify({ autonomy: { personal: "notify" }, hardStops: ["deployment"] }) });
    assert.equal(policy.status, 201);
    assert.equal((await policy.json()).version, 1);
    assert.equal((await (await fetch(`${baseUrl}/api/v1/policies`)).json()).items.length, 1);
    const routes = await fetch(`${baseUrl}/api/v1/compute/routes`);
    assert.equal(routes.status, 200);
    assert.deepEqual((await routes.json()).providers, []);
    const system = await fetch(`${baseUrl}/api/v1/system`);
    assert.equal(system.status, 200);
    assert.equal((await system.json()).counts.workers, 0);
    const audit = await fetch(`${baseUrl}/api/v1/audit`);
    assert.equal(audit.status, 200);
    assert.ok((await audit.json()).items.length >= 4);
    const connectorRun = await fetch(`${baseUrl}/api/v1/connectors/ContextHub/run`, { method: "POST" });
    assert.equal(connectorRun.status, 503);
    assert.equal((await connectorRun.json()).error.code, "CONNECTOR_NOT_CONFIGURED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("expired approved enrollment requests can be permanently purged and are idempotent", async () => {
  const now = Date.now();
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  const server = createHttpServer({ db, engine, allowUnauthenticated: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const created = await (await fetch(`${baseUrl}/api/v1/workers/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem, deviceSummary: { name: "Expired", platform: "macOS" } }) })).json() as { id: string };
    db.run("UPDATE worker_enrollment_requests SET status = 'APPROVED', expires_at = ? WHERE id = ?", now - 1, created.id);
    const list = await (await fetch(`${baseUrl}/api/v1/workers/enrollment-requests`)).json() as { items: Array<{ id: string; status: string }> };
    assert.equal(list.items[0].status, "EXPIRED");
    const deleted = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${created.id}`, { method: "DELETE", headers: { "x-pai-auth-time": String(now) } });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, true);
    assert.equal(db.one("SELECT id FROM worker_enrollment_requests WHERE id = ?", created.id), undefined);
    assert.ok(db.one("SELECT id FROM worker_purge_tombstones WHERE enrollment_request_id = ?", created.id));
    const removedStatus = await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${created.id}/status`);
    assert.equal(removedStatus.status, 410);
    const repeated = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${created.id}`, { method: "DELETE", headers: { "x-pai-auth-time": String(now) } });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).alreadyPurged, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("busy worker purge is rejected without partial changes", async () => {
  const now = Date.now();
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  db.run("INSERT INTO workers(id, identity_subject, name, platform, trust_state, protocol_min, protocol_max, metadata_json, created_at, updated_at) VALUES ('busy-worker', 'worker:busy-worker', 'Busy', 'macOS', 'TRUSTED', '1.0', '1.0', '{}', ?, ?)", now, now);
  const goal = engine.createGoal({ intent: "busy worker", source: { kind: "web" }, memoryRequirement: "none" }, "owner", "busy-worker-goal");
  const goalId = String(goal.body.goalId);
  new PlanService(db, () => now).activate(goalId, { schemaVersion: 1, goalId, revision: 1, intent: "busy worker", acceptanceCriteria: [{ id: "done", description: "done", verificationTaskId: "busy-task" }], tasks: [{ taskId: "busy-task", type: "fake", title: "Busy task", required: true, sideEffectClass: "READ_ONLY" }] });
  db.run("INSERT INTO attempts(id, task_id, generation, worker_id, state, usage_json, started_at) VALUES ('busy-attempt', 'busy-task', 1, 'busy-worker', 'RUNNING', '{}', ?)", now);
  const server = createHttpServer({ db, engine, allowUnauthenticated: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + "/api/v1/workers/busy-worker", { method: "DELETE", headers: { "x-pai-auth-time": String(now) } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "WORKER_BUSY");
    assert.ok(db.one("SELECT id FROM workers WHERE id = 'busy-worker'"));
    assert.ok(db.one("SELECT id FROM attempts WHERE id = 'busy-attempt'"));
    assert.equal(db.one("SELECT id FROM worker_purge_tombstones WHERE worker_id = 'busy-worker'"), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("goal detail projects DAG, attempts, checkpoints, reconciliation, and SSE cursor events", async () => {
  const now = Date.now();
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db, () => now);
  const goal = engine.createGoal({ intent: "inspect full detail", source: { kind: "web" }, memoryRequirement: "none" }, "owner", "detail-goal");
  const goalId = String(goal.body.goalId);
  new PlanService(db, () => now).activate(goalId, { schemaVersion: 1, goalId, revision: 1, intent: "inspect full detail", acceptanceCriteria: [{ id: "verified", description: "verified", verificationTaskId: "verify" }], tasks: [{ taskId: "work", type: "fake", title: "Work", required: true, sideEffectClass: "READ_ONLY" }, { taskId: "verify", type: "fake", title: "Verify", required: true, sideEffectClass: "READ_ONLY", dependsOn: ["work"] }] });
  db.run("INSERT INTO attempts(id, task_id, generation, state, lease_id, fencing_token, usage_json, started_at) VALUES ('attempt-1', 'work', 1, 'RUNNING', 'lease-1', 1, '{\"tokens\":2}', ?)", now);
  db.run("INSERT INTO checkpoints(id, task_id, attempt_id, schema_version, portable, next_action, created_at) VALUES ('checkpoint-1', 'work', 'attempt-1', 1, 1, 'resume', ?)", now);
  db.run("INSERT INTO reconciliation_records(id, task_id, attempt_id, provider, operation_kind, idempotency_key, request_digest, expected_resource_json, started_at, last_observed_state, reconciliation_strategy, status, last_observed_at) VALUES ('reconciliation-1', 'work', 'attempt-1', 'fake', 'read', 'op-1', 'sha256:request', '{}', ?, 'unknown', 'poll', 'OPEN', ?)", now, now);
  const server = createHttpServer({ db, engine, allowUnauthenticated: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const tasksResponse = await fetch(`${baseUrl}/api/v1/goals/${goalId}/tasks`, { headers: { "x-pai-dev-owner-id": "owner" } });
    const tasksText = await tasksResponse.text();
    assert.equal(tasksResponse.status, 200, tasksText);
    const tasks = JSON.parse(tasksText);
    const work = tasks.items.find((item: { id: string }) => item.id === "work");
    const verify = tasks.items.find((item: { id: string }) => item.id === "verify");
    assert.equal(work.attempts[0].usage.tokens, 2);
    assert.equal(work.checkpoints[0].portable, true);
    assert.equal(work.reconciliation[0].status, "OPEN");
    assert.deepEqual(verify.dependencies, ["work"]);
    engine.appendAudit("goal.updated", `goal:${goalId}`, "owner", "OBSERVED", 1, {});
    const events = await fetch(`${baseUrl}/api/v1/events?after=0`, { headers: { accept: "text/event-stream", "x-pai-dev-owner-id": "owner" } });
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.match(await events.text(), /event: goal.updated/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});
