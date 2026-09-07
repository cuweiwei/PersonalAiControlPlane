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
      this.db.run("INSERT INTO missions(id, office_id, title, goal, source_ref_json, scope_json, limits_json, delivery_target_json, mission_revision, objective_revision, current_mission_run_id, first_started_at, deadline_at, deadline_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)", missionId, input.officeId, input.title, input.goal, input.sourceRef ? JSON.stringify(input.sourceRef) : null, JSON.stringify(input.scope), JSON.stringify(limits), JSON.stringify(input.delivery ?? { mode: "OFFICE_ONLY" }), runId, now, deadlineAt, input.deadline?.mode ?? "SOFT", now, now);
      for (const [index, item] of input.inputs.entries()) this.db.run("INSERT INTO mission_inputs(id, mission_id, input_seq, objective_revision, kind, text_json, content_hash, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)", uuidv7(now + index + 3), missionId, index + 1, item.kind, JSON.stringify({ text: item.text }), safeHash(item), now);
      this.db.run("INSERT INTO mission_runs(id, mission_id, run_number, phase, control, control_revision, objective_snapshot_json, limits_snapshot_json, scope_snapshot_json, projection_revision, authority_epoch, started_at) VALUES (?, ?, 1, 'PLANNING', 'ACTIVE', 1, ?, ?, ?, 1, ?, ?)", runId, missionId, JSON.stringify({ missionRevision: 1, objectiveRevision: 1, title: input.title, goal: input.goal }), JSON.stringify(limits), JSON.stringify(input.scope), epoch, now);
      const envelope = { protocol_version: 1, command_id: commandId, kind: "plan.requested", authority_epoch: epoch, mission_id: missionId, mission_run_id: runId, expected_objective_revision: 1, context_ref: { kind: "MISSION_SNAPSHOT", mission_run_id: runId } };
      this.db.run("INSERT INTO mission_commands(id, mission_run_id, kind, logical_key, envelope_json, request_hash, transport_state, processing_state, next_send_at) VALUES (?, ?, 'plan.requested', ?, ?, ?, 'PENDING', 'NOT_STARTED', ?)", commandId, runId, `plan:${runId}:1`, JSON.stringify(envelope), safeHash(envelope), now);
      this.appendEvent(input.officeId, missionId, runId, "mission.created", { missionId, missionRunId: runId, commandId }, now);
      this.db.run("INSERT INTO operation_receipts(scope, operation_key, request_hash, status_code, response_json, created_at, retain_until) VALUES (?, ?, ?, 202, ?, ?, ?)", scope, idempotencyKey, requestHash, JSON.stringify({ missionId, missionRunId: runId, missionRevision: 1, objectiveRevision: 1, controlRevision: 1, planCommandId: commandId, phase: "PLANNING", control: "ACTIVE", activity: "WAITING_HERMES", limits, createdAt: new Date(now).toISOString() }), now, now + 90 * 24 * 60 * 60 * 1000);
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
    return { ...this.publicMission(mission), run: { id: run.id, runNumber: Number(run.run_number), phase: run.phase, control: run.control, controlRevision: Number(run.control_revision), activePlanRevision: run.active_plan_revision ?? null, projectionRevision: Number(run.projection_revision), authorityEpoch: run.authority_epoch, waitSummary: parseJson(run.wait_summary_json), startedAt: iso(run.started_at), finishedAt: iso(run.finished_at), cleanupState: run.cleanup_state }, plan: plan ? { id: plan.id, revision: Number(plan.revision), baseRevision: plan.base_revision ?? null, objectiveRevision: Number(plan.objective_revision), status: plan.status, proposal: parseJson(plan.proposal_json), createdAt: iso(plan.created_at), activatedAt: iso(plan.activated_at) } : null, steps, dependencies, inputs, commands, events };
  }

  list(filters: { officeId?: string; phase?: string; limit?: number } = {}): Record<string, unknown>[] {
    const conditions = ["m.archived_at IS NULL"]; const params: unknown[] = [];
    if (filters.officeId) { conditions.push("m.office_id = ?"); params.push(filters.officeId); }
    if (filters.phase) { conditions.push("r.phase = ?"); params.push(filters.phase); }
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
    const finalization = selectedRun?.id ? this.db.one<Row>("SELECT result_json FROM mission_commands WHERE mission_run_id = ? AND kind = 'mission.finalize' AND processing_state = 'APPLIED' ORDER BY applied_at DESC LIMIT 1", selectedRun.id) : undefined;
    const finalResult = parseJson(finalization?.result_json, {}); const deliveries = selectedRun?.id ? this.db.all<Row>("SELECT id, state, receipt_revision, receipt_json, last_error, delivered_at FROM mission_deliveries WHERE mission_run_id = ? ORDER BY created_at", selectedRun.id).map((row) => ({ id: row.id, state: row.state, receiptRevision: Number(row.receipt_revision ?? 0), receipt: parseJson(row.receipt_json, null), lastError: row.last_error, deliveredAt: iso(row.delivered_at) })) : [];
    return { missionId, missionRunId: selectedRun?.id ?? null, phase: selectedRun?.phase ?? null, availability: selectedRun?.phase === "COMPLETED" ? "AVAILABLE" : "PENDING", acceptance: { acceptedSteps: accepted, requiredSteps: required, complete: Boolean(selectedRun?.phase === "COMPLETED") }, finalManifest: finalResult.final_manifest ?? finalResult.finalManifest ?? null, delivery: deliveries.length ? deliveries : { state: "NOT_REQUESTED" } };
  }

  command(commandId: string): Record<string, unknown> | undefined {
    const row = this.db.one<Row>("SELECT * FROM mission_commands WHERE id = ?", commandId); return row ? { id: row.id, missionRunId: row.mission_run_id, kind: row.kind, logicalKey: row.logical_key, envelope: parseJson(row.envelope_json), requestHash: row.request_hash, transportState: row.transport_state, processingState: row.processing_state, result: parseJson(row.result_json, null) } : undefined;
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
      const latest = this.db.one<Row>("SELECT m.*, r.id AS run_id, r.phase, r.control, r.control_revision, r.authority_epoch FROM missions m JOIN mission_runs r ON r.id = m.current_mission_run_id WHERE m.id = ? AND m.archived_at IS NULL", missionId);
      if (!latest) throw new Error("MISSION_NOT_FOUND");
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
  private publicMission(row: Row): Record<string, unknown> { return { id: row.id, officeId: row.office_id, title: row.title, goal: row.goal, sourceRef: parseJson(row.source_ref_json, null), scope: parseJson(row.scope_json), limits: parseJson(row.limits_json), delivery: parseJson(row.delivery_target_json), missionRevision: Number(row.mission_revision), objectiveRevision: Number(row.objective_revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deadlineAt: iso(row.deadline_at), deadlineMode: row.deadline_mode }; }
}
