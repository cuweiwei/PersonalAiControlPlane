import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";

type EdgeOrigin = { hostname: string; port: number; protocol: "http:" };

export type PrivateEdgeOptions = {
  identityOrigin: string;
  orchestratorOrigin: string;
  controlWebOrigin: string;
  memoryOrigin?: string;
  publicProto?: "http" | "https";
};

const identityHeaders = ["x-pai-verified", "x-pai-owner-id", "x-pai-session-id", "x-pai-auth-time", "x-pai-request-id"] as const;
const workloadHeaders = new Set(["x-pai-workload-id", "x-pai-workload-timestamp", "x-pai-workload-nonce", "x-pai-workload-signature", "x-pai-workload-body-digest"]);
const securityHeaders: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const hopByHopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const browserCredentialHeaders = new Set(["cookie", "x-pai-csrf-token", "authorization", "proxy-authorization"]);
const edgeServers = new WeakMap<Server, Set<{ destroy(): void }>>();

function parseOrigin(value: string, field: string): EdgeOrigin {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:") throw new Error(`${field} must use http`);
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error(`${field} must be an origin without a path`);
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${field} has an invalid port`);
  return { hostname: parsed.hostname, port, protocol: parsed.protocol };
}

function isIdentityHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.startsWith("x-pai-") && !workloadHeaders.has(normalized) && normalized !== "x-pai-csrf-token";
}

function appendSecurityHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  const excluded = headerExclusions(headers);
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !excluded.has(key.toLowerCase())) output[key] = value;
  }
  for (const [key, value] of Object.entries(securityHeaders)) output[key] = value;
  return output;
}

function headerExclusions(headers: Record<string, string | string[] | undefined>): Set<string> {
  const excluded = new Set(hopByHopHeaders);
  const connection = headers.connection;
  const values = Array.isArray(connection) ? connection : connection ? [connection] : [];
  for (const value of values) for (const token of value.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized) excluded.add(normalized);
  }
  return excluded;
}

function requestHeaders(request: IncomingMessage, extra: Record<string, string> = {}, includeBrowserAuth = false): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  const excluded = headerExclusions(request.headers);
  for (const [rawName, value] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (name === "host" || name === "content-length" || excluded.has(name)) continue;
    if (!includeBrowserAuth && browserCredentialHeaders.has(name)) continue;
    if (includeBrowserAuth && (name === "authorization" || name === "proxy-authorization")) continue;
    if (isIdentityHeader(name)) continue;
    if (value !== undefined) headers[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
  return headers;
}

function contentLength(request: IncomingMessage): string | undefined {
  const value = request.headers["content-length"];
  return typeof value === "string" ? value : undefined;
}

function targetHost(origin: EdgeOrigin): string {
  return `${origin.hostname}:${origin.port}`;
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://edge.invalid").pathname;
}

function safeMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function writeError(response: ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message, retryable: status >= 500 } });
  response.writeHead(status, appendSecurityHeaders({ "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)), "cache-control": "no-store" }));
  response.end(body);
}

export function createPrivateEdgeServer(options: PrivateEdgeOptions): Server {
  const identity = parseOrigin(options.identityOrigin, "identityOrigin");
  const orchestrator = parseOrigin(options.orchestratorOrigin, "orchestratorOrigin");
  const controlWeb = parseOrigin(options.controlWebOrigin, "controlWebOrigin");
  const memory = options.memoryOrigin ? parseOrigin(options.memoryOrigin, "memoryOrigin") : undefined;
  const publicProto = options.publicProto ?? "https";
  const upgradeSockets = new Set<{ destroy(): void }>();

  const forwardAuth = async (request: IncomingMessage): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; status: number; headers: Record<string, string | string[]>; body: Buffer }> => {
    const headers: Record<string, string> = {
      "x-forwarded-method": request.method ?? "GET",
    };
    if (typeof request.headers.cookie === "string") headers.cookie = request.headers.cookie;
    if (typeof request.headers.origin === "string") headers.origin = request.headers.origin;
    if (typeof request.headers["x-pai-csrf-token"] === "string") headers["x-pai-csrf-token"] = request.headers["x-pai-csrf-token"];
    const auth = await fetch(`http://${identity.hostname}:${identity.port}/api/v1/auth/forward`, { headers, signal: AbortSignal.timeout(2_000) });
    const body = Buffer.from(await auth.arrayBuffer());
    if (!auth.ok) {
      const authHeaders: Record<string, string | string[]> = {};
      auth.headers.forEach((value, key) => { authHeaders[key] = value; });
      return { ok: false, status: auth.status, headers: authHeaders, body };
    }
    const verified: Record<string, string> = {};
    for (const name of identityHeaders) {
      const value = auth.headers.get(name);
      if (!value) throw new Error(`forward-auth response is missing ${name}`);
      verified[name] = value;
    }
    return { ok: true, headers: verified };
  };

  const proxy = (request: IncomingMessage, response: ServerResponse, origin: EdgeOrigin, targetPath: string, authHeaders?: Record<string, string>, includeBrowserAuth = false, timeoutMs = 15_000): void => {
    const headers = requestHeaders(request, {
      host: request.headers.host ?? targetHost(origin),
      "x-forwarded-proto": publicProto,
      ...(authHeaders ?? {}),
      ...(contentLength(request) ? { "content-length": contentLength(request)! } : {}),
    }, includeBrowserAuth);
    let timedOut = false;
    const client = httpRequest({ hostname: origin.hostname, port: origin.port, method: request.method, path: targetPath, headers }, (upstream) => {
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(upstream.headers)) if (value !== undefined) responseHeaders[key] = value;
      response.writeHead(upstream.statusCode ?? 502, appendSecurityHeaders(responseHeaders));
      upstream.pipe(response);
    });
    client.setTimeout(timeoutMs, () => {
      timedOut = true;
      client.destroy();
      if (!response.headersSent) writeError(response, 504, "EDGE_UPSTREAM_TIMEOUT", "Private edge upstream timed out");
    });
    client.on("error", () => { if (!response.headersSent) writeError(response, timedOut ? 504 : 502, timedOut ? "EDGE_UPSTREAM_TIMEOUT" : "EDGE_UPSTREAM_UNAVAILABLE", timedOut ? "Private edge upstream timed out" : "Private edge upstream is unavailable"); else response.destroy(); });
    request.on("aborted", () => client.destroy());
    response.on("close", () => { if (!response.writableEnded) client.destroy(); });
    request.pipe(client);
  };

  const server = createServer(async (request, response) => {
    try {
      const path = pathOf(request);
      if (path === "/infrastructure" || path.startsWith("/infrastructure/") || path.startsWith("/api/portal/v1/infrastructure/")) return writeError(response, 404, "NOT_FOUND", "not found");
      if (path === "/" || path === "/login") return proxy(request, response, identity, "/");
      if (path.startsWith("/api/v1/auth/")) return proxy(request, response, identity, request.url ?? "/", undefined, true);
      if (path.startsWith("/health")) return proxy(request, response, orchestrator, request.url ?? "/", undefined, false, 2_000);
      if (path.startsWith("/api/v1/worker/")) return proxy(request, response, orchestrator, request.url ?? "/");
      // Workload-authenticated service calls are verified by Orchestrator. The
      // edge may route them without browser forward-auth, but never trusts the
      // caller-supplied owner or identity headers itself.
      if (path.startsWith("/api/v1/") && typeof request.headers["x-pai-workload-id"] === "string") return proxy(request, response, orchestrator, request.url ?? "/");
      if (path.startsWith("/api/portal/v1/memory/")) {
        if (!memory || !safeMethod(request.method)) return writeError(response, 405, "METHOD_NOT_ALLOWED", "Memory projection is read-only");
        const target = `/v1/control/${path.slice("/api/portal/v1/memory/".length)}${new URL(request.url ?? "/", "http://edge.invalid").search}`;
        const auth = await forwardAuth(request);
        if ("status" in auth) {
          response.writeHead(auth.status, appendSecurityHeaders(auth.headers));
          response.end(auth.body);
          return;
        }
        return proxy(request, response, memory, target, auth.headers);
      }
      const auth = await forwardAuth(request);
      if ("status" in auth) {
        response.writeHead(auth.status, appendSecurityHeaders(auth.headers));
        response.end(auth.body);
        return;
      }
      if (path.startsWith("/api/v1/")) return proxy(request, response, orchestrator, request.url ?? "/", auth.headers);
      return proxy(request, response, controlWeb, request.url ?? "/", auth.headers);
    } catch (error) {
      writeError(response, 502, "EDGE_FAILURE", error instanceof Error ? error.message : "Private edge failed");
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const path = pathOf(request);
    if (request.method !== "GET" || !path.startsWith("/api/v1/worker/")) { socket.destroy(); return; }
    const upstream = connect(orchestrator.port, orchestrator.hostname);
    upgradeSockets.add(socket);
    upgradeSockets.add(upstream);
    const cleanup = () => { upgradeSockets.delete(socket); upgradeSockets.delete(upstream); };
    socket.once("close", cleanup);
    upstream.once("close", cleanup);
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/1.1`];
      const seen = new Set<string>();
      const excluded = headerExclusions(request.headers);
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index].toLowerCase();
        const value = request.rawHeaders[index + 1];
        if (name === "host" || name === "cookie" || name === "x-pai-csrf-token" || name === "authorization" || name === "proxy-authorization" || excluded.has(name) || isIdentityHeader(name)) continue;
        lines.push(`${request.rawHeaders[index]}: ${value}`);
        seen.add(name);
      }
      lines.push(`Host: ${targetHost(orchestrator)}`);
      if (!seen.has("connection")) lines.push("Connection: Upgrade");
      if (!seen.has("upgrade")) lines.push("Upgrade: websocket");
      lines.push("", "");
      upstream.write(lines.join("\r\n"));
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  server.on("close", () => { for (const socket of upgradeSockets) socket.destroy(); upgradeSockets.clear(); });
  edgeServers.set(server, upgradeSockets);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export function closePrivateEdgeConnections(server: Server): void {
  const sockets = edgeServers.get(server);
  if (!sockets) return;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}
