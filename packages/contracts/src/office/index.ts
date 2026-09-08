import type { JsonValue } from "../index.ts";

export const MISSION_PHASES = ["PLANNING", "EXECUTING", "REVIEWING", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type MissionPhase = typeof MISSION_PHASES[number];
export const PLAN_STEP_KINDS = ["WORKER_TASK", "HERMES_ACTION", "HUMAN_INPUT", "WAIT_UNTIL"] as const;
export type PlanStepKind = typeof PLAN_STEP_KINDS[number];
export const DEPENDENCY_CONDITIONS = ["ACCEPTED", "OUTPUT_AVAILABLE"] as const;
export type DependencyCondition = typeof DEPENDENCY_CONDITIONS[number];
export const RETRY_SAFETY = ["REPLAY_SAFE", "IDEMPOTENT_EFFECT", "NON_REPLAYABLE"] as const;
export type RetrySafety = typeof RETRY_SAFETY[number];

export type MissionInput = { kind: "TEXT"; text: string };
export type MissionCreateInput = {
  officeId: string;
  brainProtocolVersion?: 1 | 2;
  sourceIntentKey?: string | null;
  conversationRef?: string | null;
  title: string;
  goal: string;
  inputs: MissionInput[];
  scope: { workspaceIds: string[]; capabilities: string[]; externalEffects: string[] };
  limits?: { maxElapsedSeconds?: number; maxHermesTurns?: number; maxWorkerAttempts?: number; maxActiveExecutions?: number; maxReplans?: number; onLimit?: "WAIT_OWNER" | "FAIL" };
  deadline?: { at: string | null; mode: "SOFT" | "HARD" };
  delivery?: { mode: "OFFICE_ONLY" | "HERMES_CHANNEL"; targetRef?: Record<string, JsonValue> };
  sourceRef?: Record<string, JsonValue> | null;
  acceptance?: Array<{ id: string; kind: string; required: boolean; description: string; verifierRef?: string | null }>;
};
export type PlanDependencyProposal = { stepKey: string; condition: DependencyCondition };
export type PlanInputProposal = { name: string; source: "MISSION_INPUT" | "STEP_OUTPUT"; inputId?: string; stepKey?: string; artifactName?: string };
export type PlanStepProposal = {
  key: string; kind: PlanStepKind; memberId: string; required: boolean;
  dependsOn: PlanDependencyProposal[]; inputs: PlanInputProposal[]; instruction?: string;
  task?: { taskType: string; payloadTemplate: string }; action?: "PRODUCE" | "REVIEW";
  outputContract?: { schemaId: string; requiredArtifactNames: string[] };
  acceptance?: { mode: "HERMES_REVIEW" | "STRUCTURED_RESULT"; schemaId?: string; reviewerStepKey?: string };
  reviewTargets?: string[]; retrySafety: RetrySafety;
  limits: { queueTimeoutSeconds: number; timeoutSeconds: number; maxAttempts: number }; dueAt?: string;
};
export type PlanProposal = { schemaVersion: 1; expectedObjectiveRevision: number; basePlanRevision: number | null; steps: PlanStepProposal[]; finalization: { memberId: string; artifactRefs: Array<{ stepKey: string; artifactName: string }> } };
export type RoleCreateInput = { name: string; responsibilities: string; contract: Record<string, JsonValue> };
export type MemberCreateInput = { roleId: string; roleVersion: number; displayName: string; avatarKey?: string | null; seatKey: string; binding: Record<string, JsonValue>; maxConcurrency: number };

export const BRAIN_ACTIONS = ["COMPLETE", "SELF_TOOL", "DELEGATE", "WAIT", "ASK_OWNER", "REPLAN", "STOP"] as const;
export type BrainAction = typeof BRAIN_ACTIONS[number];
export type BrainDecision = {
  brainProtocolVersion: 2;
  commandId: string;
  brainAttemptId: string;
  authorityEpoch: string;
  expectedObjectiveRevision: number;
  expectedControlRevision: number;
  expectedContextRevision: number;
  decisionGeneration: number;
  action: BrainAction;
  rationaleSummary: string;
  payload: Record<string, JsonValue>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], context: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`UNKNOWN_FIELD:${context}.${key}`); }
