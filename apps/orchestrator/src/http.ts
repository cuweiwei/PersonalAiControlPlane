import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseGoalCreateInput } from "../../../packages/contracts/src/index.ts";
import { CounterRegistry } from "../../../packages/observability/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";
import { ApprovalService } from "./approval-service.ts";
import { ScheduleService } from "./schedule-service.ts";
import { TaskEngine } from "./task-engine.ts";

const MAX_BODY_BYTES = 1_048_576;

type AppOptions = {
  db: OrchestratorDatabase;
  engine: TaskEngine;
  allowUnauthenticated: boolean;
  identityReady?: boolean;
  metrics?: CounterRegistry;
  approvalService?: ApprovalService;
  scheduleService?: ScheduleService;
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

function publicTask(row: Record<string, unknown>): Record<string, unknown> {
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
    stateVersion: row.state_version,
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
    error: row.error_json ? JSON.parse(String(row.error_json)) : null,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
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

function health(options: AppOptions, kind: "live" | "ready" | "ops"): Record<string, unknown> {
  const dbCheck = options.db.one<{ value: number }>("SELECT 1 AS value");
  const migration = options.db.one<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
  const auditChain = options.engine.verifyAuditChain();
  const identityReady = options.allowUnauthenticated || options.identityReady === true;
  const ready = dbCheck?.value === 1 && migration?.version === 4 && auditChain && identityReady;
  if (kind === "live") return { status: "ok" };
  if (kind === "ready") return { status: ready ? "ok" : "not_ready", database: dbCheck?.value === 1 ? "ok" : "error", auditChain: auditChain ? "ok" : "error", identity: identityReady ? "ok" : "not_ready", schemaVersion: migration?.version ?? null };
  return {
    status: ready ? "ok" : "degraded",
    evidenceLevel: "implemented_local",
    database: dbCheck?.value === 1 ? "ok" : "error",
    auditChain: auditChain ? "ok" : "error",
    identity: identityReady ? "ok" : "not_ready",
    schemaVersion: migration?.version ?? null,
    authMode: options.allowUnauthenticated ? "development" : "identity-gateway",
    providers: "not_configured",
    workers: "not_configured",
    backupRestore: "not_verified",
  };
}

export function createHttpServer(options: AppOptions) {
  const metrics = options.metrics ?? new CounterRegistry();
  const approvals = options.approvalService ?? new ApprovalService(options.db);
  const schedules = options.scheduleService ?? new ScheduleService(options.db);
  return createServer(async (req, response) => {
    const id = requestId(req);
    response.setHeader("x-request-id", id);
    try {
      const parts = pathParts(req.url);
      const method = req.method ?? "GET";
      metrics.increment("pai_http_requests_total", { method });
      if (method === "GET" && parts.length === 2 && parts[0] === "health") {
        const kind = parts[1] as "live" | "ready" | "ops";
        if (!["live", "ready", "ops"].includes(kind)) throw Object.assign(new Error("not found"), { status: 404, code: "NOT_FOUND" });
        const body = health(options, kind);
        writeJson(response, kind === "ready" && body.status !== "ok" ? 503 : 200, body);
        return;
      }
      if (method === "GET" && parts.length === 1 && parts[0] === "health") {
        writeJson(response, 200, health(options, "ready"));
        return;
      }
      if (method === "GET" && parts.length === 1 && parts[0] === "metrics") {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
        response.end(metrics.prometheus());
        return;
      }
      if (parts[0] !== "api" || parts[1] !== "v1") throw Object.assign(new Error("not found"), { status: 404, code: "NOT_FOUND" });

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
        const goals = options.db.all<Record<string, unknown>>("SELECT * FROM goals WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100", owner);
        writeJson(response, 200, { items: goals.map((row) => options.engine.getGoal(String(row.id))) });
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
          writeJson(response, 200, { items: options.engine.listTasks(goalId).map(publicTask) });
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
        const row = options.db.one<Record<string, unknown>>("SELECT r.id, r.goal_id AS goalId, r.task_id AS taskId, r.plan_digest AS planDigest, r.policy_version AS policyVersion, r.required_scope_json AS requiredScope, r.risk_json AS risk, r.status, r.expires_at AS expiresAt, r.correlation_id AS correlationId, r.created_at AS createdAt, r.decided_at AS decidedAt, r.decided_by AS decidedBy FROM approval_requests r JOIN goals g ON g.id = r.goal_id WHERE r.id = ? AND g.owner_id = ?", parts[3], owner);
        if (!row) throw Object.assign(new Error("approval not found"), { status: 404, code: "APPROVAL_NOT_FOUND" });
        writeJson(response, 200, { ...row, requiredScope: JSON.parse(String(row.requiredScope)), risk: JSON.parse(String(row.risk)) });
        return;
      }
      if (method === "POST" && parts.length === 5 && parts[2] === "approvals" && parts[4] === "decision") {
        const owner = ownerId(req, options.allowUnauthenticated);
        const request = options.db.one<{ goal_id: string }>("SELECT r.goal_id FROM approval_requests r JOIN goals g ON g.id = r.goal_id WHERE r.id = ? AND g.owner_id = ?", parts[3], owner);
        if (!request) throw Object.assign(new Error("approval not found"), { status: 404, code: "APPROVAL_NOT_FOUND" });
        const input = await readJson(req);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error("decision body must be an object"), { status: 400, code: "INVALID_DECISION" });
        const decision = (input as Record<string, unknown>).decision;
        if (decision === "REJECT") {
          writeJson(response, 200, approvals.reject(parts[3], owner));
          return;
        }
        if (decision !== "APPROVE" || typeof (input as Record<string, unknown>).signedGrant !== "string" || !(input as Record<string, unknown>).approvedBounds || !Number.isFinite(Number((input as Record<string, unknown>).authTime))) throw Object.assign(new Error("approval decision is incomplete"), { status: 400, code: "INVALID_DECISION" });
        const grant = approvals.approve(parts[3], owner, Number((input as Record<string, unknown>).authTime), String((input as Record<string, unknown>).signedGrant), (input as Record<string, unknown>).approvedBounds as never);
        writeJson(response, 200, { request: approvals.getRequest(parts[3]), grant: { ...grant, signedGrantDigest: grant.signedGrantDigest } });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "schedules") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, name, status, timezone, recurrence, next_run_at AS nextRunAt, misfire_policy AS misfirePolicy, goal_template_json AS goalTemplate, state_version AS stateVersion, created_at AS createdAt, updated_at AS updatedAt FROM schedules ORDER BY name").map((row) => ({ ...row, recurrence: JSON.parse(String(row.recurrence)), goalTemplate: JSON.parse(String(row.goalTemplate)) })) });
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
      if (method === "GET" && parts.length === 5 && parts[2] === "workers" && parts[4] === "capabilities") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, worker_id AS workerId, kind, version, descriptor_hash AS descriptorHash, descriptor_json AS descriptor, discovered_state AS discoveredState, grant_state AS grantState, health, updated_at AS updatedAt FROM capabilities WHERE worker_id = ? ORDER BY kind, version", parts[3]).map((row) => ({ ...row, descriptor: JSON.parse(String(row.descriptor)) })) });
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
      if (method === "GET" && (parts.length === 3 || parts.length === 4) && parts[2] === "conversations") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 503, { error: { code: "ARCHIVE_NOT_CONNECTED", message: "Conversation Archive authority is not connected; route remains disabled", retryable: true } });
        return;
      }
      if (method === "GET" && parts.length === 4 && parts[2] === "compute" && parts[3] === "providers") {
        ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT id, class, adapter, worker_id AS workerId, status, descriptor_json AS descriptor, last_probe_at AS lastProbeAt, evidence_json AS evidence, updated_at AS updatedAt FROM providers ORDER BY id").map((row) => ({ ...row, descriptor: JSON.parse(String(row.descriptor)), evidence: JSON.parse(String(row.evidence)) })) });
        return;
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "events") {
        const owner = ownerId(req, options.allowUnauthenticated);
        writeJson(response, 200, { items: options.db.all("SELECT e.event_id AS id, e.action AS type, e.target AS aggregateId, e.sequence AS aggregateVersion, e.occurred_at AS occurredAt FROM audit_events e WHERE EXISTS (SELECT 1 FROM goals g WHERE e.target = 'goal:' || g.id AND g.owner_id = ?) ORDER BY e.sequence DESC LIMIT 100", owner) });
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
}
