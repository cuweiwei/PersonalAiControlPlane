import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { ApprovalService, type ApprovalBounds } from "../apps/orchestrator/src/approval-service.ts";
import { createHttpServer } from "../apps/orchestrator/src/http.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";

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

test("approval decision API is owner-scoped and emits a bounded grant", async () => {
  const now = 1_700_000_000_000;
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
    const decision = await fetch(`http://127.0.0.1:${address.port}/api/v1/approvals/${request.id}/decision`, { method: "POST", headers, body: JSON.stringify({ decision: "APPROVE", authTime: now, signedGrant: "signed-grant", approvedBounds: scope }) });
    assert.equal(decision.status, 200);
    assert.equal((await decision.json()).request.status, "APPROVED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});
