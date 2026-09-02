import { createHash, randomBytes } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const TASK_TYPES = ["llm.inference", "codex", "python", "command", "generic"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_STATES = ["QUEUED", "ASSIGNED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export const WORKER_STATES = ["ONLINE", "OFFLINE", "DISABLED"] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export type TaskModelRequirement = { name?: string; mode?: "required" | "preferred" | "any" };
export type TaskExecution = {
  capabilities: string[];
  workerId?: string | null;
  runtime?: string;
  model?: TaskModelRequirement;
  resources?: { minRamMb?: number; gpuRequired?: boolean };
  workspaceId?: string;
};
export type CreateTaskInput = {
  source: string;
  correlationId?: string | null;
  groupId?: string | null;
  parentTaskId?: string | null;
  title: string;
  taskType: TaskType;
  instruction: string;
  context: Record<string, JsonValue>;
  payload: Record<string, JsonValue>;
  execution: TaskExecution;
  limits: { timeoutSeconds: number; maxAttempts: number };
  priority: TaskPriority;
  inputArtifactIds: string[];
};

export type TaskEventName =
  | "TASK_CREATED" | "TASK_ASSIGNED" | "WORKER_ACCEPTED" | "TASK_STARTED"
  | "TASK_PROGRESS" | "TASK_LOG" | "TASK_SUCCEEDED" | "TASK_FAILED"
  | "TASK_CANCELLED" | "TASK_REQUEUED" | "LATE_ATTEMPT_RESULT";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Math.max(0, Math.floor(now))) & 0xffffffffffffn;
  bytes[0] = Number(timestamp >> 40n) & 0xff;
  bytes[1] = Number(timestamp >> 32n) & 0xff;
  bytes[2] = Number(timestamp >> 24n) & 0xff;
  bytes[3] = Number(timestamp >> 16n) & 0xff;
  bytes[4] = Number(timestamp >> 8n) & 0xff;
  bytes[5] = Number(timestamp) & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], context: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${context}.${key} is not allowed`); }
function stringValue(value: unknown, field: string, max = 500): string { if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`${field} must be a non-empty string`); return value; }
function optionalString(value: unknown, field: string): string | null | undefined { if (value === undefined || value === null) return value as null | undefined; return stringValue(value, field, 500); }
function nonNegativeInt(value: unknown, field: string, fallback: number, maximum: number): number { if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`${field} must be a bounded non-negative integer`); return value; }

export function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isRecord(value)) throw new Error("request body must be an object");
  rejectUnknown(value, ["source", "correlation_id", "group_id", "parent_task_id", "title", "task_type", "instruction", "context", "payload", "execution", "limits", "priority", "input_artifact_ids"], "request");
  const executionRaw = value.execution;
  if (!isRecord(executionRaw)) throw new Error("execution must be an object");
  rejectUnknown(executionRaw, ["capabilities", "worker_id", "runtime", "model", "resources", "workspace_id"], "execution");
  const capabilities = executionRaw.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 20 || capabilities.some((item) => typeof item !== "string" || item.length === 0 || item.length > 100)) throw new Error("execution.capabilities is invalid");
  const modelRaw = executionRaw.model;
  let model: TaskModelRequirement | undefined;
  if (modelRaw !== undefined) {
    if (!isRecord(modelRaw)) throw new Error("execution.model is invalid");
    rejectUnknown(modelRaw, ["name", "mode"], "execution.model");
    model = { name: optionalString(modelRaw.name, "execution.model.name") ?? undefined, mode: (modelRaw.mode ?? "any") as TaskModelRequirement["mode"] };
    if (!["required", "preferred", "any"].includes(model.mode ?? "")) throw new Error("execution.model.mode is invalid");
  }
  const resourcesRaw = executionRaw.resources;
  let resources: TaskExecution["resources"];
  if (resourcesRaw !== undefined) {
    if (!isRecord(resourcesRaw)) throw new Error("execution.resources is invalid");
    rejectUnknown(resourcesRaw, ["min_ram_mb", "gpu_required"], "execution.resources");
    resources = { minRamMb: nonNegativeInt(resourcesRaw.min_ram_mb, "execution.resources.min_ram_mb", 0, 1_048_576), gpuRequired: resourcesRaw.gpu_required === true };
  }
  const limitsRaw = value.limits;
  if (!isRecord(limitsRaw)) throw new Error("limits must be an object");
  rejectUnknown(limitsRaw, ["timeout_seconds", "max_attempts"], "limits");
  const timeoutSeconds = nonNegativeInt(limitsRaw.timeout_seconds, "limits.timeout_seconds", 1800, 86_400);
  if (timeoutSeconds < 1) throw new Error("limits.timeout_seconds must be positive");
  const maxAttempts = nonNegativeInt(limitsRaw.max_attempts, "limits.max_attempts", 2, 10);
  if (maxAttempts < 1) throw new Error("limits.max_attempts must be positive");
  const priority = (value.priority ?? "normal") as TaskPriority;
  if (!TASK_PRIORITIES.includes(priority)) throw new Error("priority is invalid");
  const taskType = value.task_type as TaskType;
  if (!TASK_TYPES.includes(taskType)) throw new Error("task_type is invalid");
  const context = value.context ?? {};
  const payload = value.payload ?? {};
  if (!isRecord(context) || !isRecord(payload)) throw new Error("context and payload must be objects");
  const inputArtifactIds = value.input_artifact_ids ?? [];
  if (!Array.isArray(inputArtifactIds) || inputArtifactIds.some((item) => typeof item !== "string")) throw new Error("input_artifact_ids is invalid");
  return {
    source: stringValue(value.source ?? "hermes", "source"),
    correlationId: optionalString(value.correlation_id, "correlation_id"),
    groupId: optionalString(value.group_id, "group_id"),
    parentTaskId: optionalString(value.parent_task_id, "parent_task_id"),
    title: stringValue(value.title, "title", 1_000),
    taskType,
    instruction: stringValue(value.instruction, "instruction", 100_000),
    context: context as Record<string, JsonValue>,
    payload: payload as Record<string, JsonValue>,
    execution: { capabilities: [...capabilities] as string[], workerId: optionalString(executionRaw.worker_id, "execution.worker_id"), runtime: optionalString(executionRaw.runtime, "execution.runtime") ?? "auto", model, resources, workspaceId: optionalString(executionRaw.workspace_id, "execution.workspace_id") ?? undefined },
    limits: { timeoutSeconds, maxAttempts },
    priority,
    inputArtifactIds,
  };
}

export function parseRegistrationInput(value: unknown): { name: string; registrationSecret: string; platform: string; hostname?: string; agentVersion?: string; hardware: Record<string, JsonValue>; capabilities?: Record<string, JsonValue>[]; models?: Record<string, JsonValue>[] } {
  if (!isRecord(value)) throw new Error("request body must be an object");
  rejectUnknown(value, ["name", "registration_secret", "platform", "hostname", "agent_version", "hardware", "capabilities", "models"], "request");
  const hardware = value.hardware ?? {};
  if (!isRecord(hardware)) throw new Error("hardware must be an object");
  return { name: stringValue(value.name, "name", 200), registrationSecret: stringValue(value.registration_secret, "registration_secret", 500), platform: stringValue(value.platform, "platform", 80), hostname: optionalString(value.hostname, "hostname") ?? undefined, agentVersion: optionalString(value.agent_version, "agent_version") ?? undefined, hardware: hardware as Record<string, JsonValue>, capabilities: Array.isArray(value.capabilities) ? value.capabilities as Record<string, JsonValue>[] : undefined, models: Array.isArray(value.models) ? value.models as Record<string, JsonValue>[] : undefined };
}

export const priorityNumber: Record<TaskPriority, number> = { low: 20, normal: 50, high: 80 };
