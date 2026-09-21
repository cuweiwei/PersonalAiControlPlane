import { createHash, randomBytes } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export * from "./dispatch.ts";

export const TASK_TYPES = ["llm.inference", "codex", "python", "command", "computer.use", "generic"] as const;
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
  preferenceId?: string | null;
};
export type TaskSourceRef = { kind: string; id: string; title?: string | null; url?: string | null };
export type CreateTaskInput = {
  source: string;
  correlationId?: string | null;
  sourceRef?: TaskSourceRef | null;
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
  purpose?: "USER" | "MISSION" | "MODEL_TEST" | "WORKER_TEST";
  settingsVersion?: number | null;
  /** Optional platform contract metadata. Omitted values retain legacy v1 semantics. */
  schemaVersion?: 1 | 2;
  executionSemantics?: "legacy" | "platform_v2";
  idempotencyKey?: string | null;
  sourceIntentRef?: string | null;
  conversationRef?: string | null;
  workRef?: { id: string; revision: number; owner: string } | null;
  requirements?: Record<string, JsonValue> | null;
  criteria?: Record<string, JsonValue>[];
  retryPolicy?: { maxAttempts: number; effectClass: "READ_ONLY" | "WORKSPACE_WRITE" | "EXTERNAL_WRITE" } | null;
  queueDeadlineAt?: number | null;
  approvalRef?: string | null;
  requestedBy?: string;
};

export type TaskContractV2Input = CreateTaskInput & {
  schemaVersion: 2;
  executionSemantics: "platform_v2";
  idempotencyKey: string;
  sourceIntentRef: string;
};

/** A typed task must require the capability implemented by its executor. */
export function taskTypeCapabilityMismatch(taskType: TaskType, capabilities: readonly string[]): boolean {
  return taskType !== "generic" && !capabilities.includes(taskType);
}

export type TaskEventName =
  | "TASK_CREATED" | "TASK_ASSIGNED" | "WORKER_ACCEPTED" | "TASK_STARTED"
  | "TASK_PROGRESS" | "TASK_LOG" | "TASK_SUCCEEDED" | "TASK_FAILED"
  | "TASK_CANCELLED" | "TASK_REQUEUED" | "LATE_ATTEMPT_RESULT" | "TASK_DISPATCH_CHANGED";

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

