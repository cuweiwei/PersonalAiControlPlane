import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { safeHash } from "../tasks/task-service.ts";
import { parsePlanProposal, uuidv7, type PlanProposal, type PlanStepProposal } from "../../../../packages/contracts/src/index.ts";
import { MissionService } from "./mission-service.ts";

type Row = Record<string, any>;
function parseJson(value: unknown, fallback: unknown = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }

export type PlanValidationIssue = { path: string; code: string; message: string };
export class PlanValidationError extends Error {
  readonly details: PlanValidationIssue[];
  constructor(details: PlanValidationIssue[]) { super("INVALID_PLAN"); this.name = "PlanValidationError"; this.details = details; }
}

export class PlanService {
  private readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly missions: MissionService;
  constructor(db: ControlPlaneDatabase, events: EventHub, missions: MissionService) { this.db = db; this.events = events; this.missions = missions; }

  submitPlan(commandId: string, value: unknown, now = Date.now()): Record<string, unknown> {
    const plan = this.parse(value);
    const command = this.db.one<Row>("SELECT c.*, r.mission_id, m.office_id, r.active_plan_revision, r.phase, r.control, m.objective_revision FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id JOIN missions m ON m.id = r.mission_id WHERE c.id = ?", commandId);
    if (!command) throw new Error("COMMAND_NOT_FOUND");
    if (command.kind !== "plan.requested") throw new Error("UNSUPPORTED_COMMAND");
    if (command.processing_state === "APPLIED") {
      if (command.result_hash !== safeHash(plan)) throw new Error("RESULT_CONFLICT");
      return { commandId, missionId: command.mission_id, missionRunId: command.mission_run_id, planRevision: Number(command.active_plan_revision), phase: command.phase, processingState: "APPLIED", replayed: true };
    }
    this.validate(plan, String(command.mission_id), String(command.office_id), Number(command.objective_revision), command.active_plan_revision === null ? null : Number(command.active_plan_revision));
    const planHash = safeHash(plan);
    const planId = uuidv7(now);
    let replayedInTransaction = false;
    this.db.transaction(() => {
      const latest = this.db.one<Row>("SELECT c.*, r.mission_id, m.office_id, r.active_plan_revision, r.phase, r.control, m.objective_revision FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id JOIN missions m ON m.id = r.mission_id WHERE c.id = ?", commandId);
      if (!latest) throw new Error("COMMAND_NOT_FOUND");
      if (latest.processing_state === "APPLIED") { if (latest.result_hash !== planHash) throw new Error("RESULT_CONFLICT"); replayedInTransaction = true; return; }
      if (latest.phase !== "PLANNING" || latest.control !== "ACTIVE") throw new Error("REVISION_CONFLICT");
      if (Number(latest.objective_revision) !== plan.expectedObjectiveRevision) throw new Error("REVISION_CONFLICT");
      if (plan.basePlanRevision !== null || latest.active_plan_revision !== null) throw new Error("PLAN_ALREADY_COMMITTED");
      const revision = 1;
      this.db.run("INSERT INTO mission_plans(id, mission_run_id, revision, base_revision, objective_revision, status, proposal_json, proposal_hash, command_id, created_at, activated_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)", planId, latest.mission_run_id, revision, plan.basePlanRevision, plan.expectedObjectiveRevision, JSON.stringify(plan), planHash, commandId, now, now);
      const stepIds = new Map<string, string>();
      for (const [index, step] of plan.steps.entries()) {
        const stepId = uuidv7(now + index + 1); stepIds.set(step.key, stepId);
        const member = this.memberSnapshot(step.memberId);
        const state = step.dependsOn.length === 0 ? "READY" : "PENDING";
        this.db.run("INSERT INTO mission_steps(id, plan_id, step_key, kind, member_snapshot_json, contract_json, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", stepId, planId, step.key, step.kind, JSON.stringify(member), JSON.stringify(step), state, now);
      }
      for (const step of plan.steps) for (const dependency of step.dependsOn) this.db.run("INSERT INTO mission_step_dependencies(plan_id, from_step_id, to_step_id, condition, input_mapping_json) VALUES (?, ?, ?, ?, '{}')", planId, stepIds.get(dependency.stepKey), stepIds.get(step.key), dependency.condition);
      this.db.run("UPDATE mission_runs SET phase = 'EXECUTING', active_plan_revision = ?, projection_revision = projection_revision + 1, next_wake_at = NULL WHERE id = ?", revision, latest.mission_run_id);
      this.db.run("UPDATE missions SET updated_at = ? WHERE id = ?", now, latest.mission_id);
      this.db.run("UPDATE mission_commands SET processing_state = 'APPLIED', transport_state = 'ACCEPTED', result_hash = ?, result_json = ?, applied_at = ? WHERE id = ?", planHash, JSON.stringify({ plan_revision: revision, plan_id: planId }), now, commandId);
      this.missions.appendEvent(String(latest.office_id), String(latest.mission_id), String(latest.mission_run_id), "plan.committed", { commandId, planId, planRevision: revision, stepCount: plan.steps.length }, now);
    });
    if (replayedInTransaction) return { commandId, missionId: command.mission_id, missionRunId: command.mission_run_id, planRevision: Number(command.active_plan_revision), phase: command.phase, processingState: "APPLIED", replayed: true };
    this.events.publish({ type: "mission.updated", missionId: command.mission_id, missionRunId: command.mission_run_id, phase: "EXECUTING", planRevision: 1 });
    return { commandId, missionId: command.mission_id, missionRunId: command.mission_run_id, planId, planRevision: 1, phase: "EXECUTING", processingState: "APPLIED", replayed: false };
  }

