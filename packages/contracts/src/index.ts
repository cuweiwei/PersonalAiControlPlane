export const TASK_STATES = [
  "PENDING",
  "ESTIMATING",
  "WAITING_APPROVAL",
  "READY",
  "DISPATCHED",
  "RUNNING",
  "WAITING_RESOURCE",
  "WAITING_QUOTA",
  "WAITING_AUTH",
  "WAITING_RECONCILIATION",
  "CHECKPOINTED",
  "RESUMING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const GOAL_STATES = [
  "PENDING",
  "PLANNING",
  "WAITING_APPROVAL",
  "ACTIVE",
  "VERIFYING",
  "COMPLETED",
  "REJECTED",
  "CANCELLING",
  "CANCELLED",
  "FAILED",
] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export type GoalSource = {
  kind: "web" | "hermes" | "proactive" | "self-extension" | "schedule";
  correlationId?: string;
};

export type MemoryRequirement = "required" | "preferred" | "none";

export type GoalCreateInput = {
  intent: string;
  source: GoalSource;
  scope?: string[];
  constraints?: {
    deadline?: string | null;
    maxDurationMs?: number | null;
    maxTokens?: number | null;
    maxMonetaryMicros?: number;
    allowedWorkers?: string[];
    allowDeployment?: boolean;
  };
  memoryRequirement?: MemoryRequirement;
};

export type TaskEvent = {
  type: "STATE_TRANSITION" | "EVIDENCE" | "RESULT" | "CANCEL_REQUESTED";
  actor: string;
  reason?: string;
  evidence?: Record<string, unknown>;
};

export type SideEffectClass = "NONE" | "READ_ONLY" | "IDEMPOTENT_MUTATION" | "NON_IDEMPOTENT_MUTATION";

export type PlanTaskInput = {
  taskId: string;
  type: string;
  title: string;
  dependsOn?: string[];
  required: boolean;
  sideEffectClass: SideEffectClass;
  capabilityRequirements?: Record<string, unknown>[];
  budget?: Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  retryPolicy?: Record<string, unknown>;
  verification?: Record<string, unknown>;
  idempotencyKey?: string;
};

export type PlanInput = {
  schemaVersion: 1;
  goalId: string;
  revision: number;
  intent: string;
  acceptanceCriteria: Array<{ id: string; description: string; verificationTaskId: string }>;
  tasks: PlanTaskInput[];
  assumptions?: string[];
  context?: Record<string, unknown>;
  estimate?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  createdBy?: Record<string, unknown>;
  createdAt?: string;
};

export type GoalRecord = {
  id: string;
  ownerId: string;
  source: GoalSource;
  intent: string;
  scope: string[];
  constraints: NonNullable<GoalCreateInput["constraints"]>;
  memoryRequirement: MemoryRequirement;
  status: GoalState;
  activePlanRevision: number | null;
  stateVersion: number;
  policyVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type ApiError = {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${context}.${key} is not allowed`);
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

export function parseGoalCreateInput(value: unknown): GoalCreateInput {
  if (!isRecord(value)) throw new Error("request body must be an object");
  rejectUnknown(value, ["intent", "source", "scope", "constraints", "memoryRequirement"], "request");
  if (typeof value.intent !== "string" || value.intent.trim().length === 0 || value.intent.length > 20_000) {
    throw new Error("intent must be a non-empty string of at most 20000 characters");
  }
  if (!isRecord(value.source) || !["web", "hermes", "proactive", "self-extension", "schedule"].includes(value.source.kind as string)) {
    throw new Error("source.kind is invalid");
  }
  rejectUnknown(value.source, ["kind", "correlationId"], "source");
  const source: GoalSource = { kind: value.source.kind as GoalSource["kind"] };
  const correlationId = optionalString(value.source.correlationId, "source.correlationId");
  if (correlationId !== undefined) source.correlationId = correlationId;
  const scope = value.scope === undefined ? [] : value.scope;
  if (!Array.isArray(scope) || scope.length > 50 || scope.some((item) => typeof item !== "string" || item.length === 0 || item.length > 200)) {
    throw new Error("scope must be an array of at most 50 non-empty strings");
  }
  const rawConstraints = value.constraints === undefined ? {} : value.constraints;
  if (!isRecord(rawConstraints)) throw new Error("constraints must be an object");
  rejectUnknown(rawConstraints, ["deadline", "maxDurationMs", "maxTokens", "maxMonetaryMicros", "allowedWorkers", "allowDeployment"], "constraints");
  const constraints = {
    deadline: rawConstraints.deadline === undefined || rawConstraints.deadline === null
      ? null
      : optionalString(rawConstraints.deadline, "constraints.deadline") ?? null,
    maxDurationMs: optionalNonNegativeNumber(rawConstraints.maxDurationMs, "constraints.maxDurationMs") ?? null,
    maxTokens: optionalNonNegativeNumber(rawConstraints.maxTokens, "constraints.maxTokens") ?? null,
    maxMonetaryMicros: optionalNonNegativeNumber(rawConstraints.maxMonetaryMicros, "constraints.maxMonetaryMicros") ?? 0,
    allowedWorkers: rawConstraints.allowedWorkers === undefined ? [] : rawConstraints.allowedWorkers,
    allowDeployment: rawConstraints.allowDeployment === true,
  };
  if (!Array.isArray(constraints.allowedWorkers) || constraints.allowedWorkers.length > 20 || constraints.allowedWorkers.some((item) => typeof item !== "string")) {
    throw new Error("constraints.allowedWorkers must be an array of at most 20 strings");
  }
  const memoryRequirement = value.memoryRequirement ?? "preferred";
  if (!["required", "preferred", "none"].includes(memoryRequirement as string)) {
    throw new Error("memoryRequirement is invalid");
  }
  return { intent: value.intent, source, scope, constraints, memoryRequirement: memoryRequirement as MemoryRequirement };
}

export function parseTaskState(value: unknown): TaskState {
  if (typeof value !== "string" || !(TASK_STATES as readonly string[]).includes(value)) throw new Error("invalid task state");
  return value as TaskState;
}
