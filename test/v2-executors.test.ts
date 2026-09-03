import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAICompatibleExecutor } from "../apps/worker/src/executors/openai-compatible.ts";
import { OllamaExecutor } from "../apps/worker/src/executors/ollama.ts";
import { CommandExecutor } from "../apps/worker/src/executors/command.ts";

test("LM Studio and Ollama executors probe their local APIs when enabled by default", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "lm-studio-model" }] })); return; }
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "ollama-model", size: 1234 }] })); return; }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const lmstudio = new OpenAICompatibleExecutor({ runtime: "lmstudio", baseUrl: `http://127.0.0.1:${port}/v1` });
    const ollama = new OllamaExecutor(`http://127.0.0.1:${port}`);
    assert.equal((await lmstudio.discover()).models[0].id, "lm-studio-model");
    assert.equal((await ollama.discover()).models[0].id, "ollama-model");
    assert.equal(lmstudio.canExecute({ task_id: "task", attempt_id: "attempt", task_type: "llm.inference", instruction: "hello", execution: { runtime: "lmstudio" } }), true);
    assert.equal(ollama.canExecute({ task_id: "task", attempt_id: "attempt", task_type: "llm.inference", instruction: "hello", execution: { runtime: "ollama" } }), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

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

test("OpenAI-compatible executor preserves detailed model load state", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models/status") { response.end(JSON.stringify({ models: [{ id: "loaded-model", loaded: true, is_loading: false, model_context_length: 262144, actual_size: 1234, source_type: "local" }, { id: "library-model", loaded: false, is_loading: false, model_context_length: 8192 }] })); return; }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const executor = new OpenAICompatibleExecutor({ runtime: "omlx", baseUrl: `http://127.0.0.1:${port}/v1`, statusUrl: `http://127.0.0.1:${port}/v1/models/status`, enabled: true });
    const discovery = await executor.discover();
    assert.equal((discovery.models[0].metadata as Record<string, unknown>).loaded, true);
    assert.equal(discovery.models[0].context_length, 262144);
    assert.equal((discovery.models[1].metadata as Record<string, unknown>).loaded, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("OpenAI-compatible executor reads a local API key file and falls back to health discovery", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") { response.statusCode = request.headers.authorization === "Bearer local-secret" ? 200 : 401; response.end(request.headers.authorization ? JSON.stringify({ data: [{ id: "authenticated-model" }] }) : JSON.stringify({ error: "API key required" })); return; }
    if (request.url === "/health") { response.end(JSON.stringify({ status: "healthy", default_model: "health-model", engine_pool: { loaded_count: 1, model_count: 2 } })); return; }
    response.statusCode = 404; response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const directory = await mkdtemp(join(tmpdir(), "pai-omlx-key-"));
  const keyFile = join(directory, "settings.json");
  await writeFile(keyFile, JSON.stringify({ auth: { api_key: "local-secret" } }));
  try {
    const authenticated = new OpenAICompatibleExecutor({ runtime: "omlx", baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyFile: keyFile, enabled: true });
    assert.equal((await authenticated.discover()).models[0].id, "authenticated-model");
    const healthOnly = new OpenAICompatibleExecutor({ runtime: "omlx", baseUrl: `http://127.0.0.1:${port}/v1`, healthUrl: `http://127.0.0.1:${port}/health`, enabled: true });
    const discovery = await healthOnly.discover();
    assert.equal(discovery.models[0].id, "health-model");
    assert.equal(discovery.models[0].status, "unavailable");
    assert.equal(discovery.capabilities[0].status, "UNAVAILABLE");
  } finally {
    await rm(directory, { recursive: true, force: true });
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
