import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { TaskService, safeHash } from "../tasks/task-service.ts";
import { uuidv7, type CreateTaskInput, type JsonValue } from "../../../../packages/contracts/src/index.ts";
import { MissionService } from "./mission-service.ts";
import { PlanService } from "./plan-service.ts";
import { MissionCommandDispatcher } from "./command-dispatcher.ts";
import type { WorkerCoordinator } from "../workers/worker-channel.ts";

type Row = Record<string, any>;

function parseJson(value: unknown, fallback: unknown = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function record(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function terminal(value: unknown): boolean { return ["SUCCEEDED", "FAILED"].includes(String(value)); }
function activeExecution(value: unknown): boolean { return ["CREATED", "QUEUED", "RUNNING", "OUTPUT_READY", "UNKNOWN"].includes(String(value)); }

export class MissionCoordinator {
  private readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly tasks: TaskService;
  private readonly missions: MissionService;
  private readonly plans: PlanService;
  readonly commands: MissionCommandDispatcher;
  private readonly workerCoordinator?: WorkerCoordinator;
  private ticking = false;

  constructor(db: ControlPlaneDatabase, events: EventHub, tasks: TaskService, missions: MissionService, plans: PlanService, commands: MissionCommandDispatcher, workerCoordinator?: WorkerCoordinator) {
    this.db = db; this.events = events; this.tasks = tasks; this.missions = missions; this.plans = plans; this.commands = commands; this.workerCoordinator = workerCoordinator;
  }

  tick(now = Date.now()): number {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      this.recover(now);
      const runs = this.db.all<Row>("SELECT r.id FROM mission_runs r WHERE r.phase IN ('PLANNING', 'EXECUTING', 'REVIEWING', 'CANCELLED') ORDER BY r.next_wake_at IS NOT NULL, r.next_wake_at, r.started_at, r.id LIMIT 20");
      let changed = 0;
      for (const run of runs) changed += this.advance(String(run.id), now);
      return changed;
    } finally { this.ticking = false; }
  }

  async dispatchOnce(now = Date.now()): Promise<number> { return this.commands.dispatchOnce(20, now); }

  recover(now = Date.now()): number {
    let recovered = 0;
    recovered += this.commands.recoverExpiredClaims(now);
    const inbox = this.db.connection.prepare("UPDATE mission_inbox SET state = 'PENDING', claim_token = NULL, claim_until = NULL, available_at = ?, error_json = ? WHERE state = 'CLAIMED' AND claim_until IS NOT NULL AND claim_until < ?").run(now, JSON.stringify({ code: "INBOX_CLAIM_EXPIRED" }), now);
    recovered += Number(inbox.changes);
    const attempts = this.db.connection.prepare("UPDATE mission_command_attempts SET state = 'UNKNOWN', finished_at = ?, process_evidence_json = ? WHERE state IN ('ADMITTED', 'RUNNING') AND deadline_at IS NOT NULL AND deadline_at < ?").run(now, JSON.stringify({ reason: "brain_attempt_deadline_expired", observed_at: new Date(now).toISOString() }), now);
    recovered += Number(attempts.changes);
    if (Number(attempts.changes) > 0) {
      this.db.run("UPDATE mission_commands SET processing_state = 'FAILED', transport_state = 'ACCEPTED', last_error = 'BRAIN_ATTEMPT_DEADLINE_EXPIRED' WHERE current_brain_attempt_id IN (SELECT id FROM mission_command_attempts WHERE state = 'UNKNOWN') AND processing_state IN ('ADMITTED', 'RUNNING')");
      this.db.run("UPDATE mission_step_executions SET state = 'UNKNOWN', resource_state = 'UNKNOWN' WHERE command_id IN (SELECT command_id FROM mission_command_attempts WHERE state = 'UNKNOWN') AND state IN ('CREATED', 'QUEUED', 'RUNNING')");
      this.db.run("UPDATE office_resource_slots SET state = 'UNKNOWN', released_at = NULL WHERE brain_attempt_id IN (SELECT id FROM mission_command_attempts WHERE state = 'UNKNOWN') AND state <> 'FREE'");
    }
    return recovered;
  }

  enterRecovery(now = Date.now()): Record<string, unknown> {
    const epoch = randomUUID();
    this.db.transaction(() => {
      this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('office_authority_epoch', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(epoch));
      this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('office_recovery_mode', 'true') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json");
      this.db.run("UPDATE mission_runs SET wait_summary_json = ?, projection_revision = projection_revision + 1 WHERE phase NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')", JSON.stringify({ reason: "RECOVERY_MODE", enteredAt: new Date(now).toISOString() }));
    });
    this.events.publish({ type: "office.recovery.entered", authorityEpoch: epoch });
    return { recoveryMode: true, authorityEpoch: epoch };
  }

  leaveRecovery(now = Date.now()): Record<string, unknown> {
    const unknown = this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_step_executions WHERE state = 'UNKNOWN'")?.count ?? 0;
    const unknownAttempts = this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_command_attempts WHERE state = 'UNKNOWN'")?.count ?? 0;
    const unknownSlots = this.db.one<Row>("SELECT COUNT(*) AS count FROM office_resource_slots WHERE state = 'UNKNOWN'")?.count ?? 0;
    if (Number(unknown) > 0 || Number(unknownAttempts) > 0 || Number(unknownSlots) > 0) throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
    this.db.run("INSERT INTO runtime_metadata(key, value_json) VALUES ('office_recovery_mode', 'false') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json");
    this.events.publish({ type: "office.recovery.cleared", clearedAt: new Date(now).toISOString() });
    return this.recoveryStatus();
  }

  recoveryStatus(): Record<string, unknown> {
    const mode = Boolean(parseJson(this.db.one<Row>("SELECT value_json FROM runtime_metadata WHERE key = 'office_recovery_mode'")?.value_json, false));
    const epoch = String(parseJson(this.db.one<Row>("SELECT value_json FROM runtime_metadata WHERE key = 'office_authority_epoch'")?.value_json, ""));
    const unknown = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_step_executions WHERE state = 'UNKNOWN'")?.count ?? 0);
    const unknownAttempts = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_command_attempts WHERE state = 'UNKNOWN'")?.count ?? 0);
    const unknownSlots = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM office_resource_slots WHERE state = 'UNKNOWN'")?.count ?? 0);
    return { recoveryMode: mode, authorityEpoch: epoch, unknownExecutions: unknown, unknownAttempts, unknownSlots };
  }

  context(commandId: string): Record<string, unknown> | undefined {
    const row = this.db.one<Row>("SELECT c.*, r.mission_id, r.authority_epoch, r.active_plan_revision, r.objective_snapshot_json, r.scope_snapshot_json, r.limits_snapshot_json, m.goal, m.title FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id JOIN missions m ON m.id = r.mission_id WHERE c.id = ?", commandId);
    if (!row) return undefined;
    const inputs = this.db.all<Row>("SELECT id, input_seq, kind, text_json, content_hash FROM mission_inputs WHERE mission_id = ? ORDER BY input_seq", row.mission_id).map((input) => ({ id: input.id, sequence: Number(input.input_seq), kind: input.kind, text: parseJson(input.text_json).text ?? null, contentHash: input.content_hash }));
    const members = this.db.all<Row>("SELECT m.id, m.display_name, m.seat_key, m.binding_json, m.max_concurrency, r.role_id, r.version AS role_version, r.name AS role_name, r.responsibilities, r.contract_json FROM office_members m JOIN role_definitions r ON r.role_id = m.role_id AND r.version = m.role_version JOIN missions ms ON ms.office_id = m.office_id WHERE ms.id = ? AND m.archived_at IS NULL ORDER BY m.seat_key, m.id", row.mission_id).map((member) => ({ id: member.id, displayName: member.display_name, seatKey: member.seat_key, maxConcurrency: Number(member.max_concurrency), role: { id: member.role_id, version: Number(member.role_version), name: member.role_name, responsibilities: member.responsibilities, contract: parseJson(member.contract_json) }, binding: parseJson(member.binding_json) }));
    const plan = row.active_plan_revision === null || row.active_plan_revision === undefined ? null : this.db.one<Row>("SELECT proposal_json, revision, status FROM mission_plans WHERE mission_run_id = ? AND revision = ?", row.mission_run_id, row.active_plan_revision);
    const steps = plan ? this.db.all<Row>("SELECT step_key, kind, state, wait_reason, output_manifest_json, failure_json FROM mission_steps WHERE plan_id = (SELECT id FROM mission_plans WHERE mission_run_id = ? AND revision = ?) ORDER BY rowid", row.mission_run_id, row.active_plan_revision).map((step) => ({ key: step.step_key, kind: step.kind, state: step.state, waitReason: step.wait_reason, outputManifest: parseJson(step.output_manifest_json, null), failure: parseJson(step.failure_json, null) })) : [];
    return { commandId: row.id, missionId: row.mission_id, missionRunId: row.mission_run_id, authorityEpoch: row.authority_epoch, kind: row.kind, goal: row.goal, title: row.title, objective: parseJson(row.objective_snapshot_json), inputs, scope: parseJson(row.scope_snapshot_json), limits: parseJson(row.limits_snapshot_json), officeMembers: members, activePlanRevision: row.active_plan_revision ?? null, activePlan: plan ? { revision: Number(plan.revision), status: plan.status, proposal: parseJson(plan.proposal_json) } : null, steps, envelope: parseJson(row.envelope_json) };
  }

  admitCommand(commandId: string, input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const command = this.db.one<Row>("SELECT c.*, r.authority_epoch, r.control, r.phase, r.limits_snapshot_json FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id WHERE c.id = ?", commandId);
    if (!command) throw new Error("COMMAND_NOT_FOUND");
    const requestHash = String(input.request_hash ?? command.request_hash);
    if (requestHash !== String(command.request_hash)) throw new Error("RESULT_CONFLICT");
    if (this.recoveryStatus().recoveryMode) throw new Error("RECOVERY_MODE");
    if (command.processing_state === "APPLIED") return { commandId, state: "APPLIED", brainAttemptId: command.current_brain_attempt_id, replayed: true };
    if (command.current_brain_attempt_id) {
      const currentAttempt = this.db.one<Row>("SELECT state FROM mission_command_attempts WHERE id = ? AND command_id = ?", command.current_brain_attempt_id, commandId);
      if (currentAttempt?.state === "UNKNOWN") return { commandId, state: "UNKNOWN", brainAttemptId: command.current_brain_attempt_id, replayed: true, recoveryRequired: true };
    }
    if (command.control !== "ACTIVE" || ["CANCELLED", "FAILED"].includes(String(command.phase))) throw new Error("STALE_EXECUTION");
    const admissionKey = String(input.admission_key ?? `command:${commandId}`);
    const admissionHash = safeHash({ commandId, requestHash, admissionKey });
    let result!: Record<string, unknown>;
    this.db.transaction(() => {
      const latest = this.db.one<Row>("SELECT c.*, r.authority_epoch, r.control, r.phase, r.limits_snapshot_json FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id WHERE c.id = ?", commandId);
      if (!latest) throw new Error("COMMAND_NOT_FOUND");
      const existing = this.db.one<Row>("SELECT * FROM mission_command_attempts WHERE command_id = ? AND admission_key = ?", commandId, admissionKey);
      if (existing) {
        if (existing.admission_hash !== admissionHash) throw new Error("RESULT_CONFLICT");
        result = { commandId, state: existing.state, brainAttemptId: existing.id, admissionReceipt: parseJson(existing.admission_receipt_json), replayed: true };
        return;
      }
      const active = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_command_attempts WHERE state IN ('ADMITTED', 'RUNNING')")?.count ?? 0);
      if (active >= 1) throw new Error("ADMISSION_DEFERRED");
      const limits = parseJson(latest.limits_snapshot_json, {});
      const turns = Number(this.db.one<Row>("SELECT COALESCE(SUM(amount), 0) AS total FROM mission_budget_charges WHERE mission_run_id = ? AND dimension = 'hermes_turns'", latest.mission_run_id)?.total ?? 0);
      if (turns >= Number(limits.maxHermesTurns ?? 30)) throw new Error("LIMIT_WAIT_OWNER");
      this.db.run("INSERT OR IGNORE INTO office_resource_slots(resource_key, slot_no, state) VALUES ('hermes:office', 0, 'FREE')");
      const slot = this.db.one<Row>("SELECT * FROM office_resource_slots WHERE resource_key = 'hermes:office' AND slot_no = 0");
      if (slot?.state !== "FREE") throw new Error("ADMISSION_DEFERRED");
      const brainAttemptId = uuidv7(now); const attemptNumber = Number(latest.brain_attempts ?? 0) + 1; const deadlineAt = now + 900_000;
      this.db.run("INSERT INTO mission_command_attempts(id, command_id, attempt_number, admission_key, admission_hash, admission_receipt_json, state, deadline_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ADMITTED', ?, ?)", brainAttemptId, commandId, attemptNumber, admissionKey, admissionHash, JSON.stringify({ brain_attempt_id: brainAttemptId, attempt_number: attemptNumber, authority_epoch: latest.authority_epoch }), deadlineAt, now);
      this.db.run("UPDATE mission_commands SET processing_state = 'ADMITTED', current_brain_attempt_id = ?, brain_attempts = ?, last_error = NULL WHERE id = ?", brainAttemptId, attemptNumber, commandId);
      this.db.run("UPDATE office_resource_slots SET state = 'RESERVED', execution_id = (SELECT id FROM mission_step_executions WHERE command_id = ?), brain_attempt_id = ?, acquired_at = ? WHERE resource_key = 'hermes:office' AND slot_no = 0 AND state = 'FREE'", commandId, brainAttemptId, now);
      this.db.run("INSERT INTO mission_budget_charges(mission_id, mission_run_id, charge_key, dimension, amount, created_at) SELECT r.mission_id, r.id, ?, 'hermes_turns', 1, ? FROM mission_runs r WHERE r.id = ? ON CONFLICT DO NOTHING", `brain:${brainAttemptId}`, now, latest.mission_run_id);
      result = { commandId, state: "ADMITTED", brainAttemptId, attemptNumber, deadlineAt: new Date(deadlineAt).toISOString(), authorityEpoch: latest.authority_epoch, replayed: false };
    });
    this.events.publish({ type: "mission.command.admitted", commandId, brainAttemptId: result.brainAttemptId });
    return result;
  }

  progress(commandId: string, input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const attemptId = String(input.brain_attempt_id ?? ""); const sequence = Number(input.progress_seq ?? 0);
    if (!attemptId || !Number.isInteger(sequence) || sequence < 1) throw new Error("INVALID_PROGRESS");
    const changed = this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT c.*, r.authority_epoch, a.progress_seq, a.state AS attempt_state FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id JOIN mission_command_attempts a ON a.command_id = c.id AND a.id = ? WHERE c.id = ?", attemptId, commandId);
      if (!row) throw new Error("STALE_EXECUTION");
      if (String(input.authority_epoch ?? "") !== String(row.authority_epoch) || !["ADMITTED", "RUNNING"].includes(String(row.attempt_state))) throw new Error("STALE_EXECUTION");
      if (sequence <= Number(row.progress_seq ?? 0)) return false;
      this.db.run("UPDATE mission_command_attempts SET progress_seq = ?, last_heartbeat_at = ?, state = 'RUNNING' WHERE id = ?", sequence, now, attemptId);
      this.db.run("UPDATE mission_commands SET processing_state = 'RUNNING' WHERE id = ?", commandId);
      return true;
    });
    if (changed) this.events.publish({ type: "mission.command.progress", commandId, progressSeq: sequence });
    return { commandId, brainAttemptId: attemptId, progressSeq: sequence, applied: changed };
  }

  stopReceipt(commandId: string, input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const attemptId = String(input.brain_attempt_id ?? ""); const state = input.stop_state === "STOPPED" ? "STOPPED" : input.stop_state === "UNKNOWN" ? "UNKNOWN" : "";
    if (!attemptId || !state) throw new Error("INVALID_STOP_RECEIPT");
    let replayed = false;
    this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT a.*, r.authority_epoch FROM mission_command_attempts a JOIN mission_commands c ON c.id = a.command_id JOIN mission_runs r ON r.id = c.mission_run_id WHERE a.id = ? AND a.command_id = ?", attemptId, commandId); if (!row) throw new Error("STALE_EXECUTION");
      if (String(input.authority_epoch ?? "") !== String(row.authority_epoch)) throw new Error("STALE_EXECUTION");
      if (row.state === state) { replayed = true; return; }
      if (!["ADMITTED", "RUNNING"].includes(String(row.state))) throw new Error("STALE_EXECUTION");
      this.db.run("UPDATE mission_command_attempts SET state = ?, finished_at = ?, process_evidence_json = ? WHERE id = ?", state, now, JSON.stringify(input.evidence ?? {}), attemptId);
      if (state === "STOPPED") this.db.run("UPDATE office_resource_slots SET state = 'FREE', execution_id = NULL, brain_attempt_id = NULL, released_at = ? WHERE brain_attempt_id = ?", now, attemptId);
      if (state === "UNKNOWN") this.db.run("UPDATE mission_step_executions SET state = 'UNKNOWN', resource_state = 'UNKNOWN' WHERE command_id = ?", commandId);
      this.db.run("UPDATE mission_commands SET processing_state = ? WHERE id = ?", state === "STOPPED" ? "CANCELLED" : "FAILED", commandId);
    });
    this.events.publish({ type: "mission.command.stopped", commandId, brainAttemptId: attemptId, state });
    return { commandId, brainAttemptId: attemptId, state, replayed };
  }

  failCommand(commandId: string, input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const attemptId = String(input.brain_attempt_id ?? ""); const code = String(record(input.error).code ?? input.error_code ?? "BRAIN_FAILED").slice(0, 200);
    if (!attemptId || !code) throw new Error("INVALID_COMMAND_FAILURE");
    let replayed = false;
    this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT c.*, r.authority_epoch FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id JOIN mission_command_attempts a ON a.command_id = c.id AND a.id = ? WHERE c.id = ?", attemptId, commandId);
      if (!row) throw new Error("STALE_EXECUTION");
      if (String(input.authority_epoch ?? "") !== String(row.authority_epoch)) throw new Error("STALE_EXECUTION");
      const attempt = this.db.one<Row>("SELECT * FROM mission_command_attempts WHERE id = ? AND command_id = ?", attemptId, commandId);
      if (!attempt) throw new Error("STALE_EXECUTION");
      if (["FAILED", "STOPPED"].includes(String(attempt.state))) { replayed = true; return; }
      const unknown = String(input.stop_state ?? "") === "UNKNOWN";
      const attemptState = unknown ? "UNKNOWN" : "FAILED";
      this.db.run("UPDATE mission_command_attempts SET state = ?, finished_at = ?, process_evidence_json = ? WHERE id = ?", attemptState, now, JSON.stringify(input.evidence ?? { code }), attemptId);
      if (unknown) {
        this.db.run("UPDATE mission_step_executions SET state = 'UNKNOWN', resource_state = 'UNKNOWN' WHERE command_id = ? AND state IN ('CREATED', 'QUEUED', 'RUNNING')", commandId);
        this.db.run("UPDATE office_resource_slots SET state = 'UNKNOWN', released_at = NULL WHERE brain_attempt_id = ? AND state <> 'FREE'", attemptId);
      } else {
        this.db.run("UPDATE office_resource_slots SET state = 'FREE', execution_id = NULL, brain_attempt_id = NULL, released_at = ? WHERE brain_attempt_id = ?", now, attemptId);
      }
      this.db.run("UPDATE mission_commands SET processing_state = 'FAILED', transport_state = 'ACCEPTED', last_error = ? WHERE id = ?", code, commandId);
    });
    if (!replayed) this.events.publish({ type: "mission.command.failed", commandId, brainAttemptId: attemptId, code });
    return { commandId, brainAttemptId: attemptId, state: "FAILED", errorCode: code, replayed };
  }

  applyCommandResult(commandId: string, input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const command = this.db.one<Row>("SELECT c.*, r.mission_id, r.authority_epoch, r.phase, r.control, r.active_plan_revision, r.objective_snapshot_json FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id WHERE c.id = ?", commandId);
    if (!command) throw new Error("COMMAND_NOT_FOUND");
    if (String(input.authority_epoch ?? "") !== String(command.authority_epoch)) throw new Error("STALE_EXECUTION");
    if (command.kind === "plan.requested") {
      const result = this.plans.submitPlan(commandId, input.result ?? input.plan ?? input, now);
      const attemptId = String(input.brain_attempt_id ?? command.current_brain_attempt_id ?? "");
      if (attemptId) this.db.transaction(() => { this.db.run("UPDATE mission_command_attempts SET state = 'RESULT_READY', result_hash = ?, finished_at = ? WHERE id = ? AND command_id = ? AND state IN ('ADMITTED', 'RUNNING', 'RESULT_READY')", safeHash(input.result ?? input.plan ?? input), now, attemptId, commandId); this.db.run("UPDATE office_resource_slots SET state = 'FREE', execution_id = NULL, brain_attempt_id = NULL, released_at = ? WHERE brain_attempt_id = ?", now, attemptId); });
      return result;
    }
    const resultValue = input.result && typeof input.result === "object" ? input.result : input;
    const resultHash = safeHash(resultValue);
    if (input.result_hash && input.result_hash !== resultHash) throw new Error("RESULT_CONFLICT");
    if (command.processing_state === "APPLIED") { if (command.result_hash !== resultHash) throw new Error("RESULT_CONFLICT"); return { commandId, state: "APPLIED", applicationState: "APPLIED", replayed: true }; }
    if (String(input.authority_epoch ?? "") !== String(command.authority_epoch)) throw new Error("STALE_EXECUTION");
    let output!: Record<string, unknown>;
    this.db.transaction(() => {
      const latest = this.db.one<Row>("SELECT c.*, r.mission_id, r.authority_epoch, r.phase, r.control, r.active_plan_revision FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id WHERE c.id = ?", commandId);
      if (!latest) throw new Error("COMMAND_NOT_FOUND");
      if (latest.processing_state === "APPLIED") { if (latest.result_hash !== resultHash) throw new Error("RESULT_CONFLICT"); output = { commandId, state: "APPLIED", applicationState: "APPLIED", replayed: true }; return; }
      const attemptId = String(input.brain_attempt_id ?? latest.current_brain_attempt_id ?? "");
      if (attemptId) {
        const attempt = this.db.one<Row>("SELECT * FROM mission_command_attempts WHERE id = ? AND command_id = ?", attemptId, commandId);
        if (!attempt || !["ADMITTED", "RUNNING", "RESULT_READY"].includes(String(attempt.state))) throw new Error("STALE_EXECUTION");
        this.db.run("UPDATE mission_command_attempts SET state = 'RESULT_READY', result_hash = ?, finished_at = ? WHERE id = ?", resultHash, now, attemptId);
        this.db.run("UPDATE office_resource_slots SET state = 'FREE', execution_id = NULL, brain_attempt_id = NULL, released_at = ? WHERE brain_attempt_id = ?", now, attemptId);
      }
      if (latest.kind === "mission.finalize") {
        const required = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_steps s JOIN mission_plans p ON p.id = s.plan_id WHERE p.mission_run_id = ? AND p.revision = ? AND s.contract_json NOT LIKE '%\"required\":false%'", latest.mission_run_id, latest.active_plan_revision)?.count ?? 0);
        const accepted = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_steps s JOIN mission_plans p ON p.id = s.plan_id WHERE p.mission_run_id = ? AND p.revision = ? AND s.state = 'SUCCEEDED' AND s.contract_json NOT LIKE '%\"required\":false%'", latest.mission_run_id, latest.active_plan_revision)?.count ?? 0);
        if (!latest.active_plan_revision || accepted < required) throw new Error("FINALIZATION_INCOMPLETE");
        const manifest = record((resultValue as Row).final_manifest ?? (resultValue as Row).finalManifest ?? (resultValue as Row).manifest);
        this.db.run("UPDATE mission_runs SET phase = 'COMPLETED', finished_at = ?, cleanup_state = 'CLEAR', projection_revision = projection_revision + 1, wait_summary_json = ? WHERE id = ?", now, JSON.stringify({ acceptedSteps: accepted, requiredSteps: required }), latest.mission_run_id);
        this.db.run("UPDATE mission_commands SET processing_state = 'APPLIED', transport_state = 'ACCEPTED', result_hash = ?, result_json = ?, applied_at = ?, last_error = NULL WHERE id = ?", resultHash, JSON.stringify(resultValue), now, commandId);
        this.db.run("UPDATE missions SET updated_at = ? WHERE id = ?", now, latest.mission_id);
        const mission = this.db.one<Row>("SELECT delivery_target_json, office_id FROM missions WHERE id = ?", latest.mission_id);
        if (parseJson(mission?.delivery_target_json, {}).mode === "HERMES_CHANNEL") {
          const target = parseJson(mission?.delivery_target_json, {}).targetRef ?? {};
          const targetKey = safeHash(target);
          const deliveryId = uuidv7(now + 1); const deliveryCommandId = uuidv7(now + 2);
          this.db.run("INSERT OR IGNORE INTO mission_deliveries(id, mission_run_id, final_manifest_hash, target_key, target_ref_json, state, command_id, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)", deliveryId, latest.mission_run_id, resultHash, targetKey, JSON.stringify(target), deliveryCommandId, now);
          const deliveryEnvelope = { protocol_version: 1, command_id: deliveryCommandId, kind: "mission.deliver", authority_epoch: latest.authority_epoch, mission_id: latest.mission_id, mission_run_id: latest.mission_run_id, final_manifest: manifest, target_ref: target, result_hash: resultHash };
          this.db.run("INSERT OR IGNORE INTO mission_commands(id, mission_run_id, kind, logical_key, envelope_json, request_hash, transport_state, processing_state, next_send_at) VALUES (?, ?, 'mission.deliver', ?, ?, ?, 'PENDING', 'NOT_STARTED', ?)", deliveryCommandId, latest.mission_run_id, `delivery:${targetKey}:${resultHash}`, JSON.stringify(deliveryEnvelope), safeHash(deliveryEnvelope), now);
        }
        this.missions.appendEvent(String(mission?.office_id), latest.mission_id, latest.mission_run_id, "mission.completed", { commandId, resultHash, manifest }, now);
        output = { commandId, missionId: latest.mission_id, missionRunId: latest.mission_run_id, state: "COMPLETED", applicationState: "APPLIED", resultHash, replayed: false };
      } else {
        const execution = this.db.one<Row>("SELECT e.*, s.plan_id, s.step_key, p.revision, p.objective_revision, r.office_id FROM mission_step_executions e JOIN mission_steps s ON s.id = e.step_id JOIN mission_plans p ON p.id = s.plan_id JOIN mission_runs r ON r.id = p.mission_run_id WHERE e.command_id = ?", commandId);
        if (!execution || Number(execution.revision) !== Number(latest.active_plan_revision)) throw new Error("STALE_EXECUTION");
        const manifest = (resultValue as Row).result_manifest ?? (resultValue as Row).resultManifest ?? (resultValue as Row).manifest ?? resultValue;
        this.db.run("UPDATE mission_step_executions SET state = 'SUCCEEDED', finished_at = ?, resource_state = 'CLEAR' WHERE id = ?", now, execution.id);
        this.db.run("UPDATE mission_steps SET state = 'SUCCEEDED', output_manifest_json = ?, output_ready_at = ?, accepted_at = ?, wait_reason = NULL, failure_json = NULL, updated_at = ? WHERE id = ?", JSON.stringify(manifest), now, now, now, execution.step_id);
        this.db.run("UPDATE mission_commands SET processing_state = 'APPLIED', transport_state = 'ACCEPTED', result_hash = ?, result_json = ?, applied_at = ?, last_error = NULL WHERE id = ?", resultHash, JSON.stringify(resultValue), now, commandId);
        this.db.run("UPDATE mission_step_executions SET resource_state = 'CLEAR' WHERE id = ?", execution.id);
        this.missions.appendEvent(String(execution.office_id), latest.mission_id, latest.mission_run_id, "step.accepted", { commandId, stepId: execution.step_id, stepKey: execution.step_key, resultHash }, now);
        output = { commandId, missionId: latest.mission_id, missionRunId: latest.mission_run_id, stepId: execution.step_id, state: "SUCCEEDED", applicationState: "APPLIED", resultHash, replayed: false };
      }
    });
    this.events.publish({ type: "mission.updated", missionId: command.mission_id, missionRunId: command.mission_run_id, commandId, state: output.state });
    return output;
  }

  deliveryReceipt(input: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    const deliveryId = String(input.delivery_id ?? ""); if (!deliveryId) throw new Error("DELIVERY_NOT_FOUND");
    const result = this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT * FROM mission_deliveries WHERE id = ?", deliveryId); if (!row) throw new Error("DELIVERY_NOT_FOUND");
      const revision = Number(input.receipt_revision ?? 0); if (revision < Number(row.receipt_revision ?? 0)) return { deliveryId, state: row.state, replayed: true };
      if (revision === Number(row.receipt_revision ?? 0) && row.receipt_json && safeHash(parseJson(row.receipt_json)) !== safeHash(input)) throw new Error("RECEIPT_CONFLICT");
      const state = ["DELIVERED", "FAILED", "UNCERTAIN", "ATTENTION"].includes(String(input.state)) ? String(input.state) : "UNCERTAIN";
      this.db.run("UPDATE mission_deliveries SET state = ?, receipt_revision = ?, receipt_json = ?, delivered_at = CASE WHEN ? = 'DELIVERED' THEN ? ELSE delivered_at END, last_error = ? WHERE id = ?", state, revision, JSON.stringify(input), state, now, input.last_error ?? null, deliveryId);
      return { deliveryId, state, receiptRevision: revision, replayed: false };
    });
    this.events.publish({ type: "mission.delivery.updated", deliveryId, state: result.state });
    return result;
  }

  health(): Record<string, unknown> {
    const command = this.commands.status(); const recovery = this.recoveryStatus();
    const lastEvent = this.db.one<Row>("SELECT MAX(created_at) AS value FROM mission_events")?.value ?? null;
    const active = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_runs WHERE phase NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')")?.count ?? 0);
    return { ...command, ...recovery, activeMissions: active, lastEventAt: lastEvent ? new Date(Number(lastEvent)).toISOString() : null, coordinator: "RUNNING" };
  }

  close(): void { /* no process handles are owned by the CP coordinator */ }

  private advance(runId: string, now: number): number {
    let changed = 0;
    this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT r.*, m.office_id, m.id AS mission_id, m.deadline_at, m.deadline_mode FROM mission_runs r JOIN missions m ON m.id = r.mission_id WHERE r.id = ?", runId);
      if (!row || terminal(row.phase)) return;
      if (this.recoveryStatus().recoveryMode) { this.setRunWait(row, { reason: "RECOVERY_MODE" }, now); return; }
      changed += this.reconcileTasks(row, now);
      if (row.control !== "ACTIVE") { if (row.control === "CANCEL_REQUESTED") this.cancelMissionTasks(row, now); this.setRunWait(row, { reason: row.control === "PAUSE_REQUESTED" ? "MISSION_PAUSED" : "CANCEL_REQUESTED" }, now); return; }
      if (row.deadline_mode === "HARD" && row.deadline_at && Number(row.deadline_at) <= now) { this.failRun(row, "DEADLINE_EXCEEDED", now); return; }
      const limits = parseJson(row.limits_snapshot_json, {}); if (Number(limits.maxElapsedSeconds) > 0 && now - Number(row.started_at) > Number(limits.maxElapsedSeconds) * 1_000) { this.failRun(row, "MAX_ELAPSED_EXCEEDED", now); return; }
      if (row.phase === "PLANNING" || row.active_plan_revision === null || row.active_plan_revision === undefined) { this.setRunWait(row, { reason: "WAITING_HERMES_PLAN" }, now); return; }
      const plan = this.db.one<Row>("SELECT * FROM mission_plans WHERE mission_run_id = ? AND revision = ? AND status = 'ACTIVE'", runId, row.active_plan_revision); if (!plan) { this.setRunWait(row, { reason: "PLAN_MISSING" }, now); return; }
      const steps = this.db.all<Row>("SELECT * FROM mission_steps WHERE plan_id = ? ORDER BY rowid", plan.id);
      const required = steps.filter((step) => parseJson(step.contract_json).required !== false);
      const failed = required.find((step) => step.state === "FAILED"); if (failed) { this.failRun(row, "STEP_FAILED", now); return; }
      const live = steps.some((step) => activeExecution(step.state));
      if (required.length > 0 && required.every((step) => step.state === "SUCCEEDED") && !live) { this.ensureFinalize(row, plan, now); return; }
      const activeCount = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_step_executions e JOIN mission_steps s ON s.id = e.step_id JOIN mission_plans p ON p.id = s.plan_id WHERE p.mission_run_id = ? AND e.state IN ('CREATED', 'QUEUED', 'RUNNING', 'OUTPUT_READY', 'UNKNOWN')", runId)?.count ?? 0);
      if (activeCount >= Number(limits.maxActiveExecutions ?? 3)) { this.setRunWait(row, { reason: "MISSION_CAPACITY_BUSY", activeCount }, now); return; }
      const candidate = steps.find((step) => !step.current_execution_id && ["READY", "PENDING"].includes(String(step.state)) && this.dependenciesAccepted(step.id, plan.id));
      if (!candidate) { this.setRunWait(row, { reason: "WAITING_DEPENDENCY" }, now); return; }
      const contract = parseJson(candidate.contract_json, {}); const dueAt = contract.dueAt ? Date.parse(String(contract.dueAt)) : null;
      if (candidate.kind === "WAIT_UNTIL" && dueAt && dueAt > now) { this.db.run("UPDATE mission_steps SET state = 'WAITING', wait_reason = 'WAIT_UNTIL', next_wake_at = ? WHERE id = ?", dueAt, candidate.id); this.setRunWait(row, { reason: "WAIT_UNTIL", stepId: candidate.id }, now, dueAt); return; }
      if (candidate.kind === "HUMAN_INPUT") { this.db.run("UPDATE mission_steps SET state = 'WAITING', wait_reason = 'WAITING_OWNER', next_wake_at = NULL WHERE id = ?", candidate.id); this.setRunWait(row, { reason: "WAITING_OWNER", stepId: candidate.id }, now); return; }
      if (dueAt && dueAt > now) { this.setRunWait(row, { reason: "WAIT_UNTIL", stepId: candidate.id }, now, dueAt); return; }
      if (candidate.kind === "WAIT_UNTIL") { this.db.run("UPDATE mission_steps SET state = 'SUCCEEDED', accepted_at = ?, output_ready_at = ?, output_manifest_json = ? WHERE id = ?", now, now, JSON.stringify({ kind: "WAIT_UNTIL", dueAt: contract.dueAt ?? null }), candidate.id); changed += 1; return; }
      if (candidate.kind === "WORKER_TASK") { this.createWorkerExecution(row, plan, candidate, contract, now); changed += 1; }
      else if (candidate.kind === "HERMES_ACTION") { this.createHermesExecution(row, plan, candidate, contract, now); changed += 1; }
      this.setRunWait(row, { reason: "EXECUTION_QUEUED", stepId: candidate.id }, now);
    });
    return changed;
  }

  private dependenciesAccepted(stepId: string, planId: string): boolean {
    const dependencies = this.db.all<Row>("SELECT d.condition, s.state, s.output_manifest_json FROM mission_step_dependencies d JOIN mission_steps s ON s.id = d.from_step_id WHERE d.to_step_id = ? AND d.plan_id = ?", stepId, planId);
    return dependencies.every((dependency) => dependency.condition === "OUTPUT_AVAILABLE" ? dependency.output_manifest_json !== null : dependency.state === "SUCCEEDED");
  }

  private createWorkerExecution(run: Row, plan: Row, step: Row, contract: Row, now: number): void {
    const member = this.db.one<Row>("SELECT binding_json FROM office_members WHERE id = ? AND archived_at IS NULL", step.member_snapshot_json ? parseJson(step.member_snapshot_json).memberId : "");
    if (!member) { this.db.run("UPDATE mission_steps SET state = 'WAITING', wait_reason = 'MEMBER_NOT_FOUND', updated_at = ? WHERE id = ?", now, step.id); return; }
    const limits = parseJson(run.limits_snapshot_json, {}); const used = Number(this.db.one<Row>("SELECT COALESCE(SUM(amount), 0) AS total FROM mission_budget_charges WHERE mission_run_id = ? AND dimension = 'worker_attempts'", run.id)?.total ?? 0); if (used >= Number(limits.maxWorkerAttempts ?? 100)) { this.setRunWait(run, { reason: "LIMIT_WAIT_OWNER", dimension: "worker_attempts" }, now); return; }
    const executionId = uuidv7(now); const binding = parseJson(member.binding_json, {}); const operationKey = `mission:${run.mission_id}:step:${step.id}:generation:${Number(step.execution_generation ?? 1)}`;
    const taskType = String(contract.task?.taskType ?? "generic"); const template = this.template(contract.task?.payloadTemplate); const workspaceId = String(binding.workspace_id ?? binding.workspaceId ?? template.workspace_id ?? ""); const payload = { ...template, ...(workspaceId ? { workspace_id: workspaceId } : {}), instruction: contract.instruction ?? template.instruction ?? "" };
    const scope = parseJson(run.scope_snapshot_json, { workspaceIds: [] }); if (workspaceId && (!Array.isArray(scope.workspaceIds) || !scope.workspaceIds.includes(workspaceId))) { this.db.run("UPDATE mission_steps SET state = 'WAITING', wait_reason = 'SCOPE_BLOCKED', updated_at = ? WHERE id = ?", now, step.id); return; }
    const modelName = binding.model_id ?? binding.modelId ?? binding.model; const taskInput: CreateTaskInput = { source: "virtual-office", sourceRef: { kind: "mission-step", id: step.id }, correlationId: run.mission_id, groupId: run.mission_id, parentTaskId: null, title: `${run.mission_id} · ${step.step_key}`, taskType: taskType as CreateTaskInput["taskType"], instruction: String(contract.instruction ?? payload.instruction ?? step.step_key), context: { mission_id: run.mission_id, mission_run_id: run.id, plan_revision: Number(plan.revision), step_id: step.id, execution_generation: Number(step.execution_generation ?? 1) }, payload: payload as Record<string, JsonValue>, execution: { capabilities: Array.isArray(binding.capabilities) && binding.capabilities.length ? binding.capabilities.map(String) : [taskType], workerId: binding.worker_id ?? binding.workerId ?? undefined, runtime: String(binding.runtime ?? "auto"), ...(modelName ? { model: { name: String(modelName), mode: "required" as const } } : {}), ...(workspaceId ? { workspaceId, workspaceAccess: "WRITE_EXCLUSIVE" } : {}) }, limits: { timeoutSeconds: Number(contract.limits?.timeoutSeconds ?? 1800), maxAttempts: Number(contract.limits?.maxAttempts ?? 2) }, priority: "normal", inputArtifactIds: [], purpose: "MISSION" };
    this.db.run("INSERT INTO mission_step_executions(id, step_id, generation, backend_kind, state, retry_safety, operation_key, request_hash, resolved_target_json) VALUES (?, ?, ?, 'WORKER', 'QUEUED', ?, ?, ?, ?)", executionId, step.id, Number(step.execution_generation ?? 1), contract.retrySafety ?? "REPLAY_SAFE", operationKey, safeHash(taskInput), JSON.stringify(taskInput.execution));
    const created = this.tasks.createInTx(taskInput, now, { ownerKind: "MISSION", missionExecutionId: executionId });
    this.db.run("UPDATE mission_step_executions SET task_id = ?, task_run_id = ? WHERE id = ?", created.id, created.runId, executionId);
    this.db.run("UPDATE mission_steps SET state = 'QUEUED', current_execution_id = ?, wait_reason = NULL, updated_at = ? WHERE id = ?", executionId, now, step.id);
    this.db.run("INSERT INTO mission_budget_charges(mission_id, mission_run_id, charge_key, dimension, amount, created_at) VALUES (?, ?, ?, 'worker_attempts', 1, ?) ON CONFLICT DO NOTHING", run.mission_id, run.id, `execution:${executionId}`, now);
    this.missions.appendEvent(run.office_id, run.mission_id, run.id, "step.execution.created", { stepId: step.id, executionId, taskId: created.id, taskRunId: created.runId, backend: "WORKER" }, now);
  }

  private createHermesExecution(run: Row, plan: Row, step: Row, contract: Row, now: number): void {
    const member = parseJson(step.member_snapshot_json, {}); const binding = record(member.binding); const executionId = uuidv7(now); const commandId = uuidv7(now + 1); const generation = Number(step.execution_generation ?? 1);
    const profileRef = { id: String(binding.profile_id ?? binding.profileId ?? "default"), version: Number(binding.profile_version ?? binding.profileVersion ?? 1) };
    const envelope = { protocol_version: 1, command_id: commandId, kind: "step.execute", authority_epoch: run.authority_epoch, mission_id: run.mission_id, mission_run_id: run.id, expected_objective_revision: Number(run.objective_snapshot_json ? parseJson(run.objective_snapshot_json).objectiveRevision ?? 1 : 1), base_plan_revision: Number(plan.revision), step_id: step.id, execution_generation: generation, profile_ref: profileRef, action: contract.action ?? "PRODUCE", output_schema_id: contract.outputContract?.schemaId ?? contract.acceptance?.schemaId ?? null, context_ref: { kind: "MISSION_STEP", mission_run_id: run.id, step_id: step.id }, expires_at: run.deadline_at ? new Date(Number(run.deadline_at)).toISOString() : null };
    const operationKey = `mission:${run.mission_id}:step:${step.id}:generation:${generation}`;
    this.db.run("INSERT INTO mission_step_executions(id, step_id, generation, backend_kind, command_id, state, retry_safety, operation_key, request_hash, resolved_target_json) VALUES (?, ?, ?, 'HERMES', ?, 'QUEUED', ?, ?, ?, ?)", executionId, step.id, generation, commandId, contract.retrySafety ?? "REPLAY_SAFE", operationKey, safeHash(envelope), JSON.stringify(profileRef));
    this.db.run("INSERT INTO mission_commands(id, mission_run_id, step_execution_id, kind, logical_key, envelope_json, request_hash, transport_state, processing_state, next_send_at) VALUES (?, ?, ?, 'step.execute', ?, ?, ?, 'PENDING', 'NOT_STARTED', ?)", commandId, run.id, executionId, operationKey, JSON.stringify({ ...envelope, request_hash: safeHash(envelope) }), safeHash(envelope), now);
    this.db.run("UPDATE mission_steps SET state = 'QUEUED', current_execution_id = ?, wait_reason = NULL, updated_at = ? WHERE id = ?", executionId, now, step.id);
    this.missions.appendEvent(run.office_id, run.mission_id, run.id, "step.execution.created", { stepId: step.id, executionId, commandId, backend: "HERMES" }, now);
  }

  private ensureFinalize(run: Row, plan: Row, now: number): void {
    const exists = this.db.one<Row>("SELECT id FROM mission_commands WHERE mission_run_id = ? AND logical_key = ?", run.id, `finalize:${plan.revision}`); if (exists) return;
    const commandId = uuidv7(now); const envelope = { protocol_version: 1, command_id: commandId, kind: "mission.finalize", authority_epoch: run.authority_epoch, mission_id: run.mission_id, mission_run_id: run.id, expected_objective_revision: Number(parseJson(run.objective_snapshot_json).objectiveRevision ?? 1), plan_revision: Number(plan.revision), context_ref: { kind: "MISSION_FINALIZATION", mission_run_id: run.id } };
    this.db.run("UPDATE mission_runs SET phase = 'REVIEWING', next_wake_at = NULL, projection_revision = projection_revision + 1 WHERE id = ?", run.id);
    this.db.run("INSERT INTO mission_commands(id, mission_run_id, kind, logical_key, envelope_json, request_hash, transport_state, processing_state, next_send_at) VALUES (?, ?, 'mission.finalize', ?, ?, ?, 'PENDING', 'NOT_STARTED', ?)", commandId, run.id, `finalize:${plan.revision}`, JSON.stringify(envelope), safeHash(envelope), now);
    this.missions.appendEvent(run.office_id, run.mission_id, run.id, "mission.finalization.requested", { commandId, planRevision: plan.revision }, now);
  }

  private reconcileTasks(run: Row, now: number): number {
    let changed = 0;
    const rows = this.db.all<Row>("SELECT e.*, s.id AS step_id, s.state AS step_state, t.status AS task_status, t.result_summary_json, t.failure_code, t.failure_message, a.occupancy AS task_occupancy, a.stop_evidence_json FROM mission_step_executions e JOIN mission_steps s ON s.id = e.step_id LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN task_attempts a ON a.id = t.current_attempt_id JOIN mission_plans p ON p.id = s.plan_id WHERE p.mission_run_id = ? AND e.backend_kind = 'WORKER' AND e.state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED')", run.id);
    for (const item of rows) {
      const status = String(item.task_status ?? "");
      if (status === "SUCCEEDED") { const stored = parseJson(item.result_summary_json, {}); this.db.run("UPDATE mission_step_executions SET state = 'SUCCEEDED', finished_at = ?, resource_state = 'CLEAR' WHERE id = ?", now, item.id); this.db.run("UPDATE mission_steps SET state = 'SUCCEEDED', output_manifest_json = ?, output_ready_at = ?, accepted_at = ?, current_execution_id = ?, wait_reason = NULL, updated_at = ? WHERE id = ?", JSON.stringify(stored.resultManifest ?? stored), now, now, item.id, now, item.step_id); changed += 1; }
      else if (status === "FAILED") { this.db.run("UPDATE mission_step_executions SET state = 'FAILED', finished_at = ?, resource_state = 'CLEAR' WHERE id = ?", now, item.id); this.db.run("UPDATE mission_steps SET state = 'FAILED', failure_json = ?, current_execution_id = ?, updated_at = ? WHERE id = ?", JSON.stringify({ code: item.failure_code, message: item.failure_message }), item.id, now, item.step_id); changed += 1; }
      else if (status === "CANCELLED") {
        const evidence = parseJson(item.stop_evidence_json, null);
        const stopped = item.task_occupancy === "RELEASED" && evidence?.stop_state === "STOPPED" && evidence.children_accounted_for === true;
        if (stopped) { this.db.run("UPDATE mission_step_executions SET state = 'CANCELLED', finished_at = ?, resource_state = 'CLEAR' WHERE id = ?", now, item.id); this.db.run("UPDATE mission_steps SET state = 'CANCELLED', current_execution_id = ?, updated_at = ? WHERE id = ?", item.id, now, item.step_id); changed += 1; }
        else { this.db.run("UPDATE mission_step_executions SET state = 'UNKNOWN', resource_state = 'UNKNOWN' WHERE id = ?", item.id); this.db.run("UPDATE mission_steps SET state = 'WAITING', wait_reason = 'RECONCILIATION_REQUIRED', updated_at = ? WHERE id = ?", now, item.step_id); }
      }
      else if (["ASSIGNED", "RUNNING"].includes(status)) { this.db.run("UPDATE mission_step_executions SET state = 'RUNNING', started_at = COALESCE(started_at, ?) WHERE id = ?", now, item.id); this.db.run("UPDATE mission_steps SET state = 'RUNNING', wait_reason = NULL, updated_at = ? WHERE id = ?", now, item.step_id); }
    }
    return changed;
  }

  cancelRun(runId: string, now = Date.now()): void {
    const run = this.db.one<Row>("SELECT r.*, m.office_id, m.id AS mission_id FROM mission_runs r JOIN missions m ON m.id = r.mission_id WHERE r.id = ?", runId);
    if (run && run.control === "CANCEL_REQUESTED") this.cancelMissionTasks(run, now);
  }

  private cancelMissionTasks(run: Row, now: number): void {
    const rows = this.db.all<Row>("SELECT t.id, t.current_attempt_id FROM tasks t JOIN mission_step_executions e ON e.task_id = t.id WHERE t.owner_kind = 'MISSION' AND e.step_id IN (SELECT s.id FROM mission_steps s JOIN mission_plans p ON p.id = s.plan_id WHERE p.mission_run_id = ?) AND t.status IN ('QUEUED', 'ASSIGNED', 'RUNNING')", run.id);
    for (const row of rows) {
      const cancelled = this.tasks.cancel(String(row.id), now);
      const attemptId = String(cancelled?.currentAttemptId ?? row.current_attempt_id ?? "");
      if (attemptId && this.workerCoordinator) {
        const workerId = String(this.db.one<Row>("SELECT worker_id FROM task_attempts WHERE id = ?", attemptId)?.worker_id ?? "");
        if (workerId) this.workerCoordinator.cancel(workerId, String(row.id), attemptId);
      }
    }
    const commands = this.db.all<Row>("SELECT c.*, e.id AS execution_id FROM mission_commands c JOIN mission_step_executions e ON e.command_id = c.id WHERE c.mission_run_id = ? AND c.kind = 'step.execute' AND c.processing_state IN ('NOT_STARTED', 'ADMITTED', 'RUNNING')", run.id);
    for (const command of commands) {
      const attemptId = String(command.current_brain_attempt_id ?? "");
      if (!attemptId) { this.db.run("UPDATE mission_commands SET processing_state = 'CANCELLED', transport_state = 'ACCEPTED', last_error = 'OWNER_CANCELLED' WHERE id = ?", command.id); continue; }
      const logicalKey = `cancel:${command.id}:${attemptId}`;
      if (this.db.one("SELECT id FROM mission_commands WHERE mission_run_id = ? AND logical_key = ?", run.id, logicalKey)) continue;
      const cancelId = uuidv7(now); const envelope = { protocol_version: 1, command_id: cancelId, kind: "execution.cancel", authority_epoch: run.authority_epoch, mission_id: run.mission_id, mission_run_id: run.id, target_command_id: command.id, target_brain_attempt_id: attemptId, context_ref: { kind: "MISSION_CANCEL", mission_run_id: run.id, target_command_id: command.id } };
      this.db.run("INSERT INTO mission_commands(id, mission_run_id, kind, logical_key, envelope_json, request_hash, transport_state, processing_state, next_send_at) VALUES (?, ?, 'execution.cancel', ?, ?, ?, 'PENDING', 'NOT_STARTED', ?)", cancelId, run.id, logicalKey, JSON.stringify(envelope), safeHash(envelope), now);
    }
  }

  private setRunWait(run: Row, summary: Record<string, unknown>, now: number, nextWakeAt: number | null = null): void { this.db.run("UPDATE mission_runs SET wait_summary_json = ?, next_wake_at = ?, projection_revision = projection_revision + 1 WHERE id = ?", JSON.stringify(summary), nextWakeAt, run.id); }
  private failRun(run: Row, reason: string, now: number): void { this.db.run("UPDATE mission_runs SET phase = 'FAILED', finished_at = ?, stop_reason = ?, wait_summary_json = ?, projection_revision = projection_revision + 1 WHERE id = ?", now, reason, JSON.stringify({ reason }), run.id); this.db.run("UPDATE missions SET updated_at = ? WHERE id = ?", now, run.mission_id); this.missions.appendEvent(run.office_id, run.mission_id, run.id, "mission.failed", { reason }, now); }
  private template(value: unknown): Record<string, any> { if (typeof value !== "string") return {}; try { const parsed = JSON.parse(value); return record(parsed); } catch { return { prompt: value }; } }
}
