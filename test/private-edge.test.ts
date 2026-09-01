import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { closePrivateEdgeConnections, createPrivateEdgeServer } from "../apps/control-plane/src/private-edge.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("private edge routes auth, strips browser credentials, and removes infrastructure", async () => {
  const observed: { auth?: Record<string, string | string[] | undefined>; upstream?: Record<string, string | string[] | undefined>; web?: Record<string, string | string[] | undefined>; memory?: Record<string, string | string[] | undefined> } = {};
  const identity = createServer((request, response) => {
    if (request.url === "/api/v1/auth/forward") {
      observed.auth = { cookie: request.headers.cookie, origin: request.headers.origin, csrf: request.headers["x-pai-csrf-token"], method: request.headers["x-forwarded-method"] };
      if (!request.headers.cookie) { response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":{"code":"AUTH_REQUIRED"}}'); return; }
      response.writeHead(204, { "x-pai-verified": "1", "x-pai-owner-id": "owner-real", "x-pai-session-id": "session-ref", "x-pai-auth-time": "1700000000000", "x-pai-request-id": "request-id" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/" ? "identity-root" : "identity-auth");
  });
  const orchestrator = createServer((request, response) => {
    observed.upstream = { cookie: request.headers.cookie, csrf: request.headers["x-pai-csrf-token"], owner: request.headers["x-pai-owner-id"], verified: request.headers["x-pai-verified"], workload: request.headers["x-pai-workload-id"], workloadExtra: request.headers["x-pai-workload-spoof"], proto: request.headers["x-forwarded-proto"] };
    if (request.url === "/api/v1/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("event: ready\\ndata: {}\\n\\n"); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url }));
  });
  const web = createServer((request, response) => { observed.web = { cookie: request.headers.cookie, csrf: request.headers["x-pai-csrf-token"], owner: request.headers["x-pai-owner-id"], verified: request.headers["x-pai-verified"] }; response.writeHead(200, { "content-type": "text/html" }); response.end(`web:${request.url}`); });
  const memory = createServer((request, response) => {
    observed.memory = { host: request.headers.host, proto: request.headers["x-forwarded-proto"], owner: request.headers["x-pai-owner-id"], cookie: request.headers.cookie };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url }));
  });
  const identityPort = await listen(identity);
  const orchestratorPort = await listen(orchestrator);
  const webPort = await listen(web);
  const memoryPort = await listen(memory);
  const edge = createPrivateEdgeServer({ identityOrigin: `http://127.0.0.1:${identityPort}`, orchestratorOrigin: `http://127.0.0.1:${orchestratorPort}`, controlWebOrigin: `http://127.0.0.1:${webPort}`, memoryOrigin: `http://127.0.0.1:${memoryPort}`, publicProto: "https" });
  const edgePort = await listen(edge);
  const base = `http://127.0.0.1:${edgePort}`;
  try {
    const api = await fetch(`${base}/api/v1/goals`, { headers: { cookie: "pai_session=raw-secret", origin: "https://pai.example.test", "x-pai-owner-id": "spoofed", "x-pai-csrf-token": "csrf" } });
    assert.equal(api.status, 200);
    assert.deepEqual(observed.auth, { cookie: "pai_session=raw-secret", origin: "https://pai.example.test", csrf: "csrf", method: "GET" });
    assert.equal(await api.text(), JSON.stringify({ path: "/api/v1/goals" }));
    assert.deepEqual(observed.upstream, { cookie: undefined, csrf: undefined, owner: "owner-real", verified: "1", workload: undefined, workloadExtra: undefined, proto: "https" });
    const workload = await fetch(`${base}/api/v1/goals`, { headers: { "x-pai-workload-id": "hermes-test", "x-pai-workload-spoof": "drop-me" } });
    assert.equal(workload.status, 200);
    assert.deepEqual(observed.upstream, { cookie: undefined, csrf: undefined, owner: undefined, verified: undefined, workload: "hermes-test", workloadExtra: undefined, proto: "https" });
    const home = await fetch(`${base}/home`, { headers: { cookie: "pai_session=raw-secret", origin: "https://pai.example.test", "x-pai-owner-id": "spoofed", "x-pai-csrf-token": "csrf" } });
    assert.equal(home.status, 200);
    assert.equal(await home.text(), "web:/home");
    assert.deepEqual(observed.web, { cookie: undefined, csrf: undefined, owner: "owner-real", verified: "1" });
    const unauthorized = await fetch(`${base}/home`);
    assert.equal(unauthorized.status, 401);
    assert.match(await unauthorized.text(), /AUTH_REQUIRED/);
    const sse = await fetch(`${base}/api/v1/events`, { headers: { cookie: "pai_session=raw-secret" } });
    assert.equal(sse.headers.get("content-type"), "text/event-stream");
    assert.equal(await sse.text(), "event: ready\\ndata: {}\\n\\n");

    const login = await fetch(`${base}/login`);
    assert.equal(await login.text(), "identity-root");
    const health = await fetch(`${base}/health/ready`);
    assert.equal(health.status, 200);
    const memoryResponse = await fetch(`${base}/api/portal/v1/memory/memories?namespace=personal`, { headers: { cookie: "pai_session=raw-secret", origin: "https://pai.example.test", "x-pai-owner-id": "spoofed" } });
    assert.equal(memoryResponse.status, 200);
    assert.equal(await memoryResponse.text(), JSON.stringify({ path: "/v1/control/memories?namespace=personal" }));
    assert.deepEqual(observed.memory, { host: `127.0.0.1:${edgePort}`, proto: "https", owner: "owner-real", cookie: undefined });
    assert.equal((await fetch(`${base}/api/portal/v1/memory/memories`, { method: "POST", headers: { cookie: "pai_session=raw-secret" } })).status, 405);
    assert.equal((await fetch(`${base}/infrastructure`)).status, 404);
    assert.equal((await fetch(`${base}/api/portal/v1/infrastructure/dashboard`)).status, 404);
  } finally {
    await close(edge); await close(memory); await close(web); await close(orchestrator); await close(identity);
  }
});

