import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { IdentityDatabase } from "./db.ts";
import { IdentityService } from "./service.ts";

function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }

export function createIdentityHttpServer(options: { db: IdentityDatabase; identity: IdentityService; passkeyConfigured: boolean; passkeyAdapterReady?: boolean }) {
  return createServer((req: IncomingMessage, response: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && path === "/health/live") return json(response, 200, { status: "ok" });
    if (req.method === "GET" && path === "/health/ready") {
      const schema = options.db.one<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
      const adapterReady = options.passkeyAdapterReady === true;
      const ready = schema?.version === 1 && (process.env.NODE_ENV !== "production" ? true : options.passkeyConfigured && adapterReady);
      return json(response, ready ? 200 : 503, { status: ready ? "ok" : "not_ready", schemaVersion: schema?.version ?? null, passkey: !options.passkeyConfigured ? "disabled" : adapterReady ? "ready" : "not_wired" });
    }
    if (path.startsWith("/api/v1/auth/")) return json(response, options.passkeyConfigured ? 501 : 503, { error: { code: options.passkeyConfigured ? "NOT_IMPLEMENTED" : "PASSKEY_NOT_CONFIGURED", message: options.passkeyConfigured ? "WebAuthn RP adapter is not wired" : "Passkey origin/RP configuration is missing", retryable: false } });
    return json(response, 404, { error: { code: "NOT_FOUND", message: "not found", retryable: false } });
  });
}
