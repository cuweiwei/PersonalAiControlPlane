import assert from "node:assert/strict";
import test from "node:test";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
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
