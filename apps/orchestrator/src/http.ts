import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPublicKey, randomBytes, randomUUID } from "node:crypto";
import { parseGoalCreateInput } from "../../../packages/contracts/src/index.ts";
import { canonicalJson, sha256, uuidv7 } from "../../../packages/crypto/src/index.ts";
import { CounterRegistry } from "../../../packages/observability/src/index.ts";
import { publicKeyFingerprint, type WorkerEnvelope } from "../../../packages/worker/src/index.ts";
import { ArchiveService } from "../../archive/src/service.ts";
import { OrchestratorDatabase } from "./db.ts";
import { ApprovalService } from "./approval-service.ts";
import { ScheduleService } from "./schedule-service.ts";
import { TaskEngine } from "./task-engine.ts";
import { WorkerChannelService } from "./worker-channel.ts";
import { attachWorkerWebSocket } from "./worker-websocket.ts";
import type { AuditHealth } from "./audit-monitor.ts";

const MAX_BODY_BYTES = 1_048_576;

type AppOptions = {
  db: OrchestratorDatabase;
  engine: TaskEngine;
  allowUnauthenticated: boolean;
  identityReady?: boolean;
  identityReadyProbe?: () => Promise<boolean>;
  runtimeReady?: boolean | (() => boolean);
  runtimeRequired?: boolean;
  metrics?: CounterRegistry;
  approvalService?: ApprovalService;
  scheduleService?: ScheduleService;
  archiveService?: ArchiveService;
  workerChannel?: WorkerChannelService;
  auditHealth?: () => AuditHealth;
};

type AppError = Error & { code?: string; retryable?: boolean; status?: number };

function requestId(req: IncomingMessage): string {
  const supplied = req.headers["x-request-id"];
  return typeof supplied === "string" && supplied.length <= 200 ? supplied : randomUUID();
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(serialized);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("request body is too large") as AppError;
      error.code = "REQUEST_TOO_LARGE";
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("request body must be valid JSON") as AppError;
    error.code = "INVALID_JSON";
    error.status = 400;
    throw error;
  }
}

function pathParts(url: string | undefined): string[] {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  return pathname.split("/").filter(Boolean);
}

function query(url: string | undefined): URLSearchParams {
  return new URL(url ?? "/", "http://localhost").searchParams;
}

function idempotencyKey(req: IncomingMessage): string {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    const error = new Error("Idempotency-Key is required") as AppError;
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    error.status = 400;
    throw error;
  }
  return value;
}

function ownerId(req: IncomingMessage, allowUnauthenticated: boolean): string {
  if (allowUnauthenticated) {
    const supplied = req.headers["x-pai-dev-owner-id"];
    return typeof supplied === "string" && supplied.length > 0 && supplied.length <= 200 ? supplied : "local-owner";
  }
  const marker = req.headers["x-pai-verified"];
  const owner = req.headers["x-pai-owner-id"];
  const session = req.headers["x-pai-session-id"];
  const authTime = req.headers["x-pai-auth-time"];
  if (marker !== "1" || typeof owner !== "string" || owner.length === 0 || owner.length > 200 || typeof session !== "string" || session.length === 0 || typeof authTime !== "string" || !Number.isFinite(Number(authTime))) {
    const error = new Error("authenticated Identity Gateway session required") as AppError;
    error.code = "AUTH_REQUIRED";
    error.status = 401;
    throw error;
  }
  return owner;
}

function requireFreshStepUp(req: IncomingMessage, maxAgeMs = 5 * 60_000): number {
  const value = req.headers["x-pai-auth-time"];
  const authTime = typeof value === "string" ? Number(value) : Number.NaN;
  const now = Date.now();
  if (!Number.isFinite(authTime) || authTime > now || now - authTime > maxAgeMs) {
    const error = new Error("fresh Passkey step-up is required") as AppError;
    error.code = "STEP_UP_REQUIRED";
    error.status = 403;
    throw error;
  }
  return authTime;
}

function publicTask(db: OrchestratorDatabase, row: Record<string, unknown>): Record<string, unknown> {
  const taskId = String(row.id);
  return {
    id: row.id,
    goalId: row.goal_id,
    planRevision: row.plan_revision,
    type: row.type,
    title: row.title,
    state: row.state,
    priority: row.priority,
    required: Boolean(row.required),
    sideEffectClass: row.side_effect_class,
    definition: JSON.parse(String(row.definition_json ?? "{}")),
    capabilityRequirements: JSON.parse(String(row.capability_requirements_json ?? "[]")),
    budget: JSON.parse(String(row.budget_json ?? "{}")),
    sandbox: JSON.parse(String(row.sandbox_json ?? "{}")),
    verification: JSON.parse(String(row.verification_json ?? "{}")),
    stateVersion: row.state_version,
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    error: row.error_json ? JSON.parse(String(row.error_json)) : null,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    dependencies: db.all("SELECT from_task_id AS taskId FROM task_edges WHERE to_task_id = ? ORDER BY from_task_id", taskId).map((item) => item.taskId),
    attempts: db.all("SELECT id, generation, worker_id AS workerId, provider_id AS providerId, state, lease_id AS leaseId, fencing_token AS fencingToken, checkpoint_id AS checkpointId, external_operation_id AS externalOperationId, usage_json AS usage, result_class AS resultClass, started_at AS startedAt, ended_at AS endedAt FROM attempts WHERE task_id = ? ORDER BY generation", taskId).map((item) => ({ ...item, usage: JSON.parse(String(item.usage)) })),
    checkpoints: db.all("SELECT id, attempt_id AS attemptId, schema_version AS schemaVersion, artifact_hash AS artifactHash, portable, provider_kind AS providerKind, next_action AS nextAction, created_at AS createdAt FROM checkpoints WHERE task_id = ? ORDER BY created_at", taskId).map((item) => ({ ...item, portable: Boolean(item.portable) })),
    reconciliation: db.all("SELECT id, attempt_id AS attemptId, provider, operation_kind AS operationKind, external_operation_id AS externalOperationId, last_observed_state AS lastObservedState, status, last_observed_at AS lastObservedAt, resolved_at AS resolvedAt FROM reconciliation_records WHERE task_id = ? ORDER BY started_at", taskId),
  };
}

function publicEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: row.task_id,
    sequence: row.sequence,
    type: row.type,
    previousState: row.previous_state,
    newState: row.new_state,
    actor: row.actor,
    attemptId: row.attempt_id,
    planDigest: row.plan_digest,
    policyVersion: row.policy_version,
    payload: JSON.parse(String(row.payload_json ?? "{}")),
    occurredAt: new Date(Number(row.occurred_at)).toISOString(),
  };
}

async function health(options: AppOptions, kind: "live" | "ready" | "ops"): Promise<Record<string, unknown>> {
  if (kind === "live") return { status: "ok" };
  const dbCheck = options.db.one<{ value: number }>("SELECT 1 AS value");
  const migration = options.db.one<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
  const audit = options.auditHealth?.() ?? { ok: options.engine.verifyAuditChain(), verifiedAt: Date.now(), eventCount: Number(options.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM audit_events")?.count ?? 0), durationMs: null };
  const identityReady = await resolveIdentityReady(options);
  const runtimeReady = typeof options.runtimeReady === "function" ? options.runtimeReady() : options.runtimeReady !== false;
  const runtimeRequired = options.runtimeRequired !== false;
  const ready = dbCheck?.value === 1 && migration?.version === 7 && audit.ok && identityReady && (!runtimeRequired || runtimeReady);
  if (kind === "ready") return { status: ready ? "ok" : "not_ready", database: dbCheck?.value === 1 ? "ok" : "error", auditChain: audit.ok ? "ok" : "error", auditVerifiedAt: audit.verifiedAt, auditEventCount: audit.eventCount, auditVerificationDurationMs: audit.durationMs, identity: identityReady ? "ok" : "not_ready", runtime: runtimeReady ? "ok" : runtimeRequired ? "not_ready" : "not_required", schemaVersion: migration?.version ?? null };
  return {
    status: ready ? "ok" : "degraded",
    evidenceLevel: "implemented_local",
    database: dbCheck?.value === 1 ? "ok" : "error",
    auditChain: audit.ok ? "ok" : "error",
    auditVerifiedAt: audit.verifiedAt,
    auditEventCount: audit.eventCount,
    auditVerificationDurationMs: audit.durationMs,
    identity: identityReady ? "ok" : "not_ready",
    runtime: runtimeReady ? "ok" : runtimeRequired ? "not_ready" : "not_required",
    schemaVersion: migration?.version ?? null,
    authMode: options.allowUnauthenticated ? "development" : "identity-gateway",
    providers: "not_configured",
    workers: "not_configured",
    backupRestore: "not_verified",
  };
}

async function resolveIdentityReady(options: AppOptions): Promise<boolean> {
  if (options.allowUnauthenticated || options.identityReady === true) return true;
  if (!options.identityReadyProbe) return false;
  try { return await options.identityReadyProbe(); } catch { return false; }
}

export function createHttpServer(options: AppOptions) {
  const metrics = options.metrics ?? new CounterRegistry();
  const approvals = options.approvalService ?? new ApprovalService(options.db);
  const schedules = options.scheduleService ?? new ScheduleService(options.db);
  const workerChannel = options.workerChannel ?? new WorkerChannelService(options.db);
  const server = createServer(async (req, response) => {
    const id = requestId(req);
    response.setHeader("x-request-id", id);
    try {
      const parts = pathParts(req.url);
      const method = req.method ?? "GET";
      metrics.increment("pai_http_requests_total", { method });
      if (method === "GET" && parts.length === 2 && parts[0] === "health") {
        const kind = parts[1] as "live" | "ready" | "ops";
        if (!["live", "ready", "ops"].includes(kind)) throw Object.assign(new Error("not found"), { status: 404, code: "NOT_FOUND" });
        const body = await health(options, kind);
        writeJson(response, kind === "ready" && body.status !== "ok" ? 503 : 200, body);
        return;
      }
      if (method === "GET" && parts.length === 1 && parts[0] === "health") {
        writeJson(response, 200, await health(options, "ready"));
        return;
      }
      if (method === "GET" && parts.length === 1 && parts[0] === "metrics") {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
        response.end(metrics.prometheus());
        return;
      }
      if (parts[0] !== "api" || parts[1] !== "v1") throw Object.assign(new Error("not found"), { status: 404, code: "NOT_FOUND" });

      // Worker routes authenticate with a device credential and proof-of-possession.
      // They intentionally do not call ownerId(), so browser cookies/CSRF headers cannot
      // be used as a substitute for the registered device key.
      if (parts[2] === "worker") {
        if (method === "POST" && parts.length === 4 && parts[3] === "enrollment-requests") {
          const input = await readJson(req) as Record<string, unknown>;
          if (typeof input.publicKeyPem !== "string" || input.publicKeyPem.length > 20_000 || !input.deviceSummary || typeof input.deviceSummary !== "object" || Array.isArray(input.deviceSummary)) throw Object.assign(new Error("worker enrollment request is invalid"), { status: 400, code: "INVALID_ENROLLMENT_REQUEST" });
          let key;
          try { key = createPublicKey(input.publicKeyPem); } catch { throw Object.assign(new Error("worker public key is invalid"), { status: 400, code: "INVALID_ENROLLMENT_KEY" }); }
          const now = Date.now();
          const requestId = uuidv7(now);
          const challenge = randomBytes(32).toString("base64url");
          const expiresAt = now + 10 * 60_000;
          options.db.run("INSERT INTO worker_enrollment_requests(id, public_key_pem, fingerprint, device_summary_json, challenge_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)", requestId, input.publicKeyPem, publicKeyFingerprint(key), JSON.stringify(input.deviceSummary), sha256(challenge), expiresAt, now);
          writeJson(response, 202, { requestId, fingerprint: publicKeyFingerprint(key), status: "PENDING", challenge, expiresAt, approvalUrl: `/workers/enrollment-requests/${requestId}` });
          return;
        }
        if (method === "GET" && parts.length === 6 && parts[3] === "enrollment-requests" && parts[5] === "status") {
          const row = options.db.one<{ id: string; fingerprint: string; status: string; expires_at: number; finalized_worker_id: string | null }>("SELECT id, fingerprint, status, expires_at, finalized_worker_id FROM worker_enrollment_requests WHERE id = ?", parts[4]);
          if (!row) throw Object.assign(new Error("worker enrollment request not found"), { status: 404, code: "ENROLLMENT_NOT_FOUND" });
          const status = row.status === "PENDING" && row.expires_at <= Date.now() ? "EXPIRED" : row.status;
          if (status === "EXPIRED") options.db.run("UPDATE worker_enrollment_requests SET status = 'EXPIRED' WHERE id = ? AND status = 'PENDING'", parts[4]);
          writeJson(response, 200, { requestId: row.id, fingerprint: row.fingerprint, status, expiresAt: row.expires_at, finalized: Boolean(row.finalized_worker_id), serverNonce: status === "APPROVED" && !row.finalized_worker_id ? randomBytes(32).toString("base64url") : null });
          return;
        }
        if (method === "POST" && parts.length === 6 && parts[3] === "enrollment-requests" && parts[5] === "finalize") {
          const input = await readJson(req) as Record<string, unknown>;
          if (typeof input.challenge !== "string" || typeof input.serverNonce !== "string" || typeof input.workerSignature !== "string") throw Object.assign(new Error("worker enrollment proof is incomplete"), { status: 400, code: "INVALID_ENROLLMENT_PROOF" });
          const finalized = workerChannel.finalizeEnrollment({ requestId: parts[4], challenge: input.challenge, serverNonce: input.serverNonce, workerSignature: input.workerSignature });
          writeJson(response, 201, { workerId: finalized.workerId, credentialId: finalized.credentialId, credential: finalized.credential, expiresAt: finalized.expiresAt, fingerprint: finalized.fingerprint });
          return;
        }
        if (method === "POST" && parts.length === 4 && parts[3] === "poll") {
          const input = await readJson(req) as Record<string, unknown>;
          if (typeof input.workerId !== "string" || typeof input.credential !== "string" || typeof input.connectionId !== "string") throw Object.assign(new Error("worker poll identity is incomplete"), { status: 400, code: "INVALID_WORKER_POLL" });
          const result = workerChannel.poll({ workerId: input.workerId, credential: input.credential, connectionId: input.connectionId, hello: input.hello as never });
          writeJson(response, 200, result);
          return;
        }
        if (method === "POST" && parts.length === 4 && parts[3] === "events") {
          const input = await readJson(req) as Record<string, unknown>;
          if (typeof input.workerId !== "string" || typeof input.credential !== "string" || !input.frame || typeof input.frame !== "object") throw Object.assign(new Error("worker event identity is incomplete"), { status: 400, code: "INVALID_WORKER_EVENT" });
          workerChannel.receive(input.workerId, input.credential, input.frame as WorkerEnvelope);
          writeJson(response, 202, { accepted: true });
          return;
        }
        if (method === "POST" && parts.length === 5 && parts[3] === "credentials" && parts[4] === "rotate") {
          const input = await readJson(req) as Record<string, unknown>;
          if (typeof input.workerId !== "string" || typeof input.credential !== "string") throw Object.assign(new Error("worker credential rotation input is incomplete"), { status: 400, code: "INVALID_WORKER_CREDENTIAL_ROTATION" });
          const rotated = workerChannel.rotateCredential(input.workerId, input.credential);
          writeJson(response, 201, rotated);
          return;
        }
      }

      if (method === "POST" && parts.length === 3 && parts[2] === "goals") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const key = idempotencyKey(req);
        const input = parseGoalCreateInput(await readJson(req));
        const created = options.engine.createGoal(input, owner, key);
        writeJson(response, created.status, created.body, { "x-idempotent-replay": String(created.replayed) });
        return;
      }

      if (method === "GET" && parts.length === 3 && parts[2] === "goals") {
        const owner = ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.engine.listGoals(owner) });
        return;
      }

      if (parts.length >= 4 && parts[2] === "goals") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const goalId = parts[3];
        const goal = options.engine.getGoal(goalId);
        if (!goal || goal.ownerId !== owner) throw Object.assign(new Error("goal not found"), { status: 404, code: "GOAL_NOT_FOUND" });
        if (method === "GET" && parts.length === 4) {
          writeJson(response, 200, { ...goal, links: { self: `/api/v1/goals/${goalId}`, tasks: `/api/v1/goals/${goalId}/tasks`, events: `/api/v1/goals/${goalId}/events` } });
          return;
        }
        if (method === "GET" && parts.length === 5 && parts[4] === "plans") {
          writeJson(response, 200, { items: options.engine.listPlans(goalId) });
          return;
        }
        if (method === "GET" && parts.length === 5 && parts[4] === "tasks") {
          writeJson(response, 200, { items: options.engine.listTasks(goalId).map((row) => publicTask(options.db, row)) });
          return;
        }
        if (method === "GET" && parts.length === 5 && parts[4] === "events") {
          writeJson(response, 200, { items: options.engine.listGoalEvents(goalId).map(publicEvent) });
          return;
        }
        if (method === "POST" && parts.length === 5 && parts[4] === "cancel") {
          const key = idempotencyKey(req);
          const cancelled = options.engine.requestGoalCancellation(goalId, owner, key);
          if ("body" in cancelled) {
            writeJson(response, cancelled.status, cancelled.body, { "x-idempotent-replay": String(cancelled.replayed) });
          } else {
            writeJson(response, 202, cancelled, { "x-idempotent-replay": "false" });
          }
          return;
        }
        if (method === "POST" && parts.length === 5 && parts[4] === "retry") {
          const key = idempotencyKey(req);
          const retried = options.engine.retryGoal(goalId, owner, key);
          writeJson(response, retried.status, retried.body, { "x-idempotent-replay": String(retried.replayed) });
          return;
        }
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "approvals") {
        const owner = ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT r.id, r.goal_id AS goalId, r.task_id AS taskId, r.plan_digest AS planDigest, r.policy_version AS policyVersion, r.required_scope_json AS requiredScope, r.risk_json AS risk, r.status, r.expires_at AS expiresAt, r.correlation_id AS correlationId, r.created_at AS createdAt, r.decided_at AS decidedAt, r.decided_by AS decidedBy FROM approval_requests r JOIN goals g ON g.id = r.goal_id WHERE g.owner_id = ? ORDER BY r.created_at DESC LIMIT 100", owner).map((row) => ({ ...row, requiredScope: JSON.parse(String(row.requiredScope)), risk: JSON.parse(String(row.risk)) })) });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "approvals") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const row = options.db.one<Record<string, unknown>>("SELECT r.id, r.goal_id AS goalId, r.task_id AS taskId, r.plan_digest AS planDigest, r.policy_version AS policyVersion, r.required_scope_json AS requiredScope, r.risk_json AS risk, r.status, r.expires_at AS expiresAt, r.correlation_id AS correlationId, r.created_at AS createdAt, r.decided_at AS decidedAt, r.decided_by AS decidedBy, g.intent AS goalIntent, g.active_plan_revision AS activePlanRevision FROM approval_requests r JOIN goals g ON g.id = r.goal_id WHERE r.id = ? AND g.owner_id = ?", parts[3], owner);
        if (!row) throw Object.assign(new Error("approval not found"), { status: 404, code: "APPROVAL_NOT_FOUND" });
        const plans = options.db.all<Record<string, unknown>>("SELECT revision, plan_json AS plan, digest, created_at AS createdAt FROM plans WHERE goal_id = ? ORDER BY revision DESC LIMIT 2", row.goalId).map((plan) => ({ ...plan, plan: JSON.parse(String(plan.plan)) }));
        writeJson(response, 200, { ...row, requiredScope: JSON.parse(String(row.requiredScope)), risk: JSON.parse(String(row.risk)), activePlan: plans[0] ?? null, previousPlan: plans[1] ?? null });
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "approvals" && parts[4] === "decision") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const request = options.db.one<{ goal_id: string }>("SELECT r.goal_id FROM approval_requests r JOIN goals g ON g.id = r.goal_id WHERE r.id = ? AND g.owner_id = ?", parts[3], owner);
        if (!request) throw Object.assign(new Error("approval not found"), { status: 404, code: "APPROVAL_NOT_FOUND" });
        const input = await readJson(req);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("decision body must be an object"), { status: 400, code: "INVALID_DECISION" });
        if (Object.keys(input).some((key) => !["decision", "approvedBounds"].includes(key))) throw Object.assign(new Error("approval decision contains an unknown field"), { status: 400, code: "INVALID_DECISION" });
        const decision = (input as Record<string, unknown>).decision;
        if (decision === "REJECT") {
          writeJson(response, 200, approvals.reject(parts[3], owner));
          return;
        }
        if (decision !== "APPROVE" || !(input as Record<string, unknown>).approvedBounds) throw Object.assign(new Error("approval decision is incomplete"), { status: 400, code: "INVALID_DECISION" });
        const authTime = requireFreshStepUp(req);
        const grant = approvals.approve(parts[3], owner, authTime, (input as Record<string, unknown>).approvedBounds as never);
        writeJson(response, 200, { request: approvals.getRequest(parts[3]), grant: { ...grant, signedGrantDigest: grant.signedGrantDigest } });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "schedules") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, name, status, timezone, recurrence, next_run_at AS nextRunAt, misfire_policy AS misfirePolicy, goal_template_json AS goalTemplate, state_version AS stateVersion, created_at AS createdAt, updated_at AS updatedAt FROM schedules ORDER BY name").map((row) => ({ ...row, recurrence: JSON.parse(String(row.recurrence)), goalTemplate: JSON.parse(String(row.goalTemplate)) })) });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "schedules") {
        ownerId(req, options.allowUnauthenticated);
        const row = options.db.one<Record<string, unknown>>("SELECT id, name, status, timezone, recurrence, next_run_at AS nextRunAt, misfire_policy AS misfirePolicy, goal_template_json AS goalTemplate, state_version AS stateVersion, created_at AS createdAt, updated_at AS updatedAt FROM schedules WHERE id = ?", parts[3]);
        if (!row) throw Object.assign(new Error("schedule not found"), { status: 404, code: "SCHEDULE_NOT_FOUND" });
        writeJson(response, 200, { ...row, recurrence: JSON.parse(String(row.recurrence)), goalTemplate: JSON.parse(String(row.goalTemplate)), firings: options.db.all("SELECT id, intended_run_at AS intendedRunAt, dedupe_key AS dedupeKey, goal_id AS goalId, disposition, created_at AS createdAt FROM schedule_firings WHERE schedule_id = ? ORDER BY created_at DESC LIMIT 50", parts[3]) });
        return;
      }
      if (method === "POST" && parts.length === 3 && parts[2] === "schedules") {
        ownerId(req, options.allowUnauthenticated);
        const input = await readJson(req) as Record<string, unknown>;
        const schedule = schedules.create({ name: String(input.name ?? ""), timezone: String(input.timezone ?? ""), recurrence: input.recurrence as never, nextRunAt: Number(input.nextRunAt), misfirePolicy: input.misfirePolicy as never, goalTemplate: (input.goalTemplate ?? {}) as Record<string, unknown> });
        writeJson(response, 201, schedule);
        return;
      }
      if (method === "PATCH" && parts.length === 4 && parts[2] === "schedules") {
        ownerId(req, options.allowUnauthenticated);
        const input = await readJson(req) as Record<string, unknown>;
        const schedule = schedules.update(parts[3], { timezone: typeof input.timezone === "string" ? input.timezone : undefined, recurrence: input.recurrence as never, nextRunAt: input.nextRunAt as number | null | undefined, misfirePolicy: input.misfirePolicy as never, goalTemplate: input.goalTemplate as Record<string, unknown> | undefined, expectedStateVersion: Number(input.expectedStateVersion) });
        writeJson(response, 200, schedule);
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "schedules" && parts[4] === "pause") {
        ownerId(req, options.allowUnauthenticated);
        const schedule = schedules.pause(parts[3]);
        writeJson(response, 200, schedule);
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "schedules" && parts[4] === "run") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const goalId = schedules.manualRun(parts[3], (template, dedupeKey) => {
          const created = options.engine.createGoal(parseGoalCreateInput(template), owner, `schedule:${dedupeKey}`);
          return String(created.body.goalId);
        });
        writeJson(response, 202, { scheduleId: parts[3], goalId });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "workers") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, identity_subject AS identitySubject, name, platform, trust_state AS trustState, protocol_min AS protocolMin, protocol_max AS protocolMax, last_heartbeat_at AS lastHeartbeatAt, stale_at AS staleAt, drain_state AS drainState, metadata_json AS metadata, updated_at AS updatedAt FROM workers ORDER BY name").map((row) => ({ ...row, metadata: JSON.parse(String(row.metadata)) })) });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "workers" && parts[3] === "enrollment-requests") {
        ownerId(req, options.allowUnauthenticated);
        const status = query(req.url).get("status");
        const allowedStatuses = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"];
        const rows = status && allowedStatuses.includes(status)
          ? options.db.all("SELECT id, fingerprint, device_summary_json AS deviceSummary, status, expires_at AS expiresAt, created_at AS createdAt, decided_at AS decidedAt, decided_by AS decidedBy FROM worker_enrollment_requests WHERE status = ? ORDER BY created_at DESC LIMIT 50", status)
          : options.db.all("SELECT id, fingerprint, device_summary_json AS deviceSummary, status, expires_at AS expiresAt, created_at AS createdAt, decided_at AS decidedAt, decided_by AS decidedBy FROM worker_enrollment_requests ORDER BY created_at DESC LIMIT 50");
        writeJson(response, 200, { items: rows.map((row) => ({ ...row, deviceSummary: JSON.parse(String(row.deviceSummary)) })) });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "workers" && parts[3] !== "enrollment-requests") {
        ownerId(req, options.allowUnauthenticated);
        const worker = options.db.one<Record<string, unknown>>("SELECT id, identity_subject AS identitySubject, name, platform, trust_state AS trustState, protocol_min AS protocolMin, protocol_max AS protocolMax, last_heartbeat_at AS lastHeartbeatAt, stale_at AS staleAt, wake_policy_json AS wakePolicy, drain_state AS drainState, metadata_json AS metadata, created_at AS createdAt, updated_at AS updatedAt FROM workers WHERE id = ?", parts[3]);
        if (!worker) throw Object.assign(new Error("worker not found"), { status: 404, code: "WORKER_NOT_FOUND" });
        writeJson(response, 200, { ...worker, wakePolicy: JSON.parse(String(worker.wakePolicy)), metadata: JSON.parse(String(worker.metadata)), capabilities: options.db.all("SELECT id, worker_id AS workerId, kind, version, descriptor_hash AS descriptorHash, descriptor_json AS descriptor, discovered_state AS discoveredState, grant_state AS grantState, health, updated_at AS updatedAt FROM capabilities WHERE worker_id = ? ORDER BY kind, version", parts[3]).map((row) => ({ ...row, descriptor: JSON.parse(String(row.descriptor)) })) });
        return;
      }
      if (method === "GET" && parts.length === 5 && parts[2] === "workers" && parts[4] === "capabilities") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, worker_id AS workerId, kind, version, descriptor_hash AS descriptorHash, descriptor_json AS descriptor, discovered_state AS discoveredState, grant_state AS grantState, health, updated_at AS updatedAt FROM capabilities WHERE worker_id = ? ORDER BY kind, version", parts[3]).map((row) => ({ ...row, descriptor: JSON.parse(String(row.descriptor)) })) });
        return;
      }
      if (method === "GET" && parts.length === 5 && parts[2] === "workers" && parts[3] === "enrollment-requests") {
        ownerId(req, options.allowUnauthenticated);
        const enrollment = options.db.one<Record<string, unknown>>("SELECT id, fingerprint, device_summary_json AS deviceSummary, status, expires_at AS expiresAt, created_at AS createdAt, decided_at AS decidedAt, decided_by AS decidedBy FROM worker_enrollment_requests WHERE id = ?", parts[4]);
        if (!enrollment) throw Object.assign(new Error("enrollment request not found"), { status: 404, code: "ENROLLMENT_NOT_FOUND" });
        writeJson(response, 200, { ...enrollment, deviceSummary: JSON.parse(String(enrollment.deviceSummary)) });
        return;
      }
      if (method === "POST" && parts.length === 4 && parts[2] === "workers" && parts[3] === "enrollment-requests") {
        ownerId(req, options.allowUnauthenticated);
        const input = await readJson(req) as Record<string, unknown>;
        if (typeof input.publicKeyPem !== "string" || !input.deviceSummary || typeof input.deviceSummary !== "object" || Array.isArray(input.deviceSummary)) throw Object.assign(new Error("worker enrollment request is invalid"), { status: 400, code: "INVALID_ENROLLMENT_REQUEST" });
        let key;
        try { key = createPublicKey(input.publicKeyPem); } catch { throw Object.assign(new Error("worker public key is invalid"), { status: 400, code: "INVALID_ENROLLMENT_KEY" }); }
        const now = Date.now();
        const requestId = uuidv7(now);
        const challenge = randomBytes(32).toString("base64url");
        const expiresAt = now + 10 * 60_000;
        options.db.run("INSERT INTO worker_enrollment_requests(id, public_key_pem, fingerprint, device_summary_json, challenge_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)", requestId, input.publicKeyPem, publicKeyFingerprint(key), JSON.stringify(input.deviceSummary), sha256(challenge), expiresAt, now);
        const enrollment = options.db.one<Record<string, unknown>>("SELECT id, fingerprint, device_summary_json AS deviceSummary, status, expires_at AS expiresAt, created_at AS createdAt FROM worker_enrollment_requests WHERE id = ?", requestId)!;
        writeJson(response, 202, { ...enrollment, deviceSummary: JSON.parse(String(enrollment.deviceSummary)), challenge });
        return;
      }
      if (method === "POST" && parts.length === 6 && parts[2] === "workers" && parts[3] === "enrollment-requests" && parts[5] === "approve") {
        const owner = ownerId(req, options.allowUnauthenticated);
        requireFreshStepUp(req);
        const input = await readJson(req) as Record<string, unknown>;
        const enrollment = options.db.one<{ fingerprint: string; status: string; expires_at: number }>("SELECT fingerprint, status, expires_at FROM worker_enrollment_requests WHERE id = ?", parts[4]);
        if (!enrollment) throw Object.assign(new Error("enrollment request not found"), { status: 404, code: "ENROLLMENT_NOT_FOUND" });
        if (enrollment.status !== "PENDING" || enrollment.expires_at <= Date.now()) throw Object.assign(new Error("enrollment request is not pending"), { status: 409, code: "ENROLLMENT_NOT_PENDING" });
        if (input.fingerprint !== enrollment.fingerprint) throw Object.assign(new Error("enrollment fingerprint does not match"), { status: 409, code: "ENROLLMENT_FINGERPRINT_MISMATCH" });
        options.db.run("UPDATE worker_enrollment_requests SET status = 'APPROVED', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'", Date.now(), owner, parts[4]);
        options.engine.appendAudit("worker.enrollment.approved", `worker-enrollment:${parts[4]}`, owner, "APPROVED", 1, { fingerprint: enrollment.fingerprint });
        writeJson(response, 200, { id: parts[4], status: "APPROVED", fingerprint: enrollment.fingerprint, next: "AWAITING_WORKER_PROOF" });
        return;
      }
      if (method === "DELETE" && parts.length === 5 && parts[2] === "workers" && parts[3] === "enrollment-requests") {
        const owner = ownerId(req, options.allowUnauthenticated);
        requireFreshStepUp(req);
        const enrollment = options.db.one<{ status: string; expires_at: number }>("SELECT status, expires_at FROM worker_enrollment_requests WHERE id = ?", parts[4]);
        if (!enrollment) throw Object.assign(new Error("enrollment request not found"), { status: 404, code: "ENROLLMENT_NOT_FOUND" });
        if (enrollment.status !== "PENDING" || enrollment.expires_at <= Date.now()) throw Object.assign(new Error("enrollment request is not pending"), { status: 409, code: "ENROLLMENT_NOT_PENDING" });
        const now = Date.now();
        options.db.run("UPDATE worker_enrollment_requests SET status = 'REJECTED', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'PENDING'", now, owner, parts[4]);
        options.engine.appendAudit("worker.enrollment.cancelled", `worker-enrollment:${parts[4]}`, owner, "REJECTED", 1, {});
        writeJson(response, 200, { id: parts[4], cancelled: true, status: "REJECTED" });
        return;
      }
      if (method === "DELETE" && parts.length === 4 && parts[2] === "workers") {
        const owner = ownerId(req, options.allowUnauthenticated);
        requireFreshStepUp(req);
        const worker = options.db.one<{ id: string; trust_state: string }>("SELECT id, trust_state FROM workers WHERE id = ?", parts[3]);
        if (!worker) throw Object.assign(new Error("worker not found"), { status: 404, code: "WORKER_NOT_FOUND" });
        const active = Number(options.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM attempts WHERE worker_id = ? AND state IN ('OFFERED', 'DISPATCHED', 'RUNNING', 'RESUMING')", parts[3])?.count ?? 0);
        if (active > 0) throw Object.assign(new Error("worker has active attempts; drain it and wait for completion"), { status: 409, code: "WORKER_BUSY" });
        const now = Date.now();
        options.db.transaction(() => {
          options.db.run("UPDATE workers SET trust_state = 'REVOKED', drain_state = 'DRAINED', updated_at = ? WHERE id = ?", now, parts[3]);
          options.db.run("UPDATE capabilities SET grant_state = 'REVOKED', updated_at = ? WHERE worker_id = ?", now, parts[3]);
        });
        options.engine.appendAudit("worker.deleted", `worker:${parts[3]}`, owner, "REVOKED", 1, { logicalDelete: true });
        writeJson(response, 200, { id: parts[3], deleted: true, trustState: "REVOKED", drainState: "DRAINED", retention: "historical-evidence-preserved" });
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "workers" && parts[4] === "drain") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const existing = options.db.one("SELECT id FROM workers WHERE id = ?", parts[3]);
        if (!existing) throw Object.assign(new Error("worker not found"), { status: 404, code: "WORKER_NOT_FOUND" });
        options.db.run("UPDATE workers SET drain_state = 'DRAINING', updated_at = ? WHERE id = ?", Date.now(), parts[3]);
        options.engine.appendAudit("worker.drain.requested", `worker:${parts[3]}`, owner, "ACCEPTED", 1, {});
        writeJson(response, 202, { id: parts[3], drainState: "DRAINING" });
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "workers" && parts[4] === "revoke") {
        const owner = ownerId(req, options.allowUnauthenticated);
        requireFreshStepUp(req);
        const existing = options.db.one("SELECT id FROM workers WHERE id = ?", parts[3]);
        if (!existing) throw Object.assign(new Error("worker not found"), { status: 404, code: "WORKER_NOT_FOUND" });
        options.db.transaction(() => {
          options.db.run("UPDATE workers SET trust_state = 'REVOKED', drain_state = 'DRAINED', updated_at = ? WHERE id = ?", Date.now(), parts[3]);
          options.db.run("UPDATE capabilities SET grant_state = 'REVOKED', updated_at = ? WHERE worker_id = ?", Date.now(), parts[3]);
        });
        options.engine.appendAudit("worker.revoked", `worker:${parts[3]}`, owner, "REVOKED", 1, {});
        writeJson(response, 200, { id: parts[3], trustState: "REVOKED", drainState: "DRAINED" });
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "workers" && parts[4] === "wake") {
        ownerId(req, options.allowUnauthenticated);
        throw Object.assign(new Error("accepted wake adapter is not configured"), { status: 503, code: "WAKE_ADAPTER_NOT_CONFIGURED", retryable: true });
      }
      if (method === "POST" && parts.length === 7 && parts[2] === "workers" && parts[4] === "capabilities" && parts[6] === "grant") {
        const owner = ownerId(req, options.allowUnauthenticated);
        requireFreshStepUp(req);
        const capability = options.db.one<{ descriptor_hash: string; grant_state: string }>("SELECT descriptor_hash, grant_state FROM capabilities WHERE id = ? AND worker_id = ?", parts[5], parts[3]);
        if (!capability) throw Object.assign(new Error("capability not found"), { status: 404, code: "CAPABILITY_NOT_FOUND" });
        const input = await readJson(req) as Record<string, unknown>;
        if (input.descriptorHash !== capability.descriptor_hash) throw Object.assign(new Error("capability descriptor changed"), { status: 409, code: "CAPABILITY_DESCRIPTOR_CHANGED" });
        options.db.run("UPDATE capabilities SET grant_state = 'GRANTED', updated_at = ? WHERE id = ? AND worker_id = ?", Date.now(), parts[5], parts[3]);
        options.engine.appendAudit("worker.capability.granted", `capability:${parts[5]}`, owner, "GRANTED", 1, { workerId: parts[3], descriptorHash: capability.descriptor_hash });
        writeJson(response, 200, { id: parts[5], workerId: parts[3], grantState: "GRANTED", descriptorHash: capability.descriptor_hash });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "credentials") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, alias, storage_class AS storageClass, adapter, purpose, scopes_json AS scopes, health, expires_at AS expiresAt, last_verified_at AS lastVerifiedAt, updated_at AS updatedAt FROM credential_handles ORDER BY alias").map((row) => ({ ...row, scopes: JSON.parse(String(row.scopes)) })) });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "connectors") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, {
          items: options.db.all("SELECT connector, source_account_handle AS accountHandle, cursor_ref AS cursorRef, state, counters_json AS counters, error_class AS errorClass, next_retry_at AS nextRetryAt, updated_at AS updatedAt FROM connector_runs ORDER BY connector, source_account_handle").map((row) => ({
            ...row,
            counters: JSON.parse(String(row.counters ?? "{}")),
          })),
        });
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "connectors" && ["run", "reauthorize"].includes(parts[4])) {
        ownerId(req, options.allowUnauthenticated);
        throw Object.assign(new Error("connector adapter is not configured"), { status: 503, code: "CONNECTOR_NOT_CONFIGURED", retryable: false });
      }
      if (method === "GET" && (parts.length === 3 || parts.length === 4) && parts[2] === "conversations") {
        ownerId(req, options.allowUnauthenticated);
        if (!options.archiveService) {
          writeJson(response, 503, { error: { code: "ARCHIVE_NOT_CONNECTED", message: "Conversation Archive authority is not connected; route remains disabled", retryable: true } });
          return;
        }
        if (parts.length === 3) {
          writeJson(response, 200, { items: options.archiveService.listConversations() });
          return;
        }
        const conversation = options.archiveService.getConversation(parts[3]);
        if (!conversation) throw Object.assign(new Error("conversation not found"), { status: 404, code: "CONVERSATION_NOT_FOUND" });
        writeJson(response, 200, conversation);
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "conversations" && parts[4] === "export") {
        const owner = ownerId(req, options.allowUnauthenticated);
        if (!options.archiveService) throw Object.assign(new Error("archive not connected"), { status: 503, code: "ARCHIVE_NOT_CONNECTED" });
        const jobId = options.archiveService.requestExport(parts[3], owner, idempotencyKey(req));
        writeJson(response, 202, { jobId, status: options.archiveService.getJob(jobId)?.status, links: { self: `/api/v1/conversation-jobs/${jobId}` } });
        return;
      }
      if (method === "DELETE" && parts.length === 4 && parts[2] === "conversations") {
        const owner = ownerId(req, options.allowUnauthenticated);
        requireFreshStepUp(req);
        if (!options.archiveService) throw Object.assign(new Error("archive not connected"), { status: 503, code: "ARCHIVE_NOT_CONNECTED" });
        const input = await readJson(req) as Record<string, unknown>;
        if (Object.keys(input).some((key) => !["reason", "blockFuture"].includes(key)) || typeof input.reason !== "string" || input.reason.length === 0 || input.blockFuture !== undefined && typeof input.blockFuture !== "boolean") throw Object.assign(new Error("deletion request is invalid"), { status: 400, code: "INVALID_DELETION_REQUEST" });
        const jobId = options.archiveService.requestPurge(parts[3], owner, input.reason, input.blockFuture === true, idempotencyKey(req));
        writeJson(response, 202, { jobId, status: options.archiveService.getJob(jobId)?.status, links: { self: `/api/v1/conversation-jobs/${jobId}` } });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "conversation-jobs") {
        ownerId(req, options.allowUnauthenticated);
        if (!options.archiveService) throw Object.assign(new Error("archive not connected"), { status: 503, code: "ARCHIVE_NOT_CONNECTED" });
        const job = options.archiveService.getJob(parts[3]);
        if (!job) throw Object.assign(new Error("archive job not found"), { status: 404, code: "ARCHIVE_JOB_NOT_FOUND" });
        writeJson(response, 200, job);
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "compute" && parts[3] === "providers") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, class, adapter, worker_id AS workerId, status, descriptor_json AS descriptor, last_probe_at AS lastProbeAt, evidence_json AS evidence, updated_at AS updatedAt FROM providers ORDER BY id").map((row) => ({ ...row, descriptor: JSON.parse(String(row.descriptor)), evidence: JSON.parse(String(row.evidence)) })) });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "compute" && parts[3] === "routes") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { policy: options.db.one("SELECT version, policy_json AS policy, digest, created_at AS createdAt FROM policy_revisions ORDER BY version DESC LIMIT 1") ?? null, providers: options.db.all("SELECT p.id, p.class, p.status, p.descriptor_json AS descriptor, q.window, q.remaining_json AS remaining, q.confidence, q.observed_at AS observedAt FROM providers p LEFT JOIN quota_observations q ON q.id = (SELECT id FROM quota_observations WHERE provider_id = p.id ORDER BY observed_at DESC LIMIT 1) ORDER BY p.id").map((row) => ({ ...row, descriptor: JSON.parse(String(row.descriptor)), remaining: row.remaining === null ? null : JSON.parse(String(row.remaining)) })), decisionEvidence: [] });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "policies") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT version, policy_json AS policy, digest, created_at AS createdAt FROM policy_revisions ORDER BY version DESC").map((row) => ({ ...row, policy: JSON.parse(String(row.policy)) })) });
        return;
      }
      if (method === "PATCH" && parts.length === 3 && parts[2] === "policies") {
        const owner = ownerId(req, options.allowUnauthenticated);
        requireFreshStepUp(req);
        const policy = await readJson(req);
        if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw Object.assign(new Error("policy must be an object"), { status: 400, code: "INVALID_POLICY" });
        const now = Date.now();
        const digest = sha256(canonicalJson(policy as never));
        const version = Number(options.db.one<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM policy_revisions")?.version ?? 1);
        try { options.db.run("INSERT INTO policy_revisions(version, policy_json, digest, created_at) VALUES (?, ?, ?, ?)", version, JSON.stringify(policy), digest, now); } catch { throw Object.assign(new Error("policy revision already exists"), { status: 409, code: "POLICY_DUPLICATE" }); }
        options.engine.appendAudit("policy.updated", `policy:${version}`, owner, "CREATED", version, { digest });
        writeJson(response, 201, { version, policy, digest, createdAt: now });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "audit") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT event_id AS id, sequence, actor, action, target, decision, policy_version AS policyVersion, metadata_json AS metadata, previous_hash AS previousHash, hash, occurred_at AS occurredAt FROM audit_events ORDER BY sequence DESC LIMIT 200").map((row) => ({ ...row, metadata: JSON.parse(String(row.metadata)) })) });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "system") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { health: await health(options, "ops"), counts: { goals: Number(options.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM goals")?.count ?? 0), openApprovals: Number(options.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM approval_requests WHERE status = 'OPEN'")?.count ?? 0), workers: Number(options.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM workers")?.count ?? 0), providers: Number(options.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM providers")?.count ?? 0), deadLetters: Number(options.db.one<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE dead_lettered_at IS NOT NULL")?.count ?? 0) }, external: { memory: "/memory/" } });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "events") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const after = Number(query(req.url).get("after") ?? 0);
        const items = options.db.all<Record<string, unknown>>("SELECT e.event_id AS id, e.action AS type, e.target AS aggregateId, e.sequence AS aggregateVersion, e.occurred_at AS occurredAt FROM audit_events e WHERE e.sequence > ? AND (e.target NOT LIKE 'goal:%' OR EXISTS (SELECT 1 FROM goals g WHERE e.target = 'goal:' || g.id AND g.owner_id = ?)) ORDER BY e.sequence LIMIT 100", Number.isInteger(after) && after >= 0 ? after : 0, owner);
        if (req.headers.accept?.includes("text/event-stream")) {
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
          for (const item of items) response.write(`id: ${item.aggregateVersion}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
          response.write(": refetch REST projections after reconnect\n\n");
          response.end();
        } else {
          writeJson(response, 200, { items });
        }
        return;
      }
      throw Object.assign(new Error("not found"), { status: 404, code: "NOT_FOUND" });
    } catch (cause) {
      const error = cause as AppError;
      const status = error.status ?? ({
        AUTH_REQUIRED: 401,
        GOAL_NOT_FOUND: 404,
        TASK_NOT_FOUND: 404,
        IDEMPOTENCY_CONFLICT: 409,
        STATE_CONFLICT: 409,
        INVALID_STATE_TRANSITION: 409,
        STALE_PLAN: 409,
      }[error.code ?? ""] ?? 400);
      writeJson(response, status, {
        error: {
          code: error.code ?? "INVALID_REQUEST",
          message: error.code === "AUTH_REQUIRED" ? error.message : (error.message || "request failed"),
          requestId: id,
          retryable: error.retryable === true,
        },
      });
    }
  });
  attachWorkerWebSocket(server, workerChannel);
  return server;
}
