import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { IdentityDatabase } from "../apps/identity-gateway/src/db.ts";
import { WorkloadActionGrantService, workloadRequestSigningPayload, type ActionGrantIssueInput, type WorkloadRequestProof } from "../apps/identity-gateway/src/grants.ts";
import { createIdentityHttpServer } from "../apps/identity-gateway/src/http.ts";
import { IdentityService } from "../apps/identity-gateway/src/service.ts";
import { verifyActionGrant } from "../packages/identity/src/index.ts";

function setup() {
  let now = 1_700_000_000_000;
  const db = new IdentityDatabase(":memory:");
  const workloadKeys = generateKeyPairSync("ed25519");
  const grantKeys = generateKeyPairSync("ed25519");
  const service = new WorkloadActionGrantService(db, {
    sign(privateKeyRef, input) {
      assert.equal(privateKeyRef, "opaque://grant-key-1");
      return sign(null, input, grantKeys.privateKey);
    },
  }, () => now);
  const workloadId = service.registerWorkload("orchestrator", "pai-orchestrator", workloadKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
  service.registerSigningKey("grant-key-1", grantKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), "opaque://grant-key-1", "ACTIVE");
  const body: ActionGrantIssueInput = {
    audience: "pai-worker:worker-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    planDigest: "sha256:plan",
    policyVersion: 1,
    fencingToken: 7,
    actions: ["codex.execute"],
    resources: ["repo:test"],
    capabilityIds: ["cap-1"],
    budget: { tokens: 100 },
    sandbox: { roots: ["repo:test"] },
    hardStopApprovalId: null,
    expiresInSeconds: 120,
  };
  const proof = (nonce: string, idempotencyKey = "issue-1", input = body): WorkloadRequestProof => {
    const unsigned = { timestamp: now, nonce, idempotencyKey, method: "POST" as const, path: "/api/v1/workloads/action-grants" as const };
    return { ...unsigned, workloadId, signature: sign(null, Buffer.from(workloadRequestSigningPayload(unsigned, input), "utf8"), workloadKeys.privateKey).toString("base64url") };
  };
  return { db, service, workloadId, workloadKeys, grantKeys, body, proof, advance: (ms: number) => { now += ms; } };
}

test("workload proof issues an exactly-bound action grant through an opaque signing-key handle", async () => {
  const { db, service, grantKeys, body, proof } = setup();
  const issued = await service.issue(proof("nonce-1"), body);
  assert.equal(issued.replayed, false);
  const verified = verifyActionGrant(issued.token, {
    issuer: "pai-identity-gateway",
    audience: body.audience,
    taskId: body.taskId,
    attemptId: body.attemptId,
    planDigest: body.planDigest,
    policyVersion: body.policyVersion,
    fencingToken: body.fencingToken,
    allowedActions: body.actions,
    allowedResources: body.resources,
    allowedCapabilityIds: body.capabilityIds,
    resolveKey: (kid) => kid === "grant-key-1" ? { kid, state: "ACTIVE", publicKey: grantKeys.publicKey } : undefined,
    consumeJti: () => true,
    nowSeconds: 1_700_000_000,
  });
  assert.equal(verified.ok, true);
  assert.equal(db.one<{ private_key_ref: string }>("SELECT private_key_ref FROM signing_keys WHERE kid = 'grant-key-1'")?.private_key_ref, "opaque://grant-key-1");
  assert.equal(db.one<{ count: number }>("SELECT COUNT(*) AS count FROM identity_audit_events WHERE action = 'action-grant.issued'")?.count, 1);
  db.close();
});

test("workload nonce replay and idempotency conflicts fail closed while a fresh proof replays the stored grant", async () => {
  const { db, service, body, proof } = setup();
  const first = await service.issue(proof("nonce-1"), body);
  await assert.rejects(() => service.issue(proof("nonce-1"), body), /WORKLOAD_REQUEST_REPLAY/);
  const replay = await service.issue(proof("nonce-2"), body);
  assert.equal(replay.replayed, true);
  assert.equal(replay.token, first.token);
  const changed = { ...body, fencingToken: 8 };
  await assert.rejects(() => service.issue(proof("nonce-3", "issue-1", changed), changed), /IDEMPOTENCY_CONFLICT/);
  db.close();
});

test("workload action-grant HTTP route verifies signed request context and returns public verification keys", async () => {
  const { db, service, body, proof } = setup();
  const identity = new IdentityService(db);
  const server = createIdentityHttpServer({ db, identity, passkeyConfigured: false, actionGrantService: service });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const signed = proof("http-nonce");
    const response = await fetch(`${baseUrl}/api/v1/workloads/action-grants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": signed.idempotencyKey,
        "x-pai-workload-id": signed.workloadId,
        "x-pai-workload-timestamp": String(signed.timestamp),
        "x-pai-workload-nonce": signed.nonce,
        "x-pai-workload-signature": signed.signature,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    assert.equal(typeof (await response.json()).token, "string");
    const keys = await fetch(`${baseUrl}/api/v1/action-grant-keys`);
    assert.equal(keys.status, 200);
    assert.deepEqual((await keys.json()).keys.map((key: { kid: string }) => key.kid), ["grant-key-1"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});
