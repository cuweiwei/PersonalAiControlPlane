import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { RecoveryService } from "../apps/control-plane/src/recovery/recovery-service.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { WorkerService } from "../apps/control-plane/src/workers/worker-service.ts";

const now = 1_800_100_000_000;

function fixture() {
  const db = new ControlPlaneDatabase(":memory:");
  const workers = new WorkerService(db, new EventHub());
  const registration = workers.register({ name: "Recovery Worker", registrationSecret: "recovery-worker-secret-123", platform: "win32", hardware: {} }, now);
  const workerId = String(workers.approveRegistration(registration.registrationId, "test-owner", now + 1).workerId);
  db.run(`INSERT INTO tasks(id, source, title, task_type, instruction, context_json, payload_json, execution_json, priority, status,
    timeout_seconds, max_attempts, created_at, updated_at, current_attempt_id, execution_semantics, occupancy, effect_state, control_cancel)
    VALUES ('task-recovery', 'test', 'Quota interrupted task', 'opencode', 'continue bounded work', '{}', '{}', '{"workspace_id":"workspace-a"}', 50,
    'RUNNING', 1800, 1, ?, ?, 'attempt-recovery', 'platform_v2', 'RUNNING', 'NONE_CONFIRMED', 'NONE')`, now, now);
  db.run(`INSERT INTO task_attempts(id, task_id, attempt_number, worker_id, status, assigned_at, started_at, occupancy, effect_state, fence_epoch, workspace_id)
    VALUES ('attempt-recovery', 'task-recovery', 1, ?, 'RUNNING', ?, ?, 'RUNNING', 'NONE_CONFIRMED', 7, 'workspace-a')`, workerId, now, now);
  db.run(`INSERT INTO workspace_locks(workspace_id, lock_mode, attempt_id, fence_epoch, state, acquired_at, updated_at)
    VALUES ('workspace-a', 'WRITE_EXCLUSIVE', 'attempt-recovery', 7, 'HELD', ?, ?)`, now, now);
  return { db, workers, workerId, service: new RecoveryService(db) };
}

function report(workerId: string) {
  return {
    task_id: "task-recovery",
    attempt_id: "attempt-recovery",
    worker_id: workerId,
    runtime: "opencode" as const,
    native_session_id: "native-session-secret-like-id",
    workspace_id: "workspace-a",
    workspace_fence_epoch: 7,
    blocker_kind: "FIVE_HOUR" as const,
    blocker_generation: 1,
    resume_policy: "MANUAL_ONLY" as const,
    observed_at: now + 2,
    next_probe_at: now + 300_000,
    branch: "feat/example",
    baseline_sha: "a".repeat(40),
    last_head_sha: "b".repeat(40),
  };
}

test("quota blocker is durable, idempotent, fenced, and never exposes the native session id", () => {
  const f = fixture();
  const first = f.service.recordQuotaBlock(report(f.workerId), "worker-runtime", now + 3) as any;
  const duplicate = f.service.recordQuotaBlock(report(f.workerId), "worker-runtime", now + 4) as any;
  assert.equal(first.id, duplicate.id);
  assert.equal(first.state, "WAITING_RESET");
  assert.equal(first.blockerKind, "FIVE_HOUR");
  assert.equal(first.resumePolicy, "MANUAL_ONLY");
  assert.equal(JSON.stringify(first).includes("native-session-secret-like-id"), false);
  assert.equal(f.db.one<any>("SELECT status FROM tasks WHERE id = 'task-recovery'")?.status, "RUNNING");
  assert.equal(f.db.one<any>("SELECT condition FROM task_execution_conditions WHERE task_id = 'task-recovery'")?.condition, "WAITING_RESET");
  assert.equal(f.db.one<any>("SELECT native_session_id FROM agent_session_bindings WHERE attempt_id = 'attempt-recovery'")?.native_session_id, "native-session-secret-like-id");
  assert.equal(Number(f.db.one<any>("SELECT COUNT(*) AS count FROM recovery_intents")?.count), 1);
  assert.equal(Number(f.db.one<any>("SELECT COUNT(*) AS count FROM recovery_events")?.count), 1);
  assert.throws(() => f.service.recordQuotaBlock({ ...report(f.workerId), branch: "feat/changed" }, "worker-runtime", now + 5), /QUOTA_BLOCK_REPORT_CONFLICT/);
  assert.equal(f.db.all<any>("SELECT payload_json FROM audit_events").some((row) => String(row.payload_json).includes("native-session-secret-like-id")), false);
  assert.equal(f.db.all<any>("SELECT payload_json FROM recovery_events").some((row) => String(row.payload_json).includes("native-session-secret-like-id")), false);
  assert.equal(f.workers.verifyAuditChain(), true);
  f.db.close();
});

test("a Worker cannot upgrade the authoritative Work resume policy", () => {
  const f = fixture();
  f.db.run(`INSERT INTO orchestration_works(id, owner_kind, owner_principal, origin_ref, objective, design_authority, implementation_owner,
    revision, status, review_state, contract_json, created_at, updated_at)
    VALUES ('work-manual', 'CODEX', 'owner', 'test:manual', 'manual only', 'MAC_LED', 'WINDOWS', 1, 'ACTIVE', 'PENDING', ?, ?, ?)`, JSON.stringify({ resume_policy: "MANUAL_ONLY" }), now, now);
  f.db.run("INSERT INTO orchestration_work_tasks(work_id, task_id, role, created_at) VALUES ('work-manual', 'task-recovery', 'IMPLEMENTATION', ?)", now);
  const result = f.service.recordQuotaBlock({ ...report(f.workerId), resume_policy: "INHERIT_WORKER" }, "worker-runtime", now + 3) as any;
  assert.equal(result.resumePolicy, "MANUAL_ONLY");
  assert.equal(result.state, "WAITING_RESET");
  f.db.close();
});

test("quota blocker rejects stale ownership, fence, cancel, and invalid checkpoint references", () => {
  const f = fixture();
  assert.throws(() => f.service.recordQuotaBlock({ ...report(f.workerId), workspace_fence_epoch: 6 }, "worker-runtime", now + 3), /WORKSPACE_FENCE_MISMATCH/);
  f.db.run("UPDATE workspace_locks SET fence_epoch = 8 WHERE workspace_id = 'workspace-a'");
  assert.throws(() => f.service.recordQuotaBlock(report(f.workerId), "worker-runtime", now + 4), /WORKSPACE_FENCE_MISMATCH/);
  f.db.run("UPDATE workspace_locks SET fence_epoch = 7 WHERE workspace_id = 'workspace-a'");
  assert.throws(() => f.service.recordQuotaBlock({ ...report(f.workerId), checkpoint_artifact_id: "missing-artifact" }, "worker-runtime", now + 4), /CHECKPOINT_ARTIFACT_NOT_FOUND/);
  f.db.run("UPDATE tasks SET control_cancel = 'REQUESTED' WHERE id = 'task-recovery'");
  assert.throws(() => f.service.recordQuotaBlock(report(f.workerId), "worker-runtime", now + 5), /TASK_NOT_RESUMABLE/);
  assert.equal(Number(f.db.one<any>("SELECT COUNT(*) AS count FROM recovery_intents")?.count), 0);
  f.db.close();
});
