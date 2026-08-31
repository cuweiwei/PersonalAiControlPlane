import assert from "node:assert/strict";
import test from "node:test";
import { sha256 } from "../packages/crypto/src/index.ts";
import { IdentityDatabase } from "../apps/identity-gateway/src/db.ts";
import { createIdentityHttpServer } from "../apps/identity-gateway/src/http.ts";
import { IdentityService } from "../apps/identity-gateway/src/service.ts";
import { IdentityAuthError, PasskeyRpAdapter } from "../apps/identity-gateway/src/webauthn.ts";

function adapterFixture() {
  const db = new IdentityDatabase(":memory:");
  const identity = new IdentityService(db, () => 1_700_000_000_000);
  const adapter = new PasskeyRpAdapter({ db, identity, rpName: "Personal AI Control Plane", rpId: "pai.example.test", expectedOrigin: "https://pai.example.test", bootstrapToken: "bootstrap-secret" });
  return { db, identity, adapter };
}

test("WebAuthn RP adapter keeps registration behind the bootstrap boundary and stores only challenge hashes", async () => {
  const { db, identity, adapter } = adapterFixture();
  try {
    assert.deepEqual(adapter.status(), { configured: true, registrationAllowed: true, userCount: 0, rpId: "pai.example.test", origin: "https://pai.example.test", bootstrapConfigured: true });
    await assert.rejects(() => adapter.registrationOptions({ bootstrapToken: "wrong", login: "owner@local", displayName: "Owner" }), (error: unknown) => error instanceof IdentityAuthError && error.code === "INVALID_BOOTSTRAP_TOKEN");
    const started = await adapter.registrationOptions({ bootstrapToken: "bootstrap-secret", login: "owner@local", displayName: "Owner" });
    assert.equal(typeof started.challengeId, "string");
    assert.equal(started.options.rp.id, "pai.example.test");
    assert.equal(started.options.user.name, "owner@local");
    const challenge = db.one<{ challenge_hash: string }>("SELECT challenge_hash FROM auth_challenges WHERE id = ?", started.challengeId);
    assert.ok(challenge?.challenge_hash);
    assert.equal(sha256(Buffer.from(started.options.challenge, "base64url").toString("base64url")), challenge?.challenge_hash);
    assert.equal(adapter.status().registrationAllowed, true);
    db.run("INSERT INTO identity_profiles(user_id, login, display_name, created_at) VALUES (?, ?, ?, ?)", started.userId, "owner@local", "Owner", 1_700_000_000_000);
    identity.registerCredential(started.userId, "credential-1", Buffer.from([1, 2, 3]).toString("base64url"));
    assert.equal(adapter.status().registrationAllowed, false);
    const login = await adapter.authenticationOptions("owner@local");
    assert.equal(login.options.rpId, "pai.example.test");
    assert.equal(login.options.allowCredentials?.[0]?.id, "credential-1");
    const loginChallenge = db.one<{ challenge_hash: string }>("SELECT challenge_hash FROM auth_challenges WHERE id = ?", login.challengeId);
    assert.equal(sha256(Buffer.from(login.options.challenge, "base64url").toString("base64url")), loginChallenge?.challenge_hash);
  } finally { db.close(); }
});

test("interrupted bootstrap registration can be retried without replacing a completed owner", async () => {
  const { db, identity, adapter } = adapterFixture();
  try {
    const interrupted = await adapter.registrationOptions({ bootstrapToken: "bootstrap-secret", login: "owner@local", displayName: "Owner" });
    assert.equal(adapter.status().registrationAllowed, true);
    const retried = await adapter.registrationOptions({ bootstrapToken: "bootstrap-secret", login: "owner@local", displayName: "Owner" });
    assert.notEqual(retried.userId, interrupted.userId);
    assert.ok(db.one("SELECT disabled_at FROM identity_users WHERE id = ? AND disabled_at IS NOT NULL", interrupted.userId));
    db.run("INSERT INTO identity_profiles(user_id, login, display_name, created_at) VALUES (?, ?, ?, ?)", retried.userId, "owner@local", "Owner", 1_700_000_000_000);
    identity.registerCredential(retried.userId, "credential-1", Buffer.from([1, 2, 3]).toString("base64url"));
    assert.equal(adapter.status().registrationAllowed, false);
    await assert.rejects(() => adapter.registrationOptions({ bootstrapToken: "bootstrap-secret", login: "owner@local", displayName: "Owner" }), (error: unknown) => error instanceof IdentityAuthError && error.code === "BOOTSTRAP_COMPLETE");
  } finally { db.close(); }
});

test("wired adapter reports production readiness and serves the owner entry page", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const { db, identity, adapter } = adapterFixture();
  const server = createIdentityHttpServer({ db, identity, passkeyConfigured: true, passkeyAdapterReady: true, passkeyAdapter: adapter, canonicalOrigin: "https://pai.example.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const ready = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).passkey, "ready");
    const page = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Owner Passkey/);
    assert.match(pageHtml, /challenge: bytes\(options\.challenge\)/);
    assert.match(pageHtml, /user: \{ \.\.\.options\.user, id: bytes\(options\.user\.id\) \}/);
    assert.match(pageHtml, /allowCredentials: options\.allowCredentials\?\.map/);
    assert.match(pageHtml, /const rawId = b64\(credential\.rawId\); return \{ id: rawId, rawId/);
    assert.match(pageHtml, /clientExtensionResults: credential\.getClientExtensionResults/);
    assert.match(pageHtml, /const authenticationJSON = \(credential\) => \{ const rawId = b64\(credential\.rawId\); return \{ id: rawId, rawId/);
    assert.match(pageHtml, /fetch\('\/api\/v1\/auth\/me'/);
    assert.match(pageHtml, /location\.replace\('\/home'\)/);
    assert.doesNotMatch(pageHtml, /publicKey:start\.options/);
    const status = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).registrationAllowed, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});
