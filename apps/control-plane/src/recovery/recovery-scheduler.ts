import { createHash } from "node:crypto";
import { canonicalJson, uuidv7 } from "../../../../packages/contracts/src/index.ts";
import { ControlPlaneDatabase } from "../db/database.ts";
import { SettingsService } from "../settings/settings-service.ts";
import { WorkerService } from "../workers/worker-service.ts";
import { QuotaPoolService, type QuotaPoolReadiness } from "./quota-pool-service.ts";
import { evaluateResumeEligibility } from "./resume-policy.ts";

type Row = Record<string, any>;
type ProbeTarget = "WAITING_RESET" | "DISABLED_BY_POLICY" | "WAITING_HOST" | "BLOCKED_AUTH" | "RECONCILIATION_REQUIRED" | "NEEDS_OWNER_ACTION";
const LEASE_MS = 30_000;
const MAX_PROBES = 12;
const MAX_BACKOFF_MS = 60 * 60_000;

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function timestamp(value: string | null | undefined): number | undefined { if (!value) return undefined; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; }

/**
 * Performs bounded, database-only quota/reset checks. It never sends a Worker
 * message, creates a new attempt, or invokes a model continuation. Until a
 * verified native-session adapter and dispatcher exist, eligible work remains
 * non-runnable and requires owner/runtime evidence.
 */
export class RecoveryScheduler {
  private readonly db: ControlPlaneDatabase;
  private readonly settings: SettingsService;
  private readonly workers: WorkerService;
  private readonly quotaPools: QuotaPoolService;

  constructor(db: ControlPlaneDatabase, settings: SettingsService, workers: WorkerService, quotaPools: QuotaPoolService) {
    this.db = db;
    this.settings = settings;
    this.workers = workers;
    this.quotaPools = quotaPools;
  }

  tick(now = Date.now(), limit = 50): { examined: number; claimed: number; deferred: number; needsOwnerAction: number; dispatched: 0 } {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_RECOVERY_SCHEDULER_INPUT");
    const ids = this.db.all<Row>(`SELECT id FROM recovery_intents
      WHERE state = 'WAITING_RESET' AND (next_probe_at IS NULL OR next_probe_at <= ?)
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_probe_at IS NULL, next_probe_at, created_at, id LIMIT ?`, now, now, limit).map((row) => String(row.id));
    let claimed = 0;
    let deferred = 0;
    let needsOwnerAction = 0;
    for (const id of ids) {
      const owner = `recovery-scheduler:${process.pid}:${uuidv7(now)}`;
      const row = this.claim(id, owner, now);
      if (!row) continue;
      claimed++;
      try {
        const decision = this.evaluate(row, now);
        const finalized = this.persistDecision(row, owner, decision.target, decision.reason, decision.policyVersion, decision.readiness, now);
        if (finalized) {
          if (decision.target === "NEEDS_OWNER_ACTION") needsOwnerAction++;
          else deferred++;
        }
      } catch {
        this.releaseAfterError(id, owner, now);
      }
    }
    return { examined: ids.length, claimed, deferred, needsOwnerAction, dispatched: 0 };
  }

  private claim(intentId: string, owner: string, now: number): Row | undefined {
    return this.db.transaction(() => {
      const row = this.db.one<Row>(`SELECT r.id, r.task_id, r.session_binding_id, r.state, r.resume_policy, r.policy_version,
          r.next_probe_at, r.retry_count, r.lease_owner, r.lease_until,
          s.worker_id, s.runtime, s.workspace_id, s.workspace_fence_epoch, s.usage_pool_id, s.attempt_id,
          t.status AS task_status, t.current_attempt_id, t.control_cancel, t.effect_state AS task_effect_state,
          a.status AS attempt_status, a.fence_epoch AS attempt_fence_epoch, a.workspace_id AS attempt_workspace_id,
          a.effect_state AS attempt_effect_state,
          l.attempt_id AS lock_attempt_id, l.fence_epoch AS lock_fence_epoch, l.state AS lock_state,
          c.condition AS task_condition
        FROM recovery_intents r
        JOIN agent_session_bindings s ON s.id = r.session_binding_id
        JOIN tasks t ON t.id = r.task_id
        LEFT JOIN task_attempts a ON a.id = s.attempt_id
        LEFT JOIN workspace_locks l ON l.workspace_id = s.workspace_id
        LEFT JOIN task_execution_conditions c ON c.task_id = r.task_id
        WHERE r.id = ? AND r.state = 'WAITING_RESET'
          AND (r.next_probe_at IS NULL OR r.next_probe_at <= ?)
          AND (r.lease_until IS NULL OR r.lease_until <= ?)`, intentId, now, now);
      if (!row) return undefined;
      this.db.run("UPDATE recovery_intents SET lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND state = 'WAITING_RESET' AND (lease_until IS NULL OR lease_until <= ?)", owner, now + LEASE_MS, now, intentId, now);
      if (Number(this.db.one<Row>("SELECT changes() AS count")?.count ?? 0) !== 1) return undefined;
      return row;
    });
  }

