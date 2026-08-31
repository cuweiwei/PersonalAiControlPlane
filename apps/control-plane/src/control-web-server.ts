import { readFile, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function headers(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("x-content-type-options", "nosniff");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const content = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": content.length });
  response.end(content);
}

export function createControlWebServer(assetRoot = process.env.PAI_CONTROL_WEB_ROOT ?? "./dist/control-web") {
  const root = resolve(assetRoot);
  const indexPath = join(root, "index.html");

  return createServer(async (request, response) => {
    headers(response);
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (request.method === "GET" && pathname === "/health/live") return json(response, 200, { status: "ok" });
      if (request.method === "GET" && pathname === "/health/ready") {
        try {
          await stat(indexPath);
          return json(response, 200, { status: "ok" });
        } catch {
          return json(response, 503, { status: "not_ready", assets: "missing" });
        }
      }
      if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Control Web accepts only GET and HEAD" } });

      const relative = pathname.replace(/^\/+/, "");
      let filePath = resolve(root, relative || "index.html");
      if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return json(response, 404, { error: { code: "NOT_FOUND", message: "not found" } });
      try {
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) filePath = join(filePath, "index.html");
      } catch {
        filePath = indexPath;
      }
      const content = await readFile(filePath);
      response.writeHead(200, { "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream", "content-length": content.length });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      if (!response.headersSent) json(response, 503, { error: { code: "CONTROL_WEB_UNAVAILABLE", message: "Control Web assets are unavailable" } });
      else response.destroy();
    }
  });
}
