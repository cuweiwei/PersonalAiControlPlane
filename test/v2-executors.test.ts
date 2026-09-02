import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { OpenAICompatibleExecutor } from "../apps/worker/src/executors/openai-compatible.ts";
import { CommandExecutor } from "../apps/worker/src/executors/command.ts";

test("OpenAI-compatible executor discovers models and returns inference result", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "fake-model", context_length: 8192 }] }));
    else if (request.url === "/v1/chat/completions") response.end(JSON.stringify({ choices: [{ message: { content: "fake answer" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const executor = new OpenAICompatibleExecutor({ runtime: "fake", baseUrl, enabled: true });
  try {
    const discovery = await executor.discover();
    assert.equal(discovery.models[0].id, "fake-model");
    const events = [];
    for await (const event of executor.execute({ task_id: "task", attempt_id: "attempt", task_type: "llm.inference", instruction: "hello", payload: {}, execution: { model: { name: "fake-model" } }, limits: { timeout_seconds: 30 } })) events.push(event);
    assert.equal(events.at(-1)?.result?.text, "fake answer");
    assert.equal(events.at(-1)?.metrics?.completion_tokens, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("command executor exposes only validated static profiles", async () => {
  const executor = new CommandExecutor({
    safe: { command: [process.execPath, "-e", "process.stdout.write(\"ok\")"], cwd: process.cwd(), allowedExecutables: [process.execPath], roots: [process.cwd()] },
    unsafe: { command: ["sudo", "echo", "bad"] },
  }, true);
  const task = { task_id: "command-task", attempt_id: "command-attempt", task_type: "command", instruction: "run", payload: { profile: "safe" }, limits: { timeout_seconds: 10 } } as const;
  assert.equal(executor.canExecute(task), true);
  assert.equal(executor.canExecute({ ...task, payload: { profile: "unsafe" } }), false);
  assert.equal((await executor.discover()).capabilities[0].capability, "command");
  const events = [];
  for await (const event of executor.execute(task)) events.push(event);
  assert.equal(events.at(-1)?.result?.stdout, "ok");
});
