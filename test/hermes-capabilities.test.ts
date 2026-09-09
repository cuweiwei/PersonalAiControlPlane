import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readHermesCapabilities } from "../apps/control-plane/src/missions/hermes-capabilities.ts";

test("Hermes capability is based on deployed policy and fails closed", async () => {
  let status = 200;
  let payload: any = { service: "hermes-office-adapter", brain_protocol_versions: [2], supervisor_read_only: true, driver: { available: true } };
  const server = createServer((req, res) => { assert.equal(req.url, "/api/internal/office/capabilities"); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await readHermesCapabilities(origin)).available, true);
    payload.supervisor_read_only = false;
    assert.deepEqual((await readHermesCapabilities(origin)).unavailableReasons, ["SUPERVISOR_READ_ONLY_NOT_VERIFIED"]);
    payload.supervisor_read_only = true; payload.driver.available = false;
    assert.equal((await readHermesCapabilities(origin)).available, false);
    status = 403;
    assert.deepEqual((await readHermesCapabilities(origin)).unavailableReasons, ["HERMES_CAPABILITY_PROBE_FAILED"]);
    status = 200; payload = { supervisor_read_only: true };
    assert.equal((await readHermesCapabilities(origin)).available, false);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.equal((await readHermesCapabilities(origin)).available, false);
});
