import { ControlPlaneDatabase } from "../db/database.ts";
import { EventHub } from "../events/event-hub.ts";
import { SettingsService } from "../settings/settings-service.ts";
import { safeHash } from "../tasks/task-service.ts";
import { uuidv7, type MissionCreateInput } from "../../../../packages/contracts/src/index.ts";

type Row = Record<string, any>;
function parseJson(value: unknown, fallback: unknown = {}): any { try { return value === null || value === undefined ? fallback : JSON.parse(String(value)); } catch { return fallback; } }
function iso(value: unknown): string | null { return typeof value === "number" ? new Date(value).toISOString() : null; }
function missionPhaseTerminal(phase: string): boolean { return ["COMPLETED", "FAILED", "CANCELLED"].includes(phase); }

export class MissionService {
  private readonly db: ControlPlaneDatabase;
  private readonly events: EventHub;
  private readonly settings: SettingsService;
  constructor(db: ControlPlaneDatabase, events: EventHub, settings: SettingsService) { this.db = db; this.events = events; this.settings = settings; }

  isEnabled(): boolean { return this.settings.get().office_enabled === true; }

  create(input: MissionCreateInput, idempotencyKey: string, now = Date.now()): { response: Record<string, unknown>; replayed: boolean } {
    if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const requestHash = safeHash(input);
    const scope = `mission:create:${input.officeId}`;
    if (input.sourceIntentKey) {
      const source = this.db.one<Row>("SELECT m.id, m.current_mission_run_id, m.source_intent_hash FROM missions m WHERE m.source_intent_key = ?", input.sourceIntentKey);
      if (source) {
        if (source.source_intent_hash && source.source_intent_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
        return { response: { missionId: source.id, missionRunId: source.current_mission_run_id, sourceIntentKey: input.sourceIntentKey, replayed: true }, replayed: true };
      }
    }
    const prior = this.db.one<Row>("SELECT status_code, request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return { response: parseJson(prior.response_json), replayed: true }; }
    const missionId = uuidv7(now); const runId = uuidv7(now + 1); const commandId = uuidv7(now + 2); const epoch = this.authorityEpoch();
    let replayedInTransaction = false;
    this.db.transaction(() => {
      const committed = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
      if (committed) { if (committed.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); replayedInTransaction = true; return; }
      const office = this.db.one<Row>("SELECT id FROM offices WHERE id = ? AND archived_at IS NULL", input.officeId);
      if (!office) throw new Error("OFFICE_NOT_FOUND");
      if (!this.isEnabled()) throw new Error("OFFICE_DISABLED");
      if ((input.brainProtocolVersion ?? 1) === 2 && this.settings.get().hermes_brain_v2_enabled !== true) throw new Error("BRAIN_V2_DISABLED");
      const active = Number(this.db.one<Row>("SELECT COUNT(*) AS count FROM mission_runs r JOIN missions m ON m.id = r.mission_id WHERE m.office_id = ? AND r.phase NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')", input.officeId)?.count ?? 0);
      const maxActive = Number(this.settings.get().office_max_active_missions ?? 5);
      if (active >= maxActive) throw new Error("MISSION_LIMIT_REACHED");
      const configured = this.settings.get();
      const limits = {
        maxElapsedSeconds: input.limits?.maxElapsedSeconds ?? Number(configured.office_default_max_elapsed_seconds ?? 604800),
        maxHermesTurns: input.limits?.maxHermesTurns ?? Number(configured.office_default_max_hermes_turns ?? 30),
        maxWorkerAttempts: input.limits?.maxWorkerAttempts ?? Number(configured.office_default_max_worker_attempts ?? 100),
        maxActiveExecutions: input.limits?.maxActiveExecutions ?? Number(configured.office_default_run_concurrency ?? 3),
        maxReplans: input.limits?.maxReplans ?? Number(configured.office_default_max_replans ?? 3),
        onLimit: input.limits?.onLimit ?? "WAIT_OWNER",
      };
      const deadlineAt = input.deadline?.at ? Date.parse(input.deadline.at) : null;
      this.db.run("INSERT INTO missions(id, office_id, title, goal, source_ref_json, source_intent_key, source_intent_hash, conversation_ref, acceptance_json, scope_json, limits_json, delivery_target_json, mission_revision, objective_revision, current_mission_run_id, first_started_at, deadline_at, deadline_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)", missionId, input.officeId, input.title, input.goal, input.sourceRef ? JSON.stringify(input.sourceRef) : null, input.sourceIntentKey ?? null, input.sourceIntentKey ? requestHash : null, input.conversationRef ?? null, JSON.stringify(input.acceptance ?? []), JSON.stringify(input.scope), JSON.stringify(limits), JSON.stringify(input.delivery ?? { mode: "OFFICE_ONLY" }), runId, now, deadlineAt, input.deadline?.mode ?? "SOFT", now, now);
      for (const [index, item] of input.inputs.entries()) this.db.run("INSERT INTO mission_inputs(id, mission_id, input_seq, objective_revision, kind, text_json, content_hash, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)", uuidv7(now + index + 3), missionId, index + 1, item.kind, JSON.stringify({ text: item.text }), safeHash(item), now);
      const brainVersion = input.brainProtocolVersion ?? 1;
      this.db.run("INSERT INTO mission_runs(id, mission_id, run_number, phase, control, control_revision, objective_snapshot_json, limits_snapshot_json, scope_snapshot_json, projection_revision, authority_epoch, brain_protocol_version, brain_state, decision_pending, started_at) VALUES (?, ?, 1, 'PLANNING', 'ACTIVE', 1, ?, ?, ?, 1, ?, ?, ?, ?, ?)", runId, missionId, JSON.stringify({ missionRevision: 1, objectiveRevision: 1, title: input.title, goal: input.goal }), JSON.stringify(limits), JSON.stringify(input.scope), epoch, brainVersion, brainVersion === 2 ? "DECISION_QUEUED" : "IDLE", brainVersion === 2 ? 1 : 0, now);
      const commandKind = brainVersion === 2 ? "mission.decide" : "plan.requested";
      const logicalKey = brainVersion === 2 ? `decide:${runId}:1` : `plan:${runId}:1`;
      const envelope = { protocol_version: 1, brain_protocol_version: brainVersion, command_id: commandId, kind: commandKind, authority_epoch: epoch, mission_id: missionId, mission_run_id: runId, expected_objective_revision: 1, expected_control_revision: 1, expected_context_revision: 1, decision_generation: 1, context_ref: { kind: "MISSION_SNAPSHOT", mission_run_id: runId } };
      this.db.run("INSERT INTO mission_commands(id, mission_run_id, kind, logical_key, envelope_json, request_hash, transport_state, processing_state, next_send_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'NOT_STARTED', ?)", commandId, runId, commandKind, logicalKey, JSON.stringify(envelope), safeHash(envelope), now);
      this.db.run("UPDATE mission_runs SET current_decision_command_id = ?, decision_generation = ?, brain_state = ? WHERE id = ?", brainVersion === 2 ? commandId : null, brainVersion === 2 ? 1 : 0, brainVersion === 2 ? "DECISION_QUEUED" : "IDLE", runId);
      this.appendEvent(input.officeId, missionId, runId, "mission.created", { missionId, missionRunId: runId, commandId }, now);
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at, retain_until) VALUES (?, ?, ?, 202, ?, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify({ missionId, missionRunId: runId, missionRevision: 1, objectiveRevision: 1, controlRevision: 1, planCommandId: commandId, brainProtocolVersion: brainVersion, sourceIntentKey: input.sourceIntentKey ?? null, conversationRef: input.conversationRef ?? null, phase: "PLANNING", control: "ACTIVE", activity: brainVersion === 2 ? "DECISION_QUEUED" : "WAITING_HERMES", limits, createdAt: new Date(now).toISOString() }), now, now + 90 * 24 * 60 * 60 * 1000);
    });
    const response = parseJson(this.db.one<Row>("SELECT response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey)?.response_json);
    if (replayedInTransaction) return { response, replayed: true };
    this.events.publish({ type: "mission.updated", missionId, missionRunId: runId, phase: "PLANNING" });
    return { response, replayed: false };
  }

  get(missionId: string, runId?: string): Record<string, unknown> | undefined {
    const mission = this.db.one<Row>("SELECT * FROM missions WHERE id = ? AND archived_at IS NULL", missionId); if (!mission) return undefined;
    const selectedRunId = runId ?? mission.current_mission_run_id; const run = selectedRunId ? this.db.one<Row>("SELECT * FROM mission_runs WHERE id = ? AND mission_id = ?", selectedRunId, missionId) : undefined;
    if (!run) return { ...this.publicMission(mission), run: null };
    const plan = run.active_plan_revision === null || run.active_plan_revision === undefined ? undefined : this.db.one<Row>("SELECT * FROM mission_plans WHERE mission_run_id = ? AND revision = ?", run.id, run.active_plan_revision);
    const steps = plan ? this.db.all<Row>("SELECT s.*, e.id AS execution_id, e.backend_kind, e.task_id, e.command_id, e.state AS execution_state, e.resource_state FROM mission_steps s LEFT JOIN mission_step_executions e ON e.id = s.current_execution_id WHERE s.plan_id = ? ORDER BY s.rowid", plan.id).map((step) => ({ id: step.id, key: step.step_key, kind: step.kind, member: parseJson(step.member_snapshot_json), contract: parseJson(step.contract_json), state: step.state, waitReason: step.wait_reason, nextWakeAt: iso(step.next_wake_at), executionGeneration: Number(step.execution_generation), outputManifest: parseJson(step.output_manifest_json, null), acceptedAt: iso(step.accepted_at), failure: parseJson(step.failure_json, null), execution: step.execution_id ? { id: step.execution_id, backend: step.backend_kind, taskId: step.task_id ?? null, commandId: step.command_id ?? null, state: step.execution_state, resourceState: step.resource_state } : null })) : [];
    const dependencies = plan ? this.db.all<Row>("SELECT d.from_step_id, d.to_step_id, d.condition, d.input_mapping_json, f.step_key AS from_key, t.step_key AS to_key FROM mission_step_dependencies d JOIN mission_steps f ON f.id = d.from_step_id JOIN mission_steps t ON t.id = d.to_step_id WHERE d.plan_id = ? ORDER BY f.step_key, t.step_key", plan.id).map((item) => ({ fromStepKey: item.from_key, toStepKey: item.to_key, condition: item.condition, inputMapping: parseJson(item.input_mapping_json) })) : [];
    const commands = this.db.all<Row>("SELECT id, kind, logical_key, transport_state, processing_state, delivery_attempts, brain_attempts, current_brain_attempt_id, last_error, applied_at FROM mission_commands WHERE mission_run_id = ? ORDER BY next_send_at, id").map((item) => ({ id: item.id, kind: item.kind, logicalKey: item.logical_key, transportState: item.transport_state, processingState: item.processing_state, deliveryAttempts: Number(item.delivery_attempts ?? 0), brainAttempts: Number(item.brain_attempts ?? 0), currentBrainAttemptId: item.current_brain_attempt_id ?? null, lastError: item.last_error ?? null, appliedAt: iso(item.applied_at) }));
    const inputs = this.db.all<Row>("SELECT * FROM mission_inputs WHERE mission_id = ? ORDER BY input_seq", missionId).map((item) => ({ id: item.id, sequence: Number(item.input_seq), objectiveRevision: Number(item.objective_revision), kind: item.kind, text: parseJson(item.text_json).text ?? null, contentHash: item.content_hash, createdAt: iso(item.created_at) }));
    const events = this.db.all<Row>("SELECT seq, event_id, type, event_version, payload_json, created_at FROM mission_events WHERE mission_id = ? ORDER BY seq DESC LIMIT 100", missionId).map((item) => ({ seq: Number(item.seq), eventId: item.event_id, type: item.type, eventVersion: Number(item.event_version), payload: parseJson(item.payload_json), createdAt: iso(item.created_at) })).reverse();
    return { ...this.publicMission(mission), run: { id: run.id, runNumber: Number(run.run_number), phase: run.phase, control: run.control, controlRevision: Number(run.control_revision), activePlanRevision: run.active_plan_revision ?? null, projectionRevision: Number(run.projection_revision), authorityEpoch: run.authority_epoch, brainProtocolVersion: Number(run.brain_protocol_version ?? 1), brainState: run.brain_state ?? "IDLE", contextRevision: Number(run.context_revision ?? 1), decisionGeneration: Number(run.decision_generation ?? 0), decisionPending: Boolean(run.decision_pending), currentDecisionCommandId: run.current_decision_command_id ?? null, waitSummary: parseJson(run.wait_summary_json), startedAt: iso(run.started_at), finishedAt: iso(run.finished_at), cleanupState: run.cleanup_state }, plan: plan ? { id: plan.id, revision: Number(plan.revision), baseRevision: plan.base_revision ?? null, objectiveRevision: Number(plan.objective_revision), status: plan.status, proposal: parseJson(plan.proposal_json), createdAt: iso(plan.created_at), activatedAt: iso(plan.activated_at) } : null, steps, dependencies, inputs, commands, events };
  }

  list(filters: { officeId?: string; phase?: string; sourceIntentKey?: string; limit?: number } = {}): Record<string, unknown>[] {
    const conditions = ["m.archived_at IS NULL"]; const params: unknown[] = [];
    if (filters.officeId) { conditions.push("m.office_id = ?"); params.push(filters.officeId); }
    if (filters.phase) { conditions.push("r.phase = ?"); params.push(filters.phase); }
    if (filters.sourceIntentKey) { conditions.push("m.source_intent_key = ?"); params.push(filters.sourceIntentKey); }
    const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
    return this.db.all<Row>(`SELECT m.*, r.id AS run_id, r.phase, r.control, r.control_revision, r.active_plan_revision, r.wait_summary_json FROM missions m LEFT JOIN mission_runs r ON r.id = m.current_mission_run_id WHERE ${conditions.join(" AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`, ...params, limit).map((row) => ({ ...this.publicMission(row), run: row.run_id ? { id: row.run_id, phase: row.phase, control: row.control, controlRevision: Number(row.control_revision), activePlanRevision: row.active_plan_revision ?? null, waitSummary: parseJson(row.wait_summary_json) } : null }));
  }

  eventsPage(missionId: string, afterSeq = 0, limit = 100): Record<string, unknown> {
    if (!this.missionRow(missionId)) throw new Error("MISSION_NOT_FOUND");
    const safeLimit = Math.min(200, Math.max(1, limit));
    const rows = this.db.all<Row>("SELECT seq, event_id, type, event_version, payload_json, created_at FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?", missionId, Math.max(0, afterSeq), safeLimit + 1);
    const items = rows.slice(0, safeLimit).map((item) => ({ seq: Number(item.seq), eventId: item.event_id, type: item.type, eventVersion: Number(item.event_version), payload: parseJson(item.payload_json), createdAt: iso(item.created_at) }));
    return { items, nextSeq: items.length ? items.at(-1)!.seq : Math.max(0, afterSeq), hasMore: rows.length > items.length, snapshotSeq: Number(this.db.one<Row>("SELECT COALESCE(MAX(seq), 0) AS seq FROM mission_events WHERE mission_id = ?", missionId)?.seq ?? 0) };
  }

  results(missionId: string, runId?: string): Record<string, unknown> {
    const detail = this.get(missionId, runId); if (!detail) throw new Error("MISSION_NOT_FOUND");
    const selectedRun = detail.run as Row | null; const steps = (detail.steps as Row[] | undefined) ?? []; const accepted = steps.filter((step) => step.state === "SUCCEEDED").length; const required = steps.filter((step) => step.contract?.required !== false).length;
    const finalization = selectedRun?.id ? this.db.one<Row>("SELECT result_json FROM mission_commands WHERE mission_run_id = ? AND kind IN ('mission.finalize', 'mission.decide') AND processing_state = 'APPLIED' ORDER BY applied_at DESC LIMIT 1", selectedRun.id) : undefined;
    const finalResult = parseJson(finalization?.result_json, {}); const deliveries = selectedRun?.id ? this.db.all<Row>("SELECT id, state, receipt_revision, receipt_json, last_error, delivered_at, delivery_key, conversation_ref, uncertainty_reason FROM mission_deliveries WHERE mission_run_id = ? ORDER BY created_at", selectedRun.id).map((row) => ({ id: row.id, state: row.state, deliveryKey: row.delivery_key ?? null, conversationRef: row.conversation_ref ?? null, receiptRevision: Number(row.receipt_revision ?? 0), receipt: parseJson(row.receipt_json, null), lastError: row.last_error, uncertaintyReason: row.uncertainty_reason ?? null, deliveredAt: iso(row.delivered_at) })) : [];
    return { missionId, missionRunId: selectedRun?.id ?? null, phase: selectedRun?.phase ?? null, availability: selectedRun?.phase === "COMPLETED" ? "AVAILABLE" : "PENDING", acceptance: { acceptedSteps: accepted, requiredSteps: required, complete: Boolean(selectedRun?.phase === "COMPLETED") }, finalManifest: finalResult.final_manifest ?? finalResult.finalManifest ?? null, delivery: deliveries.length ? deliveries : { state: "NOT_REQUESTED" } };
  }

  command(commandId: string): Record<string, unknown> | undefined {
    const row = this.db.one<Row>("SELECT * FROM mission_commands WHERE id = ?", commandId); return row ? { id: row.id, missionRunId: row.mission_run_id, kind: row.kind, logicalKey: row.logical_key, envelope: parseJson(row.envelope_json), requestHash: row.request_hash, transportState: row.transport_state, processingState: row.processing_state, result: parseJson(row.result_json, null) } : undefined;
  }

  bySourceIntent(sourceIntentKey: string): Record<string, unknown> | undefined {
    if (!sourceIntentKey) return undefined;
    const row = this.db.one<Row>("SELECT id FROM missions WHERE source_intent_key = ? AND archived_at IS NULL", sourceIntentKey);
    return row ? this.get(String(row.id)) : undefined;
  }

  appendInput(missionId: string, input: { kind: "TEXT"; text: string }, idempotencyKey: string, expectedObjectiveRevision?: number, now = Date.now()): Record<string, unknown> {
    if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const request = { input, expectedObjectiveRevision: expectedObjectiveRevision ?? null }; const requestHash = safeHash(request); const scope = `mission:input:${missionId}`;
    const prior = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return parseJson(prior.response_json); }
    let result!: Record<string, unknown>;
    this.db.transaction(() => {
      const mission = this.db.one<Row>("SELECT * FROM missions WHERE id = ? AND archived_at IS NULL", missionId); if (!mission) throw new Error("MISSION_NOT_FOUND");
      if (expectedObjectiveRevision !== undefined && Number(mission.objective_revision) !== expectedObjectiveRevision) throw new Error("REVISION_CONFLICT");
      const run = mission.current_mission_run_id ? this.db.one<Row>("SELECT phase, objective_snapshot_json, brain_protocol_version FROM mission_runs WHERE id = ? AND mission_id = ?", mission.current_mission_run_id, missionId) : undefined;
      if (!run || missionPhaseTerminal(String(run.phase))) throw new Error("MISSION_TERMINAL");
      const seq = Number(this.db.one<Row>("SELECT COALESCE(MAX(input_seq), 0) AS value FROM mission_inputs WHERE mission_id = ?", missionId)?.value ?? 0) + 1; const revision = Number(mission.objective_revision) + 1; const inputId = uuidv7(now);
      this.db.run("INSERT INTO mission_inputs(id, mission_id, input_seq, objective_revision, kind, text_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", inputId, missionId, seq, revision, input.kind, JSON.stringify({ text: input.text }), safeHash(input), now);
      this.db.run("UPDATE missions SET mission_revision = mission_revision + 1, objective_revision = ?, updated_at = ? WHERE id = ?", revision, now, missionId);
      const currentDecision = this.db.one<Row>("SELECT id, processing_state FROM mission_commands WHERE id = (SELECT current_decision_command_id FROM mission_runs WHERE id = ?)", mission.current_mission_run_id);
      if (currentDecision && currentDecision.processing_state === "NOT_STARTED") this.db.run("UPDATE mission_commands SET processing_state = 'STALE', transport_state = 'ATTENTION', last_error = 'STALE_CONTEXT' WHERE id = ? AND processing_state = 'NOT_STARTED'", currentDecision.id);
      const objectiveSnapshot = { ...parseJson(run.objective_snapshot_json, {}), objectiveRevision: revision };
      this.db.run("UPDATE mission_runs SET objective_snapshot_json = ?, context_revision = context_revision + 1, decision_pending = CASE WHEN brain_protocol_version = 2 THEN 1 ELSE decision_pending END, brain_state = CASE WHEN brain_protocol_version = 2 THEN 'DECISION_QUEUED' ELSE brain_state END, wait_summary_json = CASE WHEN brain_protocol_version = 2 THEN ? ELSE wait_summary_json END, projection_revision = projection_revision + 1 WHERE id = ? AND phase NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')", JSON.stringify(objectiveSnapshot), JSON.stringify({ reason: "NEW_OWNER_INPUT" }), mission.current_mission_run_id);
      this.db.run("UPDATE mission_waits SET state = 'SATISFIED', updated_at = ? WHERE mission_run_id = ? AND state = 'PENDING'", now, mission.current_mission_run_id);
      this.appendEvent(String(mission.office_id), missionId, String(mission.current_mission_run_id), "mission.input.appended", { inputId, objectiveRevision: revision }, now);
      result = { missionId, inputId, objectiveRevision: revision, replayed: false };
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at, retain_until) VALUES (?, ?, ?, 202, ?, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now, now + 90 * 24 * 60 * 60 * 1000);
    });
    this.events.publish({ type: "mission.updated", missionId, objectiveRevision: result.objectiveRevision });
    return result;
  }

  reopen(missionId: string, idempotencyKey: string, expectedMissionRevision?: number, now = Date.now()): Record<string, unknown> {
    if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const request = { missionId, expectedMissionRevision: expectedMissionRevision ?? null }; const requestHash = safeHash(request); const scope = `mission:reopen:${missionId}`;
    const prior = this.db.one<Row>("SELECT request_hash, response_json FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return parseJson(prior.response_json); }
    let result!: Record<string, unknown>;
    this.db.transaction(() => {
      const mission = this.db.one<Row>("SELECT * FROM missions WHERE id = ? AND archived_at IS NULL", missionId); if (!mission) throw new Error("MISSION_NOT_FOUND");
      if (expectedMissionRevision !== undefined && Number(mission.mission_revision) !== expectedMissionRevision) throw new Error("REVISION_CONFLICT");
      const previous = this.db.one<Row>("SELECT * FROM mission_runs WHERE id = ? AND mission_id = ?", mission.current_mission_run_id, missionId);
      if (!previous || !missionPhaseTerminal(String(previous.phase))) throw new Error("MISSION_NOT_TERMINAL");
      const runNumber = Number(this.db.one<Row>("SELECT COALESCE(MAX(run_number), 0) AS value FROM mission_runs WHERE mission_id = ?", missionId)?.value ?? 0) + 1;
      const runId = uuidv7(now + 1); const commandId = uuidv7(now + 2); const brainVersion = Number(previous.brain_protocol_version ?? 1) === 2 ? 2 : 1;
      const objective = { ...parseJson(previous.objective_snapshot_json, {}), objectiveRevision: Number(mission.objective_revision) };
      this.db.run("INSERT INTO mission_runs(id, mission_id, run_number, phase, control, control_revision, objective_snapshot_json, limits_snapshot_json, scope_snapshot_json, projection_revision, authority_epoch, brain_protocol_version, brain_state, decision_pending, started_at) VALUES (?, ?, ?, 'PLANNING', 'ACTIVE', 1, ?, ?, ?, 1, ?, ?, ?, ?, ?)", runId, missionId, runNumber, JSON.stringify(objective), mission.limits_json, mission.scope_json, this.authorityEpoch(), brainVersion, brainVersion === 2 ? "DECISION_QUEUED" : "IDLE", brainVersion === 2 ? 1 : 0, now);
      const kind = brainVersion === 2 ? "mission.decide" : "plan.requested"; const logicalKey = brainVersion === 2 ? `decide:${runId}:1` : `plan:${runId}:1`;
      const envelope = { protocol_version: 1, brain_protocol_version: brainVersion, command_id: commandId, kind, authority_epoch: this.authorityEpoch(), mission_id: missionId, mission_run_id: runId, expected_objective_revision: Number(mission.objective_revision), expected_control_revision: 1, expected_context_revision: 1, decision_generation: 1, context_ref: { kind: "MISSION_SNAPSHOT", mission_run_id: runId } };
      this.db.run("INSERT INTO mission_commands(id, mission_run_id, kind, logical_key, envelope_json, request_hash, transport_state, processing_state, next_send_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 'NOT_STARTED', ?)", commandId, runId, kind, logicalKey, JSON.stringify(envelope), safeHash(envelope), now);
      this.db.run("UPDATE mission_runs SET current_decision_command_id = ?, decision_generation = ? WHERE id = ?", brainVersion === 2 ? commandId : null, brainVersion === 2 ? 1 : 0, runId);
      this.db.run("UPDATE missions SET mission_revision = mission_revision + 1, current_mission_run_id = ?, updated_at = ? WHERE id = ?", runId, now, missionId);
      this.appendEvent(String(mission.office_id), missionId, runId, "mission.reopened", { missionId, missionRunId: runId, commandId, runNumber }, now);
      result = { missionId, missionRunId: runId, missionRevision: Number(mission.mission_revision) + 1, objectiveRevision: Number(mission.objective_revision), planCommandId: commandId, brainProtocolVersion: brainVersion, phase: "PLANNING", control: "ACTIVE", activity: brainVersion === 2 ? "DECISION_QUEUED" : "WAITING_HERMES", replayed: false };
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at, retain_until) VALUES (?, ?, ?, 202, ?, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now, now + 90 * 24 * 60 * 60 * 1000);
    });
    this.events.publish({ type: "mission.updated", missionId, missionRunId: result.missionRunId, phase: "PLANNING" });
    return result;
  }

  retryCommand(missionId: string, commandId: string, idempotencyKey: string, expectedControlRevision?: number, now = Date.now()): Record<string, unknown> {
    if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const request = { commandId, expectedControlRevision: expectedControlRevision ?? null };
    const requestHash = safeHash(request); const scope = `mission:command-retry:${missionId}`;
    const prior = this.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return parseJson(prior.response_json) as Record<string, unknown>; }
    let result!: Record<string, unknown>;
    this.db.transaction(() => {
      const row = this.db.one<Row>("SELECT c.*, r.mission_id, r.phase, r.control, r.control_revision, r.authority_epoch, m.office_id FROM mission_commands c JOIN mission_runs r ON r.id = c.mission_run_id JOIN missions m ON m.id = r.mission_id WHERE c.id = ? AND m.id = ? AND m.archived_at IS NULL", commandId, missionId);
      if (!row) throw new Error("COMMAND_NOT_FOUND");
      if (expectedControlRevision !== undefined && Number(row.control_revision) !== expectedControlRevision) throw new Error("REVISION_CONFLICT");
      if (this.terminal(String(row.phase)) || String(row.control) !== "ACTIVE") throw new Error("STALE_EXECUTION");
      const attempt = row.current_brain_attempt_id ? this.db.one<Row>("SELECT state FROM mission_command_attempts WHERE id = ? AND command_id = ?", row.current_brain_attempt_id, commandId) : undefined;
      const transportRetry = String(row.processing_state) === "NOT_STARTED" && String(row.transport_state) === "ATTENTION" && !row.current_brain_attempt_id;
      const brainRetry = String(row.processing_state) === "FAILED" && String(row.transport_state) === "ACCEPTED" && String(attempt?.state) === "FAILED" && ["plan.requested", "plan.repair", "plan.revise", "mission.finalize"].includes(String(row.kind));
      if (!transportRetry && !brainRetry) {
        if (String(attempt?.state) === "UNKNOWN") throw new Error("RECOVERY_RECONCILIATION_REQUIRED");
        throw new Error("COMMAND_RETRY_NOT_AVAILABLE");
      }
      this.db.run("UPDATE mission_commands SET transport_state = 'PENDING', processing_state = 'NOT_STARTED', next_send_at = ?, claim_token = NULL, claim_until = NULL, current_brain_attempt_id = NULL, last_error = NULL WHERE id = ?", now, commandId);
      this.db.run("UPDATE missions SET updated_at = ? WHERE id = ?", now, missionId);
      this.appendEvent(String(row.office_id), missionId, String(row.mission_run_id), "mission.command.retry_requested", { commandId, kind: row.kind, previousTransportState: row.transport_state, previousProcessingState: row.processing_state, controlRevision: Number(row.control_revision) }, now);
      result = { missionId, missionRunId: row.mission_run_id, commandId, kind: row.kind, transportState: "PENDING", processingState: "NOT_STARTED", controlRevision: Number(row.control_revision), replayed: false };
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at, retain_until) VALUES (?, ?, ?, 202, ?, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now, now + 90 * 24 * 60 * 60 * 1000);
    });
    this.events.publish({ type: "mission.updated", missionId, missionRunId: result.missionRunId, phase: "PLANNING", commandId });
    return result;
  }

  control(missionId: string, action: "PAUSE" | "RESUME" | "CANCEL", idempotencyKey: string, expectedControlRevision?: number, now = Date.now()): Record<string, unknown> {
    if (!idempotencyKey) throw new Error("MISSING_IDEMPOTENCY_KEY");
    const request = { action, expectedControlRevision: expectedControlRevision ?? null };
    const requestHash = safeHash(request); const scope = `mission:control:${missionId}`;
    const prior = this.db.one<Row>("SELECT * FROM operation_receipts WHERE scope = ? AND operation_key = ?", scope, idempotencyKey);
    if (prior) { if (prior.request_hash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT"); return parseJson(prior.response_json) as Record<string, unknown>; }
    let result!: Record<string, unknown>;
    this.db.transaction(() => {
      const latest = this.db.one<Row>("SELECT m.*, r.id AS run_id, r.phase, r.control, r.control_revision, r.brain_protocol_version, r.authority_epoch FROM missions m JOIN mission_runs r ON r.id = m.current_mission_run_id WHERE m.id = ? AND m.archived_at IS NULL", missionId);
      if (!latest) throw new Error("MISSION_NOT_FOUND");
      if (Number(latest.brain_protocol_version ?? 1) === 2 && expectedControlRevision === undefined) throw new Error("REVISION_REQUIRED");
      if (expectedControlRevision !== undefined && Number(latest.control_revision) !== expectedControlRevision) throw new Error("REVISION_CONFLICT");
      if (this.terminal(String(latest.phase))) { result = { missionId, missionRunId: latest.run_id, action, phase: latest.phase, control: latest.control, controlRevision: Number(latest.control_revision), replayed: false }; }
      else {
        const control = action === "PAUSE" ? "PAUSE_REQUESTED" : action === "CANCEL" ? "CANCEL_REQUESTED" : "ACTIVE";
        const phase = action === "CANCEL" ? "CANCELLED" : latest.phase;
        const finishedAt = action === "CANCEL" ? now : null;
        this.db.run("UPDATE mission_runs SET control = ?, phase = ?, control_revision = control_revision + 1, finished_at = COALESCE(?, finished_at), stop_reason = CASE WHEN ? = 'CANCEL' THEN 'OWNER_CANCELLED' ELSE stop_reason END, projection_revision = projection_revision + 1 WHERE id = ?", control, phase, finishedAt, action, latest.run_id);
        this.db.run("UPDATE missions SET updated_at = ? WHERE id = ?", now, missionId);
        this.appendEvent(String(latest.office_id), missionId, String(latest.run_id), `mission.${action.toLowerCase()}`, { action, control, controlRevision: Number(latest.control_revision) + 1 }, now);
        result = { missionId, missionRunId: latest.run_id, action, phase, control, controlRevision: Number(latest.control_revision) + 1, replayed: false };
      }
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at, retain_until) VALUES (?, ?, ?, 202, ?, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify(result), now, now + 90 * 24 * 60 * 60 * 1000);
    });
    this.events.publish({ type: "mission.updated", missionId, missionRunId: result.missionRunId, phase: result.phase, control: result.control });
    return result;
  }

  appendEvent(officeId: string, missionId: string, runId: string, type: string, payload: Record<string, unknown>, now: number): void { this.db.run("INSERT INTO mission_events(event_id, office_id, mission_id, mission_run_id, type, event_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)", uuidv7(now), officeId, missionId, runId, type, JSON.stringify(payload), now); }
  missionRow(missionId: string): Row | undefined { return this.db.one<Row>("SELECT * FROM missions WHERE id = ? AND archived_at IS NULL", missionId); }
  runRow(runId: string): Row | undefined { return this.db.one<Row>("SELECT * FROM mission_runs WHERE id = ?", runId); }
  terminal(phase: string): boolean { return missionPhaseTerminal(phase); }
  private authorityEpoch(): string { return String(parseJson(this.db.one<Row>("SELECT value_json FROM runtime_metadata WHERE key = 'office_authority_epoch'")?.value_json, "")); }
  private publicMission(row: Row): Record<string, unknown> { return { id: row.id, officeId: row.office_id, title: row.title, goal: row.goal, sourceRef: parseJson(row.source_ref_json, null), sourceIntentKey: row.source_intent_key ?? null, conversationRef: row.conversation_ref ?? null, acceptance: parseJson(row.acceptance_json, []), scope: parseJson(row.scope_json), limits: parseJson(row.limits_json), delivery: parseJson(row.delivery_target_json), missionRevision: Number(row.mission_revision), objectiveRevision: Number(row.objective_revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deadlineAt: iso(row.deadline_at), deadlineMode: row.deadline_mode }; }
}
