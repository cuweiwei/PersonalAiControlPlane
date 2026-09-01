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
import { canonicalJson, sha256 } from "../packages/crypto/src/index.ts";
import { signWorkerEnvelope, signEnrollmentProof } from "../packages/worker/src/index.ts";
import type { WorkerEnvelope } from "../packages/worker/src/index.ts";
import { WorkerDatabase } from "../apps/worker/src/db.ts";
import { OutboundWorkerRuntime } from "../apps/worker/src/runtime.ts";
import { FileDeviceKeyStore, FileWorkerCredentialStore, WorkerHttpTransport, WorkerWebSocketTransport } from "../apps/worker/src/transport.ts";
import { WorkerBootstrap } from "../apps/worker/src/bootstrap.ts";
import { createWorkerDaemon } from "../apps/worker/src/service.ts";

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

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

test("resident worker bootstrap auto-finalizes after owner approval", async () => {
  await withServer(async (baseUrl, _channel, db) => {
    const temp = mkdtempSync(join(tmpdir(), "pai-worker-bootstrap-"));
    const keyStore = new FileDeviceKeyStore(join(temp, "device-key.json"));
    const credentialStore = new FileWorkerCredentialStore(join(temp, "credential.json"));
    const bootstrap = new WorkerBootstrap({ origin: baseUrl, keyStore, credentialStore, enrollmentPath: join(temp, "enrollment.json"), deviceSummary: { name: "Auto", platform: "darwin" } });
    assert.equal(await bootstrap.ensureCredential(), undefined);
    const pending = bootstrap.readEnrollment();
    assert.ok(pending);
    const enrollment = db.one<{ fingerprint: string }>("SELECT fingerprint FROM worker_enrollment_requests WHERE id = ?", pending!.requestId);
    assert.ok(enrollment);
    const approve = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${pending!.requestId}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ fingerprint: enrollment!.fingerprint }) });
    assert.equal(approve.status, 200);
    const credential = await bootstrap.ensureCredential();
    assert.ok(credential);
    assert.equal(credentialStore.read()?.workerId, credential!.workerId);
    assert.equal(bootstrap.readEnrollment(), undefined);
  });
});

test("worker daemon starts from an uncredentialed install and connects after approval", async () => {
  await withServer(async (baseUrl, _channel, db) => {
    const temp = mkdtempSync(join(tmpdir(), "pai-worker-daemon-"));
    const service = createWorkerDaemon({ dataDir: temp, origin: baseUrl, repositories: {}, pollIntervalMs: 10, heartbeatIntervalMs: 10 });
    service.daemon.start();
    try {
      await waitFor(() => Boolean(db.one("SELECT id FROM worker_enrollment_requests WHERE status = 'PENDING'")));
      const pending = db.one<{ id: string; fingerprint: string }>("SELECT id, fingerprint FROM worker_enrollment_requests WHERE status = 'PENDING'");
      assert.ok(pending);
      const approve = await fetch(`${baseUrl}/api/v1/workers/enrollment-requests/${pending!.id}/approve`, { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ fingerprint: pending!.fingerprint }) });
      assert.equal(approve.status, 200);
      await waitFor(() => Boolean(db.one("SELECT worker_id FROM worker_connections")) && Boolean(db.one("SELECT worker_id FROM capabilities WHERE kind = 'codex.execute'")));
      assert.equal(db.one<{ trust_state: string }>("SELECT trust_state FROM workers LIMIT 1")?.trust_state, "TRUSTED");
      assert.equal(db.one<{ grant_state: string }>("SELECT grant_state FROM capabilities WHERE kind = 'codex.execute'")?.grant_state, "REVIEW_REQUIRED");
    } finally {
      service.daemon.stop();
      service.db.close();
    }
  });
});

