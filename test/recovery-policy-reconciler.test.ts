import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { RecoveryPolicyReconciler } from "../apps/control-plane/src/recovery/recovery-policy-reconciler.ts";
import { RecoveryService } from "../apps/control-plane/src/recovery/recovery-service.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";

const now = 1_800_200_000_000;

function fixture(resumePolicy: "INHERIT_WORKER" | "MANUAL_ONLY" = "INHERIT_WORKER") {
  const db = new ControlPlaneDatabase(":memory:");
  const settings = new SettingsService(db);
  const events = new EventHub();
  const workers = new WorkerService(db, events, () => ({ defaultEnabled: Boolean(settings.get().auto_resume_default_enabled), emergencyStop: Boolean(settings.get().auto_resume_emergency_stop) }));
  const registration = workers.register({ name: "Policy Worker", registrationSecret: "policy-worker-secret-123", platform: "win32", hardware: {} }, now);
  const workerId = String(workers.approveRegistration(registration.registrationId, "test-owner", now + 1).workerId);
  workers.markConnected(workerId, now + 2);
  db.run(`INSERT INTO tasks(id, source, title, task_type, instruction, context_json, payload_json, execution_json, priority, status,
    timeout_seconds, max_attempts, created_at, updated_at, current_attempt_id, execution_semantics, occupancy, effect_state, control_cancel)
    VALUES ('task-policy', 'test', 'Policy task', 'opencode', 'continue bounded work', '{}', '{}', '{"workspace_id":"workspace-policy"}', 50,
    'RUNNING', 1800, 1, ?, ?, 'attempt-policy', 'platform_v2', 'RUNNING', 'NONE_CONFIRMED', 'NONE')`, now, now);
  db.run(`INSERT INTO task_attempts(id, task_id, attempt_number, worker_id, status, assigned_at, started_at, occupancy, effect_state, fence_epoch, workspace_id)
    VALUES ('attempt-policy', 'task-policy', 1, ?, 'RUNNING', ?, ?, 'RUNNING', 'NONE_CONFIRMED', 4, 'workspace-policy')`, workerId, now, now);
  db.run(`INSERT INTO workspace_locks(workspace_id, lock_mode, attempt_id, fence_epoch, state, acquired_at, updated_at)
    VALUES ('workspace-policy', 'WRITE_EXCLUSIVE', 'attempt-policy', 4, 'HELD', ?, ?)`, now, now);
  const recovery = new RecoveryService(db);
  const intent = recovery.recordQuotaBlock({ task_id: "task-policy", attempt_id: "attempt-policy", worker_id: workerId, runtime: "opencode", native_session_id: "private-session-id", workspace_id: "workspace-policy", workspace_fence_epoch: 4, blocker_kind: "WEEKLY", blocker_generation: 1, resume_policy: resumePolicy, observed_at: now + 3 }, "worker-runtime", now + 4) as any;
  const reconciler = new RecoveryPolicyReconciler(db, settings, workers);
  return { db, settings, workers, workerId, intentId: String(intent.id), reconciler };
}

function intent(db: ControlPlaneDatabase, id: string) { return db.one<any>("SELECT state, last_error_code, policy_version FROM recovery_intents WHERE id = ?", id); }

test("per-Worker OFF disables durable blockers and ON only returns them to waiting, never dispatches", () => {
  const f = fixture();
  f.workers.updatePreferences(f.workerId, { autoResumeOverride: false }, 0, now + 5);
  const off = f.reconciler.reconcile(now + 10);
  assert.deepEqual(off, { examined: 1, changed: 1, inFlight: 0 });
  assert.equal(intent(f.db, f.intentId).state, "DISABLED_BY_POLICY");
  assert.equal(intent(f.db, f.intentId).last_error_code, "WORKER_POLICY_OFF");
  assert.equal(Number(intent(f.db, f.intentId).policy_version), 2);
  assert.equal(f.db.one<any>("SELECT condition FROM task_execution_conditions WHERE task_id = 'task-policy'")?.condition, "DISABLED_BY_POLICY");

  f.workers.updatePreferences(f.workerId, { autoResumeOverride: true }, 1, now + 11);
  f.reconciler.reconcile(now + 12);
  assert.equal(intent(f.db, f.intentId).state, "WAITING_RESET");
  assert.equal(intent(f.db, f.intentId).last_error_code, "RUNTIME_UNSUPPORTED");
  assert.equal(f.db.all<any>("SELECT event_type FROM recovery_events").some((row) => row.event_type.includes("SENT")), false);
  f.db.close();
});

test("global default OFF can be explicitly overridden, while emergency stop and manual-only always veto", () => {
  const inherited = fixture();
  inherited.settings.patch({ auto_resume_default_enabled: false }, now + 5, inherited.settings.getEffective().version, "test-owner");
  inherited.reconciler.reconcile(now + 6);
  assert.equal(intent(inherited.db, inherited.intentId).state, "DISABLED_BY_POLICY");
  inherited.workers.updatePreferences(inherited.workerId, { autoResumeOverride: true }, 0, now + 7);
  inherited.reconciler.reconcile(now + 8);
  assert.equal(intent(inherited.db, inherited.intentId).state, "WAITING_RESET");
  assert.equal(intent(inherited.db, inherited.intentId).last_error_code, "RUNTIME_UNSUPPORTED");
  inherited.settings.patch({ auto_resume_emergency_stop: true }, now + 9, inherited.settings.getEffective().version, "test-owner");
  inherited.reconciler.reconcile(now + 10);
  assert.equal(intent(inherited.db, inherited.intentId).state, "DISABLED_BY_POLICY");
  assert.equal(intent(inherited.db, inherited.intentId).last_error_code, "GLOBAL_STOP");
  inherited.db.close();

  const manual = fixture("MANUAL_ONLY");
  manual.reconciler.reconcile(now + 5);
  assert.equal(intent(manual.db, manual.intentId).state, "DISABLED_BY_POLICY");
  assert.equal(intent(manual.db, manual.intentId).last_error_code, "TASK_MANUAL_ONLY");
  manual.db.close();
});

test("turning Auto Resume OFF never kills a RESUMING turn; it records in-flight policy change", () => {
  const f = fixture();
  f.db.run("UPDATE recovery_intents SET state = 'RESUMING' WHERE id = ?", f.intentId);
  f.db.run("UPDATE task_execution_conditions SET condition = 'RESUMING' WHERE task_id = 'task-policy'");
  f.workers.updatePreferences(f.workerId, { autoResumeOverride: false }, 0, now + 5);
  f.reconciler.reconcile(now + 6);
  assert.equal(intent(f.db, f.intentId).state, "RESUMING");
  assert.equal(intent(f.db, f.intentId).last_error_code, "POLICY_CHANGED_IN_FLIGHT");
  assert.equal(f.db.one<any>("SELECT control_cancel FROM tasks WHERE id = 'task-policy'")?.control_cancel, "NONE");
  f.db.close();
});
