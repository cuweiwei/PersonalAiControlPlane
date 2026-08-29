import assert from "node:assert/strict";
import test from "node:test";
import { IdentityDatabase } from "../apps/identity-gateway/src/db.ts";
import { createIdentityHttpServer } from "../apps/identity-gateway/src/http.ts";
import { IdentityService } from "../apps/identity-gateway/src/service.ts";
import { PasskeyRpAdapter } from "../apps/identity-gateway/src/webauthn.ts";

test("identity gateway health is ready only when the configured Passkey boundary is present", async () => {
  const db = new IdentityDatabase(":memory:");
  const identity = new IdentityService(db);
  const server = createIdentityHttpServer({ db, identity, passkeyConfigured: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const ready = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.equal(ready.status, process.env.NODE_ENV === "production" ? 503 : 200);
    const auth = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/login`, { method: "POST" });
    assert.equal(auth.status, 503);
    assert.equal((await auth.json()).error.code, "PASSKEY_NOT_CONFIGURED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("configured Passkey without a wired RP adapter remains not ready in production", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const db = new IdentityDatabase(":memory:");
  const server = createIdentityHttpServer({ db, identity: new IdentityService(db), passkeyConfigured: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const ready = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    assert.equal(ready.status, 503);
    assert.equal((await ready.json()).passkey, "not_wired");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
  }
});

test("forward-auth validates the session cookie and emits only gateway-owned identity headers", async () => {
  const db = new IdentityDatabase(":memory:");
  const identity = new IdentityService(db);
  const userId = identity.createUser("owner-1");
  const adapter = new PasskeyRpAdapter({ db, identity, rpName: "Personal AI Control Plane", rpId: "pai.example.test", expectedOrigin: "https://pai.example.test" });
  const issued = identity.issueSession(userId);
  const server = createIdentityHttpServer({ db, identity, passkeyConfigured: true, passkeyAdapterReady: true, passkeyAdapter: adapter, canonicalOrigin: "https://pai.example.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const forwarded = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/forward`, { headers: { cookie: `pai_session=${issued.sessionId}`, "x-forwarded-method": "GET", "x-pai-owner-id": "spoofed-owner" } });
    assert.equal(forwarded.status, 204);
    assert.equal(forwarded.headers.get("x-pai-verified"), "1");
    assert.equal(forwarded.headers.get("x-pai-owner-id"), userId);
    assert.equal(forwarded.headers.get("x-pai-session-id"), issued.view.id);
    assert.notEqual(forwarded.headers.get("x-pai-session-id"), issued.sessionId);
    assert.equal(forwarded.headers.get("x-pai-auth-time"), String(issued.view.authTime));
    assert.match(forwarded.headers.get("x-pai-request-id") ?? "", /^[0-9a-f-]{36}$/);
    const missingContext = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/forward`, { headers: { cookie: `pai_session=${issued.sessionId}` } });
    assert.equal(missingContext.status, 400);
    assert.equal((await missingContext.json()).error.code, "FORWARD_CONTEXT_REQUIRED");
    const rejectedMutation = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/forward`, { headers: { cookie: `pai_session=${issued.sessionId}`, "x-forwarded-method": "POST", origin: "https://pai.example.test" } });
    assert.equal(rejectedMutation.status, 403);
    assert.equal((await rejectedMutation.json()).error.code, "CSRF_REJECTED");
    const forwardedMutation = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/forward`, { headers: { cookie: `pai_session=${issued.sessionId}`, "x-forwarded-method": "POST", "x-pai-csrf-token": issued.csrfToken, origin: "https://pai.example.test" } });
    assert.equal(forwardedMutation.status, 204);
    const rejected = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/forward`);
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, "AUTH_REQUIRED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("identity browser mutations require canonical origin and session-bound CSRF", async () => {
  const db = new IdentityDatabase(":memory:");
  const identity = new IdentityService(db);
  const userId = identity.createUser("owner-1");
  db.run("INSERT INTO identity_profiles(user_id, login, display_name, created_at) VALUES (?, ?, ?, ?)", userId, "owner@local", "Owner", Date.now());
  identity.registerCredential(userId, "credential-1", "cose-public-key", 0, ["internal"]);
  identity.issueRecoveryCode(userId, "recovery-code-123");
  const existing = identity.issueSession(userId);
  const adapter = new PasskeyRpAdapter({ db, identity, rpName: "Personal AI Control Plane", rpId: "pai.example.test", expectedOrigin: "https://pai.example.test" });
  const server = createIdentityHttpServer({ db, identity, passkeyConfigured: true, passkeyAdapterReady: true, passkeyAdapter: adapter, canonicalOrigin: "https://pai.example.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const missingOrigin = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/login/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "owner@local" }) });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await missingOrigin.json()).error.code, "ORIGIN_REJECTED");
    const badLogout = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/logout`, { method: "POST", headers: { cookie: `pai_session=${existing.sessionId}`, origin: "https://pai.example.test" } });
    assert.equal(badLogout.status, 403);
    assert.equal((await badLogout.json()).error.code, "CSRF_REJECTED");
    const stepUpOptions = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/step-up/options`, { method: "POST", headers: { cookie: `pai_session=${existing.sessionId}`, "x-pai-csrf-token": existing.csrfToken, origin: "https://pai.example.test" } });
    assert.equal(stepUpOptions.status, 200);
    assert.equal(typeof (await stepUpOptions.json()).challengeId, "string");
    const recovered = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/recovery`, { method: "POST", headers: { "content-type": "application/json", origin: "https://pai.example.test" }, body: JSON.stringify({ login: "owner@local", recoveryCode: "recovery-code-123" }) });
    assert.equal(recovered.status, 200);
    const recoveredBody = await recovered.json();
    assert.equal(recoveredBody.recovered, true);
    assert.equal(typeof recoveredBody.csrfToken, "string");
    const recoveredCookie = recovered.headers.get("set-cookie") ?? "";
    assert.match(recoveredCookie, /^pai_session=/);
    assert.equal(identity.verifySession(existing.sessionId), undefined);
    const recoveredSessionId = /^pai_session=([^;]+)/.exec(recoveredCookie)?.[1];
    assert.ok(recoveredSessionId);
    const logout = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/logout`, { method: "POST", headers: { cookie: `pai_session=${recoveredSessionId}`, "x-pai-csrf-token": recoveredBody.csrfToken, origin: "https://pai.example.test" } });
    assert.equal(logout.status, 200);
    assert.equal((await logout.json()).revoked, true);
    assert.equal(identity.verifySession(recoveredSessionId), undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("authenticated browser can refresh a session-bound CSRF token without exposing the session secret", async () => {
  const db = new IdentityDatabase(":memory:");
  const identity = new IdentityService(db);
  const userId = identity.createUser("owner-1");
  const issued = identity.issueSession(userId);
  const adapter = new PasskeyRpAdapter({ db, identity, rpName: "Personal AI Control Plane", rpId: "pai.example.test", expectedOrigin: "https://pai.example.test" });
  const server = createIdentityHttpServer({ db, identity, passkeyConfigured: true, passkeyAdapterReady: true, passkeyAdapter: adapter, canonicalOrigin: "https://pai.example.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/csrf`, { headers: { cookie: `pai_session=${issued.sessionId}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.csrfToken, "string");
    assert.notEqual(body.csrfToken, issued.sessionId);
    assert.equal(identity.verifyCsrf(issued.sessionId, issued.csrfToken), false);
    assert.equal(identity.verifyCsrf(issued.sessionId, body.csrfToken), true);
    const rejected = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/csrf`);
    assert.equal(rejected.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});
