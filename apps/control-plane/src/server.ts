import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { ControlPlaneDatabase } from "./db/database.ts";
import { EventHub } from "./events/event-hub.ts";
import { ArtifactStorage } from "./artifacts/artifact-storage.ts";
import { TaskService } from "./tasks/task-service.ts";
import { WorkerService } from "./workers/worker-service.ts";
import { WorkerCoordinator } from "./workers/worker-channel.ts";
import { SettingsService } from "./settings/settings-service.ts";
import { HealthMonitor } from "./systems/health-monitor.ts";
import { parseCreateTaskInput, parseRegistrationInput } from "../../../packages/contracts/src/index.ts";

type Options = { db: ControlPlaneDatabase; tasks: TaskService; workers: WorkerService; coordinator: WorkerCoordinator; artifacts: ArtifactStorage; settings: SettingsService; health: HealthMonitor; events: EventHub; assetRoot?: string; isReady?: () => boolean };
type Row = Record<string, any>;
const JSON_LIMIT = 5 * 1024 * 1024;

function writeJson(response: ServerResponse, status: number, body: unknown): void { const data = Buffer.from(JSON.stringify(body)); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": data.length }); response.end(data); }
function errorBody(code: string, message = code, details?: unknown): { error: { code: string; message: string; details?: unknown } } { return { error: { code, message, ...(details === undefined ? {} : { details }) } }; }
function requestId(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
function pathParts(request: IncomingMessage): string[] { return new URL(request.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
function query(request: IncomingMessage): URLSearchParams { return new URL(request.url ?? "/", "http://localhost").searchParams; }
function jsonValue(value: string): any { try { return JSON.parse(value); } catch { return null; } }
function json(value: unknown, fallback: any = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > limit) throw new Error("REQUEST_TOO_LARGE"); chunks.push(buffer); }
  return Buffer.concat(chunks);
}
async function bodyJson(request: IncomingMessage): Promise<Record<string, unknown>> { const raw = await body(request, JSON_LIMIT); if (!raw.length) return {}; const parsed = JSON.parse(raw.toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_JSON_BODY"); return parsed as Record<string, unknown>; }
function authWorker(request: IncomingMessage, workers: WorkerService): Row { const value = request.headers.authorization; const token = value?.startsWith("Bearer ") ? value.slice(7) : ""; const worker = workers.authenticate(token); if (!worker) throw new Error("INVALID_WORKER_TOKEN"); return worker; }
function actor(request: IncomingMessage): string { const value = request.headers["x-actor"]?.toString().trim(); return value && value.length <= 120 ? value : "owner"; }
function stepUpActor(request: IncomingMessage): string {
  if (process.env.PAI_REQUIRE_STEP_UP === "true") {
    const assertion = request.headers["x-step-up-assertion"]?.toString().trim();
    if (!assertion || assertion.length < 16 || assertion.length > 4096) throw new Error("STEP_UP_REQUIRED");
  }
  return actor(request);
}

export function createControlPlaneServer(options: Options) {
  const root = options.assetRoot ?? process.env.PAI_CONTROL_WEB_ROOT ?? "./dist/control-web";
  const api = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const parts = pathParts(request); const method = request.method ?? "GET"; const q = query(request);
    if (parts[0] !== "api" || parts[1] !== "v2") return false;
    try {
      if (parts[2] === "events" && method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" }); response.write(`event: ready\ndata: ${JSON.stringify({ status: "connected" })}\n\n`); const unsubscribe = options.events.subscribe((event) => { if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`); }); request.on("close", unsubscribe); return true;
      }
      if (parts[2] === "tasks") {
        if (method === "POST" && parts.length === 3) { const created = options.tasks.create(parseCreateTaskInput(await bodyJson(request))); return writeJson(response, 202, { task_id: created.id, status: created.status, created_at: created.createdAt }), true; }
        if (method === "GET" && parts.length === 3) return writeJson(response, 200, { items: options.tasks.list({ status: q.get("status") ?? undefined, workerId: q.get("worker_id") ?? undefined, taskType: q.get("task_type") ?? undefined, search: q.get("search") ?? undefined, limit: Number(q.get("limit") ?? 100) }) }), true;
        const taskId = parts[3]; if (!taskId) throw new Error("TASK_NOT_FOUND");
        if (method === "GET" && parts.length === 4) { const detail = options.tasks.detail(taskId); if (!detail) throw new Error("TASK_NOT_FOUND"); return writeJson(response, 200, detail), true; }
        if (method === "GET" && parts[4] === "events") { if (!options.tasks.get(taskId)) throw new Error("TASK_NOT_FOUND"); return writeJson(response, 200, { items: options.tasks.eventsFor(taskId) }), true; }
        if (method === "POST" && parts[4] === "cancel") { const cancelled = options.tasks.cancel(taskId); if (!cancelled) throw new Error("TASK_NOT_FOUND"); const attemptId = String(cancelled.currentAttemptId ?? ""); const workerId = attemptId ? String(options.db.one<Row>("SELECT worker_id FROM task_attempts WHERE id = ?", attemptId)?.worker_id ?? "") : ""; if (workerId && attemptId) options.coordinator.cancel(workerId, taskId, attemptId); return writeJson(response, 202, cancelled), true; }
        if (method === "POST" && parts[4] === "retry") { const retried = options.tasks.retry(taskId); if (!retried) throw new Error("TASK_NOT_FOUND"); return writeJson(response, 202, retried), true; }
      }
      if (parts[2] === "workers") {
        if (method === "GET" && parts.length === 3) return writeJson(response, 200, { items: options.workers.listWorkers() }), true;
        if (parts[3] === "registrations") {
          if (method === "GET" && parts.length === 4) return writeJson(response, 200, { items: options.workers.listRegistrations() }), true;
          const registrationId = parts[4];
          if (method === "POST" && parts[5] === "approve") return writeJson(response, 200, options.workers.approveRegistration(registrationId)), true;
          if (method === "POST" && parts[5] === "reject") { options.workers.rejectRegistration(registrationId); return writeJson(response, 200, { status: "rejected", registrationId }), true; }
          if (method === "DELETE" && parts.length === 5) return writeJson(response, 200, options.workers.removeRegistration(registrationId, stepUpActor(request))), true;
        }
        if (method === "GET" && parts.length === 4) { const worker = options.workers.getWorker(parts[3]); if (!worker) throw new Error("WORKER_NOT_FOUND"); return writeJson(response, 200, worker), true; }
        const workerId = parts[3]; if (!workerId) throw new Error("WORKER_NOT_FOUND");
        if (method === "PATCH" && parts.length === 4) { const input = await bodyJson(request); options.workers.rename(workerId, String(input.name ?? ""), actor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "enable") { options.workers.setEnabled(workerId, true, actor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "disable") { options.workers.setEnabled(workerId, false, actor(request)); options.coordinator.closeWorker(workerId, 4005, "worker disabled"); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "drain") { options.workers.setDrain(workerId, true, actor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "resume") { options.workers.setDrain(workerId, false, actor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "capabilities" && parts[6] === "grant") { options.workers.grantCapability(workerId, parts[5], stepUpActor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "capabilities" && parts[6] === "revoke") { options.workers.revokeCapability(workerId, parts[5], stepUpActor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "DELETE" && parts.length === 4) { const removed = options.workers.remove(workerId, stepUpActor(request)); options.coordinator.closeWorker(workerId); return writeJson(response, 200, removed), true; }
      }
      if (parts[2] === "worker" && parts[3] === "registration") {
        if (method === "POST" && parts.length === 4) { const input = parseRegistrationInput(await bodyJson(request)); if (process.env.PAI_REGISTRATION_ENABLED === "false") throw new Error("REGISTRATION_DISABLED"); return writeJson(response, 202, options.workers.register(input)), true; }
        const registrationId = parts[4]; const secret = request.headers["x-registration-secret"]?.toString() ?? ""; if (method === "GET" && registrationId) return writeJson(response, 200, options.workers.pollRegistration(registrationId, secret)), true;
      }
      if (parts[2] === "models" && method === "GET") return writeJson(response, 200, { items: options.workers.listModels() }), true;
      if (parts[2] === "systems" && method === "GET") return writeJson(response, 200, { items: options.health.list(Boolean(options.isReady?.() ?? true)) }), true;
      if (parts[2] === "settings") {
        if (method === "GET") return writeJson(response, 200, options.settings.get()), true;
        if (method === "PATCH") return writeJson(response, 200, options.settings.patch(await bodyJson(request))), true;
      }
      if (parts[2] === "worker" && parts[3] === "tasks" && parts[5] === "artifacts") {
        const worker = authWorker(request, options.workers); const taskId = parts[4]; const taskRow = options.db.one<Row>("SELECT t.id FROM tasks t JOIN task_attempts a ON a.task_id = t.id WHERE t.id = ? AND a.worker_id = ?", taskId, worker.id); if (!taskRow) throw new Error("ARTIFACT_NOT_FOUND");
        if (method === "POST") { const bytes = await body(request, Number(process.env.PAI_MAX_ARTIFACT_BYTES ?? 1_073_741_824)); const filename = basename(request.headers["x-artifact-filename"]?.toString() ?? "artifact.bin"); const mediaTypeRaw = request.headers["content-type"]?.toString() ?? "application/octet-stream"; const mediaType = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=._ -]+)*$/.test(mediaTypeRaw) ? mediaTypeRaw.slice(0, 160) : "application/octet-stream"; const stored = options.artifacts.write(taskId, filename, mediaType, bytes); options.db.run("INSERT INTO artifacts(id, task_id, attempt_id, filename, media_type, size_bytes, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", stored.id, taskId, options.db.one<Row>("SELECT current_attempt_id FROM tasks WHERE id = ?", taskId)?.current_attempt_id ?? null, stored.filename, stored.mediaType, stored.sizeBytes, stored.sha256, stored.storagePath, Date.now()); options.db.run("INSERT INTO task_artifacts(task_id, artifact_id, direction) VALUES (?, ?, 'OUTPUT')", taskId, stored.id); return writeJson(response, 201, { id: stored.id, filename: stored.filename, mediaType: stored.mediaType, sizeBytes: stored.sizeBytes, sha256: stored.sha256 }), true; }
      }
      if (parts[2] === "worker" && parts[3] === "artifacts" && method === "GET") { const worker = authWorker(request, options.workers); const artifactId = parts[4]; const row = options.db.one<Row>("SELECT a.* FROM artifacts a JOIN task_artifacts ta ON ta.artifact_id = a.id JOIN task_attempts at ON at.task_id = ta.task_id WHERE a.id = ? AND at.worker_id = ?", artifactId, worker.id); if (!row || !options.artifacts.exists(row.storage_path)) throw new Error("ARTIFACT_NOT_FOUND"); response.writeHead(200, { "content-type": row.media_type ?? "application/octet-stream", "content-length": row.size_bytes, "content-disposition": `attachment; filename="${basename(row.filename)}"` }); options.artifacts.stream(row.storage_path).pipe(response); return true; }
      return writeJson(response, 404, errorBody("NOT_FOUND", "API route not found")), true;
    } catch (error) {
      const code = error instanceof Error ? error.message : "INTERNAL_ERROR"; const status = code === "TASK_NOT_FOUND" || code === "WORKER_NOT_FOUND" || code === "REGISTRATION_NOT_FOUND" || code === "ARTIFACT_NOT_FOUND" || code === "CAPABILITY_NOT_FOUND" ? 404 : code === "INVALID_WORKER_TOKEN" ? 401 : code === "REGISTRATION_DISABLED" || code === "STEP_UP_REQUIRED" ? 403 : code === "INVALID_TASK_STATE" || code === "INVALID_REGISTRATION_STATE" || code === "WORKER_BUSY" || code === "REGISTRATION_ALREADY_FINALIZED" ? 409 : code === "REQUEST_TOO_LARGE" ? 413 : code.startsWith("INVALID_") || code === "REGISTRATION_SECRET_TOO_SHORT" || code === "INVALID_JSON_BODY" || code.includes("must be") ? 400 : 500; return writeJson(response, status, errorBody(code, code, process.env.NODE_ENV === "production" ? undefined : { requestId: requestId(request) })), true;
    }
  };

  return createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff"); response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/healthz") return writeJson(response, 200, { status: "ok", service: "personal-ai-control-plane", version: "2.0.0", observed_at: new Date().toISOString() });
    if (pathname === "/readyz") { const ready = options.isReady?.() ?? true; return writeJson(response, ready ? 200 : 503, { status: ready ? "ok" : "not_ready", service: "personal-ai-control-plane", observed_at: new Date().toISOString() }); }
    if (pathname.startsWith("/api/")) { await api(request, response); return; }
    if (request.method !== "GET" && request.method !== "HEAD") return writeJson(response, 405, errorBody("METHOD_NOT_ALLOWED", "Control Plane accepts GET, HEAD and API methods"));
    try {
      const relativePath = pathname.replace(/^\/+/, ""); const asset = relativePath.startsWith("assets/"); const file = asset ? resolve(root, relativePath) : resolve(root, "index.html"); const rootPath = resolve(root); const withinRoot = file === rootPath || !relative(rootPath, file).startsWith(".."); if (!withinRoot) return writeJson(response, 404, errorBody("NOT_FOUND", "Asset not found")); const content = await readFile(file); response.setHeader("cache-control", asset ? "public, max-age=31536000, immutable" : "no-cache"); response.setHeader("content-type", file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8"); response.end(request.method === "HEAD" ? undefined : content);
    } catch { writeJson(response, 503, errorBody("CONTROL_WEB_UNAVAILABLE", "Control Web assets are unavailable")); }
  });
}
