import assert from "node:assert/strict";
import test from "node:test";
import { IdentityDatabase } from "../apps/identity-gateway/src/db.ts";
import { createIdentityHttpServer } from "../apps/identity-gateway/src/http.ts";
import { IdentityService } from "../apps/identity-gateway/src/service.ts";

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
