import { createHash } from "node:crypto";
import { canonicalJson, uuidv7, type NativeQuotaBlockReport, type ResumePolicy } from "../../../../packages/contracts/src/index.ts";
import { ControlPlaneDatabase } from "../db/database.ts";

type Row = Record<string, any>;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function boundedText(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`INVALID_${field.toUpperCase()}`);
  return value.trim();
}
function optionalText(value: unknown, field: string, max = 300): string | null {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, field, max);
}
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_${field.toUpperCase()}`);
  return value;
}
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${field.toUpperCase()}`);
  return value;
}
function shaOrNull(value: unknown, field: string): string | null {
  const text = optionalText(value, field, 128);
  if (text === null) return null;
  if (!SHA.test(text)) throw new Error(`INVALID_${field.toUpperCase()}`);
  return text;
}

/** Persists quota blockers without failing the Task or sending a continuation. */
export class RecoveryService {
  private readonly db: ControlPlaneDatabase;

  constructor(db: ControlPlaneDatabase) { this.db = db; }

  recordQuotaBlock(report: NativeQuotaBlockReport, actor = "worker", now = Date.now()): Record<string, unknown> {
    if (!report || !["opencode", "codex"].includes(report.runtime)) throw new Error("INVALID_NATIVE_SESSION_REPORT");
    if (!["FIVE_HOUR", "WEEKLY", "UNKNOWN"].includes(report.blocker_kind)) throw new Error("INVALID_QUOTA_BLOCKER");
    if (!["INHERIT_WORKER", "MANUAL_ONLY"].includes(report.resume_policy)) throw new Error("INVALID_RESUME_POLICY");
    const taskId = boundedText(report.task_id, "task_id", 160);
    const attemptId = boundedText(report.attempt_id, "attempt_id", 160);
    const workerId = boundedText(report.worker_id, "worker_id", 160);
    const sessionId = boundedText(report.native_session_id, "native_session_id", 512);
    const workspaceId = boundedText(report.workspace_id, "workspace_id", 200);
    const fenceEpoch = positiveInteger(report.workspace_fence_epoch, "workspace_fence_epoch");
    const blockerGeneration = positiveInteger(report.blocker_generation, "blocker_generation");
    const observedAt = nonNegativeInteger(report.observed_at, "observed_at");
    const nextProbeAt = report.next_probe_at == null ? null : nonNegativeInteger(report.next_probe_at, "next_probe_at");
    const providerId = optionalText(report.provider_id, "provider_id", 120);
    const modelId = optionalText(report.model_id, "model_id", 200);
    const branch = optionalText(report.branch, "branch", 300);
    const baselineSha = shaOrNull(report.baseline_sha, "baseline_sha");
    const lastHeadSha = shaOrNull(report.last_head_sha, "last_head_sha");
    const checkpointArtifactId = optionalText(report.checkpoint_artifact_id, "checkpoint_artifact_id", 160);
    const requestedPoolId = optionalText(report.usage_pool_id, "usage_pool_id", 160);
    const principal = boundedText(actor, "actor", 120);
    if (observedAt > now + 5 * 60_000) throw new Error("SESSION_REPORT_FROM_FUTURE");
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_CREATED_AT");

    return this.db.transaction(() => {
      const attempt = this.db.one<Row>(`SELECT a.id, a.task_id, a.worker_id, a.status AS attempt_status, a.workspace_id,
          a.fence_epoch, t.status AS task_status, t.current_attempt_id, t.control_cancel
        FROM task_attempts a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?`, attemptId);
      if (!attempt || String(attempt.task_id) !== taskId || String(attempt.worker_id) !== workerId) throw new Error("ATTEMPT_OWNERSHIP_MISMATCH");
      if (attempt.attempt_status !== "RUNNING" || attempt.task_status !== "RUNNING" || String(attempt.current_attempt_id) !== attemptId || attempt.control_cancel !== "NONE") throw new Error("TASK_NOT_RESUMABLE");
      if (String(attempt.workspace_id ?? "") !== workspaceId || Number(attempt.fence_epoch) !== fenceEpoch) throw new Error("WORKSPACE_FENCE_MISMATCH");
      const lock = this.db.one<Row>("SELECT attempt_id, fence_epoch, state FROM workspace_locks WHERE workspace_id = ?", workspaceId);
      if (!lock || String(lock.attempt_id) !== attemptId || Number(lock.fence_epoch) !== fenceEpoch || lock.state !== "HELD") throw new Error("WORKSPACE_FENCE_MISMATCH");
      if (checkpointArtifactId) {
        const artifact = this.db.one<Row>("SELECT id FROM artifacts WHERE id = ? AND task_id = ? AND storage_state = 'AVAILABLE'", checkpointArtifactId, taskId);
        if (!artifact) throw new Error("CHECKPOINT_ARTIFACT_NOT_FOUND");
      }
      let usagePoolId: string | null = null;
      if (requestedPoolId) {
        const binding = this.db.one<Row>(`SELECT p.id FROM quota_pools p JOIN quota_pool_bindings b ON b.usage_pool_id = p.id
          WHERE p.id = ? AND p.identity_state = 'OWNER_CONFIRMED' AND b.worker_id = ? AND b.runtime = ? AND b.evidence_state = 'OWNER_CONFIRMED'`, requestedPoolId, workerId, report.runtime);
        if (!binding) throw new Error("QUOTA_POOL_BINDING_UNVERIFIED");
        usagePoolId = requestedPoolId;
      }

      const linkedWork = this.db.one<Row>(`SELECT w.contract_json FROM orchestration_work_tasks t
        JOIN orchestration_works w ON w.id = t.work_id WHERE t.task_id = ?`, taskId);
      let taskResumePolicy: ResumePolicy = "INHERIT_WORKER";
      if (linkedWork) {
        try {
          const contract = JSON.parse(String(linkedWork.contract_json)) as Row;
          taskResumePolicy = contract.resume_policy === "INHERIT_WORKER" || contract.resume_policy === "MANUAL_ONLY" ? contract.resume_policy : "MANUAL_ONLY";
        } catch {
          taskResumePolicy = "MANUAL_ONLY";
        }
      }
      // A Worker may make a task stricter, but cannot upgrade an authoritative
      // MANUAL_ONLY Work contract to automatic recovery.
      const resumePolicy: ResumePolicy = taskResumePolicy === "MANUAL_ONLY" || report.resume_policy === "MANUAL_ONLY" ? "MANUAL_ONLY" : "INHERIT_WORKER";

      const priorBinding = this.db.one<Row>("SELECT * FROM agent_session_bindings WHERE attempt_id = ?", attemptId);
      if (priorBinding && (String(priorBinding.native_session_id) !== sessionId || String(priorBinding.runtime) !== report.runtime || String(priorBinding.worker_id) !== workerId || String(priorBinding.workspace_id) !== workspaceId || Number(priorBinding.workspace_fence_epoch) !== fenceEpoch)) throw new Error("SESSION_BINDING_CONFLICT");
      const collision = this.db.one<Row>("SELECT id, attempt_id FROM agent_session_bindings WHERE runtime = ? AND worker_id = ? AND native_session_id = ?", report.runtime, workerId, sessionId);
      if (collision && String(collision.attempt_id) !== attemptId) throw new Error("NATIVE_SESSION_ALREADY_BOUND");
      const sessionBindingId = priorBinding ? String(priorBinding.id) : `session_${uuidv7(now)}`;
      const requestHash = digest({ taskId, attemptId, workerId, runtime: report.runtime, sessionId, workspaceId, fenceEpoch, blockerKind: report.blocker_kind, blockerGeneration, resumePolicy, usagePoolId, providerId, modelId, branch, baselineSha, lastHeadSha, checkpointArtifactId });
      const existingIntent = this.db.one<Row>("SELECT id, request_hash FROM recovery_intents WHERE session_binding_id = ? AND blocker_generation = ? AND resume_generation = 0", sessionBindingId, blockerGeneration);
      if (existingIntent) {
        if (String(existingIntent.request_hash) !== requestHash) throw new Error("QUOTA_BLOCK_REPORT_CONFLICT");
        return this.publicIntent(String(existingIntent.id))!;
      }
      if (priorBinding) {
        this.db.run(`UPDATE agent_session_bindings SET usage_pool_id = COALESCE(?, usage_pool_id), provider_id = COALESCE(?, provider_id),
          model_id = COALESCE(?, model_id), branch = COALESCE(?, branch), baseline_sha = COALESCE(?, baseline_sha),
          last_head_sha = COALESCE(?, last_head_sha), runtime_state = 'BLOCKED_QUOTA', checkpoint_artifact_id = COALESCE(?, checkpoint_artifact_id),
          observed_at = ?, updated_at = ? WHERE id = ?`,
        usagePoolId, providerId, modelId, branch, baselineSha, lastHeadSha, checkpointArtifactId, observedAt, now, sessionBindingId);
      } else {
        this.db.run(`INSERT INTO agent_session_bindings(id, task_id, attempt_id, worker_id, runtime, native_session_id, workspace_id,
          workspace_fence_epoch, provider_id, model_id, usage_pool_id, branch, baseline_sha, last_head_sha, runtime_state,
          checkpoint_artifact_id, observed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BLOCKED_QUOTA', ?, ?, ?, ?)`,
        sessionBindingId, taskId, attemptId, workerId, report.runtime, sessionId, workspaceId, fenceEpoch, providerId, modelId, usagePoolId,
        branch, baselineSha, lastHeadSha, checkpointArtifactId, observedAt, now, now);
      }

      const intentId = `recovery_${uuidv7(now)}`;
      const settingsVersion = this.db.one<Row>("SELECT value_json FROM runtime_metadata WHERE key = 'settings_version'")?.value_json;
      const policyVersion = Number(settingsVersion === undefined ? 0 : JSON.parse(String(settingsVersion)));
      this.db.run(`INSERT INTO recovery_intents(id, task_id, session_binding_id, blocker_generation, resume_generation, state,
        blocker_kind, policy_version, next_probe_at, retry_count, lease_owner, lease_until, last_error_code, last_native_command_id,
        created_at, updated_at, resume_policy, request_hash)
        VALUES (?, ?, ?, ?, 0, 'WAITING_RESET', ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      intentId, taskId, sessionBindingId, blockerGeneration, report.blocker_kind, policyVersion, nextProbeAt, now, now, resumePolicy, requestHash);
      this.db.run(`INSERT INTO task_execution_conditions(task_id, condition, reason_code, since, revision, next_action_at)
        VALUES (?, 'WAITING_RESET', ?, ?, 1, ?)
        ON CONFLICT(task_id) DO UPDATE SET condition = 'WAITING_RESET', reason_code = excluded.reason_code,
          since = excluded.since, revision = task_execution_conditions.revision + 1, next_action_at = excluded.next_action_at`,
      taskId, `QUOTA_${report.blocker_kind}`, now, nextProbeAt);
      const correlationId = uuidv7(now);
      const eventPayload = { taskId, sessionBindingId, blockerKind: report.blocker_kind, blockerGeneration, resumePolicy, usagePoolId, nextProbeAt };
      this.db.run("INSERT INTO recovery_events(id, intent_id, event_type, correlation_id, payload_json, created_at) VALUES (?, ?, 'QUOTA_BLOCKED', ?, ?, ?)", uuidv7(now), intentId, correlationId, JSON.stringify(eventPayload), now);
      this.appendAudit(principal, "recovery.quota_blocked", workerId, eventPayload, now);
      return this.publicIntent(intentId)!;
    });
  }

  getIntent(intentId: string): Record<string, unknown> | undefined { return this.publicIntent(intentId); }

  listIntents(limit = 100): Record<string, unknown>[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_RECOVERY_LIMIT");
    return this.db.all<Row>("SELECT id FROM recovery_intents ORDER BY created_at DESC, id DESC LIMIT ?", limit).map((row) => this.publicIntent(String(row.id))!);
  }

  private publicIntent(intentId: string): Record<string, unknown> | undefined {
    const row = this.db.one<Row>(`SELECT r.id, r.task_id, r.session_binding_id, r.blocker_generation, r.resume_generation,
      r.state, r.blocker_kind, r.policy_version, r.next_probe_at, r.retry_count, r.last_error_code, r.resume_policy,
      r.created_at, r.updated_at, s.runtime, s.worker_id, s.workspace_id, s.workspace_fence_epoch, s.usage_pool_id
      FROM recovery_intents r JOIN agent_session_bindings s ON s.id = r.session_binding_id WHERE r.id = ?`, intentId);
    if (!row) return undefined;
    const events = this.db.all<Row>("SELECT event_type, correlation_id, payload_json, created_at FROM recovery_events WHERE intent_id = ? ORDER BY created_at, id", intentId).map((event) => ({ type: event.event_type, correlationId: event.correlation_id, payload: JSON.parse(String(event.payload_json)), createdAt: new Date(Number(event.created_at)).toISOString() }));
    return { id: row.id, taskId: row.task_id, sessionBindingId: row.session_binding_id, blockerGeneration: Number(row.blocker_generation), resumeGeneration: Number(row.resume_generation), state: row.state, blockerKind: row.blocker_kind, policyVersion: Number(row.policy_version), nextProbeAt: row.next_probe_at === null ? null : new Date(Number(row.next_probe_at)).toISOString(), retryCount: Number(row.retry_count), lastErrorCode: row.last_error_code, resumePolicy: row.resume_policy, runtime: row.runtime, workerId: row.worker_id, workspaceId: row.workspace_id, workspaceFenceEpoch: Number(row.workspace_fence_epoch), usagePoolId: row.usage_pool_id, createdAt: new Date(Number(row.created_at)).toISOString(), updatedAt: new Date(Number(row.updated_at)).toISOString(), events };
  }

  private appendAudit(actor: string, action: string, workerId: string | null, payload: Record<string, unknown>, now: number): void {
    const previousHash = String(this.db.one<Row>("SELECT event_hash FROM audit_events ORDER BY id DESC LIMIT 1")?.event_hash ?? "");
    const eventHash = digest({ actor, action, workerId, payload, previousHash, createdAt: now });
    this.db.run("INSERT INTO audit_events(event_uuid, actor, action, worker_id, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", uuidv7(now), actor, action, workerId, JSON.stringify(payload), previousHash, eventHash, now);
  }
}
