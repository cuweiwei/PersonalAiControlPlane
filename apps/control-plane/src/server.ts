import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
import { HermesCallbackDispatcher } from "./callbacks/outbox.ts";
import { ModelTestService } from "./models/model-test-service.ts";
import { ModelPreferenceService } from "./models/model-preference-service.ts";
import { OnboardingService } from "./workers/onboarding-service.ts";
import { OfficeService } from "./office/office-service.ts";
import { MissionService } from "./missions/mission-service.ts";
import { PlanService } from "./missions/plan-service.ts";
import { MissionCoordinator } from "./missions/coordinator.ts";
import { operationCatalog } from "./control/operation-catalog.ts";
import { safeHash } from "./tasks/task-service.ts";
import { parseCreateMemberInput, parseCreateMissionInput, parseCreateRoleInput, parseCreateTaskInput, parseRegistrationInput } from "../../../packages/contracts/src/index.ts";

type Options = { db: ControlPlaneDatabase; tasks: TaskService; workers: WorkerService; coordinator: WorkerCoordinator; missionCoordinator?: MissionCoordinator; artifacts: ArtifactStorage; settings: SettingsService; health: HealthMonitor; events: EventHub; office?: OfficeService; missions?: MissionService; plans?: PlanService; callback?: HermesCallbackDispatcher; modelTests?: ModelTestService; modelPreferences?: ModelPreferenceService; onboarding?: OnboardingService; assetRoot?: string; isReady?: () => boolean };
type Row = Record<string, any>;
const JSON_LIMIT = 5 * 1024 * 1024;