  private evaluate(row: Row, now: number): { target: ProbeTarget; reason: string; policyVersion: number; readiness?: QuotaPoolReadiness; nextCheckAt?: number } {
    const effective = this.settings.getEffective();
    const workerId = String(row.worker_id);
    const worker = this.workers.getWorker(workerId, now) as Row | undefined;
    const preferences = this.workers.preferences(workerId) as Row;
    const autoResume = preferences.autoResume as Row | undefined;
    let readiness: QuotaPoolReadiness | undefined;
    if (row.usage_pool_id) {
      try { readiness = this.quotaPools.getReadiness(String(row.usage_pool_id), now); } catch { readiness = undefined; }
    }
    const nextCheckAt = this.readinessCheckAt(readiness, now);
    const decision = evaluateResumeEligibility({
      global: { defaultEnabled: Boolean(effective.values.auto_resume_default_enabled), emergencyStop: Boolean(effective.values.auto_resume_emergency_stop), version: effective.version },
      worker: {
        autoResumeOverride: autoResume?.override === null || autoResume?.override === undefined ? null : Boolean(autoResume.override),
        enabled: Boolean(worker?.enabled),
        drain: Boolean(worker?.drain),
        paused: Boolean(preferences.pause),
        preferencesVersion: Number(preferences.version ?? 0),
      },
      task: { resumePolicy: row.resume_policy === "INHERIT_WORKER" ? "INHERIT_WORKER" : "MANUAL_ONLY", condition: String(row.task_condition ?? "WAITING_RESET") },
      quota: {
        fiveHourReady: readiness?.fiveHour.ready === true,
        weeklyReady: readiness?.weekly.ready === true,
        freshnessOk: readiness?.quotaReady === true,
        ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
      },
      runtime: {
        // No native adapter exposes a reviewed authentication/managed-session
        // readiness signal yet. Unknown is deliberately treated as unavailable.
        authReady: false,
        hostOnline: worker?.status === "ONLINE",
        sessionSupported: false,
        ownershipExclusive: row.lock_state === "HELD" && String(row.lock_attempt_id ?? "") === String(row.attempt_id) && Number(row.lock_fence_epoch) === Number(row.workspace_fence_epoch),
        fenceValid: row.task_status === "RUNNING" && row.current_attempt_id === row.attempt_id && row.attempt_status === "RUNNING" && row.attempt_workspace_id === row.workspace_id && Number(row.attempt_fence_epoch) === Number(row.workspace_fence_epoch),
        sideEffectsReconciled: ["NONE_CONFIRMED", "CONFIRMED"].includes(String(row.task_effect_state)) && ["NONE_CONFIRMED", "CONFIRMED"].includes(String(row.attempt_effect_state)),
        attemptsAvailable: row.task_status === "RUNNING" && row.attempt_status === "RUNNING" && row.control_cancel === "NONE",
      },
    });

    // The current Worker exposes runtimeSupport=UNSUPPORTED; a custom client
    // feature advertisement is not sufficient to establish a safe adapter.
    let reason = decision.reason;
    if (!worker || worker.status !== "ONLINE" || !worker.enabled || worker.drain || preferences.pause) {
      if (!["GLOBAL_STOP", "WORKER_POLICY_OFF", "GLOBAL_POLICY_OFF", "TASK_MANUAL_ONLY"].includes(reason)) reason = "WORKER_UNAVAILABLE";
    }
    if (decision.eligible) reason = "SESSION_UNSUPPORTED";
    const target = this.targetFor(reason);
    return { target, reason, policyVersion: decision.policyVersion, readiness, nextCheckAt };
  }

  private targetFor(reason: string): ProbeTarget {
    if (["GLOBAL_STOP", "WORKER_POLICY_OFF", "GLOBAL_POLICY_OFF", "TASK_MANUAL_ONLY"].includes(reason)) return "DISABLED_BY_POLICY";
    if (["WORKER_UNAVAILABLE", "HOST_UNAVAILABLE"].includes(reason)) return "WAITING_HOST";
    if (reason === "AUTH_UNAVAILABLE") return "BLOCKED_AUTH";
    if (["OWNERSHIP_CONFLICT", "WORKSPACE_FENCED", "EFFECT_UNKNOWN"].includes(reason)) return "RECONCILIATION_REQUIRED";
    if (reason === "QUOTA_NOT_READY") return "WAITING_RESET";
    return "NEEDS_OWNER_ACTION";
  }