function requiredString(value: unknown, field: string, max: number): string { if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`INVALID_FIELD:${field}`); return value; }
function optionalString(value: unknown, field: string, max: number): string | undefined { return value === undefined || value === null ? undefined : requiredString(value, field, max); }
function boundedInt(value: unknown, field: string, fallback: number, min: number, max: number): number { if (value === undefined) return fallback; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`INVALID_FIELD:${field}`); return value; }
function stringArray(value: unknown, field: string, maxItems: number, maxLength = 200): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > maxLength)) throw new Error(`INVALID_FIELD:${field}`); return [...value]; }

export function parseCreateMissionInput(value: unknown): MissionCreateInput {
  if (!isRecord(value)) throw new Error("INVALID_MISSION");
  rejectUnknown(value, ["office_id", "brain_protocol_version", "source_intent_key", "conversation_ref", "title", "goal", "inputs", "scope", "limits", "deadline", "delivery", "source_ref", "acceptance"], "mission");
  if (!isRecord(value.scope)) throw new Error("INVALID_FIELD:scope");
  rejectUnknown(value.scope, ["workspace_ids", "capabilities", "external_effects"], "scope");
  const inputsRaw = value.inputs ?? [];
  if (!Array.isArray(inputsRaw) || inputsRaw.length > 100) throw new Error("INVALID_FIELD:inputs");
  const inputs = inputsRaw.map((item, index) => { if (!isRecord(item)) throw new Error(`INVALID_FIELD:inputs[${index}]`); rejectUnknown(item, ["kind", "text"], `inputs[${index}]`); if (item.kind !== "TEXT") throw new Error(`INVALID_FIELD:inputs[${index}].kind`); return { kind: "TEXT" as const, text: requiredString(item.text, `inputs[${index}].text`, 32 * 1024) }; });
  const limitsRaw = value.limits; if (limitsRaw !== undefined && !isRecord(limitsRaw)) throw new Error("INVALID_FIELD:limits"); const limits = isRecord(limitsRaw) ? limitsRaw : {}; rejectUnknown(limits, ["max_elapsed_seconds", "max_hermes_turns", "max_worker_attempts", "max_active_executions", "max_replans", "on_limit"], "limits");
  const deadlineRaw = value.deadline; if (deadlineRaw !== undefined && !isRecord(deadlineRaw)) throw new Error("INVALID_FIELD:deadline"); const deadline = isRecord(deadlineRaw) ? deadlineRaw : {}; rejectUnknown(deadline, ["at", "mode"], "deadline");
  const deadlineAt = deadline.at === null || deadline.at === undefined ? null : requiredString(deadline.at, "deadline.at", 80); if (deadlineAt !== null && !Number.isFinite(Date.parse(deadlineAt))) throw new Error("INVALID_FIELD:deadline.at"); const deadlineMode = deadline.mode ?? "SOFT"; if (deadlineMode !== "SOFT" && deadlineMode !== "HARD") throw new Error("INVALID_FIELD:deadline.mode");
  const deliveryRaw = value.delivery; if (deliveryRaw !== undefined && !isRecord(deliveryRaw)) throw new Error("INVALID_FIELD:delivery"); const delivery = isRecord(deliveryRaw) ? deliveryRaw : {}; rejectUnknown(delivery, ["mode", "target_ref"], "delivery"); const deliveryMode = delivery.mode ?? "OFFICE_ONLY"; if (deliveryMode !== "OFFICE_ONLY" && deliveryMode !== "HERMES_CHANNEL") throw new Error("INVALID_FIELD:delivery.mode"); if (delivery.target_ref !== undefined && !isRecord(delivery.target_ref)) throw new Error("INVALID_FIELD:delivery.target_ref");
  const sourceRef = value.source_ref === null || value.source_ref === undefined ? null : isRecord(value.source_ref) ? value.source_ref : (() => { throw new Error("INVALID_FIELD:source_ref"); })();
  const onLimit = limits.on_limit ?? "WAIT_OWNER"; if (onLimit !== "WAIT_OWNER" && onLimit !== "FAIL") throw new Error("INVALID_FIELD:limits.on_limit");
  const brainProtocolVersion = value.brain_protocol_version === undefined ? 1 : value.brain_protocol_version; if (brainProtocolVersion !== 1 && brainProtocolVersion !== 2) throw new Error("INVALID_FIELD:brain_protocol_version");
  const sourceIntentKey = value.source_intent_key === undefined || value.source_intent_key === null ? null : requiredString(value.source_intent_key, "source_intent_key", 300);
  const conversationRef = value.conversation_ref === undefined || value.conversation_ref === null ? null : requiredString(value.conversation_ref, "conversation_ref", 300);
  const acceptanceRaw = value.acceptance ?? []; if (!Array.isArray(acceptanceRaw) || acceptanceRaw.length > 100) throw new Error("INVALID_FIELD:acceptance");
  const acceptance = acceptanceRaw.map((item, index) => { if (!isRecord(item)) throw new Error(`INVALID_FIELD:acceptance[${index}]`); rejectUnknown(item, ["id", "kind", "required", "description", "verifier_ref"], `acceptance[${index}]`); if (typeof item.required !== "boolean") throw new Error(`INVALID_FIELD:acceptance[${index}].required`); return { id: requiredString(item.id, `acceptance[${index}].id`, 100), kind: requiredString(item.kind, `acceptance[${index}].kind`, 100), required: item.required, description: requiredString(item.description, `acceptance[${index}].description`, 2_000), verifierRef: item.verifier_ref === undefined || item.verifier_ref === null ? null : requiredString(item.verifier_ref, `acceptance[${index}].verifier_ref`, 300) }; });
  return { officeId: requiredString(value.office_id, "office_id", 200), brainProtocolVersion: brainProtocolVersion as 1 | 2, sourceIntentKey, conversationRef, title: requiredString(value.title, "title", 200), goal: requiredString(value.goal, "goal", 32 * 1024), inputs, scope: { workspaceIds: stringArray(value.scope.workspace_ids, "scope.workspace_ids", 100), capabilities: stringArray(value.scope.capabilities, "scope.capabilities", 100), externalEffects: stringArray(value.scope.external_effects, "scope.external_effects", 100) }, limits: { maxElapsedSeconds: boundedInt(limits.max_elapsed_seconds, "limits.max_elapsed_seconds", 604800, 3600, 2_592_000), maxHermesTurns: boundedInt(limits.max_hermes_turns, "limits.max_hermes_turns", 30, 1, 200), maxWorkerAttempts: boundedInt(limits.max_worker_attempts, "limits.max_worker_attempts", 100, 1, 1000), maxActiveExecutions: boundedInt(limits.max_active_executions, "limits.max_active_executions", 3, 1, 10), maxReplans: boundedInt(limits.max_replans, "limits.max_replans", 3, 0, 10), onLimit }, deadline: { at: deadlineAt, mode: deadlineMode }, delivery: { mode: deliveryMode, ...(delivery.target_ref ? { targetRef: delivery.target_ref as Record<string, JsonValue> } : {}) }, sourceRef: sourceRef as Record<string, JsonValue> | null, acceptance };
}