export function parseCreateTaskInput(value: unknown, defaults: { timeoutSeconds?: number; maxAttempts?: number } = {}): CreateTaskInput {
  if (!isRecord(value)) throw new Error("request body must be an object");
  rejectUnknown(value, ["source", "source_ref", "correlation_id", "group_id", "parent_task_id", "title", "task_type", "instruction", "context", "payload", "execution", "limits", "priority", "input_artifact_ids"], "request");
  const executionRaw = value.execution;
  if (!isRecord(executionRaw)) throw new Error("execution must be an object");
  rejectUnknown(executionRaw, ["capabilities", "worker_id", "runtime", "model", "resources", "workspace_id", "preference_id"], "execution");
  const capabilities = executionRaw.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 20 || capabilities.some((item) => typeof item !== "string" || item.length === 0 || item.length > 100)) throw new Error("execution.capabilities is invalid");
  const modelRaw = executionRaw.model;
  let model: TaskModelRequirement | undefined;
  if (modelRaw !== undefined) {
    if (!isRecord(modelRaw)) throw new Error("execution.model is invalid");
    rejectUnknown(modelRaw, ["name", "mode"], "execution.model");
    model = { name: optionalString(modelRaw.name, "execution.model.name") ?? undefined, mode: (modelRaw.mode ?? "any") as TaskModelRequirement["mode"] };
    if (!["required", "preferred", "any"].includes(model.mode ?? "")) throw new Error("execution.model.mode is invalid");
    if (["required", "preferred"].includes(model.mode ?? "") && !model.name) throw new Error("execution.model.name is required for this mode");
  }
  const resourcesRaw = executionRaw.resources;
  let resources: TaskExecution["resources"];
  if (resourcesRaw !== undefined) {
    if (!isRecord(resourcesRaw)) throw new Error("execution.resources is invalid");
    rejectUnknown(resourcesRaw, ["min_ram_mb", "gpu_required"], "execution.resources");
    resources = { minRamMb: nonNegativeInt(resourcesRaw.min_ram_mb, "execution.resources.min_ram_mb", 0, 1_048_576), gpuRequired: resourcesRaw.gpu_required === true };
  }
  const limitsRaw = value.limits;
  if (limitsRaw !== undefined && !isRecord(limitsRaw)) throw new Error("limits must be an object");
  const limits = isRecord(limitsRaw) ? limitsRaw : {};
  rejectUnknown(limits, ["timeout_seconds", "max_attempts"], "limits");
  const timeoutSeconds = nonNegativeInt(limits.timeout_seconds, "limits.timeout_seconds", defaults.timeoutSeconds ?? 1800, 86_400);
  if (timeoutSeconds < 1) throw new Error("limits.timeout_seconds must be positive");
  const maxAttempts = nonNegativeInt(limits.max_attempts, "limits.max_attempts", defaults.maxAttempts ?? 2, 10);
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
  const legacyWorkspace = isRecord(payload) ? optionalString(payload.workspace_id, "payload.workspace_id") : undefined;
  const executionWorkspace = optionalString(executionRaw.workspace_id, "execution.workspace_id");
  if (legacyWorkspace && executionWorkspace && legacyWorkspace !== executionWorkspace) throw new Error("WORKSPACE_CONFLICT");
  let sourceRef: TaskSourceRef | null | undefined;
  if (value.source_ref !== undefined && value.source_ref !== null) {
    if (!isRecord(value.source_ref)) throw new Error("source_ref must be an object");
    rejectUnknown(value.source_ref, ["kind", "id", "title", "url"], "source_ref");
    sourceRef = { kind: stringValue(value.source_ref.kind, "source_ref.kind", 80), id: stringValue(value.source_ref.id, "source_ref.id", 500), title: optionalString(value.source_ref.title, "source_ref.title") ?? null, url: optionalString(value.source_ref.url, "source_ref.url") ?? null };
  }
  return {
    source: stringValue(value.source ?? "hermes", "source"),
    correlationId: optionalString(value.correlation_id, "correlation_id"),
    sourceRef,
    groupId: optionalString(value.group_id, "group_id"),
    parentTaskId: optionalString(value.parent_task_id, "parent_task_id"),
    title: stringValue(value.title, "title", 1_000),
    taskType,
    instruction: stringValue(value.instruction, "instruction", 100_000),
    context: context as Record<string, JsonValue>,
    payload: payload as Record<string, JsonValue>,
    execution: { capabilities: [...capabilities] as string[], workerId: optionalString(executionRaw.worker_id, "execution.worker_id"), runtime: optionalString(executionRaw.runtime, "execution.runtime") ?? "auto", model, resources, workspaceId: executionWorkspace ?? legacyWorkspace ?? undefined, preferenceId: optionalString(executionRaw.preference_id, "execution.preference_id") ?? null },
    limits: { timeoutSeconds, maxAttempts },
    priority,
    inputArtifactIds,
  };
}

/**
 * Parse the additive v2 delegation contract. The legacy parser intentionally
 * remains strict and unchanged so an old client cannot accidentally send v2
 * fields to a reject-unknown consumer.
 */
