import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrchestratorDatabase } from "../apps/orchestrator/src/db.ts";
import { WorkerChannelService } from "../apps/orchestrator/src/worker-channel.ts";
import { createHttpServer } from "../apps/orchestrator/src/http.ts";
import { TaskEngine } from "../apps/orchestrator/src/task-engine.ts";
import { signWorkerEnvelope, signEnrollmentProof } from "../packages/worker/src/index.ts";
import type { WorkerEnvelope } from "../packages/worker/src/index.ts";
import { WorkerDatabase } from "../apps/worker/src/db.ts";
import { OutboundWorkerRuntime } from "../apps/worker/src/runtime.ts";
import { WorkerHttpTransport, WorkerWebSocketTransport } from "../apps/worker/src/transport.ts";

async function withServer(run: (baseUrl: string, channel: WorkerChannelService, db: OrchestratorDatabase) => Promise<void>): Promise<void> {
  const db = new OrchestratorDatabase(":memory:");
  const channel = new WorkerChannelService(db);
  const server = createHttpServer({ db, engine: new TaskEngine(db), allowUnauthenticated: true, workerChannel: channel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`, channel, db); }
  finally { channel.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); db.close(); }
}

test("device enrollment finalizes only after owner approval and proof of possession", async () => {
  await withServer(async (baseUrl, channel, db) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const requestResponse = await fetch(`${baseUrl}/api/v1/worker/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem, deviceSummary: { name: "MacBook", platform: "darwin", version: "0.1.0" } }) });
    assert.equal(requestResponse.status, 202);
    const request = await requestResponse.json() as { requestId: string; challenge: string; fingerprint: string };
    const approve = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${request.requestId}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ fingerprint: request.fingerprint }) });
    assert.equal(approve.status, 200);
    const status = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${request.requestId}/status`)).json() as { serverNonce: string; status: string };
    assert.equal(status.status, "APPROVED");
    const finalize = await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${request.requestId}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: request.challenge, serverNonce: status.serverNonce, workerSignature: signEnrollmentProof(request.challenge, status.serverNonce, privateKey) }) });
    assert.equal(finalize.status, 201);
    const credentials = await finalize.json() as { workerId: string; credential: string; credentialId: string };
    assert.match(credentials.credential, /^[A-Za-z0-9_-]{32,}$/);
    assert.ok(db.one("SELECT id FROM worker_credentials WHERE id = ?", credentials.credentialId));
    const replay = await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${request.requestId}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: request.challenge, serverNonce: status.serverNonce, workerSignature: signEnrollmentProof(request.challenge, status.serverNonce, privateKey) }) });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, "ENROLLMENT_ALREADY_FINALIZED");
    channel.close();
  });
});

test("worker poll and events authenticate signed frames and resolve a queued result", async () => {
  await withServer(async (baseUrl, channel, db) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const created = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem, deviceSummary: { name: "Windows", platform: "win32" } }) })).json() as { requestId: string; challenge: string; fingerprint: string };
    await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${created.requestId}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ fingerprint: created.fingerprint }) });
    const status = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${created.requestId}/status`)).json() as { serverNonce: string };
    const credentials = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${created.requestId}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: created.challenge, serverNonce: status.serverNonce, workerSignature: signEnrollmentProof(created.challenge, status.serverNonce, privateKey) }) })).json() as { workerId: string; credential: string };
    const now = Date.now();
    const connectionId = "connection-test";
    const hello = signWorkerEnvelope({ protocolVersion: "1.0", messageId: "hello-1", connectionId, sequence: 0, workerId: credentials.workerId, sentAt: new Date(now).toISOString(), nonce: "0123456789abcdef", type: "worker.hello", payload: { kind: "codex.execute" } }, privateKey);
    const poll = await fetch(`${baseUrl}/api/v1/worker/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential, connectionId, hello }) });
    assert.equal(poll.status, 200);
    assert.equal((await poll.json()).generation, 1);
    const heartbeat = signWorkerEnvelope({ protocolVersion: "1.0", messageId: "heartbeat-1", connectionId, sequence: 1, workerId: credentials.workerId, sentAt: new Date(now).toISOString(), nonce: "0123456789abcdef", type: "worker.heartbeat", payload: { health: "HEALTHY" } }, privateKey);
    const event = await fetch(`${baseUrl}/api/v1/worker/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential, frame: heartbeat }) });
    assert.equal(event.status, 202);
    const job = { workerId: credentials.workerId, capabilityId: "cap-1", capabilityDescriptorHash: "sha256:descriptor", attemptId: "attempt-channel", taskId: "task-channel", planDigest: "sha256:plan", policyVersion: 1, fencingToken: 1, leaseId: "lease-channel", requiredAction: "codex.execute", resources: ["repo:test"], budget: {}, sandbox: {}, hardStopApprovalId: null, actionGrant: "grant", input: {} };
    const resultPromise = channel.offer(job, 2_000);
    const offered = await (await fetch(`${baseUrl}/api/v1/worker/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential, connectionId }) })).json() as { offers: typeof job[] };
    assert.equal(offered.offers[0].attemptId, job.attemptId);
    const resultFrame: WorkerEnvelope = signWorkerEnvelope({ protocolVersion: "1.0", messageId: "result-1", connectionId, sequence: 2, workerId: credentials.workerId, sentAt: new Date(now).toISOString(), nonce: "0123456789abcdef", type: "job.result", payload: { attemptId: job.attemptId, taskId: job.taskId, outcome: "COMPLETED", result: { artifact: "sha256:result" } } }, privateKey);
    const resultEvent = await fetch(`${baseUrl}/api/v1/worker/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential, frame: resultFrame }) });
    assert.equal(resultEvent.status, 202);
    assert.equal((await resultPromise).status, "COMPLETED");
    assert.equal(db.one<{ status: string }>("SELECT status FROM worker_channel_messages WHERE attempt_id = ?", job.attemptId)?.status, "ACKED");
    const replayFrame = signWorkerEnvelope({ protocolVersion: resultFrame.protocolVersion, messageId: resultFrame.messageId, connectionId: resultFrame.connectionId, sequence: 3, workerId: resultFrame.workerId, sentAt: resultFrame.sentAt, nonce: resultFrame.nonce, type: resultFrame.type, payload: resultFrame.payload }, privateKey);
    const replay = await fetch(`${baseUrl}/api/v1/worker/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential, frame: replayFrame }) });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, "WORKER_MESSAGE_REPLAY");
    const rotated = await fetch(`${baseUrl}/api/v1/worker/credentials/rotate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential }) });
    assert.equal(rotated.status, 201);
    const rotatedBody = await rotated.json() as { credential: string };
    const oldPoll = await fetch(`${baseUrl}/api/v1/worker/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential, connectionId }) });
    assert.equal(oldPoll.status, 401);
    const newPoll = await fetch(`${baseUrl}/api/v1/worker/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: rotatedBody.credential, connectionId: "connection-new" }) });
    assert.equal(newPoll.status, 200);
  });
});

