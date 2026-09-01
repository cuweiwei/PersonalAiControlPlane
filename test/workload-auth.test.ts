import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import test from "node:test";
import { canonicalJson } from "../packages/crypto/src/index.ts";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { createHttpServer } from "../apps/orchestrator/src/http.ts";
import { allowHermesWorkloadOperation, workloadBodyDigest, WorkloadRequestVerifier, WORKLOAD_HEADERS, workloadRequestSigningPayload } from "../apps/orchestrator/src/workload-auth.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function headers(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], workloadId: string, method: string, path: string, body: unknown, idempotencyKey = ""): Record<string, string> {
  const timestamp = Date.now();
  const nonce = randomBytes(24).toString("base64url");
  const digest = workloadBodyDigest(body);
  const payload = workloadRequestSigningPayload({ method, path, timestamp, nonce, idempotencyKey, bodyDigest: digest });
  const signature = sign(null, Buffer.from(payload), privateKey).toString("base64url");
  return {
    [WORKLOAD_HEADERS.id]: workloadId,
    [WORKLOAD_HEADERS.timestamp]: String(timestamp),
    [WORKLOAD_HEADERS.nonce]: nonce,
    [WORKLOAD_HEADERS.signature]: signature,
    [WORKLOAD_HEADERS.bodyDigest]: digest,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

test("workload proof authenticates Hermes goal requests and rejects replay or body tampering", async () => {
  const keys = generateKeyPairSync("ed25519");
  const db = new OrchestratorDatabase(":memory:");
  const engine = new TaskEngine(db);
  const verifier = new WorkloadRequestVerifier({ workloadId: "hermes-test", ownerId: "owner-hermes", subject: "hermes-agent", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() });
  const server = createHttpServer({ db, engine, allowUnauthenticated: false, runtimeRequired: false, workloadAuth: verifier });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const body = { intent: "check status", source: { kind: "hermes" }, memoryRequirement: "none" };
    const firstHeaders = headers(keys.privateKey, "hermes-test", "POST", "/api/v1/goals", body, "goal-1");
    const first = await fetch(`${base}/api/v1/goals`, { method: "POST", headers: { ...firstHeaders, "content-type": "application/json" }, body: canonicalJson(body as never) });
    assert.equal(first.status, 202);
    const firstBody = await first.json() as { goalId: string };
    const list = await fetch(`${base}/api/v1/goals`, { headers: headers(keys.privateKey, "hermes-test", "GET", "/api/v1/goals", {}) });
    assert.equal(list.status, 200);
    assert.equal((await list.json() as { items: unknown[] }).items.length, 1);
    // Reuse the first nonce/signature to prove nonce replay is denied.
    const replay = await fetch(`${base}/api/v1/goals`, { method: "POST", headers: { ...firstHeaders, "content-type": "application/json" }, body: canonicalJson(body as never) });
    assert.equal(replay.status, 401);
    const tampered = await fetch(`${base}/api/v1/goals`, { method: "POST", headers: { ...headers(keys.privateKey, "hermes-test", "POST", "/api/v1/goals", body, "goal-2"), "content-type": "application/json" }, body: canonicalJson({ ...body, intent: "tampered" } as never) });
    assert.equal(tampered.status, 401);
    const invalidCancel = await fetch(`${base}/api/v1/goals/does-not-exist/cancel`, { method: "POST", headers: { "x-pai-workload-id": "hermes-test", "content-type": "application/json" }, body: "{}" });
    assert.equal(invalidCancel.status, 401);
    assert.ok(firstBody.goalId);
  } finally {
    await close(server);
    db.close();
  }
});

test("Hermes workload policy excludes owner-management and mutation routes", () => {
  const request = (method: string, url: string): IncomingMessage => ({ method, url } as IncomingMessage);
  assert.equal(allowHermesWorkloadOperation(request("POST", "/api/v1/schedules"), {}), false);
  assert.equal(allowHermesWorkloadOperation(request("POST", "/api/v1/approvals/a/decision"), { decision: "APPROVE" }), false);
  assert.equal(allowHermesWorkloadOperation(request("GET", "/api/v1/goals/a/tasks"), {}), true);
});