export function parseBrainDecision(value: unknown): BrainDecision {
  if (!isRecord(value)) throw new Error("INVALID_BRAIN_DECISION");
  rejectUnknown(value, ["brain_protocol_version", "command_id", "brain_attempt_id", "authority_epoch", "expected_objective_revision", "expected_control_revision", "expected_context_revision", "decision_generation", "action", "rationale_summary", "payload"], "brain_decision");
  if (value.brain_protocol_version !== 2) throw new Error("INVALID_FIELD:brain_protocol_version");
  const action = value.action; if (!BRAIN_ACTIONS.includes(action as BrainAction)) throw new Error("INVALID_FIELD:action");
  if (!isRecord(value.payload)) throw new Error("INVALID_FIELD:payload");
  const requiredRevision = (candidate: unknown, field: string): number => boundedInt(candidate, field, Number.NaN, 1, 10_000);
  if (value.expected_objective_revision === undefined || value.expected_control_revision === undefined || value.expected_context_revision === undefined || value.decision_generation === undefined) throw new Error("INVALID_BRAIN_DECISION");
  return { brainProtocolVersion: 2, commandId: requiredString(value.command_id, "command_id", 300), brainAttemptId: requiredString(value.brain_attempt_id, "brain_attempt_id", 300), authorityEpoch: requiredString(value.authority_epoch, "authority_epoch", 300), expectedObjectiveRevision: requiredRevision(value.expected_objective_revision, "expected_objective_revision"), expectedControlRevision: requiredRevision(value.expected_control_revision, "expected_control_revision"), expectedContextRevision: requiredRevision(value.expected_context_revision, "expected_context_revision"), decisionGeneration: requiredRevision(value.decision_generation, "decision_generation"), action: action as BrainAction, rationaleSummary: requiredString(value.rationale_summary, "rationale_summary", 1_000), payload: value.payload as Record<string, JsonValue> };
}

