import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { parseGoalCreateInput } from "../../../packages/contracts/src/index.ts";
import { OrchestratorDatabase } from "./db.ts";
import { TaskEngine } from "./task-engine.ts";

const MAX_BODY_BYTES = 1_048_576;

type AppOptions = {
  db: OrchestratorDatabase;
  engine: TaskEngine;
  allowUnauthenticated: boolean;
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
  if (!allowUnauthenticated) {
    const error = new Error("authenticated Identity Gateway session required") as AppError;
    error.code = "AUTH_REQUIRED";
    error.status = 401;
    throw error;
  }
  const supplied = req.headers["x-pai-dev-owner-id"];
  return typeof supplied === "string" && supplied.length > 0 && supplied.length <= 200 ? supplied : "local-owner";
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
  const ready = dbCheck?.value === 1 && migration?.version === 4 && auditChain;
  if (kind === "live") return { status: "ok" };
  if (kind === "ready") return { status: ready ? "ok" : "not_ready", database: dbCheck?.value === 1 ? "ok" : "error", auditChain: auditChain ? "ok" : "error", schemaVersion: migration?.version ?? null };
  return {
    status: ready ? "ok" : "degraded",
    evidenceLevel: "implemented_local",
    database: dbCheck?.value === 1 ? "ok" : "error",
    auditChain: auditChain ? "ok" : "error",
    schemaVersion: migration?.version ?? null,
    authMode: options.allowUnauthenticated ? "development" : "identity-gateway",
    providers: "not_configured",
    workers: "not_configured",
    backupRestore: "not_verified",
  };
}

export function createHttpServer(options: AppOptions) {
  return createServer(async (req, response) => {
    const id = requestId(req);
    response.setHeader("x-request-id", id);
    try {
      const parts = pathParts(req.url);
      const method = req.method ?? "GET";
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
        ownerId(req, options.allowUnauthenticated);
        const goals = options.db.all<Record<string, unknown>>("SELECT * FROM goals ORDER BY created_at DESC LIMIT 100");
        writeJson(response, 200, { items: goals.map((row) => options.engine.getGoal(String(row.id))) });
        return;
      }

      if (parts.length >= 4 && parts[2] === "goals") {
        ownerId(req, options.allowUnauthenticated);
        const goalId = parts[3];
        const goal = options.engine.getGoal(goalId);
        if (!goal) throw Object.assign(new Error("goal not found"), { status: 404, code: "GOAL_NOT_FOUND" });
        if (method === "GET" && parts.length === 4) {
          writeJson(response, 200, { ...goal, links: { self: `/api/v1/goals/${goalId}`, tasks: `/api/v1/goals/${goalId}/tasks`, events: `/api/v1/goals/${goalId}/events` } });
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
          const cancelled = options.engine.requestGoalCancellation(goalId, ownerId(req, options.allowUnauthenticated), key);
          if ("body" in cancelled) {
            writeJson(response, cancelled.status, cancelled.body, { "x-idempotent-replay": String(cancelled.replayed) });
          } else {
            writeJson(response, 202, cancelled, { "x-idempotent-replay": "false" });
          }
          return;
        }
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
