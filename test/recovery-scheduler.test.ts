import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { QuotaPoolService } from "../apps/control-plane/src/recovery/quota-pool-service.ts";
import { RecoveryScheduler } from "../apps/control-plane/src/recovery/recovery-scheduler.ts";
import { RecoveryService } from "../apps/control-plane/src/recovery/recovery-service.ts";
import { RecoveryPolicyReconciler } from "../apps/control-plane/src/recovery/recovery-policy-reconciler.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";

const base = 1_800_200_000_000;

function fixture() {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const settings = new SettingsService(db);
  const workers = new WorkerService(db, events, () => ({ defaultEnabled: Boolean(settings.get().auto_resume_default_enabled), emergencyStop: Boolean(settings.get().auto_resume_emergency_stop) }));
  const registration = workers.register({ name: "Recovery Scheduler Worker", registrationSecret: "recovery-scheduler-secret-123", platform: "win32", hardware: {} }, base);
  const workerId = String(workers.approveRegistration(registration.registrationId, "test-owner", base + 1).workerId);
  workers.markConnected(workerId, base + 2);
  db.run(`INSERT INTO tasks(id, source, title, task_type, instruction, context_json, payload_json, execution_json, priority, status,
    timeout_seconds, max_attempts, created_at, updated_at, current_attempt_id, execution_semantics, occupancy, effect_state, control_cancel)
    VALUES ('task-scheduler', 'test', 'Quota interrupted task', 'opencode', 'bounded work', '{}', '{}', '{"workspace_id":"workspace-scheduler"}', 50,
    'RUNNING', 1800, 2, ?, ?, 'attempt-scheduler', 'platform_v2', 'RUNNING', 'NONE_CONFIRMED', 'NONE')`, base, base);
  db.run(`INSERT INTO task_attempts(id, task_id, attempt_number, worker_id, status, assigned_at, started_at, occupancy, effect_state, fence_epoch, workspace_id)
    VALUES ('attempt-scheduler', 'task-scheduler', 1, ?, 'RUNNING', ?, ?, 'RUNNING', 'NONE_CONFIRMED', 5, 'workspace-scheduler')`, workerId, base, base);
  db.run(`INSERT INTO workspace_locks(workspace_id, lock_mode, attempt_id, fence_epoch, state, acquired_at, updated_at)
    VALUES ('workspace-scheduler', 'WRITE_EXCLUSIVE', 'attempt-scheduler', 5, 'HELD', ?, ?)`, base, base);
  const quotaPools = new QuotaPoolService(db);
  const recovery = new RecoveryService(db);
  const scheduler = new RecoveryScheduler(db, settings, workers, quotaPools);
  return { db, settings, workers, workerId, quotaPools, recovery, scheduler };
}

function report(workerId: string, resumePolicy: "INHERIT_WORKER" | "MANUAL_ONLY" = "INHERIT_WORKER", usagePoolId?: string) {
  return {
    task_id: "task-scheduler",
    attempt_id: "attempt-scheduler",
    worker_id: workerId,
    runtime: "opencode" as const,
    native_session_id: "private-native-session-id",
    workspace_id: "workspace-scheduler",
    workspace_fence_epoch: 5,
    blocker_kind: "FIVE_HOUR" as const,
    blocker_generation: 1,
    resume_policy: resumePolicy,
    observed_at: base + 3,
    next_probe_at: base + 4,
    ...(usagePoolId ? { usage_pool_id: usagePoolId } : {}),
  };
}