export function parseCreateRoleInput(value: unknown): RoleCreateInput {
  if (!isRecord(value)) throw new Error("INVALID_ROLE");
  rejectUnknown(value, ["name", "responsibilities", "contract"], "role");
  if (!isRecord(value.contract ?? {})) throw new Error("INVALID_FIELD:contract");
  return { name: requiredString(value.name, "name", 100), responsibilities: requiredString(value.responsibilities, "responsibilities", 16 * 1024), contract: (value.contract ?? {}) as Record<string, JsonValue> };
}

export function parseCreateMemberInput(value: unknown): MemberCreateInput {
  if (!isRecord(value)) throw new Error("INVALID_MEMBER");
  rejectUnknown(value, ["role_id", "role_version", "display_name", "avatar_key", "seat_key", "binding", "max_concurrency"], "member");
  if (!isRecord(value.binding ?? {})) throw new Error("INVALID_FIELD:binding");
  return { roleId: requiredString(value.role_id, "role_id", 200), roleVersion: boundedInt(value.role_version, "role_version", 1, 1, 10_000), displayName: requiredString(value.display_name, "display_name", 100), avatarKey: value.avatar_key === null || value.avatar_key === undefined ? null : requiredString(value.avatar_key, "avatar_key", 100), seatKey: requiredString(value.seat_key, "seat_key", 100), binding: (value.binding ?? {}) as Record<string, JsonValue>, maxConcurrency: boundedInt(value.max_concurrency, "max_concurrency", 1, 1, 10) };
}