export function parseTaskContractV2Input(value: unknown, defaults: { timeoutSeconds?: number; maxAttempts?: number } = {}): TaskContractV2Input {
  if (!isRecord(value)) throw new Error("request body must be an object");
  rejectUnknown(value, ["schema_version", "source", "idempotency_key", "source_intent_ref", "conversation_ref", "work_ref", "task_type", "description", "title", "input", "requirements", "criteria", "input_artifact_ids", "priority", "queue_deadline", "execution_timeout_seconds", "retry_policy", "approval_ref"], "request");
  if (value.schema_version !== 2) throw new Error("CONTRACT_UPGRADE_REQUIRED");
  const idempotencyKey = stringValue(value.idempotency_key, "idempotency_key", 300);
  const sourceIntentRef = stringValue(value.source_intent_ref, "source_intent_ref", 500);
  const source = stringValue(value.source ?? "hermes", "source", 120);
  const taskType = value.task_type as TaskType;
  if (!TASK_TYPES.includes(taskType)) throw new Error("task_type is invalid");
  const description = typeof value.description === "string" ? value.description : value.title;
  const instruction = stringValue(description, "description", 100_000);
  const title = stringValue(value.title ?? instruction.slice(0, 1_000), "title", 1_000);
  const input = value.input ?? {};
  if (!isRecord(input)) throw new Error("input must be an object");
  const requirementsRaw = value.requirements;
  if (!isRecord(requirementsRaw)) throw new Error("requirements must be an object");
  rejectUnknown(requirementsRaw, ["capabilities_all", "runtime", "model", "workspace_ref", "data_policy_ref", "os", "resources", "required_worker", "preferred_worker"], "requirements");
  const capabilitiesRaw = requirementsRaw.capabilities_all;
  if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length === 0 || capabilitiesRaw.length > 20) throw new Error("requirements.capabilities_all is invalid");
  const capabilities: string[] = [];
  const capabilityRequirements: JsonValue[] = [];
  for (const [index, item] of capabilitiesRaw.entries()) {
    if (!isRecord(item)) throw new Error(`requirements.capabilities_all[${index}] is invalid`);
    rejectUnknown(item, ["id", "contract_version"], `requirements.capabilities_all[${index}]`);
    const id = stringValue(item.id, `requirements.capabilities_all[${index}].id`, 120);
    const contractVersion = nonNegativeInt(item.contract_version, `requirements.capabilities_all[${index}].contract_version`, 1, 100);
    capabilities.push(id);
    capabilityRequirements.push({ id, contract_version: contractVersion });
  }
  if (taskTypeCapabilityMismatch(taskType, capabilities)) throw new Error("TASK_TYPE_CAPABILITY_MISMATCH");
  let runtime: string | undefined;
  if (requirementsRaw.runtime !== undefined && requirementsRaw.runtime !== null) {
    if (!isRecord(requirementsRaw.runtime)) throw new Error("requirements.runtime is invalid");
    rejectUnknown(requirementsRaw.runtime, ["id", "version_constraint"], "requirements.runtime");
    runtime = stringValue(requirementsRaw.runtime.id, "requirements.runtime.id", 120);
  }
  let model: TaskModelRequirement | undefined;
  if (requirementsRaw.model !== undefined && requirementsRaw.model !== null) {
    if (typeof requirementsRaw.model === "string") model = { name: stringValue(requirementsRaw.model, "requirements.model", 200), mode: "required" };
    else {
      if (!isRecord(requirementsRaw.model)) throw new Error("requirements.model is invalid");
      rejectUnknown(requirementsRaw.model, ["id", "name", "mode", "version_constraint"], "requirements.model");
      const name = optionalString(requirementsRaw.model.id ?? requirementsRaw.model.name, "requirements.model.id") ?? undefined;
      const mode = (requirementsRaw.model.mode ?? "any") as TaskModelRequirement["mode"];
      if (!name && mode !== "any") throw new Error("requirements.model.id is required for this mode");
      if (!name && mode === "any") model = { mode };
      else { if (!["required", "preferred", "any"].includes(mode ?? "")) throw new Error("requirements.model.mode is invalid"); model = { name, mode }; }
    }
  }
  const resourcesRaw = requirementsRaw.resources;
  let resources: TaskExecution["resources"] = {};
  if (resourcesRaw !== undefined && resourcesRaw !== null) {
    if (!isRecord(resourcesRaw)) throw new Error("requirements.resources is invalid");
    rejectUnknown(resourcesRaw, ["min_ram_mb", "gpu_required", "cpu_cores", "free_storage_mb"], "requirements.resources");
    resources = { minRamMb: nonNegativeInt(resourcesRaw.min_ram_mb, "requirements.resources.min_ram_mb", 0, 1_048_576), gpuRequired: resourcesRaw.gpu_required === true };
  }
  const workspaceRef = optionalString(requirementsRaw.workspace_ref, "requirements.workspace_ref") ?? undefined;
  if (taskType === "codex" && !workspaceRef) throw new Error("WORKSPACE_REQUIRED_FOR_CODEX");
  const requiredWorker = optionalString(requirementsRaw.required_worker, "requirements.required_worker") ?? undefined;
  const preferredWorker = optionalString(requirementsRaw.preferred_worker, "requirements.preferred_worker") ?? undefined;
  const criteriaRaw = value.criteria ?? [];
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length > 100) throw new Error("criteria is invalid");
  const criteria: Record<string, JsonValue>[] = criteriaRaw.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`criteria[${index}] is invalid`);
    rejectUnknown(raw, ["id", "kind", "description", "expected", "evidence_refs"], `criteria[${index}]`);
    return { id: stringValue(raw.id, `criteria[${index}].id`, 120), kind: stringValue(raw.kind ?? "custom", `criteria[${index}].kind`, 80), description: stringValue(raw.description, `criteria[${index}].description`, 2_000), expected: (raw.expected ?? null) as JsonValue, evidence_refs: (raw.evidence_refs ?? []) as JsonValue };
  });
  const timeoutSeconds = nonNegativeInt(value.execution_timeout_seconds, "execution_timeout_seconds", defaults.timeoutSeconds ?? 1_800, 86_400);
  if (timeoutSeconds < 1) throw new Error("execution_timeout_seconds must be positive");
  const retryRaw = value.retry_policy;
  if (!isRecord(retryRaw)) throw new Error("retry_policy must be an object");
  rejectUnknown(retryRaw, ["max_attempts", "effect_class"], "retry_policy");
  const maxAttempts = nonNegativeInt(retryRaw.max_attempts, "retry_policy.max_attempts", defaults.maxAttempts ?? 1, 10);
  if (maxAttempts < 1) throw new Error("retry_policy.max_attempts must be positive");
  const effectClass = String(retryRaw.effect_class ?? "READ_ONLY") as "READ_ONLY" | "WORKSPACE_WRITE" | "EXTERNAL_WRITE";
  if (!["READ_ONLY", "WORKSPACE_WRITE", "EXTERNAL_WRITE"].includes(effectClass)) throw new Error("retry_policy.effect_class is invalid");
  let queueDeadlineAt: number | null = null;
  if (value.queue_deadline !== undefined && value.queue_deadline !== null) {
    if (typeof value.queue_deadline !== "string" || !Number.isFinite(Date.parse(value.queue_deadline))) throw new Error("queue_deadline must be an RFC3339 timestamp");
    queueDeadlineAt = Date.parse(value.queue_deadline);
  }
  let workRef: { id: string; revision: number; owner: string } | null = null;
  if (value.work_ref !== undefined && value.work_ref !== null) {
    if (!isRecord(value.work_ref)) throw new Error("work_ref must be an object");
    rejectUnknown(value.work_ref, ["id", "revision", "owner"], "work_ref");
    const revision = nonNegativeInt(value.work_ref.revision, "work_ref.revision", 1, Number.MAX_SAFE_INTEGER);
    workRef = { id: stringValue(value.work_ref.id, "work_ref.id", 300), revision, owner: stringValue(value.work_ref.owner ?? "hermes", "work_ref.owner", 120) };
  }
  const inputArtifactIds = value.input_artifact_ids ?? [];
  if (!Array.isArray(inputArtifactIds) || inputArtifactIds.length > 100 || inputArtifactIds.some((item) => typeof item !== "string" || item.length === 0 || item.length > 300)) throw new Error("input_artifact_ids is invalid");
  const priority = (value.priority ?? "normal") as TaskPriority;
  if (!TASK_PRIORITIES.includes(priority)) throw new Error("priority is invalid");
  const approvalRef = optionalString(value.approval_ref, "approval_ref") ?? null;
  const requirements = { capabilities_all: capabilityRequirements, runtime: requirementsRaw.runtime ?? null, model: requirementsRaw.model ?? null, workspace_ref: workspaceRef ?? null, data_policy_ref: requirementsRaw.data_policy_ref ?? null, os: requirementsRaw.os ?? null, resources: (resourcesRaw ?? {}) as JsonValue, required_worker: requiredWorker ?? null, preferred_worker: preferredWorker ?? null } as Record<string, JsonValue>;
  return { schemaVersion: 2, executionSemantics: "platform_v2", idempotencyKey, sourceIntentRef, source, title, taskType, instruction, context: {}, payload: input as Record<string, JsonValue>, execution: { capabilities, workerId: requiredWorker ?? null, runtime: runtime ?? "auto", model, resources, workspaceId: workspaceRef, preferenceId: null }, limits: { timeoutSeconds, maxAttempts }, priority, inputArtifactIds: inputArtifactIds as string[], correlationId: typeof value.conversation_ref === "string" ? value.conversation_ref : null, sourceRef: null, groupId: null, parentTaskId: null, requirements, criteria, retryPolicy: { maxAttempts, effectClass }, queueDeadlineAt, approvalRef, workRef, conversationRef: typeof value.conversation_ref === "string" ? value.conversation_ref : null };
}