  private parse(value: unknown): PlanProposal {
    try { return parsePlanProposal(value); } catch (error) { if (error instanceof PlanValidationError) throw error; throw new PlanValidationError([{ path: "plan", code: "SCHEMA_INVALID", message: error instanceof Error ? error.message : "invalid plan" }]); }
  }

  private validate(plan: PlanProposal, missionId: string, officeId: string, objectiveRevision: number, activePlanRevision: number | null): void {
    const issues: PlanValidationIssue[] = [];
    if (plan.expectedObjectiveRevision !== objectiveRevision) issues.push({ path: "expected_objective_revision", code: "REVISION_CONFLICT", message: "Plan objective revision is stale" });
    if (activePlanRevision !== null || plan.basePlanRevision !== null) issues.push({ path: "base_plan_revision", code: "PLAN_ALREADY_COMMITTED", message: "This initial plan command cannot replace an active plan" });
    const byKey = new Map<string, PlanStepProposal>();
    for (const [index, step] of plan.steps.entries()) {
      if (byKey.has(step.key)) issues.push({ path: `steps[${index}].key`, code: "DUPLICATE_STEP_KEY", message: `Step key ${step.key} is duplicated` }); else byKey.set(step.key, step);
      const member = this.db.one<Row>("SELECT m.id FROM office_members m WHERE m.id = ? AND m.office_id = ? AND m.archived_at IS NULL", step.memberId, officeId);
      if (!member) issues.push({ path: `steps[${index}].member_id`, code: "MEMBER_NOT_FOUND", message: "Member is not active in this office" });
      if (step.kind === "WORKER_TASK" && !step.task) issues.push({ path: `steps[${index}].task`, code: "TASK_REQUIRED", message: "WORKER_TASK requires a typed task renderer" });
      if (step.kind === "HERMES_ACTION" && !step.action) issues.push({ path: `steps[${index}].action`, code: "ACTION_REQUIRED", message: "HERMES_ACTION requires PRODUCE or REVIEW" });
      if (step.kind === "WAIT_UNTIL" && !step.dueAt) issues.push({ path: `steps[${index}].due_at`, code: "DUE_AT_REQUIRED", message: "WAIT_UNTIL requires due_at" });
      if (step.required && !step.acceptance) issues.push({ path: `steps[${index}].acceptance`, code: "ACCEPTANCE_REQUIRED", message: "Required steps need an acceptance contract" });
      if (step.acceptance?.mode === "HERMES_REVIEW" && (!step.acceptance.reviewerStepKey || !step.reviewTargets?.length)) issues.push({ path: `steps[${index}].acceptance`, code: "REVIEW_TARGET_REQUIRED", message: "HERMES_REVIEW requires reviewer_step_key and review_targets" });
      for (const input of step.inputs) {
        if (input.source === "MISSION_INPUT" && input.inputId && !this.db.one("SELECT id FROM mission_inputs WHERE id = ? AND mission_id = ?", input.inputId, missionId)) issues.push({ path: `steps[${index}].inputs`, code: "INPUT_NOT_FOUND", message: "Mission input does not belong to this Mission" });
        if (input.source === "STEP_OUTPUT" && (!input.stepKey || !step.dependsOn.some((dependency) => dependency.stepKey === input.stepKey))) issues.push({ path: `steps[${index}].inputs`, code: "INPUT_DEPENDENCY_REQUIRED", message: "STEP_OUTPUT must reference a declared dependency" });
      }
      for (const dependency of step.dependsOn) {
        if (dependency.stepKey === step.key) issues.push({ path: `steps[${index}].depends_on`, code: "SELF_EDGE", message: "A step cannot depend on itself" });
        if (!byKey.has(dependency.stepKey) && !plan.steps.some((candidate) => candidate.key === dependency.stepKey)) issues.push({ path: `steps[${index}].depends_on`, code: "DEPENDENCY_NOT_FOUND", message: `Dependency ${dependency.stepKey} does not exist` });
        if (dependency.condition === "OUTPUT_AVAILABLE" && step.kind !== "HERMES_ACTION") issues.push({ path: `steps[${index}].depends_on`, code: "OUTPUT_EDGE_NOT_ALLOWED", message: "OUTPUT_AVAILABLE edges are reserved for Hermes review/check steps" });
      }
    }
    const finalMember = this.db.one<Row>("SELECT m.id FROM office_members m WHERE m.id = ? AND m.office_id = ? AND m.archived_at IS NULL", plan.finalization.memberId, officeId);
    if (!finalMember) issues.push({ path: "finalization.member_id", code: "MEMBER_NOT_FOUND", message: "Finalization member is not active in this office" });
    for (const ref of plan.finalization.artifactRefs) if (!byKey.has(ref.stepKey) && !plan.steps.some((step) => step.key === ref.stepKey)) issues.push({ path: "finalization.artifact_refs", code: "STEP_NOT_FOUND", message: `Final artifact step ${ref.stepKey} does not exist` });
    if (!this.isAcyclic(plan.steps)) issues.push({ path: "steps", code: "CYCLE", message: "Plan dependencies must be acyclic" });
    if (issues.length) throw new PlanValidationError(issues);
  }