  private readinessCheckAt(readiness: QuotaPoolReadiness | undefined, now: number): number | undefined {
    if (!readiness) return undefined;
    const blockedResets = [readiness.fiveHour, readiness.weekly]
      .filter((bucket) => bucket.state === "BLOCKED")
      .map((bucket) => timestamp(bucket.resetsAt))
      .filter((value): value is number => value !== undefined && value > now);
    if (blockedResets.length) return Math.max(...blockedResets);
    const checks = [timestamp(readiness.fiveHour.nextCheckAt), timestamp(readiness.weekly.nextCheckAt)]
      .filter((value): value is number => value !== undefined && value > now);
    return checks.length ? Math.max(...checks) : undefined;
  }

  private persistDecision(row: Row, owner: string, target: ProbeTarget, initialReason: string, policyVersion: number, readiness: QuotaPoolReadiness | undefined, now: number): boolean {
    return this.db.transaction(() => {
      const current = this.db.one<Row>("SELECT state, lease_owner, retry_count FROM recovery_intents WHERE id = ?", row.id);
      if (!current || current.state !== "WAITING_RESET" || current.lease_owner !== owner) return false;
      const retryCount = Number(current.retry_count) + 1;
      let state = target;
      let reason = initialReason;
      let nextProbeAt: number | null = null;
      let intentErrorCode = initialReason;
      if (target === "WAITING_RESET") {
        if (retryCount > MAX_PROBES) {
          state = "NEEDS_OWNER_ACTION";
          reason = "PROBE_LIMIT_REACHED";
        } else {
          const quotaNext = this.poolCooldown(String(row.usage_pool_id ?? ""), readiness, now);
          const backoff = Math.min(5 * 60_000 * (2 ** Math.max(0, retryCount - 1)), MAX_BACKOFF_MS);
          const jitter = Number.parseInt(digest({ id: row.id, retryCount }).slice(0, 8), 16) % 30_000;
          nextProbeAt = Math.max(quotaNext === undefined ? 0 : quotaNext + jitter, now + backoff + jitter);
          if (row.usage_pool_id) {
            this.db.run("UPDATE quota_pools SET next_recheck_at = CASE WHEN next_recheck_at IS NULL OR next_recheck_at < ? THEN ? ELSE next_recheck_at END, updated_at = ? WHERE id = ?", nextProbeAt, nextProbeAt, now, row.usage_pool_id);
          }
          reason = "QUOTA_NOT_READY";
          intentErrorCode = "SCHEDULER_QUOTA_NOT_READY";
        }
      }
      this.db.run("UPDATE recovery_intents SET state = ?, retry_count = ?, policy_version = ?, last_error_code = ?, next_probe_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?", state, retryCount, policyVersion, intentErrorCode, nextProbeAt, now, row.id, owner);
      if (Number(this.db.one<Row>("SELECT changes() AS count")?.count ?? 0) !== 1) return false;
      const condition = this.db.one<Row>("SELECT condition, reason_code, revision, since FROM task_execution_conditions WHERE task_id = ?", row.task_id);
      if (!condition || condition.condition !== state || condition.reason_code !== reason) {
        this.db.run(`INSERT INTO task_execution_conditions(task_id, condition, reason_code, since, revision, next_action_at)
          VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(task_id) DO UPDATE SET condition = excluded.condition,
          reason_code = excluded.reason_code, since = excluded.since, revision = task_execution_conditions.revision + 1,
          next_action_at = excluded.next_action_at`, row.task_id, state, reason, now, nextProbeAt);
      } else {
        this.db.run("UPDATE task_execution_conditions SET next_action_at = ? WHERE task_id = ?", nextProbeAt, row.task_id);
      }
      const payload = { intentId: row.id, taskId: row.task_id, from: "WAITING_RESET", to: state, reason, retryCount, policyVersion, nextProbeAt };
      this.db.run("INSERT INTO recovery_events(id, intent_id, event_type, correlation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", uuidv7(now), row.id, state === "NEEDS_OWNER_ACTION" ? "RECOVERY_OWNER_ACTION_REQUIRED" : "RECOVERY_PROBE_DEFERRED", uuidv7(now), JSON.stringify(payload), now);
      return true;
    });
  }

  private poolCooldown(poolId: string, readiness: QuotaPoolReadiness | undefined, now: number): number | undefined {
    if (!poolId) return undefined;
    const persisted = this.db.one<Row>("SELECT next_recheck_at FROM quota_pools WHERE id = ?", poolId)?.next_recheck_at;
    const persistedAt = persisted === null || persisted === undefined ? undefined : Number(persisted);
    const candidate = readiness ? this.readinessCheckAt(readiness, now) : undefined;
    const next = Math.max(persistedAt && persistedAt > now ? persistedAt : 0, candidate ?? 0);
    return next > now ? next : undefined;
  }

  private releaseAfterError(intentId: string, owner: string, now: number): void {
    this.db.transaction(() => {
      this.db.run("UPDATE recovery_intents SET lease_owner = NULL, lease_until = NULL, next_probe_at = ?, last_error_code = 'SCHEDULER_CHECK_FAILED', updated_at = ? WHERE id = ? AND lease_owner = ?", now + 5 * 60_000, now, intentId, owner);
    });
  }
}