function writeJson(response: ServerResponse, status: number, body: unknown): void { const data = Buffer.from(JSON.stringify(body)); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": data.length }); response.end(data); }
function errorBody(code: string, message = code, details?: unknown): { error: { code: string; message: string; details?: unknown } } { return { error: { code, message, ...(details === undefined ? {} : { details }) } }; }
function requestId(request: IncomingMessage): string { return request.headers["x-request-id"]?.toString() || randomUUID(); }
function pathParts(request: IncomingMessage): string[] { return new URL(request.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part)); }
function query(request: IncomingMessage): URLSearchParams { return new URL(request.url ?? "/", "http://localhost").searchParams; }
function jsonValue(value: string): any { try { return JSON.parse(value); } catch { return null; } }
function json(value: unknown, fallback: any = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function dateQuery(value: string | null): number | undefined { if (!value) return undefined; const timestamp = Date.parse(value); if (!Number.isFinite(timestamp)) throw new Error("INVALID_DATE_RANGE"); return timestamp; }

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
function normalizedAddress(value: string): string {
  const normalized = value.replace(/^::ffff:/, "");
  return isIP(normalized) === 0 ? normalized : normalized.toLowerCase();
}

async function internalPeerAllowed(request: IncomingMessage): Promise<boolean> {
  if (request.headers.origin) return false;
  const remote = normalizedAddress(request.socket.remoteAddress ?? "");
  const configured = (process.env.PAI_OFFICE_TRUSTED_PEERS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (configured.length > 0) {
    const allowed = new Set(configured.map(normalizedAddress));
    for (const peer of configured.filter((value) => isIP(value) === 0)) {
      try {
        for (const address of await lookup(peer, { all: true, verbatim: true })) allowed.add(normalizedAddress(address.address));
      } catch {
        // An unresolved fixed peer remains untrusted.
      }
    }
    return allowed.has(remote);
  }
  return process.env.NODE_ENV !== "production" && ["127.0.0.1", "::1"].includes(remote);
}

export function createControlPlaneServer(options: Options) {
  const root = options.assetRoot ?? process.env.PAI_CONTROL_WEB_ROOT ?? "./dist/control-web";
  const capabilitySnapshot = (): Record<string, unknown> => {
    const workers = options.workers.listWorkers().map((worker: any) => ({ workerId: worker.id, executorKind: "WORKER", available: worker.status === "ONLINE" && worker.enabled !== false && worker.drain !== true, status: worker.status, observedAt: worker.lastHeartbeatAt ?? null }));
    const models = options.workers.listModels(false).map((model: any) => ({ workerId: model.workerId, executorKind: "WORKER", capability: model.taskType ?? "llm.inference", runtime: model.runtime, model: model.model, available: model.dispatchable === true, observedAt: model.lastSeenAt ?? null }));
    const hermesConfigured = Boolean(process.env.PAI_HERMES_OFFICE_URL); const supervisorReadOnly = process.env.PAI_HERMES_SUPERVISOR_READ_ONLY === "true";
    const items = [...workers, ...models];
    return { snapshotId: randomUUID(), observedAt: new Date().toISOString(), ttlSeconds: Number(options.settings.get().hermes_brain_capability_ttl_seconds ?? 30), contentHash: safeHash(items), items, hermes: { executorKind: "HERMES_TOOL", available: hermesConfigured && supervisorReadOnly, supervisorReadOnly, tools: ["control.missions", "control.tasks", "control.workers", "control.models", "control.systems", "control.settings", "control.artifacts"], unavailableReasons: hermesConfigured ? supervisorReadOnly ? [] : ["SUPERVISOR_READ_ONLY_NOT_VERIFIED"] : ["HERMES_ADAPTER_NOT_CONFIGURED"] } };
  };
  const api = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const parts = pathParts(request); const method = request.method ?? "GET"; const q = query(request);
    if (parts[0] !== "api" || parts[1] !== "v2") return false;
    try {
      if (parts[2] === "events" && method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" }); response.write(`event: ready\ndata: ${JSON.stringify({ status: "connected" })}\n\n`); const unsubscribe = options.events.subscribe((event) => { if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`); }); request.on("close", unsubscribe); return true;
      }
      if (parts[2] === "office" && parts[3] === "recovery") {
        if (!options.missionCoordinator) throw new Error("OFFICE_NOT_READY");
        if (method === "GET" && parts.length === 4) return writeJson(response, 200, options.missionCoordinator.recoveryStatus()), true;
        if (method === "POST" && parts.length === 4) {
          const input = await bodyJson(request); const action = String(input.action ?? "").toUpperCase();
          if (action === "ENTER") return writeJson(response, 202, options.missionCoordinator.enterRecovery()), true;
          if (action === "CLEAR") return writeJson(response, 200, options.missionCoordinator.leaveRecovery()), true;
          throw new Error("INVALID_RECOVERY_ACTION");
        }
      }
      if (parts[2] === "acceptance" && method === "GET" && parts.length === 3) {
        const office = options.office?.get("office-1") ?? null;
        return writeJson(response, 200, { service: "personal-ai-control-plane", ready: Boolean(options.isReady?.() ?? true), office, coordinator: options.missionCoordinator?.health() ?? null, observedAt: new Date().toISOString() }), true;
      }
      if (parts[2] === "capabilities" && method === "GET" && parts.length === 3) {
        return writeJson(response, 200, capabilitySnapshot()), true;
      }
      if (parts[2] === "role-definitions") {
        if (!options.office) throw new Error("OFFICE_NOT_READY");
        if (method === "POST" && parts.length === 3) return writeJson(response, 201, options.office.createRole(parseCreateRoleInput(await bodyJson(request)))), true;
      }
      if (parts[2] === "offices") {
        if (!options.office || !options.missions) throw new Error("OFFICE_NOT_READY");
        if (method === "GET" && parts.length === 3) return writeJson(response, 200, { items: options.office.list() }), true;
        const officeId = parts[3];
        if (method === "GET" && parts.length === 4) { const office = options.office.get(officeId); if (!office) throw new Error("OFFICE_NOT_FOUND"); return writeJson(response, 200, office), true; }
        if (method === "POST" && parts[4] === "members" && parts.length === 5) return writeJson(response, 201, options.office.createMember(officeId, parseCreateMemberInput(await bodyJson(request)))), true;
      }
      if (parts[2] === "missions") {
        if (!options.missions) throw new Error("OFFICE_NOT_READY");
        if (method === "POST" && parts.length === 3) { const key = request.headers["idempotency-key"]?.toString(); const created = options.missions.create(parseCreateMissionInput(await bodyJson(request)), key ?? ""); return writeJson(response, 202, created.response), true; }
        if (method === "GET" && parts[3] === "by-source" && parts.length === 4) { const sourceIntentKey = q.get("source_intent_key"); if (!sourceIntentKey) throw new Error("MISSING_SOURCE_INTENT_KEY"); const mission = options.missions.bySourceIntent(String(sourceIntentKey)); if (!mission) throw new Error("MISSION_NOT_FOUND"); return writeJson(response, 200, mission), true; }
        if (method === "GET" && parts.length === 3 && q.get("source_intent_key")) { const mission = options.missions.bySourceIntent(String(q.get("source_intent_key"))); if (!mission) throw new Error("MISSION_NOT_FOUND"); return writeJson(response, 200, mission), true; }
        if (method === "GET" && parts.length === 3) return writeJson(response, 200, { items: options.missions.list({ officeId: q.get("office_id") ?? undefined, phase: q.get("phase") ?? undefined, sourceIntentKey: q.get("source_intent_key") ?? undefined, limit: q.has("limit") ? Number(q.get("limit")) : undefined }), observedAt: new Date().toISOString() }), true;
        const missionId = parts[3]; if (!missionId) throw new Error("MISSION_NOT_FOUND");
        if (method === "GET" && parts.length === 4) { const mission = options.missions.get(missionId, q.get("mission_run_id") ?? undefined); if (!mission) throw new Error("MISSION_NOT_FOUND"); return writeJson(response, 200, mission), true; }
        if (method === "POST" && parts[4] === "inputs" && parts.length === 5) { const input = await bodyJson(request); if (input.kind !== "TEXT" || typeof input.text !== "string") throw new Error("INVALID_MISSION_INPUT"); return writeJson(response, 202, options.missions.appendInput(missionId, { kind: "TEXT", text: input.text }, request.headers["idempotency-key"]?.toString() ?? "", input.expected_objective_revision === undefined ? undefined : Number(input.expected_objective_revision))), true; }
        if (method === "POST" && parts[4] === "reopen" && parts.length === 5) { const input = await bodyJson(request); return writeJson(response, 202, options.missions.reopen(missionId, request.headers["idempotency-key"]?.toString() ?? "", input.expected_mission_revision === undefined ? undefined : Number(input.expected_mission_revision))), true; }
        if (method === "GET" && parts[4] === "events") return writeJson(response, 200, options.missions.eventsPage(missionId, Number(q.get("after_seq") ?? 0), Number(q.get("limit") ?? 100))), true;
        if (method === "GET" && parts[4] === "results") return writeJson(response, 200, options.missions.results(missionId, q.get("mission_run_id") ?? undefined)), true;
        if (method === "POST" && parts[4] === "commands" && parts[5] && parts[6] === "retry") {
          const input = await bodyJson(request); const idempotencyKey = request.headers["idempotency-key"]?.toString();
          const result = options.missions.retryCommand(missionId, parts[5], idempotencyKey ?? "", input.expected_control_revision === undefined ? undefined : Number(input.expected_control_revision));
          return writeJson(response, 202, result), true;
        }
        if (method === "POST" && parts[4] === "control" && parts.length === 5) {
          const input = await bodyJson(request); const action = String(input.action ?? "").toUpperCase();
          if (!(action === "PAUSE" || action === "RESUME" || action === "CANCEL")) throw new Error("INVALID_MISSION_CONTROL");
          const result = options.missions.control(missionId, action, request.headers["idempotency-key"]?.toString() ?? "", input.expected_control_revision === undefined ? undefined : Number(input.expected_control_revision));
          if (action === "CANCEL" && options.missionCoordinator) options.missionCoordinator.cancelRun(String(result.missionRunId));
          return writeJson(response, 202, result), true;
        }
      }
      if (parts[2] === "internal" && parts[3] === "office") {
        if (!(await internalPeerAllowed(request))) throw new Error("INTERNAL_ROUTE_FORBIDDEN");
        if (!options.missions || !options.plans) throw new Error("OFFICE_NOT_READY");
        if (method === "GET" && parts[4] === "operations" && parts.length === 6) {
          const descriptor = operationCatalog({ artifacts: Boolean(options.artifacts), modelTests: Boolean(options.modelTests), modelPreferences: Boolean(options.modelPreferences), onboarding: Boolean(options.onboarding) }).find((item) => item.operationId === parts[5]);
          if (!descriptor) throw new Error("OPERATION_NOT_FOUND");
          return writeJson(response, 200, { operationId: descriptor.operationId, state: descriptor.available ? "AVAILABLE" : "UNAVAILABLE", descriptor, observedAt: new Date().toISOString() }), true;
        }
        if (method === "GET" && parts[4] === "operations" && parts.length === 5) {
          return writeJson(response, 200, { catalogVersion: 1, observedAt: new Date().toISOString(), items: operationCatalog({ artifacts: Boolean(options.artifacts), modelTests: Boolean(options.modelTests), modelPreferences: Boolean(options.modelPreferences), onboarding: Boolean(options.onboarding) }) }), true;
        }
        if (method === "POST" && parts[4] === "operations" && parts.length === 5) {
          const input = await bodyJson(request); const operationId = String(input.operation_id ?? ""); const descriptor = operationCatalog({ artifacts: Boolean(options.artifacts), modelTests: Boolean(options.modelTests), modelPreferences: Boolean(options.modelPreferences), onboarding: Boolean(options.onboarding) }).find((item) => item.operationId === operationId);
          if (!descriptor) throw new Error("OPERATION_NOT_FOUND");
          if (!descriptor.available) throw new Error(`OPERATION_UNAVAILABLE:${descriptor.reason ?? "UNAVAILABLE"}`);
          const parameters = input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters) ? input.parameters as Row : input;
          const missing = descriptor.requiredParameters.filter((name) => parameters[name] === undefined || parameters[name] === null || parameters[name] === ""); if (missing.length) throw new Error(`MISSING_OPERATION_PARAMETER:${missing.join(",")}`);
          const idempotencyKey = request.headers["idempotency-key"]?.toString() ?? String(input.idempotency_key ?? "");
          if (descriptor.mutating && !idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
          if (operationId === "control.missions.get") { const mission = options.missions.get(String(parameters.mission_id)); if (!mission) throw new Error("MISSION_NOT_FOUND"); return writeJson(response, 200, { operationId, state: "APPLIED", result: mission }), true; }
          if (operationId === "control.missions.list") return writeJson(response, 200, { operationId, state: "APPLIED", result: { items: options.missions.list({ officeId: parameters.office_id ? String(parameters.office_id) : undefined, phase: parameters.phase ? String(parameters.phase) : undefined, limit: parameters.limit === undefined ? undefined : Number(parameters.limit) }) } }), true;
          if (operationId === "control.missions.results") return writeJson(response, 200, { operationId, state: "APPLIED", result: options.missions.results(String(parameters.mission_id)) }), true;
          if (operationId === "control.tasks.list") return writeJson(response, 200, { operationId, state: "APPLIED", result: options.tasks.listPage({ status: parameters.status ? String(parameters.status) : undefined, workerId: parameters.worker_id ? String(parameters.worker_id) : undefined, taskType: parameters.task_type ? String(parameters.task_type) : undefined, limit: parameters.limit === undefined ? undefined : Number(parameters.limit) }) }), true;
          if (operationId === "control.tasks.get") { const task = options.tasks.detail(String(parameters.task_id)); if (!task) throw new Error("TASK_NOT_FOUND"); return writeJson(response, 200, { operationId, state: "APPLIED", result: task }), true; }
          if (operationId === "control.workers.list") return writeJson(response, 200, { operationId, state: "APPLIED", result: { items: options.workers.listWorkers() } }), true;
          if (operationId === "control.workers.get") { const worker = options.workers.getWorker(String(parameters.worker_id)); if (!worker) throw new Error("WORKER_NOT_FOUND"); return writeJson(response, 200, { operationId, state: "APPLIED", result: worker }), true; }
          if (operationId === "control.models.list") return writeJson(response, 200, { operationId, state: "APPLIED", result: { items: options.workers.listModels(parameters.present === false) } }), true;
          if (operationId === "control.office.list") return writeJson(response, 200, { operationId, state: "APPLIED", result: { items: options.office?.list() ?? [] } }), true;
          if (operationId === "control.settings.get") return writeJson(response, 200, { operationId, state: "APPLIED", result: options.settings.getEffective() }), true;
          if (operationId === "control.systems.list") return writeJson(response, 200, { operationId, state: "APPLIED", result: options.health.list(Boolean(options.isReady?.() ?? true)) }), true;
          if (operationId === "control.capabilities.get") return writeJson(response, 200, { operationId, state: "APPLIED", result: capabilitySnapshot() }), true;
          if (operationId === "control.models.test_templates") { if (!options.modelTests) throw new Error("MODEL_TEST_UNAVAILABLE"); return writeJson(response, 200, { operationId, state: "APPLIED", result: { items: options.modelTests.listTemplates() } }), true; }
          if (operationId === "control.model_preferences.list") { if (!options.modelPreferences) throw new Error("MODEL_PREFERENCE_UNAVAILABLE"); return writeJson(response, 200, { operationId, state: "APPLIED", result: { items: options.modelPreferences.list() } }), true; }
          if (operationId === "control.artifacts.get") { const artifact = options.db.one<Row>("SELECT id, filename, display_filename, media_type, size_bytes, sha256, storage_state FROM artifacts WHERE id = ?", String(parameters.artifact_id)); if (!artifact) throw new Error("ARTIFACT_NOT_FOUND"); return writeJson(response, 200, { operationId, state: "APPLIED", result: { id: artifact.id, filename: artifact.display_filename ?? artifact.filename, mediaType: artifact.media_type, sizeBytes: artifact.size_bytes, sha256: artifact.sha256, availability: artifact.storage_state ?? "AVAILABLE" } }), true; }
          if (operationId === "control.missions.create") { const missionInput = parseCreateMissionInput(parameters); if (missionInput.brainProtocolVersion !== 2) throw new Error("BRAIN_V2_REQUIRED"); const created = options.missions.create(missionInput, idempotencyKey); return writeJson(response, 202, { operationId, state: created.replayed ? "REPLAYED" : "ACCEPTED", result: created.response }), true; }
          if (operationId === "control.missions.append_input") { const result = options.missions.appendInput(String(parameters.mission_id), { kind: "TEXT", text: String(parameters.text) }, idempotencyKey, parameters.expected_objective_revision === undefined ? undefined : Number(parameters.expected_objective_revision)); return writeJson(response, 202, { operationId, state: result.replayed ? "REPLAYED" : "ACCEPTED", result }), true; }
          if (["control.missions.pause", "control.missions.resume", "control.missions.cancel"].includes(operationId)) { const action = operationId.endsWith("pause") ? "PAUSE" : operationId.endsWith("resume") ? "RESUME" : "CANCEL"; const result = options.missions.control(String(parameters.mission_id), action, idempotencyKey, Number(parameters.expected_control_revision)); if (action === "CANCEL" && options.missionCoordinator) options.missionCoordinator.cancelRun(String(result.missionRunId)); return writeJson(response, 202, { operationId, state: result.replayed ? "REPLAYED" : "ACCEPTED", result }), true; }
          if (operationId === "control.missions.reopen") { const result = options.missions.reopen(String(parameters.mission_id), idempotencyKey, Number(parameters.expected_mission_revision)); return writeJson(response, 202, { operationId, state: result.replayed ? "REPLAYED" : "ACCEPTED", result }), true; }
          throw new Error("OPERATION_NOT_IMPLEMENTED");
        }
        if (method === "GET" && parts[4] === "commands" && parts[5] && parts[6] === "context") { if (!options.missionCoordinator) throw new Error("OFFICE_NOT_READY"); const context = options.missionCoordinator.context(parts[5]); if (!context) throw new Error("COMMAND_NOT_FOUND"); return writeJson(response, 200, context), true; }
        if (method === "GET" && parts[4] === "commands" && parts[5] && parts.length === 6) { const command = options.missions.command(parts[5]); if (!command) throw new Error("COMMAND_NOT_FOUND"); return writeJson(response, 200, command), true; }
        if (method === "POST" && parts[4] === "commands" && parts[5] && parts[6] === "admissions") { if (!options.missionCoordinator) throw new Error("OFFICE_NOT_READY"); return writeJson(response, 202, options.missionCoordinator.admitCommand(parts[5], await bodyJson(request))), true; }
        if (method === "POST" && parts[4] === "commands" && parts[5] && parts[6] === "progress") { if (!options.missionCoordinator) throw new Error("OFFICE_NOT_READY"); return writeJson(response, 200, options.missionCoordinator.progress(parts[5], await bodyJson(request))), true; }
        if (method === "POST" && parts[4] === "commands" && parts[5] && parts[6] === "stop-receipts") { if (!options.missionCoordinator) throw new Error("OFFICE_NOT_READY"); return writeJson(response, 200, options.missionCoordinator.stopReceipt(parts[5], await bodyJson(request))), true; }
        if (method === "POST" && parts[4] === "commands" && parts[5] && parts[6] === "failures") { if (!options.missionCoordinator) throw new Error("OFFICE_NOT_READY"); return writeJson(response, 200, options.missionCoordinator.failCommand(parts[5], await bodyJson(request))), true; }
        if (method === "POST" && parts[4] === "command-results" && parts.length === 5) { const input = await bodyJson(request); const commandId = typeof input.command_id === "string" ? input.command_id : ""; if (!commandId) throw new Error("INVALID_COMMAND"); if (options.missionCoordinator) return writeJson(response, 200, options.missionCoordinator.applyCommandResult(commandId, input)), true; const result = input.result && typeof input.result === "object" && !Array.isArray(input.result) ? (input.result as Record<string, unknown>) : input; const proposal = result.plan ?? input.plan; return writeJson(response, 200, options.plans.submitPlan(commandId, proposal)), true; }
        if (method === "POST" && parts[4] === "delivery-receipts" && parts.length === 5) { if (!options.missionCoordinator) throw new Error("OFFICE_NOT_READY"); return writeJson(response, 200, options.missionCoordinator.deliveryReceipt(await bodyJson(request))), true; }
      }
      if (parts[2] === "tasks") {
        if (method === "POST" && parts.length === 3) { const input = await bodyJson(request); const key = request.headers["idempotency-key"]?.toString(); const requestHash = safeHash(input); if (key) { const prior = options.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = 'tasks-create' AND operation_key = ?", key); if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return writeJson(response, Number(prior.status_code), json(prior.response_json)), true; } } const defaults = options.settings.taskDefaults(); const parsed = parseCreateTaskInput(input, defaults); parsed.settingsVersion = defaults.settingsVersion; const created = options.tasks.create(parsed); const result = { task_id: created.id, status: created.status, created_at: created.createdAt, run_id: created.currentRunId }; if (key) options.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES ('tasks-create', ?, ?, 202, ?, ?)", key, requestHash, JSON.stringify(result), Date.now()); return writeJson(response, 202, result), true; }
        if (method === "GET" && parts.length === 3) {
          const result = options.tasks.listPage({ status: q.get("status") ?? undefined, workerId: q.get("worker_id") ?? undefined, taskType: q.get("task_type") ?? undefined, search: q.get("search") ?? undefined, workspaceId: q.get("workspace_id") ?? undefined, purpose: q.get("purpose") ?? undefined, createdFrom: dateQuery(q.get("created_from")), createdTo: dateQuery(q.get("created_to")), finishedFrom: dateQuery(q.get("finished_from")), finishedTo: dateQuery(q.get("finished_to")), sort: (q.get("sort") as "created_desc" | "created_asc" | "finished_desc" | null) ?? undefined, limit: q.has("limit") ? Number(q.get("limit")) : undefined, cursor: q.get("cursor") ?? undefined });
          return writeJson(response, 200, result), true;
        }
        if (method === "GET" && parts.length === 4 && parts[3] === "summary") return writeJson(response, 200, options.tasks.summary({ status: q.get("status") ?? undefined, workerId: q.get("worker_id") ?? undefined, taskType: q.get("task_type") ?? undefined, search: q.get("search") ?? undefined, workspaceId: q.get("workspace_id") ?? undefined, purpose: q.get("purpose") ?? undefined, createdFrom: dateQuery(q.get("created_from")), createdTo: dateQuery(q.get("created_to")), finishedFrom: dateQuery(q.get("finished_from")), finishedTo: dateQuery(q.get("finished_to")) })), true;
        const taskId = parts[3]; if (!taskId) throw new Error("TASK_NOT_FOUND");
        if (method === "GET" && parts.length === 4) { const detail = options.tasks.detail(taskId); if (!detail) throw new Error("TASK_NOT_FOUND"); if (options.callback) detail.delivery = options.callback.listForTask(taskId); return writeJson(response, 200, detail), true; }
        if (method === "GET" && parts[4] === "events") { if (!options.tasks.get(taskId)) throw new Error("TASK_NOT_FOUND"); const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 100))); const afterEventId = q.get("after_event_id") ?? q.get("cursor") ?? undefined; return writeJson(response, 200, options.tasks.eventsPage(taskId, { afterEventId, limit })), true; }
        if (method === "POST" && parts[4] === "cancel") { const cancelled = options.tasks.cancel(taskId); if (!cancelled) throw new Error("TASK_NOT_FOUND"); const attemptId = String(cancelled.currentAttemptId ?? ""); const workerId = attemptId ? String(options.db.one<Row>("SELECT worker_id FROM task_attempts WHERE id = ?", attemptId)?.worker_id ?? "") : ""; if (workerId && attemptId) options.coordinator.cancel(workerId, taskId, attemptId); return writeJson(response, 202, cancelled), true; }
        if (method === "POST" && parts[4] === "retry") { const input = await bodyJson(request); const idempotencyKey = request.headers["idempotency-key"]?.toString(); if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY"); const retried = options.tasks.retryWithOptions(taskId, { expectedRunId: typeof input.expected_run_id === "string" ? input.expected_run_id : undefined, expectedRevision: typeof input.expected_task_revision === "number" ? input.expected_task_revision : undefined, idempotencyKey }, Date.now()); if (!retried) throw new Error("TASK_NOT_FOUND"); return writeJson(response, 202, retried), true; }
        if (method === "GET" && parts[4] === "results") { const detail = options.tasks.detail(taskId); if (!detail) throw new Error("TASK_NOT_FOUND"); const runId = q.get("run_id") ?? detail.currentRunId; const run = (detail.runs as Row[]).find((item) => item.id === runId); const stored = run?.result && typeof run.result === "object" ? run.result as Row : null; const result = stored && Object.prototype.hasOwnProperty.call(stored, "result") ? stored.result : run?.result ?? null; const resultManifest = stored?.resultManifest ?? null; const artifacts: Row[] = (detail.artifacts as Row[]).filter((item) => item.direction === "OUTPUT" && (!runId || item.runId === runId)).map((item) => ({ ...item, previewUrl: `/api/v2/artifacts/${encodeURIComponent(String(item.id))}/preview`, downloadUrl: `/api/v2/artifacts/${encodeURIComponent(String(item.id))}/download` })); return writeJson(response, 200, { state: run?.result ? "AVAILABLE" : run ? "PENDING" : "NOT_APPLICABLE", runId, result, metrics: stored?.metrics ?? null, resultManifest, manifest: { artifacts, availability: artifacts.every((item) => item.availability === "AVAILABLE") ? "AVAILABLE" : "PARTIAL" }, artifacts }), true; }
        if (method === "POST" && parts[4] === "delivery" && parts[5] === "retry") { if (!options.callback) throw new Error("DELIVERY_RETRY_UNAVAILABLE"); const input = await bodyJson(request); const idempotencyKey = request.headers["idempotency-key"]?.toString(); if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY"); const eventId = String(input.event_id ?? ""); const scope = `delivery-retry:${taskId}`; const requestHash = safeHash({ eventId }); const prior = options.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey); if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return writeJson(response, Number(prior.status_code), JSON.parse(String(prior.response_json))), true; } const retried = options.callback.retryDelivery(taskId, eventId); options.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 202, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(retried), Date.now()); return writeJson(response, 202, retried), true; }
        if (method === "POST" && parts[4] === "delivery" && parts[5] === "receipts") { if (!options.callback) throw new Error("DELIVERY_RETRY_UNAVAILABLE"); const receipt = await bodyJson(request); return writeJson(response, 200, options.callback.setReceipt(taskId, String(receipt.event_id ?? ""), receipt)), true; }
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
        if (method === "POST" && parts[4] === "onboarding") { if (!options.onboarding) throw new Error("ONBOARDING_UNAVAILABLE"); return writeJson(response, 201, options.onboarding.createForWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "diagnostics") {
          const key = request.headers["idempotency-key"]?.toString(); if (!key) throw new Error("MISSING_IDEMPOTENCY_KEY"); const input = await bodyJson(request); const requestHash = safeHash(input); const scope = `worker:${workerId}:diagnostics`; const prior = options.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, key); if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return writeJson(response, Number(prior.status_code), json(prior.response_json)), true; }
          const kind = String(input.kind ?? ""); if (!["MODEL", "CODEX"].includes(kind)) throw new Error("INVALID_DIAGNOSTIC_KIND"); const workspaceId = input.workspace_id === undefined ? undefined : String(input.workspace_id); if (kind === "CODEX" && workspaceId && !options.db.one("SELECT workspace_id FROM worker_workspaces WHERE worker_id = ? AND workspace_id = ?", workerId, workspaceId)) throw new Error("WORKSPACE_MISSING");
          const created = options.tasks.create({ source: "control-plane", title: `${kind === "MODEL" ? "模型" : "Codex"} 診斷`, taskType: kind === "MODEL" ? "llm.inference" : "codex", purpose: "WORKER_TEST", instruction: kind === "MODEL" ? "回覆 OK，這是唯讀模型連線診斷。" : "只讀檢查指定 workspace 是否可讀，回覆專案摘要；不得修改檔案或執行專案測試。", context: { diagnostic: true, kind }, payload: { target: (input.target ?? null) as any }, execution: { capabilities: [kind === "MODEL" ? "llm.inference" : "codex"], workerId, runtime: kind === "MODEL" ? "auto" : "auto", ...(workspaceId ? { workspaceId } : {}), resources: {} }, limits: { timeoutSeconds: 120, maxAttempts: 1 }, priority: "normal", inputArtifactIds: [] }, Date.now());
          const result = { taskId: created.id, status: created.status, kind, workerId }; options.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 202, ?, ?)", scope, key, requestHash, JSON.stringify(result), Date.now()); return writeJson(response, 202, result), true;
        }
        if (method === "PATCH" && parts[4] === "preferences") {
          const key = request.headers["idempotency-key"]?.toString(); if (!key) throw new Error("MISSING_IDEMPOTENCY_KEY"); const match = request.headers["if-match"]?.toString().match(/worker-preferences-(\d+)/); if (!match) throw new Error("MISSING_IF_MATCH"); const input = await bodyJson(request); const requestHash = safeHash(input); const scope = `worker:${workerId}:preferences`; const prior = options.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, key); if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return writeJson(response, Number(prior.status_code), json(prior.response_json)), true; }
          const preference = options.workers.updatePreferences(workerId, { mode: input.mode as "NORMAL" | "IDLE_ONLY" | undefined, idleThresholdSeconds: input.idle_threshold_seconds === null ? null : input.idle_threshold_seconds === undefined ? undefined : Number(input.idle_threshold_seconds), pause: input.pause as { kind: "NONE" | "TIMED" | "INDEFINITE"; durationSeconds?: number } | undefined }, Number(match[1])); const result = { desired: preference, applied: { state: "PENDING", preferencesVersion: preference.version } }; options.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at) VALUES (?, ?, ?, 200, ?, ?)", scope, key, requestHash, JSON.stringify(result), Date.now()); return writeJson(response, 200, result), true;
        }
        if (method === "PATCH" && parts.length === 4) { const input = await bodyJson(request); options.workers.rename(workerId, String(input.name ?? ""), actor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "enable") { options.workers.setEnabled(workerId, true, actor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "disable") { options.workers.setEnabled(workerId, false, actor(request)); options.coordinator.closeWorker(workerId, 4005, "worker disabled"); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "drain") { options.workers.setDrain(workerId, true, actor(request)); options.workers.updatePreferences(workerId, { pause: { kind: "INDEFINITE" } }); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "resume") { options.workers.setDrain(workerId, false, actor(request)); options.workers.updatePreferences(workerId, { pause: { kind: "NONE" } }); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "capabilities" && parts[6] === "grant") { options.workers.grantCapability(workerId, parts[5], stepUpActor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "POST" && parts[4] === "capabilities" && parts[6] === "revoke") { options.workers.revokeCapability(workerId, parts[5], stepUpActor(request)); return writeJson(response, 200, options.workers.getWorker(workerId)), true; }
        if (method === "DELETE" && parts.length === 4) { const removed = options.workers.remove(workerId, stepUpActor(request)); options.coordinator.closeWorker(workerId); return writeJson(response, 200, removed), true; }
      }
      if (parts[2] === "worker" && parts[3] === "registration") {
        if (method === "POST" && parts.length === 4) { const input = parseRegistrationInput(await bodyJson(request)); if (options.settings.get().registration_enabled === false) throw new Error("REGISTRATION_DISABLED"); return writeJson(response, 202, options.workers.register(input)), true; }
        const registrationId = parts[4]; const secret = request.headers["x-registration-secret"]?.toString() ?? ""; if (method === "GET" && registrationId) return writeJson(response, 200, options.workers.pollRegistration(registrationId, secret)), true;
      }
      if (parts[2] === "models" && method === "GET") { let items = options.workers.listModels(q.get("present") === "false"); const search = q.get("search")?.trim().toLowerCase(); if (search) items = items.filter((item) => [item.worker, item.runtime, item.model, item.displayName].some((value) => String(value ?? "").toLowerCase().includes(search))); if (q.get("worker_id")) items = items.filter((item) => item.workerId === q.get("worker_id")); if (q.get("runtime")) items = items.filter((item) => item.runtime === q.get("runtime")); if (q.get("dispatchable") === "true") items = items.filter((item) => item.dispatchable === true); return writeJson(response, 200, { items, observedAt: new Date().toISOString() }), true; }
      if (parts[2] === "model-test-templates" && method === "GET") { if (!options.modelTests) throw new Error("MODEL_TEST_UNAVAILABLE"); return writeJson(response, 200, { items: options.modelTests.listTemplates(), observedAt: new Date().toISOString() }), true; }
      if (parts[2] === "model-tests" && options.modelTests) {
        if (method === "POST" && parts.length === 3) return writeJson(response, 202, options.modelTests.create(await bodyJson(request), request.headers["idempotency-key"]?.toString())), true;
        const testId = parts[3]; if (!testId) throw new Error("MODEL_TEST_NOT_FOUND"); if (method === "GET" && parts.length === 4) { const result = options.modelTests.get(testId); if (!result) throw new Error("MODEL_TEST_NOT_FOUND"); return writeJson(response, 200, result), true; } if (method === "POST" && parts[4] === "cancel") return writeJson(response, 202, options.modelTests.cancel(testId) ?? (() => { throw new Error("MODEL_TEST_NOT_FOUND"); })()), true;
      }
      if (parts[2] === "model-preferences" && options.modelPreferences) {
        if (method === "GET" && parts.length === 3) return writeJson(response, 200, { items: options.modelPreferences.list() }), true;
        if (method === "POST" && parts.length === 3) return writeJson(response, 201, options.modelPreferences.create(await bodyJson(request), request.headers["idempotency-key"]?.toString())), true;
        const preferenceId = parts[3]; if (!preferenceId) throw new Error("PREFERENCE_NOT_FOUND"); const match = request.headers["if-match"]?.toString().match(/preference-(\d+)/); if ((method === "PATCH" || method === "DELETE") && !match) throw new Error("MISSING_IF_MATCH"); if (method === "PATCH") return writeJson(response, 200, options.modelPreferences.update(preferenceId, await bodyJson(request), Number(match![1]))), true; if (method === "DELETE") return writeJson(response, 200, options.modelPreferences.remove(preferenceId, Number(match![1]))), true;
      }
      if (parts[2] === "worker-onboarding" && options.onboarding) {
        if (method === "POST" && parts.length === 3) { const input = await bodyJson(request); return writeJson(response, 201, options.onboarding.create(String(input.platform ?? ""), Array.isArray(input.selected_capabilities) ? input.selected_capabilities : [])), true; }
        const onboardingId = parts[3]; if (!onboardingId) throw new Error("ONBOARDING_NOT_FOUND"); if (method === "GET") { const result = options.onboarding.get(onboardingId); if (!result) throw new Error("ONBOARDING_NOT_FOUND"); return writeJson(response, 200, result), true; } if (method === "PATCH") return writeJson(response, 200, options.onboarding.update(onboardingId, await bodyJson(request))), true;
      }
      if (parts[2] === "worker-installer" && method === "GET" && options.onboarding) return writeJson(response, 200, options.onboarding.installer(String(q.get("platform") ?? ""), q.get("onboarding_id"))), true;
      if (parts[2] === "systems" && method === "GET") { const values = options.settings.get(); const items = options.health.list(Boolean(options.isReady?.() ?? true)).map((item) => item.id === "hermes" ? { ...item, entryUrl: values.hermes_entry_url ?? item.entryUrl } : item.id === "contexthub" ? { ...item, entryUrl: values.contexthub_entry_url ?? item.entryUrl } : item); return writeJson(response, 200, { items }), true; }
      if (parts[2] === "settings") {
        if (method === "GET" && parts[3] === "effective") { const effective = options.settings.getEffective(); response.setHeader("etag", `\"settings-${effective.version}\"`); return writeJson(response, 200, effective), true; }
        if (method === "GET" && parts.length === 3) return writeJson(response, 200, options.settings.get()), true;
        if (method === "PATCH" && parts.length === 3) { const expected = request.headers["if-match"]?.toString().match(/settings-(\d+)/)?.[1]; const patched = options.settings.patch(await bodyJson(request), Date.now(), expected === undefined ? undefined : Number(expected)) as Row; response.setHeader("etag", `\"settings-${patched.version}\"`); return writeJson(response, 200, { ...(patched.values as Row), ...patched }), true; }
      }
      if (parts[2] === "dashboard" && method === "GET") {
        const since = Date.now() - 86_400_000;
        const recent = options.tasks.listPage({ purpose: "USER", sort: "created_desc", limit: 6 });
        const latest = options.tasks.listPage({ purpose: "USER", sort: "finished_desc", limit: 6 });
        const active = options.tasks.summary({ status: "QUEUED,ASSIGNED,RUNNING", purpose: "USER" });
        const attention = options.db.all<Row>("SELECT task_id AS taskId, primary_reason AS primaryReason, blocked_since AS blockedSince, evaluated_at AS evaluatedAt FROM task_dispatch_state WHERE blocked_since IS NOT NULL AND blocked_since <= ? ORDER BY blocked_since LIMIT 50", since);
        const values = options.settings.get(); const systems = options.health.list(Boolean(options.isReady?.() ?? true)).map((item) => item.id === "hermes" ? { ...item, entryUrl: values.hermes_entry_url ?? item.entryUrl } : item.id === "contexthub" ? { ...item, entryUrl: values.contexthub_entry_url ?? item.entryUrl } : item); return writeJson(response, 200, { attention: { items: attention, observedAt: new Date().toISOString() }, running: { items: (active.countsByStatus as Row).RUNNING ?? 0, observedAt: active.observedAt }, latestResults: { items: latest.items, observedAt: latest.observedAt }, recentTasks: { items: recent.items, observedAt: recent.observedAt }, summary24h: { ...options.tasks.summary({ purpose: "USER", createdFrom: since }), observedAt: new Date().toISOString() }, systems: { items: systems, observedAt: new Date().toISOString() } }), true;
      }
      if (parts[2] === "artifacts" && parts[3]) {
        const artifact = options.db.one<Row>("SELECT * FROM artifacts WHERE id = ?", parts[3]); if (!artifact) throw new Error("ARTIFACT_NOT_FOUND");
        if (parts[4] === "preview" && method === "GET") { if (["EXPIRED", "PURGING"].includes(String(artifact.storage_state ?? "AVAILABLE"))) throw new Error("ARTIFACT_EXPIRED"); if (!options.artifacts.exists(artifact.storage_path)) throw new Error("ARTIFACT_MISSING"); const mediaType = String(artifact.media_type ?? ""); if (!(mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("markdown") || mediaType.includes("diff"))) throw new Error("PREVIEW_UNSUPPORTED"); const bytes = options.artifacts.read(artifact.storage_path); const limit = 256 * 1024; const text = bytes.subarray(0, limit).toString("utf8"); return writeJson(response, 200, { id: artifact.id, text, truncated: bytes.byteLength > limit, downloadUrl: `/api/v2/artifacts/${encodeURIComponent(String(artifact.id))}/download` }), true; }
        if (parts[4] === "download" && method === "GET") { if (String(artifact.storage_state ?? "AVAILABLE") === "EXPIRED") throw new Error("ARTIFACT_EXPIRED"); if (!options.artifacts.exists(artifact.storage_path)) throw new Error("ARTIFACT_MISSING"); response.writeHead(200, { "content-type": artifact.media_type ?? "application/octet-stream", "content-length": artifact.size_bytes, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(String(artifact.display_filename ?? artifact.filename))}` }); options.artifacts.stream(artifact.storage_path).pipe(response); return true; }
        if (method === "GET" && parts.length === 4) return writeJson(response, 200, { id: artifact.id, filename: artifact.display_filename ?? artifact.filename, mediaType: artifact.media_type, sizeBytes: artifact.size_bytes, sha256: artifact.sha256, previewKind: artifact.preview_kind ?? null, availability: artifact.storage_state ?? "AVAILABLE", downloadUrl: `/api/v2/artifacts/${encodeURIComponent(String(artifact.id))}/download` }), true;
      }
      if (parts[2] === "worker" && parts[3] === "tasks" && parts[5] === "artifacts") {
        const worker = authWorker(request, options.workers); const taskId = parts[4]; const taskRow = options.db.one<Row>("SELECT t.id FROM tasks t JOIN task_attempts a ON a.task_id = t.id WHERE t.id = ? AND a.worker_id = ?", taskId, worker.id); if (!taskRow) throw new Error("ARTIFACT_NOT_FOUND");
        if (method === "POST") { const attemptHeader = request.headers["x-attempt-id"]?.toString(); const runHeader = request.headers["x-run-id"]?.toString(); const attempt = options.db.one<Row>("SELECT * FROM task_attempts WHERE task_id = ? AND worker_id = ? AND (? IS NULL OR id = ?) AND (? IS NULL OR run_id = ?)", taskId, worker.id, attemptHeader ?? null, attemptHeader ?? null, runHeader ?? null, runHeader ?? null); if (!attempt) throw new Error("ARTIFACT_NOT_FOUND"); const artifactKey = request.headers["x-artifact-key"]?.toString() || null; const bytes = await body(request, Number(process.env.PAI_MAX_ARTIFACT_BYTES ?? 1_073_741_824)); const incomingDigest = ArtifactStorage.digest(bytes); if (artifactKey) { const prior = options.db.one<Row>("SELECT * FROM artifacts WHERE task_id = ? AND artifact_key = ? AND attempt_id = ?", taskId, artifactKey, attempt.id); if (prior) { if (String(prior.sha256) !== incomingDigest) throw new Error("ARTIFACT_CONTENT_CONFLICT"); return writeJson(response, 200, { id: prior.id, artifactKey: prior.artifact_key, filename: prior.display_filename ?? prior.filename, mediaType: prior.media_type, sizeBytes: prior.size_bytes, sha256: prior.sha256, availability: prior.storage_state ?? "AVAILABLE" }), true; } } const filename = basename(request.headers["x-artifact-filename"]?.toString() ?? "artifact.bin"); const mediaTypeRaw = request.headers["content-type"]?.toString() ?? "application/octet-stream"; const mediaType = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9=._ -]+)*$/.test(mediaTypeRaw) ? mediaTypeRaw.slice(0, 160) : "application/octet-stream"; const stored = options.artifacts.write(taskId, filename, mediaType, bytes); const previewKind = mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("markdown") || mediaType.includes("diff") ? "TEXT" : null; options.db.run("INSERT INTO artifacts(id, task_id, attempt_id, filename, media_type, size_bytes, sha256, storage_path, created_at, display_filename, artifact_key, preview_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", stored.id, taskId, attempt.id, stored.filename, stored.mediaType, stored.sizeBytes, stored.sha256, stored.storagePath, Date.now(), filename.slice(0, 240), artifactKey, previewKind); options.db.run("INSERT INTO task_artifacts(task_id, artifact_id, direction) VALUES (?, ?, 'OUTPUT')", taskId, stored.id); return writeJson(response, 201, { id: stored.id, artifactKey, filename: filename.slice(0, 240), mediaType: stored.mediaType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, availability: "AVAILABLE" }), true; }
      }
      if (parts[2] === "worker" && parts[3] === "artifacts" && method === "GET") { const worker = authWorker(request, options.workers); const artifactId = parts[4]; const row = options.db.one<Row>("SELECT a.* FROM artifacts a JOIN task_artifacts ta ON ta.artifact_id = a.id JOIN task_attempts at ON at.task_id = ta.task_id WHERE a.id = ? AND at.worker_id = ?", artifactId, worker.id); if (!row || !options.artifacts.exists(row.storage_path)) throw new Error("ARTIFACT_NOT_FOUND"); response.writeHead(200, { "content-type": row.media_type ?? "application/octet-stream", "content-length": row.size_bytes, "content-disposition": `attachment; filename="${basename(row.filename)}"` }); options.artifacts.stream(row.storage_path).pipe(response); return true; }
      return writeJson(response, 404, errorBody("NOT_FOUND", "API route not found")), true;
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : "INTERNAL_ERROR";
      const code = rawCode.startsWith("UNKNOWN_FIELD:") ? "UNKNOWN_FIELD" : rawCode.startsWith("INVALID_FIELD:") ? "INVALID_FIELD" : rawCode;
      const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : undefined;
      const status = code === "TASK_NOT_FOUND" || code === "WORKER_NOT_FOUND" || code === "REGISTRATION_NOT_FOUND" || code === "ARTIFACT_NOT_FOUND" || code === "CAPABILITY_NOT_FOUND" || code === "PREFERENCE_NOT_FOUND" || code === "ONBOARDING_NOT_FOUND" || code === "MODEL_TEST_NOT_FOUND" || code === "DELIVERY_NOT_FOUND" || code === "OFFICE_NOT_FOUND" || code === "ROLE_NOT_FOUND" || code === "MISSION_NOT_FOUND" || code === "COMMAND_NOT_FOUND" || code === "OPERATION_NOT_FOUND" ? 404 : code === "INVALID_WORKER_TOKEN" ? 401 : code === "REGISTRATION_DISABLED" || code === "STEP_UP_REQUIRED" || code === "INTERNAL_ROUTE_FORBIDDEN" ? 403 : ["INVALID_TASK_STATE", "INVALID_REGISTRATION_STATE", "WORKER_BUSY", "REGISTRATION_ALREADY_FINALIZED", "IDEMPOTENCY_CONFLICT", "TASK_CHANGED", "CURSOR_STALE", "SETTING_OVERRIDDEN", "WORKER_PREFERENCES_CHANGED", "SETTINGS_CHANGED", "PREFERENCE_CHANGED", "INPUT_ARTIFACT_EXPIRED", "RECEIPT_CONFLICT", "TEMPLATE_CHANGED", "WORKSPACE_MISSING", "ARTIFACT_CONTENT_CONFLICT", "RESULT_ARTIFACT_NOT_READY", "ARTIFACT_MISSING", "REVISION_CONFLICT", "PLAN_ALREADY_COMMITTED", "RESULT_CONFLICT", "SEAT_ALREADY_ASSIGNED", "ADMISSION_DEFERRED", "STALE_EXECUTION", "STALE_DECISION", "LIMIT_WAIT_OWNER", "FINALIZATION_INCOMPLETE", "RECOVERY_RECONCILIATION_REQUIRED", "RECOVERY_MODE", "COMMAND_RETRY_NOT_AVAILABLE", "MISSION_TERMINAL", "MISSION_NOT_TERMINAL", "SIDE_EFFECT_IN_PROGRESS", "OPERATION_NOT_IMPLEMENTED"].includes(code) || code.startsWith("OPERATION_UNAVAILABLE:") ? 409 : ["TASK_ARCHIVED", "ARTIFACT_EXPIRED", "OFFICE_DISABLED", "BRAIN_V2_DISABLED"].includes(code) ? ["OFFICE_DISABLED", "BRAIN_V2_DISABLED"].includes(code) ? 503 : 410 : code === "PREVIEW_UNSUPPORTED" ? 415 : code === "REQUEST_TOO_LARGE" ? 413 : code === "TARGET_UNKNOWN" || code === "TEST_PARAMETER_UNSUPPORTED" ? 422 : code.startsWith("INVALID_") || code.startsWith("UNKNOWN_") || code === "REGISTRATION_SECRET_TOO_SHORT" || code === "INVALID_JSON_BODY" || code === "MISSING_IDEMPOTENCY_KEY" || code === "INVALID_COMMAND_FAILURE" || code.startsWith("MISSING_OPERATION_PARAMETER") || code === "MISSING_SOURCE_INTENT_KEY" || code === "REVISION_REQUIRED" || code === "BRAIN_V2_REQUIRED" || code.includes("must be") || code === "WORKSPACE_CONFLICT" || code === "INVALID_COMMAND" ? 400 : 500;
      return writeJson(response, status, { ...errorBody(code, code, details), requestId: requestId(request) }), true;
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