  private isAcyclic(steps: PlanStepProposal[]): boolean {
    const indegree = new Map(steps.map((step) => [step.key, 0])); const outgoing = new Map(steps.map((step) => [step.key, [] as string[]]));
    for (const step of steps) for (const dependency of step.dependsOn) { if (!indegree.has(dependency.stepKey)) return false; indegree.set(step.key, (indegree.get(step.key) ?? 0) + 1); outgoing.get(dependency.stepKey)!.push(step.key); }
    const queue = steps.filter((step) => indegree.get(step.key) === 0).map((step) => step.key); let visited = 0;
    while (queue.length) { const key = queue.shift()!; visited += 1; for (const downstream of outgoing.get(key) ?? []) { indegree.set(downstream, indegree.get(downstream)! - 1); if (indegree.get(downstream) === 0) queue.push(downstream); } }
    return visited === steps.length;
  }

  private memberSnapshot(memberId: string): Record<string, unknown> {
    const row = this.db.one<Row>("SELECT m.*, r.name AS role_name, r.version AS role_version, r.contract_json, r.contract_hash FROM office_members m JOIN role_definitions r ON r.role_id = m.role_id AND r.version = m.role_version WHERE m.id = ?", memberId); if (!row) throw new Error("MEMBER_NOT_FOUND");
    return { memberId: row.id, displayName: row.display_name, role: { id: row.role_id, version: Number(row.role_version), name: row.role_name, contract: parseJson(row.contract_json), contractHash: row.contract_hash }, binding: parseJson(row.binding_json), maxConcurrency: Number(row.max_concurrency), configRevision: Number(row.config_revision) };
  }
}