function parsePlanStep(value: unknown, index: number): PlanStepProposal {
  if (!isRecord(value)) throw new Error(`INVALID_FIELD:steps[${index}]`);
  rejectUnknown(value, ["key", "kind", "member_id", "required", "depends_on", "inputs", "instruction", "task", "action", "output_contract", "acceptance", "review_targets", "retry_safety", "limits", "due_at"], `steps[${index}]`);
  const kind = value.kind; if (!PLAN_STEP_KINDS.includes(kind as PlanStepKind)) throw new Error(`INVALID_FIELD:steps[${index}].kind`);
  const dependencyRaw = value.depends_on ?? []; if (!Array.isArray(dependencyRaw)) throw new Error(`INVALID_FIELD:steps[${index}].depends_on`);
  const dependsOn = dependencyRaw.map((item, dependencyIndex) => { if (!isRecord(item)) throw new Error(`INVALID_FIELD:steps[${index}].depends_on[${dependencyIndex}]`); rejectUnknown(item, ["step_key", "condition"], `steps[${index}].depends_on[${dependencyIndex}]`); const condition = item.condition ?? "ACCEPTED"; if (!DEPENDENCY_CONDITIONS.includes(condition as DependencyCondition)) throw new Error(`INVALID_FIELD:steps[${index}].depends_on[${dependencyIndex}].condition`); return { stepKey: requiredString(item.step_key, "dependency.step_key", 100), condition: condition as DependencyCondition }; });
  const inputsRaw = value.inputs ?? []; if (!Array.isArray(inputsRaw)) throw new Error(`INVALID_FIELD:steps[${index}].inputs`);
  const inputs = inputsRaw.map((item, inputIndex) => { if (!isRecord(item)) throw new Error(`INVALID_FIELD:steps[${index}].inputs[${inputIndex}]`); rejectUnknown(item, ["name", "source", "input_id", "step_key", "artifact_name"], `steps[${index}].inputs[${inputIndex}]`); const source = item.source; if (source !== "MISSION_INPUT" && source !== "STEP_OUTPUT") throw new Error(`INVALID_FIELD:steps[${index}].inputs[${inputIndex}].source`); return { name: requiredString(item.name, "input.name", 100), source: source as "MISSION_INPUT" | "STEP_OUTPUT", ...(item.input_id !== undefined ? { inputId: requiredString(item.input_id, "input.input_id", 200) } : {}), ...(item.step_key !== undefined ? { stepKey: requiredString(item.step_key, "input.step_key", 100) } : {}), ...(item.artifact_name !== undefined ? { artifactName: requiredString(item.artifact_name, "input.artifact_name", 200) } : {}) }; });
  const limitsRaw = value.limits; if (!isRecord(limitsRaw)) throw new Error(`INVALID_FIELD:steps[${index}].limits`); rejectUnknown(limitsRaw, ["queue_timeout_seconds", "timeout_seconds", "max_attempts"], `steps[${index}].limits`);
  const outputRaw = value.output_contract; if (outputRaw !== undefined && !isRecord(outputRaw)) throw new Error(`INVALID_FIELD:steps[${index}].output_contract`);
  const outputContract = isRecord(outputRaw) ? (() => { rejectUnknown(outputRaw, ["schema_id", "required_artifact_names"], `steps[${index}].output_contract`); return { schemaId: requiredString(outputRaw.schema_id, "output_contract.schema_id", 200), requiredArtifactNames: stringArray(outputRaw.required_artifact_names, "output_contract.required_artifact_names", 50) }; })() : undefined;
  const acceptanceRaw = value.acceptance; if (acceptanceRaw !== undefined && !isRecord(acceptanceRaw)) throw new Error(`INVALID_FIELD:steps[${index}].acceptance`);
  const acceptance = isRecord(acceptanceRaw) ? (() => { rejectUnknown(acceptanceRaw, ["mode", "schema_id", "reviewer_step_key"], `steps[${index}].acceptance`); const mode = acceptanceRaw.mode; if (mode !== "HERMES_REVIEW" && mode !== "STRUCTURED_RESULT") throw new Error(`INVALID_FIELD:steps[${index}].acceptance.mode`); return { mode: mode as "HERMES_REVIEW" | "STRUCTURED_RESULT", ...(acceptanceRaw.schema_id !== undefined ? { schemaId: requiredString(acceptanceRaw.schema_id, "acceptance.schema_id", 200) } : {}), ...(acceptanceRaw.reviewer_step_key !== undefined ? { reviewerStepKey: requiredString(acceptanceRaw.reviewer_step_key, "acceptance.reviewer_step_key", 100) } : {}) }; })() : undefined;
  const taskRaw = value.task; if (taskRaw !== undefined && !isRecord(taskRaw)) throw new Error(`INVALID_FIELD:steps[${index}].task`);
  const task = isRecord(taskRaw) ? (() => { rejectUnknown(taskRaw, ["task_type", "payload_template"], `steps[${index}].task`); return { taskType: requiredString(taskRaw.task_type, "task.task_type", 200), payloadTemplate: requiredString(taskRaw.payload_template, "task.payload_template", 200) }; })() : undefined;
  const action = value.action === undefined ? undefined : value.action as "PRODUCE" | "REVIEW"; if (action !== undefined && action !== "PRODUCE" && action !== "REVIEW") throw new Error(`INVALID_FIELD:steps[${index}].action`);
  const retrySafety = (value.retry_safety ?? "REPLAY_SAFE") as RetrySafety; if (!RETRY_SAFETY.includes(retrySafety)) throw new Error(`INVALID_FIELD:steps[${index}].retry_safety`);
  const dueAt = optionalString(value.due_at, `steps[${index}].due_at`, 80); if (dueAt && !Number.isFinite(Date.parse(dueAt))) throw new Error(`INVALID_FIELD:steps[${index}].due_at`);
  if (value.required !== undefined && typeof value.required !== "boolean") throw new Error(`INVALID_FIELD:steps[${index}].required`);
  return { key: requiredString(value.key, `steps[${index}].key`, 100), kind: kind as PlanStepKind, memberId: requiredString(value.member_id, `steps[${index}].member_id`, 200), required: value.required ?? true, dependsOn, inputs, ...(value.instruction === undefined ? {} : { instruction: requiredString(value.instruction, `steps[${index}].instruction`, 32 * 1024) }), ...(task ? { task } : {}), ...(action ? { action } : {}), ...(outputContract ? { outputContract } : {}), ...(acceptance ? { acceptance } : {}), reviewTargets: stringArray(value.review_targets, `steps[${index}].review_targets`, 50, 100), retrySafety, limits: { queueTimeoutSeconds: boundedInt(limitsRaw.queue_timeout_seconds, "queue_timeout_seconds", 86_400, 60, 604_800), timeoutSeconds: boundedInt(limitsRaw.timeout_seconds, "timeout_seconds", 1800, 1, 86_400), maxAttempts: boundedInt(limitsRaw.max_attempts, "max_attempts", 2, 1, 10) }, ...(dueAt ? { dueAt } : {}) };
}

