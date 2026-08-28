import assert from "node:assert/strict";
import test from "node:test";
import { generateActionGrantKey, signActionGrant, verifyActionGrant, type ActionGrantClaims } from "../packages/identity/src/index.ts";

const key = generateActionGrantKey("kid-test-1");
const baseClaims: ActionGrantClaims = {
  iss: "pai-identity-gateway",
  sub: "owner-1",
  aud: "pai-worker:worker-1",
  jti: "grant-1",
  iat: 1_700_000_000,
  nbf: 1_700_000_000,
  exp: 1_700_000_120,
  taskId: "task-1",
  attemptId: "attempt-1",
  planDigest: "sha256:plan",
  policyVersion: 12,
  fencingToken: 7,
  actions: ["codex.execute"],
  resources: ["repo:example"],
  capabilityIds: ["cap-1"],
  budget: { maxTokens: 1000 },
  sandbox: { roots: ["/work"] },
  hardStopApprovalId: null,
};

function options(consumed: Set<string>, overrides: Record<string, unknown> = {}) {
  return {
    issuer: "pai-identity-gateway",
    audience: "pai-worker:worker-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    planDigest: "sha256:plan",
    policyVersion: 12,
    fencingToken: 7,
    resolveKey: () => ({ kid: key.kid, state: key.state, publicKey: key.publicKey }),
    consumeJti: (jti: string) => !consumed.has(jti) && (consumed.add(jti), true),
    allowedActions: ["codex.execute"],
    allowedResources: ["repo:example"],
    allowedCapabilityIds: ["cap-1"],
    nowSeconds: 1_700_000_010,
    ...overrides,
  };
}

test("action grants sign and verify with exact bindings and one-time replay", () => {
  const token = signActionGrant(baseClaims, key);
  const consumed = new Set<string>();
  const result = verifyActionGrant(token, options(consumed));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.grant.claims.jti, "grant-1");
  const replay = verifyActionGrant(token, options(consumed));
  assert.deepEqual(replay, { ok: false, code: "grant.replay", message: "grant jti has already been consumed" });
});

test("action grants fail closed on audience, binding, and undeclared scope", () => {
  const token = signActionGrant(baseClaims, key);
  const consumed = new Set<string>();
  assert.equal(verifyActionGrant(token, options(consumed, { audience: "pai-worker:other" })).ok, false);
  assert.equal(verifyActionGrant(token, options(new Set(), { fencingToken: 8 })).ok, false);
  assert.equal(verifyActionGrant(token, options(new Set(), { allowedActions: ["read.only"] })).ok, false);
});

test("retiring keys verify while revoked keys do not", () => {
  const token = signActionGrant(baseClaims, key);
  const retiring = verifyActionGrant(token, options(new Set(), { resolveKey: () => ({ kid: key.kid, state: "RETIRING", publicKey: key.publicKey }) }));
  assert.equal(retiring.ok, true);
  const revoked = verifyActionGrant(token, options(new Set(), { resolveKey: () => ({ kid: key.kid, state: "REVOKED", publicKey: key.publicKey }) }));
  assert.deepEqual(revoked, { ok: false, code: "grant.key.inactive", message: "grant signing key is not active for verification" });
});

test("grant lifetime and expiry are bounded", () => {
  assert.throws(() => signActionGrant({ ...baseClaims, exp: baseClaims.iat + 301 }, key), /lifetime exceeds/);
  const expired = signActionGrant(baseClaims, key);
  const result = verifyActionGrant(expired, options(new Set(), { nowSeconds: baseClaims.exp + 10 }));
  assert.deepEqual(result, { ok: false, code: "grant.time.invalid", message: "grant is not currently valid or exceeds the lifetime bound" });
});