test("due quota checks are leased, back off durably, and never dispatch a continuation", () => {
  const f = fixture();
  try {
    const intent = f.recovery.recordQuotaBlock(report(f.workerId), "worker:test", base + 5) as Record<string, any>;
    const tick = f.scheduler.tick(base + 10);
    assert.deepEqual(tick, { examined: 1, claimed: 1, deferred: 1, needsOwnerAction: 0, dispatched: 0 });
    const stored = f.db.one<Record<string, any>>("SELECT state, retry_count, next_probe_at, lease_owner, lease_until, last_error_code FROM recovery_intents WHERE id = ?", intent.id)!;
    assert.equal(stored.state, "WAITING_RESET");
    assert.equal(stored.retry_count, 1);
    assert.ok(Number(stored.next_probe_at) > base + 10);
    assert.equal(stored.lease_owner, null);
    assert.equal(stored.lease_until, null);
    assert.equal(stored.last_error_code, "SCHEDULER_QUOTA_NOT_READY");
    const scheduledAt = Number(stored.next_probe_at);
    new RecoveryPolicyReconciler(f.db, f.settings, f.workers).reconcile(base + 20);
    assert.equal(Number(f.db.one<Record<string, any>>("SELECT next_probe_at FROM recovery_intents WHERE id = ?", intent.id)?.next_probe_at), scheduledAt);
    assert.deepEqual(f.scheduler.tick(base + 10), { examined: 0, claimed: 0, deferred: 0, needsOwnerAction: 0, dispatched: 0 });
    const events = f.db.all<Record<string, any>>("SELECT payload_json FROM recovery_events WHERE intent_id = ?", intent.id);
    assert.equal(events.some((event) => String(event.payload_json).includes("private-native-session-id")), false);
  } finally { f.db.close(); }
});

test("manual-only Work is disabled by policy before quota checks and cannot become resumable", () => {
  const f = fixture();
  try {
    const intent = f.recovery.recordQuotaBlock(report(f.workerId, "MANUAL_ONLY"), "worker:test", base + 5) as Record<string, any>;
    const tick = f.scheduler.tick(base + 10);
    assert.deepEqual(tick, { examined: 1, claimed: 1, deferred: 1, needsOwnerAction: 0, dispatched: 0 });
    assert.equal(f.db.one<Record<string, any>>("SELECT state, last_error_code, next_probe_at FROM recovery_intents WHERE id = ?", intent.id)?.state, "DISABLED_BY_POLICY");
    assert.equal(f.db.one<Record<string, any>>("SELECT condition FROM task_execution_conditions WHERE task_id = 'task-scheduler'")?.condition, "DISABLED_BY_POLICY");
  } finally { f.db.close(); }
});

test("shared quota reset schedules are respected with post-reset jitter and persisted pool cooldown", () => {
  const f = fixture();
  try {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const evidenceHash = `sha256:${"b".repeat(64)}`;
    const pool = f.quotaPools.createPool({ provider: "openai", identity_state: "OWNER_CONFIRMED", account_fingerprint: fingerprint }, "test-owner", base) as Record<string, any>;
    f.quotaPools.bindWorker({ poolId: String(pool.id), workerId: f.workerId, runtime: "opencode", evidence: "OWNER_CONFIRMED" }, "test-owner", base + 1);
    const resetAt = base + 30 * 60_000;
    f.quotaPools.recordObservation(String(pool.id), { bucket: "FIVE_HOUR", exhausted: true, used_percent: 100, resets_at: resetAt, observed_at: base + 2, source: "PROVIDER_STRUCTURED_ERROR", confidence: "HIGH", evidence_hash: evidenceHash }, "provider-test", base + 2);
    const intent = f.recovery.recordQuotaBlock(report(f.workerId, "INHERIT_WORKER", String(pool.id)), "worker:test", base + 5) as Record<string, any>;
    const tick = f.scheduler.tick(base + 10);
    assert.equal(tick.dispatched, 0);
    const scheduled = Number(f.db.one<Record<string, any>>("SELECT next_probe_at FROM recovery_intents WHERE id = ?", intent.id)?.next_probe_at);
    const cooldown = Number(f.db.one<Record<string, any>>("SELECT next_recheck_at FROM quota_pools WHERE id = ?", pool.id)?.next_recheck_at);
    assert.ok(scheduled >= resetAt);
    assert.ok(scheduled <= resetAt + 30_000);
    assert.equal(cooldown, scheduled);
  } finally { f.db.close(); }
});