test("removed bootstrap enters terminal state until explicit reset creates a new key", async () => {
  await withServer(async (baseUrl, _channel, db) => {
    const temp = mkdtempSync(join(tmpdir(), "pai-worker-removed-"));
    const keyStore = new FileDeviceKeyStore(join(temp, "device-key.json"));
    const credentialStore = new FileWorkerCredentialStore(join(temp, "credential.json"));
    const bootstrap = new WorkerBootstrap({ origin: baseUrl, keyStore, credentialStore, enrollmentPath: join(temp, "enrollment.json"), removedPath: join(temp, "removed.json"), deviceSummary: { name: "Removed", platform: "darwin" } });
    await bootstrap.requestEnrollment();
    const firstKey = await keyStore.publicKeyPem();
    bootstrap.markRemoved();
    assert.equal(bootstrap.isRemoved(), true);
    assert.equal(await bootstrap.ensureCredential(), undefined);
    assert.equal(db.one("SELECT COUNT(*) AS count FROM worker_enrollment_requests")?.count, 1);
    await bootstrap.resetLocalIdentity();
    assert.equal(bootstrap.isRemoved(), false);
    await bootstrap.requestEnrollment();
    assert.notEqual(await keyStore.publicKeyPem(), firstKey);
    assert.equal(db.one("SELECT COUNT(*) AS count FROM worker_enrollment_requests")?.count, 2);
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

test("worker purge rejects old channel credentials, drains offers, and supersedes capability grants", async () => {
  await withServer(async (baseUrl, channel, db) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const created = await (await fetch(baseUrl + "/api/v1/worker/enrollment-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKeyPem, deviceSummary: { name: "Purge", platform: "darwin" } }) })).json() as { requestId: string; challenge: string; fingerprint: string };
    await fetch(baseUrl + "/api/v1/workers/enrollment-requests/" + created.requestId + "/approve", { method: "POST", headers: { "content-type": "application/json", "x-pai-auth-time": String(Date.now()) }, body: JSON.stringify({ fingerprint: created.fingerprint }) });
    const status = await (await fetch(baseUrl + "/api/v1/worker/enrollment-requests/" + created.requestId + "/status")).json() as { serverNonce: string };
    const credentials = await (await fetch(baseUrl + "/api/v1/worker/enrollment-requests/" + created.requestId + "/finalize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: created.challenge, serverNonce: status.serverNonce, workerSignature: signEnrollmentProof(created.challenge, status.serverNonce, privateKey) }) })).json() as { workerId: string; credential: string };
    const connectionId = "purge-connection";
    assert.equal(channel.poll({ workerId: credentials.workerId, credential: credentials.credential, connectionId }).offers.length, 0);
    const descriptorBase = { kind: "codex.execute", version: "1.0.0", health: "HEALTHY" as const, properties: { loginMode: "chatgpt", sandboxModes: ["workspace_write"], maxConcurrency: 1 } };
    const descriptorOne = { ...descriptorBase, descriptorHash: sha256(canonicalJson(descriptorBase)) };
    const descriptorTwoBase = { ...descriptorBase, properties: { ...descriptorBase.properties, maxConcurrency: 2 } };
    const descriptorTwo = { ...descriptorTwoBase, descriptorHash: sha256(canonicalJson(descriptorTwoBase)) };
    channel.receive(credentials.workerId, credentials.credential, signWorkerEnvelope({ protocolVersion: "1.0", messageId: "purge-hello-1", connectionId, sequence: 0, workerId: credentials.workerId, sentAt: new Date().toISOString(), nonce: "0123456789abcdef", type: "worker.hello", payload: descriptorOne }, privateKey));
    const firstCapability = db.one<{ id: string }>("SELECT id FROM capabilities WHERE worker_id = ?", credentials.workerId);
    assert.ok(firstCapability);
    db.run("UPDATE capabilities SET grant_state = 'GRANTED' WHERE id = ?", firstCapability!.id);
    channel.receive(credentials.workerId, credentials.credential, signWorkerEnvelope({ protocolVersion: "1.0", messageId: "purge-hello-2", connectionId, sequence: 1, workerId: credentials.workerId, sentAt: new Date().toISOString(), nonce: "0123456789abcdef", type: "capability.update", payload: descriptorTwo }, privateKey));
    assert.equal(db.one<{ grant_state: string; superseded_by: string | null }>("SELECT grant_state, superseded_by FROM capabilities WHERE id = ?", firstCapability!.id)?.grant_state, "REVOKED");
    assert.ok(db.one("SELECT id FROM capabilities WHERE worker_id = ? AND descriptor_hash = ?", credentials.workerId, descriptorTwo.descriptorHash));
    const heartbeat = signWorkerEnvelope({ protocolVersion: "1.0", messageId: "purge-heartbeat", connectionId, sequence: 2, workerId: credentials.workerId, sentAt: new Date().toISOString(), nonce: "0123456789abcdef", type: "worker.heartbeat", payload: { health: "HEALTHY", transport: "HTTP_FALLBACK", resources: { cpuCount: 2, memoryFreeBytes: 1234 }, runtime: { activeJobs: 0, queuedJobs: 0, maxConcurrency: 2 } } }, privateKey);
    channel.receive(credentials.workerId, credentials.credential, heartbeat);
    assert.equal(db.one<{ health: string; transport: string }>("SELECT health, transport FROM worker_runtime_status WHERE worker_id = ?", credentials.workerId)?.transport, "HTTP_FALLBACK");
    db.run("UPDATE workers SET drain_state = 'DRAINING' WHERE id = ?", credentials.workerId);
    assert.throws(() => channel.queueOffer({ workerId: credentials.workerId } as never), (error: unknown) => (error as { status?: number; code?: string }).status === 409 && (error as { code?: string }).code === "WORKER_NOT_RUNNABLE");
    const deleted = await fetch(baseUrl + "/api/v1/workers/" + credentials.workerId, { method: "DELETE", headers: { "x-pai-auth-time": String(Date.now()) } });
    assert.equal(deleted.status, 200);
    const oldPoll = await fetch(baseUrl + "/api/v1/worker/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential, connectionId }) });
    assert.equal(oldPoll.status, 410);
    assert.equal((await oldPoll.json()).error.code, "WORKER_REMOVED");
    const oldRotate = await fetch(baseUrl + "/api/v1/worker/credentials/rotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workerId: credentials.workerId, credential: credentials.credential }) });
    assert.equal(oldRotate.status, 410);
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
    transport.close();
    workerDb.close();
  });
});
