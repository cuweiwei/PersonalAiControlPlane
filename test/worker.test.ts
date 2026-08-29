import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { canonicalJson, sha256 } from "../packages/crypto/src/index.ts";
import { approveEnrollment, createEnrollmentRequest, publicKeyFingerprint, resolvePathWithinRoots, signWorkerEnvelope, validateCapabilityDescriptor, validateJobOffer, validateShellInvocation, verifyEnrollmentProof, WorkerConnectionVerifier, type CapabilityDescriptor } from "../packages/worker/src/index.ts";

test("signed worker frames enforce connection, sequence, timestamp, and message replay", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = 1_700_000_000_000;
  const verifier = new WorkerConnectionVerifier("conn-1", "worker-1", publicKey, () => now);
  const unsigned = { protocolVersion: "1.0", messageId: "m-1", connectionId: "conn-1", sequence: 0, workerId: "worker-1", sentAt: new Date(now).toISOString(), nonce: "nonce-1234567890", type: "worker.heartbeat" as const, payload: { health: "HEALTHY" } };
  const frame = signWorkerEnvelope(unsigned, privateKey);
  assert.equal(verifier.verify(frame).ok, true);
  assert.deepEqual(verifier.verify(frame), { ok: false, code: "MESSAGE_REPLAY", message: "worker message id was already accepted" });
  const stale = signWorkerEnvelope({ ...unsigned, messageId: "m-2", sequence: 1, sentAt: new Date(now - 120_000).toISOString() }, privateKey);
  assert.equal(verifier.verify(stale).ok, false);
});

test("enrollment binds approval and proof to the displayed public-key fingerprint", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const request = createEnrollmentRequest(publicKey, { platform: "macos", version: "1" }, 1_700_000_000_000);
  assert.equal(request.fingerprint, publicKeyFingerprint(publicKey));
  assert.equal(approveEnrollment(request, "wrong", true, 1_700_000_000_001).status, "REJECTED");
  const approved = approveEnrollment(request, request.fingerprint, true, 1_700_000_000_001);
  const serverNonce = "server-nonce";
  const proof = sign(null, Buffer.from(`${request.challenge}.${serverNonce}`, "utf8"), privateKey).toString("base64url");
  assert.equal(verifyEnrollmentProof(approved, serverNonce, proof, 1_700_000_000_002), true);
  assert.equal(verifyEnrollmentProof({ ...approved, status: "EXPIRED" }, serverNonce, proof, 1_700_000_000_002), false);
});

test("capability descriptors are allowlisted and digest-bound", () => {
  const descriptorBase = { kind: "codex.execute", version: "1.0.0", health: "HEALTHY" as const, properties: { loginMode: "chatgpt", sandboxModes: ["workspace_write"], maxConcurrency: 1 } };
  const descriptor: CapabilityDescriptor = { ...descriptorBase, descriptorHash: sha256(canonicalJson(descriptorBase)) };
  assert.deepEqual(validateCapabilityDescriptor(descriptor), { valid: true });
  assert.equal(validateCapabilityDescriptor({ ...descriptor, properties: { ...descriptor.properties, OPENAI_API_KEY: "secret" } }).valid, false);
});

test("filesystem and shell profiles reject traversal and host-boundary commands", () => {
  const root = mkdtempSync(join(tmpdir(), "pai-worker-"));
  mkdirSync(join(root, "repo"));
  assert.notEqual(resolvePathWithinRoots(join(root, "repo", "file.txt"), [join(root, "repo")]), undefined);
  assert.equal(resolvePathWithinRoots(join(root, "repo", "..", "outside"), [join(root, "repo")]), undefined);
  const profile = { name: "test", allowedExecutables: ["git"], allowedEnvironment: ["LANG"], roots: [join(root, "repo")], maxRuntimeMs: 10_000, maxOutputBytes: 100_000, network: "none" as const };
  assert.deepEqual(validateShellInvocation(profile, "sudo", [], join(root, "repo"), {}), { valid: false, reason: "executable-not-allowed" });
  assert.deepEqual(validateShellInvocation({ ...profile, allowedExecutables: ["/usr/bin/sudo"] }, "/usr/bin/sudo", ["-n", "true"], join(root, "repo"), {}), { valid: false, reason: "privilege-or-host-boundary-command" });
  assert.deepEqual(validateShellInvocation(profile, "git", ["status;rm"], join(root, "repo"), {}), { valid: false, reason: "shell-metacharacter-rejected" });
  assert.deepEqual(validateShellInvocation(profile, "git", ["status"], join(root, "repo"), { PATH: "/tmp" }), { valid: false, reason: "environment-key-not-allowed" });
});

test("job offers require exact fencing and grant action", () => {
  const base = { workerId: "w", capabilityId: "c", capabilityDescriptorHash: "sha256:d", attemptId: "a", planDigest: "sha256:p", fencingToken: 7, leaseId: "l", grantDigest: "sha256:g", grantActions: ["codex.execute"], requiredAction: "codex.execute" };
  assert.deepEqual(validateJobOffer(base, { ...base, grantActions: undefined as never, requiredAction: "codex.execute" }), { valid: true });
  assert.deepEqual(validateJobOffer({ ...base, fencingToken: 6 }, { ...base, grantActions: undefined as never, requiredAction: "codex.execute" }), { valid: false, reason: "offer-binding-mismatch" });
  assert.deepEqual(validateJobOffer({ ...base, grantActions: ["read.only"] }, { ...base, grantActions: undefined as never, requiredAction: "codex.execute" }), { valid: false, reason: "grant-action-missing" });
});