export function parsePlanProposal(value: unknown): PlanProposal {
  if (!isRecord(value)) throw new Error("INVALID_PLAN");
  rejectUnknown(value, ["schema_version", "expected_objective_revision", "base_plan_revision", "steps", "finalization"], "plan");
  if (value.schema_version !== 1) throw new Error("INVALID_FIELD:plan.schema_version");
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 100) throw new Error("INVALID_FIELD:plan.steps");
  if (!isRecord(value.finalization)) throw new Error("INVALID_FIELD:plan.finalization");
  rejectUnknown(value.finalization, ["member_id", "artifact_refs"], "plan.finalization");
  const refs = value.finalization.artifact_refs ?? []; if (!Array.isArray(refs)) throw new Error("INVALID_FIELD:plan.finalization.artifact_refs");
  const artifactRefs = refs.map((item, index) => { if (!isRecord(item)) throw new Error(`INVALID_FIELD:artifact_refs[${index}]`); rejectUnknown(item, ["step_key", "artifact_name"], `artifact_refs[${index}]`); return { stepKey: requiredString(item.step_key, "artifact_ref.step_key", 100), artifactName: requiredString(item.artifact_name, "artifact_ref.artifact_name", 200) }; });
  const basePlanRevision = value.base_plan_revision === null || value.base_plan_revision === undefined ? null : boundedInt(value.base_plan_revision, "plan.base_plan_revision", 0, 0, 10_000);
  return { schemaVersion: 1, expectedObjectiveRevision: boundedInt(value.expected_objective_revision, "plan.expected_objective_revision", 1, 1, 10_000), basePlanRevision, steps: value.steps.map(parsePlanStep), finalization: { memberId: requiredString(value.finalization.member_id, "plan.finalization.member_id", 200), artifactRefs } };
}