test("WorkerHttpTransport performs the signed hello and heartbeat sequence", async () => {
  await withServer(async (baseUrl, _channel, db) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const created = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem, deviceSummary: { name: "Transport", platform: "darwin" } }) })).json() as { requestId: string; challenge: string; fingerprint: string };
    await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${created.requestId}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ fingerprint: created.fingerprint }) });
    const status = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${created.requestId}/status`)).json() as { serverNonce: string };
    const credentials = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${created.requestId}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: created.challenge, serverNonce: status.serverNonce, workerSignature: signEnrollmentProof(created.challenge, status.serverNonce, privateKey) }) })).json() as { workerId: string; credential: string };
    const temp = mkdtempSync(join(tmpdir(), "pai-worker-transport-"));
    const enrolledSigner = (payload: Buffer) => sign(null, payload, privateKey);
    const workerDb = new WorkerDatabase(join(temp, "worker.db"));
    const transport = new WorkerHttpTransport({ origin: baseUrl, workerId: credentials.workerId, credential: credentials.credential, db: workerDb, signer: enrolledSigner, descriptor: { kind: "codex.execute", version: "1.0.0", health: "HEALTHY", properties: { loginMode: "chatgpt", sandboxModes: ["workspace_write"], maxConcurrency: 1 } } });
    assert.deepEqual(await transport.poll(), []);
    const runtime = new OutboundWorkerRuntime({ workerId: credentials.workerId, connectionId: transport.activeConnectionId, db: workerDb, transport, adapter: { capabilityId: "codex.execute", descriptor: { kind: "codex.execute", version: "1.0.0", descriptorHash: "sha256:descriptor", health: "HEALTHY", properties: {} }, async probe() { return "HEALTHY"; }, async execute() { return { outcome: "COMPLETED", result: {} }; } }, resolveGrantKey: () => undefined, signFrame: enrolledSigner });
    await runtime.heartbeat();
    assert.equal(db.one<{ last_sequence: number }>("SELECT last_sequence FROM worker_connections WHERE worker_id = ?", credentials.workerId)?.last_sequence, 1);
    workerDb.close();
  });
});

test("WorkerWebSocketTransport uses WSS and keeps HTTP fallback available", async () => {
  await withServer(async (baseUrl, _channel, db) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const created = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem, deviceSummary: { name: "WebSocket", platform: "darwin" } }) })).json() as { requestId: string; challenge: string; fingerprint: string };
    await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${created.requestId}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ fingerprint: created.fingerprint }) });
    const status = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${created.requestId}/status`)).json() as { serverNonce: string };
    const credentials = await (await fetch(`${baseUrl}/api/v1/worker/enrollment-requests/${created.requestId}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: created.challenge, serverNonce: status.serverNonce, workerSignature: signEnrollmentProof(created.challenge, status.serverNonce, privateKey) }) })).json() as { workerId: string; credential: string };
    const workerDb = new WorkerDatabase(":memory:");
    const transport = new WorkerWebSocketTransport({ origin: baseUrl, workerId: credentials.workerId, credential: credentials.credential, db: workerDb, signer: (payload: Buffer) => sign(null, payload, privateKey), descriptor: { kind: "codex.execute", version: "1.0.0", health: "HEALTHY", properties: { loginMode: "chatgpt", sandboxModes: ["workspace_write"], maxConcurrency: 1 } } });
    assert.deepEqual(await transport.poll(), []);
    const heartbeat = signWorkerEnvelope({ protocolVersion: "1.0", messageId: "ws-heartbeat", connectionId: transport.activeConnectionId, sequence: 1, workerId: credentials.workerId, sentAt: new Date().toISOString(), nonce: "0123456789abcdef", type: "worker.heartbeat", payload: { health: "HEALTHY" } }, privateKey);
    await transport.send(heartbeat);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(db.one<{ last_sequence: number }>("SELECT last_sequence FROM worker_connections WHERE worker_id = ?", credentials.workerId)?.last_sequence, 1);
    workerDb.close();
  });
});
