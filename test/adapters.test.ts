import assert from "node:assert/strict";
import test from "node:test";
import { DisabledContextHubAdapter, DisabledInfrastructureAdapter, classifyHermesMessage } from "../packages/adapters/src/index.ts";

test("external adapters stay disabled until compatibility and gateway evidence exists", async () => {
  await assert.rejects(() => new DisabledContextHubAdapter().compileContext({}, "id"), (error: Error & { code?: string }) => error.code === "ADAPTER_DISABLED");
  await assert.rejects(() => new DisabledInfrastructureAdapter().requestOperation({ serviceId: "x", action: "deploy", actionGrant: "grant", idempotencyKey: "id" }), (error: Error & { code?: string }) => error.code === "ADAPTER_DISABLED");
});

test("Hermes classifier promotes only durable or sensitive requests", () => {
  assert.deepEqual(classifyHermesMessage("what is the weather?"), { mode: "STATELESS_CHAT", reasons: [] });
  assert.equal(classifyHermesMessage("please deploy the service").mode, "DURABLE_GOAL");
  assert.equal(classifyHermesMessage("每天提醒我檢查狀態").mode, "DURABLE_GOAL");
});