test("private edge proxies the worker WebSocket without browser identity", async () => {
  const identity = createServer((_, response) => { response.writeHead(404); response.end(); });
  const orchestrator = createServer();
  const target = new WebSocketServer({ server: orchestrator });
  target.on("connection", (socket, request) => {
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["x-pai-owner-id"], undefined);
    socket.on("message", (message) => socket.send(message));
  });
  const web = createServer((_, response) => { response.writeHead(404); response.end(); });
  const identityPort = await listen(identity);
  const orchestratorPort = await listen(orchestrator);
  const webPort = await listen(web);
  const edge = createPrivateEdgeServer({ identityOrigin: `http://127.0.0.1:${identityPort}`, orchestratorOrigin: `http://127.0.0.1:${orchestratorPort}`, controlWebOrigin: `http://127.0.0.1:${webPort}` });
  const edgePort = await listen(edge);
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${edgePort}/api/v1/worker/connect`, { headers: { cookie: "pai_session=raw-secret", "x-pai-owner-id": "spoofed" } });
    const message = await new Promise<string>((resolve, reject) => { socket.once("message", (value) => resolve(value.toString())); socket.once("error", reject); socket.once("open", () => socket.send("worker-frame")); });
    assert.equal(message, "worker-frame");
    socket.close();
  } finally {
    target.close(); closePrivateEdgeConnections(edge); await close(edge); await close(web); await close(orchestrator); await close(identity);
  }
});

test("private edge rejects HTTPS upstream origins and strips hop-by-hop credentials", async () => {
  assert.throws(() => createPrivateEdgeServer({ identityOrigin: "https://127.0.0.1:1", orchestratorOrigin: "http://127.0.0.1:1", controlWebOrigin: "http://127.0.0.1:1" }), /identityOrigin must use http/);

  const identity = createServer((request, response) => {
    if (request.url === "/api/v1/auth/forward") {
      response.writeHead(204, { "x-pai-verified": "1", "x-pai-owner-id": "owner-real", "x-pai-session-id": "session-ref", "x-pai-auth-time": "1700000000000", "x-pai-request-id": "request-id" });
      response.end();
      return;
    }
    response.writeHead(404); response.end();
  });
  const observed: Record<string, string | string[] | undefined> = {};
  const orchestrator = createServer((request, response) => {
    observed.connection = request.headers.connection;
    observed.secret = request.headers["x-edge-hop-secret"] as string | undefined;
    observed.authorization = request.headers.authorization;
    response.writeHead(200, { connection: "x-upstream-hop", "x-upstream-hop": "discard-me", "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const web = createServer((_, response) => { response.writeHead(404); response.end(); });
  const identityPort = await listen(identity);
  const orchestratorPort = await listen(orchestrator);
  const webPort = await listen(web);
  const edge = createPrivateEdgeServer({ identityOrigin: `http://127.0.0.1:${identityPort}`, orchestratorOrigin: `http://127.0.0.1:${orchestratorPort}`, controlWebOrigin: `http://127.0.0.1:${webPort}` });
  const edgePort = await listen(edge);
  try {
    const response = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const request = httpRequest({ hostname: "127.0.0.1", port: edgePort, path: "/api/v1/goals", method: "GET", headers: { cookie: "pai_session=raw-secret", connection: "x-edge-hop-secret", "x-edge-hop-secret": "must-not-forward", authorization: "Bearer raw-secret" } }, (upstream) => {
        const chunks: Buffer[] = [];
        upstream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        upstream.on("end", () => resolve({ status: upstream.statusCode ?? 0, headers: upstream.headers, body: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, '{"ok":true}');
    assert.notEqual(observed.connection, "x-edge-hop-secret");
    assert.equal(observed.secret, undefined);
    assert.equal(observed.authorization, undefined);
    assert.equal(response.headers["x-upstream-hop"], undefined);
  } finally {
    closePrivateEdgeConnections(edge); await close(edge); await close(web); await close(orchestrator); await close(identity);
  }
});

test("private edge times out stalled health upstreams with a gateway timeout", async () => {
  const identity = createServer((_, response) => { response.writeHead(404); response.end(); });
  const orchestrator = createServer(() => { /* intentionally stalled */ });
  const web = createServer((_, response) => { response.writeHead(404); response.end(); });
  const identityPort = await listen(identity);
  const orchestratorPort = await listen(orchestrator);
  const webPort = await listen(web);
  const edge = createPrivateEdgeServer({ identityOrigin: `http://127.0.0.1:${identityPort}`, orchestratorOrigin: `http://127.0.0.1:${orchestratorPort}`, controlWebOrigin: `http://127.0.0.1:${webPort}` });
  const edgePort = await listen(edge);
  try {
    const response = await fetch(`http://127.0.0.1:${edgePort}/health/ready`);
    assert.equal(response.status, 504);
    assert.match(await response.text(), /EDGE_UPSTREAM_TIMEOUT/);
  } finally {
    closePrivateEdgeConnections(edge); await close(edge); await close(web); await close(orchestrator); await close(identity);
  }
});