export function parseRegistrationInput(value: unknown): { name: string; registrationSecret: string; platform: string; hostname?: string; agentVersion?: string; onboardingId?: string; hardware: Record<string, JsonValue>; capabilities?: Record<string, JsonValue>[]; models?: Record<string, JsonValue>[] } {
  if (!isRecord(value)) throw new Error("request body must be an object");
  rejectUnknown(value, ["name", "registration_secret", "platform", "hostname", "agent_version", "onboarding_id", "hardware", "capabilities", "models"], "request");
  const hardware = value.hardware ?? {};
  if (!isRecord(hardware)) throw new Error("hardware must be an object");
  return { name: stringValue(value.name, "name", 200), registrationSecret: stringValue(value.registration_secret, "registration_secret", 500), platform: stringValue(value.platform, "platform", 80), hostname: optionalString(value.hostname, "hostname") ?? undefined, agentVersion: optionalString(value.agent_version, "agent_version") ?? undefined, onboardingId: optionalString(value.onboarding_id, "onboarding_id") ?? undefined, hardware: hardware as Record<string, JsonValue>, capabilities: Array.isArray(value.capabilities) ? value.capabilities as Record<string, JsonValue>[] : undefined, models: Array.isArray(value.models) ? value.models as Record<string, JsonValue>[] : undefined };
}

export const priorityNumber: Record<TaskPriority, number> = { low: 20, normal: 50, high: 80 };

export * from "./office/index.ts";
