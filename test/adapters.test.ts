import assert from "node:assert/strict";
import test from "node:test";
import { DisabledContextHubAdapter, classifyHermesMessage } from "../packages/adapters/src/index.ts";
import { ContextHubHttpAdapter } from "../packages/adapters/src/context-hub-http.ts";

test("external adapters stay disabled until compatibility and gateway evidence exists", async () => {
  await assert.rejects(() => new DisabledContextHubAdapter().compileContext({}, "id"), (error: Error & { code?: string }) => error.code === "ADAPTER_DISABLED");
});

test("Hermes classifier promotes only durable or sensitive requests", () => {
  assert.deepEqual(classifyHermesMessage("what is the weather?"), { mode: "STATELESS_CHAT", reasons: [] });
  assert.equal(classifyHermesMessage("please deploy the service").mode, "DURABLE_GOAL");
  assert.equal(classifyHermesMessage("每天提醒我檢查狀態").mode, "DURABLE_GOAL");
});

test("ContextHub HTTP adapter maps typed requests without leaking credentials", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new ContextHubHttpAdapter({
    origin: "http://host.docker.internal:18788/",
    apiKey: "chk_test_key",
    fetcher: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = new URL(String(url)).pathname;
      if (path === "/v1/changes") return new Response(JSON.stringify({ events: [{ cursor: 2, entity_id: "memory-1" }], next_cursor: 2 }), { status: 200 });
      return new Response(JSON.stringify({ package_id: "pkg-1", items: [] }), { status: 200 });
    }) as typeof fetch,
  });
  const compiled = await adapter.compileContext({ intent: "remember this", targetAgent: "generic", tokenBudget: 512, includePrivate: false }, "ctx-1");
  assert.equal(compiled.package_id, "pkg-1");
  assert.equal(calls[0]?.url, "http://host.docker.internal:18788/v1/context/compile");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer chk_test_key");
  assert.equal((calls[0]?.init.headers as Record<string, string>)["idempotency-key"], "ctx-1");
  const changes = await adapter.readChanges(null);
  assert.equal(changes.cursor, "2");
  assert.deepEqual(changes.changes, [{ cursor: 2, entity_id: "memory-1" }]);
  await adapter.proposeCandidate({ type: "fact", title: "test", content: "" }, "candidate-1");
  assert.equal(JSON.parse(String(calls[2]?.init.body)).idempotency_key, "candidate-1");
  await adapter.recordContextOutcome("pkg-1", { itemIds: ["memory-1"], outcome: "helpful", actionChanged: true }, "outcome-1");
  assert.deepEqual(JSON.parse(String(calls[3]?.init.body)), { package_id: "pkg-1", item_ids: ["memory-1"], outcome: "helpful", action_changed: true, idempotency_key: "outcome-1" });
});

test("ContextHub HTTP adapter rejects unsafe origins and invalid request fields", () => {
  assert.throws(() => new ContextHubHttpAdapter({ origin: "http://host.docker.internal:18788/v1", apiKey: "key" }), /origin must not contain/);
  assert.throws(() => new ContextHubHttpAdapter({ origin: "http://host.docker.internal:18788", apiKey: "" }), /apiKey is invalid/);
});

test("ContextHub HTTP adapter redacts transport failures", async () => {
  const adapter = new ContextHubHttpAdapter({
    origin: "http://host.docker.internal:18788",
    apiKey: "chk_test_key",
    fetcher: (async () => { throw new Error("socket details should stay private"); }) as typeof fetch,
  });
  await assert.rejects(() => adapter.compileContext({ intent: "probe" }, "transport-1"), (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.message, "ContextHub is unavailable");
    assert.equal(error.code, "CONTEXT_HUB_UNAVAILABLE");
    assert.equal(error.retryable, true);
    return true;
  });
});
