import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControlWebServer } from "../apps/control-plane/src/control-web-server.ts";

test("unified Control Plane serves the static portal with SPA fallback and security headers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pai-control-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Personal AI</title>");
  writeFileSync(join(root, "assets", "app.js"), "console.log('ready')");
  const server = createControlWebServer(root);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ok" });

    const route = await fetch(`http://127.0.0.1:${port}/goals`);
    assert.equal(route.status, 200);
    assert.match(await route.text(), /Personal AI/);
    assert.match(route.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(route.headers.get("x-content-type-options"), "nosniff");

    const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.match(await asset.text(), /ready/);

    const missingAsset = await fetch(`http://127.0.0.1:${port}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);

    const rejected = await fetch(`http://127.0.0.1:${port}/goals`, { method: "POST" });
    assert.equal(rejected.status, 405);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
