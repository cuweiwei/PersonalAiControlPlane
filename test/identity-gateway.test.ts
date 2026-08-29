import assert from "node:assert/strict";
import test from "node:test";
import { IdentityDatabase } from "../apps/identity-gateway/src/db.ts";
import { IdentityService, SESSION_COOKIE_POLICY } from "../apps/identity-gateway/src/service.ts";

function setup() {
  let now = 1_700_000_000_000;
  const db = new IdentityDatabase(":memory:");
  const identity = new IdentityService(db, () => now);
  const userId = identity.createUser("user-1");
  return { db, identity, userId, advance: (ms: number) => { now += ms; } };
}

test("identity DB issues one-time challenges and stores no raw challenge", () => {
  const { db, identity, userId } = setup();
  const challenge = identity.issueChallenge("authentication", userId);
  assert.equal(identity.consumeChallenge(challenge.id, challenge.challenge), true);
  assert.equal(identity.consumeChallenge(challenge.id, challenge.challenge), false);
  const row = db.one<{ challenge_hash: string }>("SELECT challenge_hash FROM auth_challenges WHERE id = ?", challenge.id);
  assert.notEqual(row?.challenge_hash, challenge.challenge);
  db.close();
});

test("passkey assertion creates a rotated, secure session and rejects stale counters", () => {
  const { db, identity, userId } = setup();
  identity.registerCredential(userId, "credential-1", "cose-public-key", 4, ["internal"]);
  const challenge = identity.issueChallenge("authentication", userId);
  const issued = identity.authenticateWithPasskey(challenge.id, challenge.challenge, { credentialId: "credential-1", clientDataJson: "{}", authenticatorData: "data", signature: "sig" }, ({ signCount }) => ({ valid: true, signCount: signCount + 1 }));
  assert.ok(issued);
  assert.equal(issued.cookie.includes("HttpOnly"), true);
  assert.equal(issued.cookie.includes("Secure"), true);
  assert.equal(issued.cookie.includes("SameSite=Strict"), true);
  assert.equal(SESSION_COOKIE_POLICY.hostOnly, true);
  assert.deepEqual(identity.verifySession(issued.sessionId)?.userId, userId);
  const staleChallenge = identity.issueChallenge("authentication", userId);
  const stale = identity.authenticateWithPasskey(staleChallenge.id, staleChallenge.challenge, { credentialId: "credential-1", clientDataJson: "{}", authenticatorData: "data", signature: "sig" }, () => ({ valid: true, signCount: 2 }));
  assert.equal(stale, undefined);
  db.close();
});

test("session rotation, CSRF, recovery revocation, and grant replay are fail-closed", () => {
  const { db, identity, userId, advance } = setup();
  const issued = identity.issueSession(userId);
  assert.equal(identity.verifyCsrf(issued.sessionId, issued.csrfToken), true);
  assert.equal(identity.verifyCsrf(issued.sessionId, "wrong"), false);
  const rotated = identity.rotateSession(issued.sessionId, issued.view.authTime + 1);
  assert.ok(rotated);
  assert.equal(identity.verifySession(issued.sessionId), undefined);
  assert.equal(identity.verifySession(rotated.sessionId)?.userId, userId);
  identity.issueRecoveryCode(userId, "recovery-code-123");
  assert.equal(identity.consumeRecoveryCode(userId, "recovery-code-123"), true);
  assert.equal(identity.consumeRecoveryCode(userId, "recovery-code-123"), false);
  assert.equal(identity.verifySession(rotated.sessionId), undefined);
  assert.equal(identity.consumeGrantJti("jti-1", "worker-1", 1_700_000_100), true);
  assert.equal(identity.consumeGrantJti("jti-1", "worker-1", 1_700_000_100), false);
  advance(1_000);
  db.close();
});

test("forward-auth headers are generated only by the gateway and incoming spoofed values are removed", () => {
  const { db, identity } = setup();
  const clean = identity.stripIncomingIdentityHeaders({ "x-pai-owner-id": "spoof", cookie: "safe", "x-pai-verified": "1" });
  assert.deepEqual(clean, { cookie: "safe" });
  const headers = identity.buildForwardAuthHeaders({ ownerId: "user-1", sessionId: "session-db-id", authTime: 1_700_000_000_000, requestId: "req-1" });
  assert.equal(identity.isVerifiedForwardAuth(headers), true);
  db.close();
});

test("Passkey step-up is bound to one session and rotates it on success", async () => {
  const { db, identity, userId } = setup();
  identity.registerCredential(userId, "credential-1", "cose-public-key", 4, ["internal"]);
  const session = identity.issueSession(userId);
  const otherSession = identity.issueSession(userId);
  const challenge = identity.issueStepUpChallenge(session.sessionId);
  assert.ok(challenge);
  const assertion = { credentialId: "credential-1", clientDataJson: "{}", authenticatorData: "data", signature: "sig" };
  assert.equal(await identity.stepUpWithPasskeyAsync(otherSession.sessionId, challenge.id, challenge.challenge, assertion, () => ({ valid: true, signCount: 5 })), undefined);
  const steppedUp = await identity.stepUpWithPasskeyAsync(session.sessionId, challenge.id, challenge.challenge, assertion, () => ({ valid: true, signCount: 5 }));
  assert.ok(steppedUp);
  assert.equal(identity.verifySession(session.sessionId), undefined);
  assert.equal(identity.verifySession(steppedUp.sessionId)?.userId, userId);
  db.close();
});
